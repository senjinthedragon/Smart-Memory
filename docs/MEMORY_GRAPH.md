# Memory Graph - Design Document

Smart Memory currently stores memories as flat lists. This document defines the full memory graph system: a connected, versioned, entity-aware memory store that tracks how facts evolve over time, links memories to the characters and places they involve, and supports richer retrieval and profile generation on top.

---

## Goals

- State updates that retire old facts rather than contradicting them silently
- Relationship and persona continuity that survives long consolidation passes
- Richer retrieval that uses story context (entities present, open arcs, scene mood) not just recency
- Stateful character and world profiles regenerated from graph state, injected as compact anchors
- Adaptive token allocation that shifts budget toward what matters each turn
- Three-layer summarization so nothing is truly lost - only compressed
- Works acceptably on ~8GB VRAM with a local Ollama model; scales up quality on hosted APIs

---

## 1. Schema

### 1.1 Memory item (extended)

All existing fields are preserved. New fields are added alongside them.

```js
{
  // --- existing fields (unchanged) ---
  content: string,
  type: string,               // fact | relationship | preference | event | scene | revelation | development | detail
  importance: 1|2|3,
  confidence: number,         // 0-1
  persona_relevance: 1|2|3,
  intimacy_relevance: 1|2|3,
  emotional_weight: number,   // 0-1
  expiration: string,         // permanent | session | scene
  retrieval_count: number,
  last_confirmed_ts: number,
  ts: number,                 // creation timestamp

  // --- new graph fields ---
  id: string,                 // UUID, stable across sessions
  source_messages: string[],  // ST chat message ids that support this memory
  entities: string[],         // entity ids referenced by this memory
  time_scope: string,         // scene | session | arc | global
  valid_from: number|null,    // message index when this became true (null = unknown)
  valid_to: number|null,      // message index when this stopped being true (null = still valid)
  supersedes: string[],       // ids of memories this replaces
  superseded_by: string|null, // id of the memory that replaced this one (null = still current)
  contradicts: string[],      // ids of memories this conflicts with (unresolved)
}
```

A memory with `superseded_by` set is retired - it is kept in storage for history but excluded from injection and retrieval by default. Retired memories remain queryable for the timeline view and for rehydration.

### 1.2 Entity

Entities are extracted alongside memories and stored in a separate registry. Each entity has a canonical name, a type, and a list of aliases the model might use to refer to it.

```js
{
  id: string,                 // UUID
  name: string,               // canonical name (e.g. "Senjin")
  type: string,               // character | place | object | faction | concept
  aliases: string[],          // alternate names/spellings seen in chat
  first_seen: number,         // message index
  last_seen: number,          // message index of most recent mention
  memory_ids: string[],       // ids of all memories that reference this entity
}
```

Entity registry is stored in `chatMetadata.smartMemory.entities` for session-scoped entities and in `extension_settings.smart_memory.characters[name].entities` for persistent ones.

---

## 2. Entity extraction

Entities are extracted as a lightweight pass during or alongside memory extraction. The extraction prompt asks the model to tag each memory candidate with the entities it involves, using a short controlled vocabulary:

```text
[fact:entity=Senjin,Alex] Senjin is Alex's older brother.
[relationship:entity=Senjin,Alex] Their relationship has shifted from rivalry to deep mutual affection.
```

The entity tagger normalizes names against the existing registry using fuzzy matching (same Jaccard/embedding approach as deduplication) to collapse aliases before persisting.

For local models, entity extraction is bundled into the existing extraction prompt rather than run as a separate call - one pass, one output block.

---

## 3. Supersession

When a new memory candidate directly updates or replaces an earlier fact, the old memory should be retired rather than left as a contradiction.

### 3.1 Detection

Supersession candidates are identified during the verifier pass. When a new candidate has high semantic similarity (above the deduplication threshold) with an existing memory but the content has meaningfully changed rather than being a near-duplicate, it is flagged as a supersession rather than a duplicate.

Examples of supersession vs duplicate:

- "She lives in Paris" + "She moved to Berlin last week" - supersession (state changed)
- "She lives in Paris" + "She is based in Paris" - duplicate (same fact, different wording)

The heuristic: high similarity score + divergent key named entities or negation markers → supersession candidate. The verifier prompt explicitly asks the model to classify each candidate as `new`, `duplicate`, `supersedes:[id]`, or `contradicts:[id]`.

### 3.2 Applying supersession

When a supersession is confirmed:

1. The new memory is written with `supersedes: [old_id]` and `valid_from` set to current message index.
2. The old memory is updated: `superseded_by: new_id`, `valid_to: current message index`.
3. The old memory is excluded from active injection/retrieval but kept in storage.

### 3.3 Contradiction vs supersession

