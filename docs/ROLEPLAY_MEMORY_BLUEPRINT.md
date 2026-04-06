# Roleplay Memory Blueprint (SillyTavern + Smart Memory + Vector Storage)

This blueprint describes a practical path to make characters feel consistently "alive" in long-running roleplay:

- no hard resets after trimming,
- strong continuity across sessions,
- high-fidelity short-term scene details,
- and memory retrieval that stays relevant instead of noisy.


## Primary usage targets

This design is optimized for Smart Memory's real-world usage patterns:

- **Character-card roleplay (including NSFW ERP):** preserve persona voice, relationship dynamics, boundaries, and preferences/kinks over long sessions.
- **Assistant-style chats with character persona:** maintain helpful behavior **without** flattening the character's tone and identity.
- **Mixed hardware environments:** run acceptably on small local setups (e.g., ~8GB VRAM + Ollama) while scaling up quality when stronger hosted models are available.

A key goal is to keep continuity and personality stable after consolidation, so the character never feels generic or "reset."

---

## 1) Move from "memory list" to a **memory graph**

Current long-term/session/scenes/arcs tiers are already strong. The next step is to model memories as connected entities.

### Proposed schema (per memory item)

- `id`
- `content`
- `type` (`fact`, `relationship`, `preference`, `event`, etc.)
- `importance` (1-3)
- `confidence` (0-1)
- `emotional_weight` (e.g., affection, jealousy, attachment, conflict)
- `persona_relevance` (how strongly this affects character-card identity/voice)
- `intimacy_relevance` (relationship/NSFW preference importance)
- `source_messages` (chat message ids)
- `entities` (character, place, object, faction)
- `time_scope` (`scene`, `session`, `arc`, `global`)
- `valid_from`, `valid_to` (for state changes over time)
- `supersedes` / `contradicts`
- `last_confirmed_ts`
- `retrieval_count`

### Why it matters

A graph allows state updates without deleting history:

- "She lives in Paris" -> later "She moved to Berlin" should **supersede**, not overwrite.
- Relationship changes (enemy -> ally -> lover) can be tracked as timeline transitions, not contradictory blobs.

This directly reduces the "lobotomized after consolidation" feel.

---

## 2) Two-stage extraction to reduce hallucinated memory writes

### Stage A: candidate extraction (high recall)

Generate candidates aggressively from recent messages.

### Stage B: verifier pass (high precision)

Before persistence, run a lightweight verifier that enforces:

- evidence required in `source_messages`,
- no direct contradiction with high-confidence memories unless marked as state change,
- confidence scoring,
- canonical formatting.

Only verified candidates are committed as durable memory.

---

## 3) Add **stateful profiles** for characters and world

Maintain compact rolling profiles that are regenerated from the graph, not raw chat:

- `character_state`: goals, fears, loyalties, current emotional posture,
- `world_state`: current location, active threats, unresolved events,
- `relationship_matrix`: directional relationship states with confidence.

Inject these as stable anchors every turn (small token footprint). This preserves "who they are right now" even when detailed memories are trimmed.

---

## 4) Retrieval pipeline: hybrid ranker (vector + symbolic + recency)

Do not rely on vector similarity alone.

Compute final score as weighted blend:

- semantic similarity (vector)
- entity overlap with current turn
- arc relevance (open thread match)
- temporal relevance (scene/session proximity)
- importance + emotional_weight
- contradiction penalty

Then apply **diversity constraints**:

- at least one relationship memory,
- at least one unresolved arc memory,
- at least one recent scene detail,
- at least one high-importance long-term fact.

This avoids over-retrieving near-duplicate facts while missing critical story hooks.

---

## 5) Memory budget should be adaptive, not static

Use dynamic token allocation per turn:

- calm dialogue turns: allocate more to long-term and relationship continuity,
- action/scene-heavy turns: allocate more to session + scene details,
- post-timeskip or return-after-gap: temporarily boost recap + arc context.

A simple policy engine can re-balance token budgets each generation.

---

## 6) Keep **three layers** of summarization to avoid identity loss

When trimming, compress upward instead of deleting:

1. **micro summaries** per scene,
2. **arc summaries** for clusters of scenes,
3. **character canon summaries** for long-range continuity.

Every compressed artifact stores backlinks to source memory ids.

Result: you can always rehydrate details when needed, which prevents "flat" character behavior after long campaigns.

---

## 7) Contradiction handling should produce repairs, not only warnings

The continuity checker can be extended to auto-repair flow:

- detect contradiction,
- classify type (`hard fact`, `time ordering`, `relationship state`),
- propose repair memory,
- optionally inject a tiny corrective system note for next turn.

Example: if the model says a dead NPC is alive, inject short correction context tied to the relevant event memory.

---

## 8) Add forgetting policies based on **utility decay**, not age only

Instead of oldest-first trimming, compute retention score:

- `importance`
- `emotional_weight`
- `retrieval_count`
- `last_confirmed_ts`
- `entity centrality` (how connected this memory is)

Low-utility memories are compressed first; high-utility memories are retained even if old.

---

## 9) Scene memory should track intimacy/context continuity explicitly

For character-first RP (including NSFW ERP), preserve the "what the dynamic is right now" model:

- active setting + atmosphere (private/public, safe/risky, formal/intimate),
- who is present and emotionally engaged,
- consent/boundary state and comfort progression,
- recent physical details that matter for continuity,
- temporal markers (just happened, ongoing, aftercare, next-day callback).

Inject a compact "current scene state" block each turn.

This improves immersion and prevents abrupt tone/persona drift across replies.

---

## 10) Build a regression harness for memory quality

Add benchmark chats and automatic checks for:

- long-gap recall accuracy,
- contradiction rate,
- arc completion recall,
- relationship consistency,
- post-consolidation personality retention.

Track these metrics in CI so memory quality improves release-over-release.

---


## Runtime profiles for low VRAM vs strong hosted models

Use tiered behavior so the same extension works on both local and cloud setups.

### Profile A: Local / ~8GB VRAM (cost-sensitive)

- Use a small deterministic memory model for extraction/consolidation.
- Batch memory writes every N messages (avoid per-turn heavy calls).
- Keep injected blocks short and structured (`persona core`, `relationship delta`, `scene now`).
- Run deep consolidation less frequently (e.g., on idle, manual, or every larger interval).
- Prefer lexical+metadata reranking plus small vector top-k to limit token and compute use.

### Profile B: Hosted / high-performance model

- Enable verifier pass every extraction cycle.
- Expand retrieval fan-out and apply richer reranking features.
- Run contradiction checks continuously with auto-repair suggestions.
- Generate higher-fidelity profile refreshes (persona + relationship + world state).

### Shared principle

Memory quality should degrade gracefully with compute limits: keep core persona and relationship continuity protected first, then reduce secondary detail depth if needed.

---

## Suggested implementation order

1. verifier pass + confidence/source attribution,
2. hybrid retrieval ranker + diversity constraints,
3. stateful character/world profiles,
4. utility-decay retention,
5. contradiction auto-repair,
6. memory graph migration and profile regeneration.

This ordering gives immediate quality gains before deeper refactors.

## Prompting defaults for best RP feel

- Keep extraction model deterministic (low temperature).
- Keep generation model creative (higher temperature), but anchor with profile + top memories.
- Prefer short, structured injected blocks over one long prose blob.
- Always include at least one "recent scene" and one "core identity" memory each turn.
- Reserve protected slots for `persona anchors` and `relationship/kink continuity` before optional memories.

---

With these upgrades, Smart Memory + vector storage becomes a true continuity engine rather than a simple archive, preserving both long-term identity and short-term scene intelligence across very long roleplay sessions.