Not all conflicts are supersessions. A contradiction is when two memories cannot both be true and neither clearly replaces the other - likely an extraction error or a genuine story inconsistency. These are flagged with `contradicts` links on both entries and surfaced to the continuity checker rather than resolved automatically.

---

## 4. Profiles

Stateful profiles are compact summaries regenerated from graph state on a schedule, not from raw chat. They are injected as stable anchors every turn at a low token cost.

### 4.1 character_state

A brief snapshot of who the character is right now:

- current goals and motivations
- current emotional posture (stable, anxious, in love, grieving, etc.)
- active fears or unresolved tensions
- current loyalties and commitments

Regenerated by querying the graph for high-importance `fact`, `relationship`, and `event` memories involving the main character, sorted by recency, and passing them to a compact profile-generation prompt.

### 4.2 world_state

A brief snapshot of the current story context:

- current location and atmosphere
- active threats or pressures
- unresolved events
- time context (time of day, season, how long since a key event)

Sourced from recent `scene`, `development`, and `event` memories.

### 4.3 relationship_matrix

Per named entity: a one-line directional state with confidence.

```text
Alex (character): younger brother, deep mutual affection, slight protective dynamic, high trust [confidence: 0.9]
The Cabin (place): shared safe space, strong emotional anchor for both [confidence: 0.8]
```

Sourced from `relationship` memories involving each entity.

### 4.4 Regeneration schedule

Profiles are not regenerated every turn - that would be expensive on local hardware. Instead:

- Regenerated after each extraction pass (every N messages)
- Regenerated on chat load if stale (older than a configurable threshold)
- Manually triggerable via a button in the UI
- On low-VRAM profile: profile regeneration uses the same extraction model call, appended to the extraction output rather than a separate call

Profiles are stored in `chatMetadata.smartMemory.profiles` and injected via a dedicated `setExtensionPrompt` slot.

---

## 5. Hybrid retrieval

Currently injection selects memories by type priority and utility score. The graph enables richer selection.

### 5.1 Scoring

Final retrieval score per memory is a weighted blend:

```text
score =
  w1 * utility_score          // existing importance/recency/retrieval composite
  w2 * entity_overlap         // how many entities in this memory are present in the current turn
  w3 * arc_relevance          // whether this memory connects to an open arc
  w4 * temporal_proximity     // scene/session/arc/global scope vs current context depth
  w5 * semantic_similarity    // vector similarity when embeddings available, Jaccard fallback
  - contradiction_penalty     // subtract if this memory has unresolved contradicts links
```

Weights are tunable per hardware profile. On local/low-VRAM, `w5` (semantic) is downweighted and the lighter signals dominate. On hosted, all weights are active.

### 5.2 Diversity floor

After scoring, enforce at least one memory from each of:

- a `relationship` type
- an unresolved arc
- a recent `scene` or `development`
- a high-importance `fact`

This prevents the retrieval collapsing to near-duplicate facts about the same topic.

### 5.3 Entity overlap detection

Current turn entity overlap is computed by extracting named entities from the last 1-2 messages (lightweight regex pass, not a model call) and matching against entity ids in the registry. No extra model call needed.

---

## 6. Adaptive token budget

Instead of fixed token budgets per tier, allocate dynamically based on turn context.

### 6.1 Turn classification

Classify each turn into one of:

- `dialogue` - conversation-heavy, few scene changes
- `action` - active scene, physical events, high detail
- `transition` - timeskip, location change, returning after gap
- `intimate` - ERP/relationship-focused content

Classification uses a lightweight heuristic pass on the last message (word patterns, scene break signals already used in scenes.js) - no model call.

### 6.2 Budget reallocation

Base budgets per tier are the user's configured values. Multipliers shift allocation:

| Turn type   | Long-term | Session | Scenes | Arcs | Profiles |
|-------------|-----------|---------|--------|------|----------|
| dialogue    | 1.2x      | 0.8x    | 0.7x   | 1.0x | 1.2x     |
| action      | 0.8x      | 1.3x    | 1.2x   | 1.0x | 0.8x     |
| transition  | 1.0x      | 0.9x    | 1.0x   | 1.3x | 1.0x     |
| intimate    | 0.9x      | 1.2x    | 1.0x   | 0.8x | 1.3x     |

Total budget is capped at the user's configured maximum so reallocation never adds tokens, only shifts them.

---

## 7. Three-layer summarization

The current single compaction summary compresses everything into one block. Three layers compress upward with backlinks so detail is never truly lost.

### 7.1 Layer 1 - Micro scene summaries

Generated per detected scene break (already detected by scenes.js). Each micro summary is a 2-4 sentence dense summary of what happened in that scene, stored with a list of memory ids that contributed to it.

Currently scene summaries are stored but not linked back to source memories. Add `source_memory_ids` to the scene schema.

### 7.2 Layer 2 - Arc summaries

When an arc is resolved (or after a configurable number of scenes), generate an arc summary - a paragraph covering the full thread from opening to resolution. Stored with `source_scene_ids` and `source_memory_ids`.

Arc summaries replace per-scene injection for their arc once the arc is closed, keeping the token footprint flat as the story grows.

### 7.3 Layer 3 - Canon summaries

Periodically (configurable interval, or manually triggered) generate a canon summary per character - a stable narrative document covering who they are, what has happened, and the current state of key relationships. Sourced from arc summaries and high-importance long-term memories.

Canon summaries are the long-range continuity anchor. They replace compaction's single summary for chats that have grown past multiple arcs. The compaction summary remains for short/medium chats; canon kicks in once enough arc summaries exist.

Stored in `extension_settings.smart_memory.characters[name].canon` - persists across sessions.

---

## 8. UI changes

### 8.1 Active memory list (minimal change)

- Retired/superseded entries are hidden by default, revealed via a "show history" toggle per entry
- A small "→ superseded by" label on retired entries links to the replacement
- Contradiction warnings shown as a yellow indicator on affected entries with a "review" link that opens the continuity checker pre-populated with the conflict

### 8.2 Entity panel

New collapsible panel in the Smart Memory UI listing the entity registry. Each entity shows:

- Name and type badge
- Number of memories referencing it
- Last seen (message index / relative label)
- Expandable list of linked memories

### 8.3 Timeline view (per entity)

Accessible from the entity panel. Shows a simple vertical timeline of memories involving a selected entity, ordered by `valid_from`, with retired entries shown in muted style and supersession arrows between entries. No graph library needed - pure CSS timeline.

### 8.4 Profile panel

New collapsible section showing the current `character_state`, `world_state`, and `relationship_matrix` as formatted read-only text. Includes a "Regenerate" button and a timestamp showing when profiles were last updated.

---

## 9. Hardware profiles

### Profile A: Local (~8GB VRAM, Ollama)

- Entity extraction bundled into the existing extraction prompt (no extra call)
- Profile regeneration appended to extraction output (no extra call)
- Semantic similarity (`w5`) downweighted in hybrid retrieval - rely on entity overlap and utility score
- Canon summary generation manual-only or on long idle, not automatic
- Arc summaries generated on arc resolution only, not on a schedule
- Adaptive budget enabled but with conservative multipliers

### Profile B: Hosted / high-performance

- Entity extraction as a lightweight second pass after main extraction
- Profile regeneration on its own scheduled call every N messages
- Full hybrid retrieval with all weights active including semantic
- Canon summary regenerated automatically after each arc closes
- Contradiction checks can run automatically (not just manually)
- Richer verifier pass with higher extraction quality thresholds

Hardware profile is selected automatically based on the configured memory source (Ollama/WebLLM → Profile A, main API with a known hosted model or OpenAI-compatible → Profile B). User can override in settings.

---

## 10. Migration

Existing memories have no `id`, no `entities`, no supersession links. Migration runs once on load when the graph schema version is not present.

### Migration pass

1. Assign a UUID `id` to every existing memory that lacks one
2. Set `superseded_by: null`, `supersedes: []`, `contradicts: []`
3. Set `source_messages: []`, `entities: []` (populated going forward only)
4. Set `valid_from: null`, `valid_to: null`, `time_scope: 'global'`
5. Write schema version marker to `extension_settings.smart_memory.graph_schema_version`

Migration is non-destructive - existing data is extended in place. No memories are deleted or altered beyond adding fields.

---

## 11. Module changes summary

| Module | Changes |
|--------|---------|
| `constants.js` | Graph schema version constant, new prompt keys for profiles |
| `prompts.js` | Entity-tagged extraction prompt, supersession verifier prompt, profile generation prompts, arc summary prompt, canon summary prompt |
| `parsers.js` | Entity tag parser, supersession/contradiction classifier parser, profile output parser |
| `longterm.js` | ID assignment on write, entity linkage, supersession apply/retire logic, migration pass |
| `session.js` | Same as longterm.js for session-scoped memories |
| `scenes.js` | Add `source_memory_ids` to scene schema, layer 2 arc summary generation |
| `arcs.js` | Arc summary generation on resolution |
| `continuity.js` | Surface contradiction links from graph, pre-populate checker with flagged pairs |
| `compaction.js` | Layer 3 canon summary path alongside existing single-summary path |
| `embeddings.js` | Entity overlap scoring added to batch verification pass |
| `memory-utils.js` | Hybrid retrieval scoring, adaptive budget allocation, turn classifier |
| `index.js` | Profile injection slot, entity panel, timeline view, hardware profile detection |
| `settings.html` | Hardware profile override, profile panel, entity panel, timeline |
| `style.css` | Entity panel, timeline, supersession indicators, profile panel |

---

## 12. Implementation checklist

### Schema and storage

- [x] Add `id` field - UUID generated on memory creation
- [x] Add `source_messages` field
- [x] Add `entities` field
- [x] Add `time_scope` field
- [x] Add `valid_from` / `valid_to` fields
- [x] Add `supersedes` / `superseded_by` / `contradicts` fields
- [x] Entity registry schema and storage (chatMetadata + extension_settings)
- [x] Schema version marker and migration pass

### Extraction

- [x] Entity-tagged extraction prompt (bundle entity extraction into existing prompt)
- [x] Entity normalizer (fuzzy match against registry, alias collapse)
- [x] Supersession/contradiction classifier in verifier pass
- [x] Apply supersession on verified candidates (retire old, link new)

### Profiles

- [x] `character_state` generation prompt and parser
- [x] `world_state` generation prompt and parser
- [x] `relationship_matrix` generation prompt and parser
- [x] Profile storage in chatMetadata
- [x] Profile injection slot
- [x] Profile regeneration schedule (post-extraction, on load if stale)
- [x] Manual regenerate button in UI

### Retrieval

- [x] Entity overlap scoring (regex entity pass on last messages)
- [x] Arc relevance scoring
- [x] Temporal proximity scoring
- [x] Contradiction penalty
- [x] Weighted hybrid score assembly in memory-utils.js
- [x] Diversity floor enforcement - `applyDiversityFloor` promotes the best entry of each
      required type to the front of the sorted output so it appears prominently regardless
      of its raw hybrid score. Long-term floor: relationship + fact. Session floor: development + scene.
- [x] Semantic weight downscaling for Profile A - `w5 = 0.2` on Profile A, `w5 = 0.6` on Profile B;
      turn text embedded in the existing arc-relevance batch call so no extra round-trip

### Adaptive budget

- [x] Turn classifier (heuristic, no model call)
- [x] Budget multiplier table
- [x] Apply multipliers to injection budgets per turn

### Three-layer summarization

- [x] `source_memory_ids` on scene schema
- [x] Layer 2: arc summary generation on arc resolution
- [x] Layer 3: canon summary generation (manual trigger)
- [x] Canon summary storage in extension_settings
- [x] Canon summary injection (replaces compaction for long chats)

### UI

- [x] Supersession indicator on retired memories (hidden by default, toggle)
- [x] "Superseded by →" link on retired entries
- [x] Contradiction warning indicator on affected entries
- [x] Entity panel (list, type badge, memory count, last seen)
- [x] Per-entity timeline view (vertical, CSS-only)
- [x] Profile panel (character_state, world_state, relationship_matrix read-only)
- [x] Hardware profile override setting

### Infrastructure

- [x] Hardware profile auto-detection from configured source
- [x] Schema version check and migration on load
- [x] Tests for hybrid scorer, turn classifier, budget allocator, reconcileTypeEntries (20 tests in
      memory-utils.test.js); 56 parser tests in parsers.test.js - 76 total, all passing
- [ ] Tests for entity normalizer and supersession classifier (deferred - no unit-testable
      extraction path exists yet without a full ST runtime mock)
- [x] Entity registry re-link after consolidation is substring-based - if the model uses pronouns
      in a merged memory (e.g. "she" instead of "Alex"), the entity loses its link to that memory.
      Fixed: `reconcileTypeEntries` now carries the base entry's `entities` array forward when
      replacing it with a promoted entry. `reconcileEntityRegistry` pass 2 checks
      `mem.entities.includes(entity.id)` alongside content substring so a memory that already
      carries an entity ID is re-linked even when its content uses only pronouns.

---

### Profile B behavioral gates

- [x] `getHardwareProfile()` moved to `embeddings.js`, imported everywhere else
- [x] `batchVerify` thresholds - Profile B uses higher dup thresholds (0.85/0.91 semantic,
      0.68/0.78 Jaccard) and lower same-topic threshold (0.52/0.38) to preserve nuanced
      memories from powerful models while catching more supersession candidates
- [x] Auto-canon regeneration after arc extraction (Profile B only, requires arcs_enabled +
      at least 2 resolved arc summaries)
- [x] `hybridPrioritize` - `w5 = 0.2` on Profile A, `w5 = 0.6` on Profile B; embedded in the
      existing arc-relevance batch call, no extra round-trip
- [x] Contradiction check auto-run on Profile B - fires after every AI turn; badge in settings
      header shows "clean" / "N conflicts"; auto-repair queues a repair note when enabled
- [x] Profile regeneration on its own scheduled call every N messages (Profile B only) - new
      "Also regenerate every N messages" slider; 0 (default) retains extraction-pass-only behaviour
