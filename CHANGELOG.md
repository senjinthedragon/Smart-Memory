# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Unified injection mode (experimental)**: a new toggle in the Developer
  section merges all active memory tiers into a single IN_PROMPT block instead
  of injecting each tier into its own named slot at different depths and
  positions. Content is ordered most-stable-first (canon, profiles, long-term,
  short-term, scenes) to most-immediate-last (session, arcs) so the model sees
  active goals closest to its response via recency bias. The token usage bar
  continues to show per-tier colour breakdowns even in unified mode. The
  setting is off by default.

- **Canon enabled/disabled toggle**: the Canon section now has an enable
  checkbox matching the other memory tiers. Disabling canon suppresses both
  injection and auto-regeneration on Profile B.

- **Group chat memory comparison in token display**: the token usage bar now
  shows a compact per-character row for every group member beneath the main
  bar. Each row shows that character's stored personal memory footprint
  (long-term, canon, and profiles) as a mini colour-coded bar with a token
  count. Shared tiers (session, scenes, arcs, short-term) are the same for
  all members and stay in the main bar only. The active character is
  highlighted; inactive members are dimmed. The text legend that previously
  appeared below the main bar has been removed - tier breakdowns are now on
  hover tooltips on each bar segment.

- **Extraction frequency dropdown**: simple mode gains an Extraction frequency
  selector (Low / Medium / High, mapping to every 5 / 3 / 1 messages) placed
  below the hardware profile. The individual per-tier extract-every sliders
  move to advanced mode only.

- **Consolidation settings panel**: all consolidation settings are now grouped
  into a single root-level Consolidation section (visible in advanced mode
  only - hidden in simple mode, where consolidation runs on with sensible
  defaults). The section toggle enables or disables consolidation across both
  long-term and session memory. Session memory now has per-type consolidation
  thresholds matching the long-term tier (scene, revelation, development,
  detail), replacing the previous single shared slider.

- **Simple and advanced settings mode**: the settings panel now defaults to a
  simplified view exposing only the most commonly adjusted controls. Advanced
  mode restores the full set of per-tier budgets, injection positions, depths,
  roles, templates, extraction frequencies, and compaction tuning knobs for
  users who want manual control.

- **Persistent story arcs**: a pin button on each arc in the Story Threads
  panel lets you mark an arc as persistent. Persistent arcs are stored at the
  character level and automatically appear in every new chat with that
  character, so long-running plot threads survive chapter breaks without
  requiring you to re-enter them. Unpinning an arc returns it to chat-local
  scope. Resolving a pinned arc (manually or via extraction) removes it from
  future chats automatically. Persistent arcs are visually distinguished by a
  gold left border and a highlighted pin icon. This feature is solo-chat only
  (arcs in group chats are chat-local).

- **Memory graph visualization**: a new "View Graph" button in the Entity
  Registry panel opens a full-screen force-directed canvas graph of the current
  character's entities and memories. Entity nodes (larger, coloured by type)
  are linked to their associated memory nodes (smaller, coloured by memory
  type). Supersession chains are shown as directed orange arrows. Supports
  pan (drag background), zoom (scroll wheel), node drag, click-to-highlight
  neighbours, and hover tooltips showing full memory content. Filters for
  session memories and retired memories can be toggled live without closing
  the graph.

### Removed

- **Hide summarized messages**: the "Hide summarized messages" checkbox
  introduced in v1.5.1 has been removed. The feature used SillyTavern's
  `hideChatMessageRange` which sets `is_system` on messages, excluding them
  from the LLM context window as well as hiding them visually. In practice
  this broke scene continuity - the summary captures broad strokes but loses
  immediate detail, causing the model to lose track of what just happened in
  the current scene. Users wanting a tidy chat history can use SillyTavern's
  Message Limit extension instead, which keeps a configurable number of recent
  messages without touching context.

### Fixed

- **Graph node drag causing orbital spin**: dragging a node and releasing it
  would send the graph into a sustained spinning orbit that took many seconds to
  settle. DAMPING raised from 0.88 to 0.90 and the reheat on drag-end lowered
  from 0.25 to 0.10 so the graph settles quickly after a drag without continuing
  to orbit.

- **XSS in Ollama model dropdown**: the model name dropdown for the memory LLM
  source was built via string interpolation into innerHTML, allowing a crafted
  model name returned by the Ollama API to inject markup. The list is now built
  using jQuery DOM construction so model names are always treated as text.

- **Retired memories included in continuity checker and compaction digest**:
  superseded memories were fed into the continuity checker's established-facts
  block and the compaction cross-tier digest without filtering. The checker could
  then flag contradictions against facts that had already been retired, and the
  compaction digest wasted token budget on outdated content. Both now filter by
  `!m.superseded_by` before including memories.

- **Null guard missing in `injectRepair`**: `injectRepair` wrote to
  `chatMetadata[META_KEY]` without first checking whether `chatMetadata` itself
  was set. In any context where chatMetadata had not yet been initialised the
  function would throw. A guard now returns early if `chatMetadata` is absent.

- **Arc-resolution race: stale indices after async model call**: the arc
  extraction loop captured integer indices into the `existing` arcs array to
  identify arcs to resolve, then performed async model calls. By the time the
  loop came to act on those indices, the array could have changed (e.g. a new arc
  was added from a parallel path), making the stored indices point at the wrong
  arcs. Resolution targets are now captured as arc objects before any awaits, and
  the arc list is re-fetched after async work completes with matching done by
  content rather than by index.

- **Cross-chat state corruption during extraction**: if the user switched chats
  while a multi-tier extraction pass was in progress, later tiers and metadata
  saves still completed against the original chat's data - writing session
  memories, arc updates, and summaries into the new chat's store. A
  `CHAT_SWITCHED` sentinel and `chatLoadId` capture now abort the extraction pass
  at each tier boundary and before any chatMetadata write if the chat has changed
  since extraction began. The same guard covers the group chat extraction path.

- **Unhandled rejections from fire-and-forget `updateLastActive` calls**: the
  three `updateLastActive()` call sites in the event handlers did not observe the
  returned promise. If `saveMetadata()` rejected (e.g. on a transient write
  error), the rejection was silently swallowed in some environments and surfaced
  as an unhandled-rejection warning in others. All three sites now attach
  `.catch(console.error)`.

- **`respondedThisRound` race in group chat wrapper**: `onGroupWrapperFinished`
  read `respondedThisRound` after its first `await`, by which point other group
  members' draft events could have already started mutating the set for the next
  round. The participant set is now snapshotted into `roundResponders` at the
  very start of the handler before any awaits, and all internal references use the
  snapshot.

- **Persistent arcs not cleaned from character store after group round**:
  when an arc resolved during a group round, it was removed from the chat-local
  arc list but the per-character persistent arc store was never updated, leaving
  the resolved arc to reappear in the next chat. After arc extraction completes in
  the group path, all responding characters' persistent arc stores are now pruned
  against the current arc content set.

- **Continuity repair injected to every character in a group round**: when
  auto-repair was enabled and a repair note was queued, `loadAndInjectRepair` was
  called for every character that drafted in the round, re-injecting the repair
  prompt for each one. The note is now injected only for the first character to
  draft in a round; subsequent characters call `clearRepair` instead so the
  one-shot note fires exactly once per round.

- **Group character selector staleness race**: the `change` handler on the group
  character selector called `injectMemories` and then `injectSessionMemories`
  across two awaits. If the user changed the selector again before the first await
  resolved, the second inject ran with stale selector state, clobbering the
  injection from the newer selection. The handler now captures the selected value
  at entry and bails after the first await if the selection has since changed.

- **Unified injection stale tier content after memory deletion**: when all
  memories of a tier were deleted or a tier was disabled, `injectUnified` still
  injected the previous content from its internal cache on subsequent passes.
  The cache was only updated when an injector wrote non-empty content, so
  intentional clears were silently ignored. Each tier injector now calls
  `invalidateUnifiedCache` alongside any empty `setExtensionPrompt` write,
  ensuring the unified block reflects the actual current state.

- **`/sm-search` named arguments silently ignored**: the slash command accepted
  `k` (result count) and `min` (minimum similarity score) as named arguments in
  its callback and help text, but the command definition omitted
  `namedArgumentList`. SillyTavern never parsed them - they fell through as part
  of the query string and defaults were always used regardless of what the user
  passed. `namedArgumentList` now declares both parameters with correct types and
  default values.

- **Short-term summary injected when auto-summarization is disabled**: disabling
  the compaction toggle suppressed new summary generation but did not clear the
  injection slot, so an existing summary continued to appear in every prompt.
  `injectSummary` and `loadAndInjectSummary` now clear the slot when
  `compaction_enabled` is false, matching the behaviour of every other tier
  toggle.

- **Embedding inactive notice**: a persistent amber notice now appears at the
  top of the Smart Memory settings panel whenever semantic embeddings are
  inactive - either because the toggle is off, or because an API call failed
  this session (meaning the model is enabled but unreachable). The notice
  explains that deduplication falls back to keyword matching and includes a
  "Set up embeddings" link that opens and scrolls to the deduplication section.
  It disappears automatically once embeddings are working.

- **Embedding test button**: a "Test connection" button in the Deduplication
  settings fires a small test call to the configured Ollama endpoint and shows
  an inline result - green "Connected" on success, or a descriptive error if
  Ollama is not running or the model is not installed.

- **Arc dedup now uses semantic embeddings**: arc deduplication previously used
  only Jaccard word overlap (threshold 0.4). Arc descriptions are full narrative
  sentences where different phrasing can describe the same unresolved thread -
  Jaccard misses these. Arc similarity now uses cosine similarity on embeddings
  (threshold 0.82) with Jaccard as fallback, matching the scene and session
  strategies. All arc operations (extraction, merge, promote, demote, delete)
  use the same semantic check.

- **Session dedup now uses semantic embeddings**: session memory deduplication
  previously used only a word-overlap ratio (intersection / max word count),
  which missed duplicate memories expressed with different phrasing. The
  primary check is now cosine similarity on embeddings (threshold 0.82),
  matching the scene dedup strategy. The word-overlap ratio is retained as a
  fallback when embeddings are unavailable. All texts are batched in a single
  embedding call so the overhead per extraction pass remains one request.

- **Session entity registry renamed from `entities` to `sessionEntities`**:
  the chat-scoped entity registry was stored as `chatMetadata.smartMemory.entities`,
  which was visually ambiguous next to the character-level `entities` field in
  extension_settings. It is now stored as `sessionEntities` to match the
  `sessionMemories` naming convention. Existing chats are migrated automatically
  on load (schema version 4 -> 5).

- **Confirmation dialogs now use SillyTavern's popup system**: all destructive
  action dialogs (Clear memories, Fresh Start, Clear session/scenes/arcs, Memorize
  Chat, Clear chat context, Read-only commit/discard) previously used the browser's
  native `confirm()`, which appears outside ST's overlay stack and ignores ST's
  theme. All dialogs now use `callGenericPopup` so they are styled consistently
  with the rest of ST's UI.

- **Unified injection cache leaked across chat changes**: switching chats while
  unified injection was enabled could carry stale tier content from the previous
  chat into the new one. The content cache is now cleared at the start of every
  chat change.

- **Session extraction biased toward one character in group chats**: session
  extraction passed one group member's long-term memories to the model as a
  deduplication hint, ignoring all other members. In group chats the hint is now
  suppressed entirely, since there is no single authoritative character.

- **Scene catch-up deduplication and minimum buffer**: the catch-up loop (used
  when first running Smart Memory on an existing chat) now checks new scene
  summaries against the last three stored scenes before appending, matching the
  deduplication logic in normal scene processing. A minimum message buffer
  (default 3, respecting `scene_min_messages`) is also enforced, preventing
  trivially short fragments from being summarized as scenes. Scene entries
  written by catch-up now include `source_memory_ids` for future traceability.

- **Scene dedup checked only the most recent scene**: the normal scene break
  path compared each new summary only against the immediately preceding scene.
  It now checks the last three stored scenes, catching slow-paced sessions
  where repeated descriptions accumulate without triggering a break.

- **Graph tooltip XSS**: entity and memory node labels were injected into the
  tooltip innerHTML without escaping, allowing a crafted memory content string
  to inject markup. All tooltip fields are now HTML-escaped before insertion.

- **Checkpoint and branch support via read-only mode**: Smart Memory now
  warns when a checkpoint or branch is created without read-only mode active,
  since long-term memories will continue forming and will not roll back if the
  user later switches to the checkpoint or branch. When read-only mode is
  disabled, a confirmation dialog asks whether to commit or discard the
  session. Commit runs full extraction (long-term, arcs, profiles) on the
  read-only window messages and keeps all session memories, treating the
  window as if it had always been active. Discard purges session memories and
  hides the window messages as before.

- **Session memories leaked from read-only sessions**: session extraction was
  not gated by read-only mode, so memories extracted during a read-only window
  were accumulating in session memory and feeding into character profiles and
  the entity registry. Session extraction is now suppressed while read-only
  mode is active (matching the existing long-term, arc, and profile gates).
  When read-only mode is disabled, any session memories that accumulated during
  the window (identified by timestamp) are purged before they can propagate
  further. The session entity registry is repaired in the same pass.

- **Read-only mode ghosts messages on disable**: when read-only mode is turned
  off, all messages generated during that window are automatically marked as
  hidden (`is_system`) so they are excluded from context and can never be
  picked up by future extraction passes. Multiple toggle cycles each ghost
  their own window independently. The start index for each window is stored
  in chatMetadata when read-only is enabled and cleared after ghosting.

- **"Exclude from long-term memory" renamed to "Read-only mode"**: the option
  is now described in terms of what you can do with it rather than its internal
  mechanism. The character arrives with all their memories and behaves normally;
  nothing from the chat is written back to their persistent state. Useful for
  trying out a risky scene before committing it, or for a consequence-free
  session that leaves the character's history untouched. The underlying fix
  (extraction suppressed, injection kept active) is described in the fix entry
  below.

- **Group character selector not updating on membership changes**: adding or
  removing a character from a group chat mid-session did not update the group
  character selector or token display until the next chat reload. Smart Memory
  now listens to the `GROUP_UPDATED` event and rebuilds both immediately.

- **Scene break heuristic tightened**: the sleep/wake pattern no longer fires
  on brief naps mid-scene - only on waking language that implies overnight
  passage (dawn/morning/light/sun variants). The time-skip pattern no longer
  fires on `that evening/morning` which was too broad and matched incidental
  references within the same scene.

- **Scene dedup now uses semantic embeddings**: scene break deduplication
  previously used only Jaccard word-overlap similarity, which failed to catch
  duplicate summaries when the heuristic fired multiple times on the same
  narrative event and the model described it with different wording each time.
  Deduplication now uses cosine similarity on embeddings (threshold 0.82) with
  Jaccard as a fallback when embeddings are unavailable (threshold raised to
  0.55). A minimum buffer length check (default 5 non-system messages) now
  also suppresses scene breaks that fire before the scene has had a chance to
  develop, which was the root cause of the duplicates.

- **Compaction summary reproducing injected memory context**: the compaction
  model would sometimes copy canon, profiles, or other injected memory content
  verbatim into the summary output, causing duplicate blocks in the prompt.
  Both the full compaction prompt and the update prompt now explicitly instruct
  the model to summarize only the actual roleplay exchanges and ignore any
  injected memory context already stored at other tiers.

- **Entity timeline timestamps showing "unknown"**: all memory entries in the
  entity timeline displayed "unknown" instead of a date because the `when`
  label only checked `valid_from` (message index, set only on superseding
  memories). Timestamps now fall back to the `ts` field (Unix ms, set on
  every memory at creation) formatted as a locale date/time string.

- **`generateRepair` returning undefined instead of null on non-string model
  output**: when the model returned a non-string value, `generateRepair` fell
  through with an implicit `undefined` return instead of the documented `null`.
  The return is now guarded with a `typeof note === 'string'` check so callers
  always receive either a trimmed string or `null`.

- **`savePersistentArcs` throwing when settings store is uninitialised**: if
  `extension_settings[MODULE_NAME]` or its `characters` sub-object had not yet
  been created, the function threw a TypeError on the first write. Both the
  outer settings object and the characters map are now created on demand before
  the write proceeds.

- **Oversized single item not capped by arc and scene token budget loops**: the
  `while (trimmed.length > 1)` budget loop in `injectArcs` and
  `injectSceneHistory` would leave a single oversized item uncapped when it
  alone exceeded the budget. Both functions now apply a hard proportional
  truncation after the loop so the injected text is always within the configured
  budget regardless of individual item size.

- **Arc summaries including the full scene history**: `generateArcSummary` fed
  all stored scene history into the summarisation prompt, causing bloated prompts
  and unfocused summaries on long chats. The scene history is now capped to the
  five most recent scenes.

- **Last-write-wins data loss in concurrent arc extraction paths**: `extractArcs`
  re-loaded the arc list once after the model call to avoid index-based races, but
  the race window extended through the async deduplication phase. A second re-load
  now occurs immediately before `saveArcs`, with a content-based merge so arcs
  added by any overlapping extraction path are preserved rather than overwritten.

### Changed

- **All lone and paired buttons are now full-width in the settings panel**: any
  button with nothing beside it, or two buttons side by side with nothing else,
  now expand to fill the available panel width (50/50 split for pairs). Previously
  buttons kept their intrinsic width, leaving large amounts of unused space to
  their right. Implemented via a shared `sm-btn-row` flex class applied to all
  affected button containers.

- **Embedding test button moved inside the Deduplication config block**: the
  "Test connection" button now sits below the "Keep model in memory" checkbox
  inside the Deduplication settings block, rather than floating above it. The
  result span now appears below the button as a sibling element rather than
  inline to its right.

- **Extraction prompts now explicitly prioritize physical anchors**: both the
  long-term and session extraction prompts have been updated to treat physical
  traits (appearance, scars, injuries, distinctive features, location layout,
  notable objects) as first-class captures rather than skipping them as
  transient. The long-term prompt adds physical traits to the prioritization
  block with a note that they anchor the continuity checker. The session prompt
  narrows its skip rule to genuinely transient state (wet sleeve, spilled food)
  and adds a positive `DO capture` directive for persistent physical anchors.

- **index.js split into three modules**: the 5000-line monolith has been split
  into `ui.js` (display and render functions), `settings.js` (default values,
  settings migration, and UI binding), and a trimmed `index.js` retaining only
  state variables, event handlers, and the jQuery init block. No behaviour
  changes; import graph is strictly one-way with no circular dependencies.

- **Memory graph pauses rendering when idle**: the force simulation render loop
  previously ran at 60 fps continuously while the graph overlay was open,
  regardless of whether anything was moving. The loop now stops once the
  simulation has settled and no interaction is in progress, resuming only when
  needed - hover entering a node, selection click, scroll zoom, filter toggle,
  or reset. This eliminates idle GPU usage on battery-powered machines.

- **Wrong import source for `loadArcSummaries` in `ui.js`**: the refactor
  accidentally imported `loadArcSummaries` from `canon.js` instead of
  `arcs.js`, causing a module load error on startup.

- **Top token bar not updating when switching group characters**: the bar
  stayed frozen at whoever last responded because the group character selector
  change handler did not call `maybeInjectUnified` after re-injecting
  character-specific tiers. In unified injection mode `updateTokenDisplay`
  reads a cached breakdown that is only refreshed by `injectUnified`, so the
  bar reflected stale data until the next message.

- **Entity merge and delete not persisting registry changes**: `persistAndRefresh`
  reloaded fresh copies from storage before saving, silently discarding the
  in-memory mutations made by `mergeEntitiesByName` and `deleteEntityById`.
  Both handlers now explicitly save the mutated registries and memory arrays to
  storage before `persistAndRefresh` runs.

- **Entity merge failing for same-name entities**: `mergeEntitiesByName`
  returned early when source and target names matched case-insensitively,
  blocking valid merges between two distinct entities that share a name but
  have different types (e.g. two "Whisperwood" entries - one Unknown, one
  Place). A new `mergeEntitiesById` function bypasses name lookup entirely and
  calls `mergeInRegistry` directly with entity IDs. The merge picker now also
  shows the entity type alongside the name so same-name targets are
  distinguishable.

- **Entity merge silently failing for cross-registry entity pairs**: when the
  source entity lived in the long-term registry and the target lived only in
  the session registry (or vice versa), both `mergeInRegistry` passes returned
  early because neither single registry contained both IDs. `mergeEntitiesById`
  now detects the cross-registry case and handles it by absorbing the source
  entity's name and aliases into the target, rewriting memory refs, and
  removing the source from its registry.

- **Supersession rarely firing for evolved facts**: the extraction prompts told
  the model not to duplicate existing memories but gave no guidance on how to
  express an update. The model would write a fresh positive fact ("Alex and Finn
  are now lovers") with no state-change language, so the supersession detector
  never recognized it as replacing the older entry ("Alex is wary of Finn") and
  both accumulated together. Both the long-term and session extraction prompts
  now include an explicit instruction to use state-change phrasing ("now",
  "no longer", "became", "stopped", etc.) when a known fact has evolved, so the
  supersession detector can retire the outdated entry.

- **Memory lists not sorted by timestamp**: long-term and session memory lists
  in the Entity Registry panel displayed memories in insertion order (roughly
  extraction time), which did not reflect story chronology and appeared random
  when multiple extractions ran close together. Both lists now sort by the `ts`
  field ascending before rendering.

- **Short-term Extraction and Injection section headers visible in simple mode**:
  two `<p class="sm-section-title">` headers in the Short-term Memory section
  were missing the `sm-advanced-only` class, so they remained visible in simple
  mode even though all their sibling controls were correctly hidden. Both headers
  now carry `sm-advanced-only` and hide with the rest of the advanced controls.

- **Profile B-only controls in Continuity Checker had no visible indication**:
  the "Auto-check after each response" and "Auto-repair contradictions" checkboxes
  were grayed out and non-interactive on Profile A but carried no label explaining
  why. The "Also regenerate profiles every N messages" slider in the Profiles
  section had the same issue. All three now display a small inline "Profile B"
  badge so users immediately understand the controls are gated to the hosted
  profile, without needing to hover the tooltip.

## [1.5.1] - 2026-04-24

### Fixed

- **Arc summaries stored without source backlinks**: resolved arcs were saved
  with empty `source_scene_ids` and `source_memory_ids` arrays even though
  the scene timestamps and memory ids were already computed for the prompt
  context. These fields are now populated so future traceability features
  have correct backlinks to the scenes and memories the arc drew from.
- **Canon token-budget trim ignored when no sentence boundary found**: the
  trim loop broke immediately on canon text with no period (e.g. bullet-only
  output), silently returning over-budget content. A proportional character-
  count fallback now applies when no period is found.
- **Profiles trim loop could leave partial sections**: the budget trim in
  profile injection used string replacement, which could leave a partial
  section in place if the same text appeared more than once. Trimming now
  rebuilds the text from a filtered sections array.
- **Profile schema not migrated before group chat reads on load**: the
  selected character's data container was read (for injection and UI) before
  any migration ran in the group chat load path. The selected character is
  now migrated immediately after the group selector is populated, consistent
  with the solo path.
- **Migration guard did not detect in-place mutations on nested objects**: the
  non-destructive assertion used a shallow reference snapshot, so a step that
  mutated a nested array in place would pass undetected. A `structuredClone`
  deep snapshot is now taken before each step.
- **AI scene break detection silently swallowed errors**: a model failure was
  indistinguishable from a clean "not a scene break" result with no log entry.
  Errors are now logged before returning false.
- **Continuity repair save promises not observed**: `injectRepair` and
  `clearRepair` called `saveMetadata()` without handling the returned promise.
  Unhandled rejections are now caught and logged.
- **Recap overlay persisting across chat switches**: switching to a different
  chat while the "Previously on..." modal was still open left it blocking the
  input area until the next AI response dismissed it. The overlay is now
  removed immediately when a chat switch begins.
- **Recap from wrong chat appearing after rapid switch**: if the user switched
  chats before a slow recap generation finished, the completed recap could
  appear over the new chat. A load-identity check now discards the result if
  the chat changed while generation was in progress.
- **Continuity repair not replayed in group chats**: a pending repair note
  stored in chatMetadata was never re-injected when returning to a group chat,
  leaving the repair slot empty until the next manual continuity check. The
  group chat load path now calls `loadAndInjectRepair` alongside the other
  restore steps.
- **Migration v3 crash on pre-1.5.0 chats with profiles**: the schema migration
  that restructures profiles from a flat object to a per-character map threw an
  assertion error when the old flat key was deleted, causing Smart Memory to
  silently fail to initialise on any chat that had profiles generated before
  v1.5.0. The migration runner now supports declared deletions for steps that
  intentionally drop regenerable cache.
- **Canon auto-regeneration firing on every extraction pass**: on Profile B,
  canon was regenerated once per extraction batch whenever the chat had two or
  more arc summaries - not only when a new arc resolved. Canon now regenerates
  only when the arc summary count increases during an extraction pass. Also
  fixes a group chat ordering bug where the canon check ran before arc
  extraction and could never react to an arc closing in the current round.

## [1.5.0] - 2026-04-24

### Added

- **Continuity auto-check toggle**: new checkbox in the Continuity Checker section
  to disable the automatic check that Profile B runs after every response. Previously
  the only way to stop it was to switch to Profile A entirely. The toggle defaults to
  on so existing behaviour is unchanged.
- **Group chat per-character extraction window (Phase 2)**: long-term extraction
  now filters the message window to each character's own messages plus user
  messages before calling the extraction model. Previously all characters in a
  round received the same unfiltered window, relying solely on the prompt
  instruction to limit scope. The raw window is also scaled by character count
  so each character still gets roughly 20 messages of context after filtering.
- **Canon gets its own injection slot**: canon is now injected via a dedicated
  `smart_memory_canon` slot instead of overwriting the short-term summary slot.
  Both tiers coexist independently - the rolling summary covers recent events
  while canon covers the broader character history. A new Canon section in the
  settings panel provides an editable textarea, injection budget, template, and
  position controls. Canon requires at least one resolved arc summary (previously
  two) and is available as soon as the first arc closes. On Profile B, auto-canon
  also triggers after the first arc summary rather than the second.

### Fixed

- **Spurious recap on chat switch**: switching away from a chat and back within
  the recap threshold could trigger the recap popup again. `updateLastActive` was
  using a debounced metadata save, so the updated timestamp sometimes did not
  reach disk before the switch. Changed to an immediate save so the "I was here"
  timestamp always persists before the user can leave.
- **"No character loaded" when clicking buttons after switching group chats**: ST
  fires both `CHAT_CHANGED` and `CHAT_LOADED` when switching chats, which could
  cause a second `onChatChangedImpl` run to reset `selectedGroupCharacter` to null
  while the selector DOM still showed a character. Any button click during the
  brief async window before `updateGroupCharSelector` re-set the value would
  produce "No character loaded". `getSelectedCharacterName` now falls back to the
  DOM selector value in group chats when the module variable is temporarily null.
- **Character and World profiles are now per-character in group chats**: profiles
  were previously stored in a single chat-wide slot, so in group chats each
  generation pass overwrote the previous character's profile. Profiles are now
  keyed by character name in `chatMetadata`. Switching the character selector in
  the settings panel immediately shows the correct character's profile, and each
  group member's profile is injected independently when they draft a response.
  Existing chats with the old flat profile structure are automatically migrated
  (the old entry is dropped and regenerated on the next extraction pass).
- **Group chat token display correct on initial load**: opening a group chat no
  longer shows the wrong character's token bars. The root cause was that
  `onGroupMemberDrafted` called `updateTokenDisplay()` after swapping injection
  slots to the generating character (including the Expressions extension's quiet
  generate that fires automatically on chat open). The token display is now only
  updated at the end of `onGroupWrapperFinished`, after injection slots are
  restored to the selected character.
- **Group chat long-term extraction now fires with correct character list**: the
  Expressions extension fires a quiet generate after every real round, which goes
  through the full group wrapper event chain. `GROUP_WRAPPER_STARTED` was clearing
  `respondedThisRound` for those quiet rounds, erasing the real round's participant
  list before extraction could loop over it. `GROUP_WRAPPER_FINISHED` was also
  incrementing the extraction counter for quiet rounds, so the counter could reach
  the threshold from inside a quiet wrapper when the participant set was already
  empty. Both handlers now check the event `type` and return immediately for
  `type === 'quiet'`, keeping the counter and participant tracking in sync with
  actual story progress.

## [1.4.0] - 2026-04-20

### Added

- **Graph schema foundation**: every memory (long-term and session) now carries a
  full set of graph fields alongside the existing content fields. New fields:
  `id` (stable UUID), `source_messages` (chat message ids that evidence the
  memory), `entities` (entity ids referenced), `time_scope` (scene/session/arc/global),
  `valid_from` / `valid_to` (message indices marking when the memory became and
  stopped being true), `supersedes` / `superseded_by` (links to replaced and
  replacement memories), and `contradicts` (ids of unresolved conflicting memories).
  These fields are the foundation for supersession tracking, entity linking, hybrid
  retrieval, and the timeline view - none of that logic is active yet, but the
  schema is in place for all of it.
- **Entity registry storage**: two entity registries introduced following the schema
  from the memory graph design. Persistent entities live in
  `extension_settings.smart_memory.characters[name].entities`; session-scoped
  entities live in `chatMetadata.smartMemory.entities`. Both are initialised as
  empty arrays during migration and managed via helpers in `graph-migration.js`.
- **graph-migration.js**: new module owning the migration pass and entity registry
  CRUD. `runGraphMigration()` is version-gated (`graph_schema_version` in
  extension_settings) and runs once on the first chat load after upgrade. It
  backfills all graph fields on existing memories non-destructively, initialises
  entity registries, and writes the version marker. Subsequent loads are a fast
  no-op.

- **Entity extraction**: the long-term and session extraction prompts now instruct
  the model to tag memories with an optional `:entity=Name1,Name2` field inside the
  bracket. Named characters, places, and objects encountered in chat are recorded in
  a per-character entity registry (extension_settings) and a per-session entity
  registry (chatMetadata). Each memory's `entities` field is populated with the
  stable ids of the entities it references. The normalizer uses case-insensitive
  exact matching against canonical names and recorded aliases, so variant spellings
  seen across sessions collapse to the same entity over time.
- **Entity-resilient tag parser**: `parseExtractionOutput` and `parseSessionOutput`
  now capture all bracket modifiers as a single string and extract score, expiration,
  and entity names independently. This is resilient to local models reordering
  optional fields rather than failing silently when the order doesn't match a fixed
  regex pattern.

- **Supersession detection**: when a new memory candidate describes a state
  change on the same topic as an existing memory ("no longer", "moved to",
  "became", etc.) rather than just paraphrasing it, the old memory is now
  retired rather than treating the new one as a duplicate. Retired memories
  are kept in storage for history but excluded from injection and extraction
  context. The superseding memory records which old entry it replaced via
  `supersedes` / `superseded_by` links.

- **Character and world profiles**: a new `profiles.js` module generates
  compact state snapshots (character goals and emotional state, world context,
  relationship matrix) from stored memories in a single model call after each
  extraction pass. Profiles are stored in `chatMetadata` and injected via a
  dedicated slot. Stale profiles are regenerated non-blocking on chat load.
  The settings panel includes an enable/disable toggle, a staleness threshold
  slider, a manual "Regenerate Profiles Now" button, and a read-only display
  of the current profiles.

- **Supersession indicators in UI**: retired memories are hidden by default in both
  the session and long-term memory lists. A "Show retired memories" toggle reveals
  them. Each retired entry shows a "retired" badge and a "→ superseded by" link
  that scrolls to and highlights the replacement memory. The edit button is hidden
  for retired entries (delete still permitted for manual cleanup).
- **Contradiction warning badges**: memories with unresolved `contradicts` links now
  show a yellow warning indicator with a tooltip directing the user to run the
  continuity checker. Applies to both session and long-term memory lists.
- **Entity registry panel**: a new collapsible "Entity Registry" section in the
  settings panel lists all extracted entities (character, place, object, faction,
  concept) with type badges, memory counts, and last-seen message index. Combined
  from both the long-term (extension_settings) and session (chatMetadata) registries.
- **Per-entity timeline view**: clicking the timeline button on any entity row opens
  a CSS-only vertical timeline of memories involving that entity, ordered by
  `valid_from`, with retired entries shown in muted style. The timeline toggles - a
  second click collapses it.
- **Hardware profile override setting**: a new "Hardware profile" select lets users
  override the auto-detected profile. Auto-detection uses the configured memory
  source: Ollama or WebLLM select Profile A (minimal model calls, heuristic-only
  retrieval signals); Main API or OpenAI Compatible select Profile B (richer
  extraction, all retrieval signals active). A descriptive label shows the active
  profile and updates when the source changes.
- **Three-layer summarization**:
  - Layer 1: each scene entry now carries `source_memory_ids`. After session
    extraction, newly-created memory ids are linked to the most recent scene via
    `linkMemoriesToLastScene()` in `scenes.js`.
  - Layer 2: when arc extraction marks an arc as resolved, `generateArcSummary()`
    is called before removing the arc. It generates a 3-5 sentence narrative
    paragraph from the arc content, recent scene summaries, and linked session
    memories. Arc summaries are stored in `chatMetadata.arcSummaries` with
    `source_scene_ids` and `source_memory_ids` fields for layer 3 use.
  - Layer 3: a new `canon.js` module generates a stable per-character narrative
    document (who they are, what has happened, current state) from resolved arc
    summaries and high-importance long-term memories. Canon is stored in
    `extension_settings` and persists across sessions. It injects via its own
    dedicated slot (`smart_memory_canon`) so it coexists with the short-term
    summary rather than replacing it. A dedicated Canon section in the settings
    panel provides an editable textarea, injection budget, template, and position
    controls. Requires at least one resolved arc summary. Manual trigger only on
    local hardware.

- **Model-classified entity types**: the extraction prompt now asks the model to
  classify each extracted entity as `character`, `place`, `object`, `faction`, or
  `concept` using a `Name/type` inline format (e.g. `entity=Alex/character,Kael/character`).
  The keyword-heuristic approach that tried to guess type from a word list has been
  removed entirely - it could not handle invented names or novel RP settings. Type
  badges in the entity panel now reflect the model's classification rather than a
  best-guess fallback.
- **Embedding model used for consolidation and arc relevance**: `reconcileTypeEntries`
  (consolidation overlap) and `hybridPrioritize` (arc relevance scoring) now call the
  embedding model for semantic similarity where previously Jaccard word-overlap was
  used. Jaccard remains the fallback when embeddings are unavailable. The embedding
  model is tiny enough to run on CPU and does not compete with the main model for VRAM.
- **Profile B behavioral gates**: `batchVerify` deduplication thresholds are now
  profile-dependent. Profile B (hosted models) uses higher duplicate floors
  (0.85 / 0.91 semantic, 0.68 / 0.78 Jaccard) so nuanced memories from powerful
  models are less likely to be incorrectly rejected, and a lower same-topic threshold
  (0.52 / 0.38) to catch more supersession candidates. Profile B also auto-regenerates
  the canon summary after each arc extraction pass when at least one arc summary
  exists - no manual button needed.
- **Profile settings controls**: the Character and World Profiles section in the
  settings panel now includes a live token count showing how many tokens the current
  profiles are injecting, a budget slider, and injection position/depth/role controls.
- **Profiles added to Memorize Chat flow**: after Memorize Chat completes, character
  and world profiles are regenerated and injected so they immediately reflect the
  memories just built.
- **Diversity floor in hybrid retrieval**: `hybridPrioritize` now applies a
  post-sort promotion pass that moves the best entry of each required type to the
  front of the output, regardless of its raw hybrid score. Without this, a cluster
  of high-scoring entries of the same type could dominate the injected list and push
  critical types to the bottom where the model treats them as lower priority. Floor
  types: long-term uses `relationship` + `fact`; session uses `development` + `scene`.
- **Hybrid retrieval scoring**: memory injection now ranks memories by a
  weighted blend of four signals: utility score (existing importance/durability
  composite), entity overlap (fraction of memory's entities mentioned in the
  current turn), arc relevance (Jaccard overlap with open arc content), and
  temporal proximity (how closely the memory's time scope matches the current
  moment). Entity names are extracted from the last 1-2 messages via lightweight
  regex with no model call. The scorer runs on real AI response turns; plain
  priority ordering is used on chat load where there is no current turn to read
  from. Semantic similarity via embeddings is noted as a future enhancement.
- **Adaptive token budget allocation per turn type**: `classifyTurn` uses
  lightweight regex on the last AI message to classify the current turn as
  dialogue, action, transition, or intimate. `adaptiveBudgets` then shifts
  token budgets across tiers using per-type multipliers - for example, dialogue
  boosts long-term and profiles while reducing scenes; action boosts session and
  scenes; intimate boosts session and profiles while reducing arcs. Total budget
  is preserved - if adjusted totals exceed the base, all tiers are scaled down
  proportionally. Budgets are patched for the extraction/injection pass then
  restored to user-configured values in a finally block.
- **Retrieval and budget unit tests**: targeted Jest tests for `hybridScore`,
  `hybridPrioritize`, `applyBudgetMultipliers`, `classifyTurn`, and
  `reconcileTypeEntries` in `memory-utils.js`. These cover the retrieval signal
  weighting and adaptive budget logic to guard against regressions.
- **Entity type editing**: clicking any entity's type badge in the entity panel opens
  an inline picker listing all six types (character, place, object, faction, concept,
  unknown). Selecting one updates the entity in both the long-term and session
  registries immediately.
- **Entity merge**: each entity row now has a merge button. Clicking it opens a
  dropdown of all other entity names; selecting a target merges the source into it.
  The source's canonical name and aliases become permanent aliases on the target, so
  future extractions that mention the source name (e.g. "Rod") automatically resolve
  to the merged entity (e.g. "Roderick") without any further manual action.
- **Character card seeding**: on every chat load and character change, the active
  character's name is pre-populated in the long-term entity registry if not already
  present. The main character now benefits from entity overlap scoring from the first
  message rather than only appearing after the extraction model first tags them.
- **Entity delete**: each entity row in the entity panel now has a trash button.
  Clicking it removes the entity from both the long-term and session registries and
  scrubs its id from all memory entities arrays. Useful for cleaning up noise entries
  (generic nouns the model tagged against instructions) without having to wipe the
  whole registry.
- **Entity registry and profile lifecycle**: Forget This Chat clears the session
  entity registry and character/world profiles. Fresh Start clears profiles from
  both the UI and the token injection slot. The session entity registry is also
  cleared on chat clear and after Memorize Chat runs to prevent stale ids
  accumulating across rebuilds.
- **Entity panel merges registries by canonical name**: the entity panel combines
  long-term and session registries by canonical name (case-insensitive) rather than
  by UUID. Because the two registries are independent stores, the same entity could
  have different UUIDs in each. Merging by name produces one row per real entity
  with combined `memory_ids` from both registries so the timeline is complete.
- **Entity registry reconciliation and orphan pruning**: session consolidation now
  calls `reconcileEntityRegistry` after compaction, matching the long-term path.
  `reconcileEntityRegistry` also prunes entities whose `memory_ids` array is empty
  after reconciliation - these arise from priority eviction or the pronoun edge case
  and contribute nothing to retrieval or the panel.
- **w5 turn-similarity signal in hybrid retrieval**: `hybridScore` now includes a fifth
  signal - cosine similarity between the memory content and the last AI turn text. Memories
  that closely match the current topic score higher and surface first in injection. The weight
  is profile-dependent: `w5 = 0.2` on Profile A (local), `w5 = 0.6` on Profile B (hosted).
  The turn text is embedded in the same batch call already used for arc relevance, so there
  is no extra API round-trip. Callers pass `lastTurnText` and `w5` in the `hybridPrioritize`
  context; `w5 = 0` (the default) disables the signal entirely, making the change
  backward-compatible for any caller that does not provide it.
- **Profile B auto-continuity check**: on Profile B (hosted models), the continuity
  checker now runs automatically after every AI turn without requiring a button click.
  A badge in the settings panel header shows the result: "clean" (fades after 4 s)
  or "N conflicts" (stays visible until the next check). If **Auto-repair
  contradictions** is enabled and issues are found, a repair note is queued for the
  next AI response exactly as the manual path does. Runs fire-and-forget so it does
  not delay the event handler. Profile A (local hardware) is unaffected - manual-only
  as before.
- **Scheduled profile regeneration (Profile B)**: a new "Also regenerate every N
  messages" slider in the Profiles section lets Profile B users keep profiles fresh
  between extraction passes. Set to a positive value (e.g. 5) to regenerate profiles
  every N AI messages even when extraction has not fired. 0 (default) retains the
  existing behaviour: profiles only regenerate on extraction passes and on chat load
  when stale. Fire-and-forget - does not block the event handler. Profile A is
  unaffected (profiles already regenerate on each extraction pass there).

- **`/sm-search` slash command**: search all active memories (long-term and session)
  by semantic similarity. Type `/sm-search the ritual` in the chat input and a popup
  shows the top matching memories with tier labels (long-term / session), type badges,
  content, and a similarity percentage. The optional named argument `k` controls the
  result count (`/sm-search k=20 the ritual`; default 10, max 50). Embeddings are
  used when available; Jaccard word-overlap is the fallback so the command works even
  without an embedding model configured.
- **Verbose logging setting**: a new "Verbose logging" checkbox in the Developer
  section of the settings panel gates all operational extraction, consolidation,
  migration, and scene detection progress messages. When off (default), only errors
  (`console.error`) appear in the browser console. When on, the full `[SmartMemory]`
  log stream is visible - useful for debugging extraction quality or migration issues.

- **Per-memory confidence decay**: memories that are not re-extracted over successive
  passes gradually lose confidence while memories that keep appearing in new text are
  reinforced. Each extraction pass `batchVerify` now returns a `confirmed` set
  containing the ids of existing memories whose content was re-extracted as a near-
  duplicate candidate - indicating the model still sees that fact as true. Confirmed
  memories receive a +0.05 confidence boost (capped at 1.0) and their unconfirmed
  counter resets to zero. Non-confirmed active memories increment an `unconfirmed_since`
  counter; once it reaches 10 consecutive unconfirmed passes the memory's confidence
  decays by 0.02 per pass down to a floor of 0.3. `memoryUtilityScore` already uses
  confidence as a factor (max 25 points), so decayed memories naturally sort lower
  and are evicted first by `trimByPriority` when the memory cap is reached - without
  needing an explicit retire step. Importance is never decayed: memories judged
  important due to narrative intensity remain so regardless of how long ago they
  occurred. Both `confidence` and `unconfirmed_since` are new graph fields defaulted
  to `1.0` / `0` in `applyGraphDefaults` and backfilled via schema migration v2.

### Fixed

- **Embedding failure is now surfaced to the user**: when the embedding API call
  fails (model unreachable, wrong URL, Ollama not running), a one-shot toastr
  warning is shown so the user knows deduplication is falling back to keyword
  matching. Previously the error was silently swallowed and the only symptom was
  reduced deduplication quality.

- **Arc deduplication on extraction**: each extraction pass now compares new arc candidates
  against existing arcs using Jaccard word-overlap (threshold 0.4). Candidates that are
  semantically near-identical to an existing arc are dropped rather than appended. A cleanup
  pass also runs on the stored arc list itself each extraction cycle, so duplicates that
  accumulated before this fix are removed on the next extraction. Previously the same story
  thread (e.g. an unresolved promise) could appear three or more times with slightly different
  phrasing because the model re-extracted it each pass.
- **Arc injection budget default raised from 400 to 700 tokens**: the adaptive budget applies
  a 0.8x multiplier to arcs during intimate scenes, bringing a 600 token budget down to 480.
  With 10 verbose arcs totalling ~530 tokens, this caused the oldest arc to be silently
  excluded from injection. 700 tokens (effective 560 at 0.8x) provides sufficient headroom.
  Existing installs with the old default (200 or 400) are migrated automatically on load.

- **Adaptive budget values persisted to disk during extraction**: `saveSettingsDebounced`
  was called inside the extraction try block while the per-turn-type multipliers were still
  patched into `settings`. Ollama LLM calls take several seconds - well past the 1000 ms
  debounce delay - so the debounce fired and wrote the temporary adapted values to disk as
  if they were user-configured. On the next chat load the user-set budgets were gone. The
  call is now in the finally block after the originals are restored via `Object.assign`,
  so only the user-configured values are ever persisted.

- **Recap popup clipped off the top of the screen on mobile**: the overlay used
  `align-items: center`, which centers the card relative to the full CSS viewport
  height. On mobile, browser chrome (address bar, navigation bar) reduces the
  visible area below what `100vh` reports, so a centered card overflows upward and
  the top is unreachable. The overlay is now `align-items: flex-start` with
  `overflow-y: auto` and `padding: 16px`. The card uses `margin: auto` to center
  itself when it fits, and falls back to top-aligned with overlay scrolling when it
  does not - making the full popup reachable on all screen sizes.

### Changed

- **Recap modal styling moved to `style.css`**: the away recap overlay, card, and
  content elements previously used jQuery inline `.css({...})` calls (~50 lines of
  JS-embedded styling). All styles are now in CSS classes in `style.css`, consistent
  with the rest of the extension's UI components. No visual change.

- **`getHardwareProfile()` hoisted out of inner verification loop**: the profile
  lookup was called once per `(candidate, existing)` pair inside `batchVerify`.
  The profile cannot change mid-pass, so it is now computed once above the outer
  loop. In large-chat catch-up with many candidates and existing memories, this
  eliminates proportional redundant lookups.

- **`similarity.js` extracted from `embeddings.js`**: `cosineSimilarity`, `jaccardSimilarity`,
  `STATE_CHANGE_PATTERNS`, and `hasStateChangeMarker` moved to a new file with no SillyTavern
  runtime dependencies. `reconcileTypeEntries` and `hybridPrioritize` in `memory-utils.js`
  now accept an optional `embedFn` parameter instead of importing `getEmbeddingBatch` directly.
  No behaviour change at runtime; the `memory-utils.test.js` suite now runs fully under
  `node --test` (previously blocked by the ST import chain).

- **Per-container schema versioning replaces global migration flag**: each data
  container (per-character store, per-chat block) now carries its own
  `schema_version` field. Previously a single global `graph_schema_version` flag
  tracked whether migration had run at all, making it impossible to tell whether
  any specific container was at the current schema and leaving no path for
  incremental future migrations. Migration steps are registered by version number
  in `CHARACTER_MIGRATIONS` and `CHAT_MIGRATIONS` maps in `graph-migration.js`.
  The runner applies all steps from `(stored_version + 1)` through
  `SCHEMA_VERSION` in order. Adding a future migration requires only incrementing
  `SCHEMA_VERSION` and adding a numbered entry to the relevant map.
- **Consistent red tint on all destructive action buttons**: delete buttons in
  the long-term memory list, session memory list, story arcs list, and entity
  registry now all share the same `#c06060` colour fading to `#e07070` on hover,
  with `opacity: 0.6` at rest. Previously the entity delete was red while all
  others had no colour.
- **Unknown default type for unclassified entities**: new entities whose type the
  model did not classify now receive type `unknown` (grey badge with `?` icon)
  instead of `character`. This makes extraction noise visible at a glance rather
  than hiding it behind a plausible-looking label. Type has no effect on retrieval
  scoring - only the entity name matters for overlap detection.
- **Extraction prompt tightened to exclude generic nouns**: both the long-term and
  session extraction prompts now explicitly instruct the model to tag only
  named/proper entities, not generic nouns (whiskey, sword, horse). Named examples
  (Jack Daniel's, Excalibur, Shadowmere) clarify the intended boundary. Reduces
  noise entries in the entity registry from local models that over-tag.
- **Entity links survive consolidation when content uses pronouns**: after a
  consolidation pass, the merged memory may use "she" or "he" instead of an
  entity's name. `reconcileTypeEntries` now carries the base entry's `entities`
  array forward into the promoted entry, and `reconcileEntityRegistry` pass 2
  checks `mem.entities.includes(entity.id)` alongside content substring matching,
  so the registry re-links by direct ID rather than guessing from text.
- **Compaction prompt no longer uses analysis scaffolding**: the `<analysis>` block with
  its `[Your analysis ensuring all sections are covered accurately]` placeholder has been
  removed. Models ignored the XML tags and wrote inline bracketed prose that leaked into
  the stored summary. The prompt now asks for the summary directly inside `<summary>` tags
  with the nine section headings as the output template. The update prompt's
  `[Updated summary here]` placeholder is replaced with the section skeleton for the same
  reason.
- **formatSummary strips preamble before numbered sections as a last resort**: if the model
  omits XML tags entirely, the parser now strips any content before the first `1.` at the
  start of a line rather than returning the raw string including the preamble.
- **Scene break AI detection reworked with prior context and clearer rules**: the detection
  prompt now receives the preceding AI message alongside the current one so the model can
  distinguish a continuation from a genuine transition. The prompt also explicitly lists
  what counts as a new scene (time passage, location change, hard narrative break such as
  portal or loss of consciousness) and what does not (combat or drama in the same continuous
  moment, emotional beats within the same encounter). Previously the model was given a single
  message with no context, causing it to answer YES to dramatic action sequences that were
  part of an ongoing scene and NO to dawn/intimacy transitions it could not recognise without
  knowing what came before.
- **Scene break heuristic now detects dawn/sleep/wake transitions**: added two new pattern
  groups - dawn/dusk (`as dawn broke`, `as night fell`, etc.) and sleep/wake (`woke to find`,
  `stirred from sleep`, etc.). Previously only time skips and location arrivals were caught,
  so transitions into intimate or rest scenes were never detected as scene breaks.
- **Scene deduplication on storage**: before appending a new scene summary, the Jaccard
  similarity between the new summary and the most recent stored scene is checked (threshold
  0.5). If they describe the same event in different words the new entry is dropped. Prevents
  multiple near-identical entries accumulating when the heuristic fires more than once during
  the same narrative event.
- **Consolidation prompts use concrete examples instead of template lines**: both the
  long-term and session consolidation prompts previously used format illustration lines
  like `[fact:2:permanent] The memory entry here.` as output examples. Models copied
  these literally into their output, injecting placeholder text into memories and session
  context on every consolidation pass. Replaced with fictional named examples that cannot
  be mistaken for valid output to copy.
- **Arc extraction output format uses concrete examples instead of template lines**:
  the output format description previously used lines like
  `- [arc] A newly introduced unresolved thread not already in the existing arcs above.`
  as format illustrations. Models copied these literally into their output, producing two
  identical placeholder entries on every extraction pass. The format section now uses
  fictional named examples (`[arc] Mira swore revenge...`) that cannot be mistaken for
  valid output to copy.
- **Arc extraction prompt restructured to prevent false resolves and annotation errors**:
  the existing arcs section is now labelled "read-only context - do not copy, annotate,
  or re-output these" to prevent the model from annotating existing entries inline instead
  of producing its own output list. Output instructions now explicitly name two line types
  ([arc] for new threads, [resolved] for explicitly closed ones) with a clear rule that a
  related revelation does not count as a resolution. Previously the model would mark arcs
  resolved based on thematic inference rather than explicit closure in the conversation.
- **Consolidation prompt rewritten as a step-by-step decision tree**: both the
  long-term and session consolidation prompts now guide the model through an
  explicit four-step process (find closest match, drop if no new information,
  merge if same subject with new detail, keep as new if no match). The previous
  free-form DUPLICATE/UPDATE/NEW labels were ambiguous enough that models
  consistently treated all entries as NEW rather than merging or dropping. The
  new wording also adds a concrete SAME SUBJECT example to prevent the ranger/ranger
  false-NEW pattern. Verified improvement on both long-term and session consolidation
  tasks.
- **Apostrophe normalization in entity lookup**: `findEntityByName` now normalises
  typographic apostrophes (U+2019) and modifier letter apostrophes (U+02BC) to plain
  ASCII before comparison. Previously "Jack Daniel's" (typographic) and "Jack Daniel's"
  (ASCII) were treated as different names, silently creating a duplicate entity instead
  of matching the existing one.
- **Memory save no longer clobbers entity registry**: `saveCharacterMemories` now
  spreads the existing character object before writing the memories array, so the
  entity registry and any future per-character fields stored alongside memories are
  preserved across saves.
- **Extraction cap is now profile-dependent**: the per-type extraction cap in
  `longterm.js` was previously hardcoded at 2 entries per type per pass for all
  users. It is now 4 on Profile B (hosted models) and 2 on Profile A (local
  hardware). Profile B models rarely over-fire on a single type, so the higher cap
  lets them produce more diverse memories in a single pass without throttling.
- **Migration non-destructiveness structurally enforced**: `applyMigrations` in
  `graph-migration.js` now calls `assertNonDestructive` after each step runs.
  The helper recursively verifies that no pre-existing field was deleted or
  overwritten by the step; it throws with a descriptive path if any violation is
  detected. This enforces the CLAUDE.md rule ("steps must be non-destructive -
  never delete or overwrite existing field values, only add missing ones")
  structurally rather than relying solely on code review.

---

## [1.3.0] - 2026-04-12

### Fixed

- **Summary context overflow**: when using Ollama or an OpenAI-compatible source,
  the summarization path sent the entire chat history as prior messages regardless
  of length. On a long RP this easily overflows a local model's context window,
  producing garbled or repetitive summaries. Prior messages are now trimmed to the
  most recent content that fits within 60% of the configured context size, keeping
  the recent tail that short-term memory is actually meant to capture.
- **Catch-up context overflow**: catch-up chunked by message count (20 messages)
  regardless of message length. Long AI responses in active roleplays easily pushed
  a single chunk past a local model's context window, causing incoherent or
  repetitive extraction output. Chunks are now built by token budget (35% of the
  configured context size) with the message count as a hard cap, so each chunk
  fits comfortably within the available context once prompt overhead is added.
  The budget scales automatically with the user's context size setting.
- **Scene and recap output pollution**: the scene summary and away recap prompts
  were missing a closing directive, allowing some models to append notes or
  disclaimers after the requested text. Both prompts now explicitly instruct the
  model to output only the summary text with no commentary.
- **Compaction firing every turn**: once a chat exceeded the configured threshold,
  compaction was re-triggered on every single AI response because the total chat
  token count always remained above the percentage (compaction summarizes but does
  not delete messages). The threshold now measures only the unsummarized portion of
  the chat (messages after `summaryEnd`) so the trigger resets after each compaction
  and only fires again once enough new content has accumulated.

### Added

- **Inline memory editing**: every long-term memory, session memory, and story arc
  entry now has a pencil button. Clicking it replaces the text in-place with an
  editable textarea and swaps the action buttons with Save and Cancel. Useful for
  correcting drift or fixing an extraction error without needing to delete and
  re-add the entry.
- **Manual memory insertion**: an Add form sits below each scrollable list (long-term
  memories, session memories, story arcs). For typed tiers (long-term and session) a
  custom color-coded type picker lets you choose the entry type before adding. The
  picker shows each type in its badge color - both in the closed state and in the
  open list - with a lighter hover tint per option.
- **Swipe/compaction abort**: Smart Memory now listens for the `MESSAGE_SWIPED` event
  and immediately cancels any in-flight Ollama or OpenAI-compatible memory generation
  via `AbortController`. This prevents swipe requests from queuing behind an ongoing
  memory extraction and being rejected by ST while the memory model is busy.
- **Continuity auto-repair**: the continuity checker now has an optional
  auto-repair mode. When enabled and contradictions are found, a second model
  call generates a brief corrective note that is automatically injected into the
  next AI response turn and then cleared. Disabled by default.
- **Token bar readability**: the Scenes segment color changed from teal-green to
  amber so it is clearly distinct from the adjacent Short-term green segment.
- **Compaction toast**: when using an external LLM source (Ollama or OpenAI-compat),
  a persistent "Updating story summary..." toast is shown while compaction runs and
  dismissed when it completes. Main-API compaction is silent as before since it uses
  ST's built-in quiet prompt which already has its own indicator.

## [1.2.1] - 2026-04-09

### Added

- **parsers.js**: all pure parsing and formatting functions extracted into a
  standalone module with no SillyTavern runtime dependencies, making them fully
  unit-testable without mocking the ST context.
- **47 unit tests** in `tests/parsers.test.js` covering `parseExtractionOutput`,
  `parseSessionOutput`, `parseArcOutput`, `parseContradictions`, `formatSummary`,
  and `detectSceneBreakHeuristic` - including boundary cases, format variations,
  Jaccard threshold values, XML tag edge cases, and scene break heuristics.
- **MESSAGE_DELETED handler**: when a chat message is deleted, the scene message
  buffer is filtered to remove any reference to that message and
  `sceneBufferLastIndex` is clamped to the new chat length. Without this, deleted
  messages could linger in the buffer and appear in the next scene summary.

### Changed

- **Injection depth defaults corrected**: arcs (`1` -> `2`), scenes (`3` -> `6`),
  session (`1` -> `3`) - values now match the documented stacking order in CLAUDE.md.
- **Arc injection budget default** raised from `200` to `400` tokens, matching the
  1.2.0 changelog intent.
- **Compaction response length default** raised from `1500` to `2000` tokens to
  match the actual `defaultSettings` value.
- **Summary template default** no longer wraps text in square brackets
  (`[Story so far: ...]` -> `Story so far: ...`).
- **Extraction windows widened**: session extraction now looks back 40 messages,
  long-term 20 (was `extractEvery * 2` which equalled 6 at default settings).
- **Arc resolution** switched from a brittle "overlap >= 2 words" count to Jaccard
  word-overlap similarity at a 0.25 threshold - handles paraphrased resolution
  lines and avoids false co-resolution of arcs that happen to share only two words.
- **Cross-tier digest in compaction** is now capped by token budget (400 tokens per
  tier) rather than by entry count, so a few long memories cannot overflow a local
  model's context window.
- **Summary injection truncation** now uses a proportional char-slice based on the
  actual token estimate rather than the `budget * 4` approximation (inaccurate for
  multibyte content), and attempts to break at a sentence boundary.
- **Group chat warning** now tracks `lastWarnedGroupId` instead of a plain boolean
  so the toast fires once per distinct group rather than once per JS lifecycle.

### Fixed

- **Extraction sequencing**: the extraction IIFE is now awaited inside a
  try/finally block so a compaction or scene detection triggered on the next
  message cannot race against an ongoing extraction pass. This is the same
  `TempResponseLength` corruption risk fixed in 1.0.1 and 1.0.2.
- **Extraction counter reset order**: `messagesSinceLastExtraction` is now reset
  only after the stable-window check passes. Previously resetting it before the
  check meant a bail on an empty window delayed the next extraction attempt by a
  full `extractEvery` cycle.
- **Eviction guard in mergeMemories**: a new entry can no longer displace an
  existing entry it actually scores lower than. Previously any new entry at the
  per-type cap would trigger an eviction regardless of relative priority.
- **Embedding threshold mismatch**: `batchVerify` now selects thresholds per pair
  based on whether both vectors are present. When one or both vectors are missing
  the Jaccard fallback path now uses Jaccard thresholds (0.65/0.75) instead of the
  semantic ones (0.82/0.88), which had been causing valid new memories to be
  incorrectly rejected as duplicates.
- **`last_confirmed_ts` legacy default**: changed from `Date.now()` to `0` for
  entries that have neither `last_confirmed_ts` nor `ts`. Entries without measured
  recency no longer receive an artificial boost in `memoryUtilityScore`.
- **Consolidation dirty flag ordering**: `dirty = true` is now set before the
  `unprocessed.forEach` in both catch blocks (longterm.js and session.js) so a
  mid-iteration error on a corrupted entry still triggers a save rather than
  silently losing the partial consolidation state.
- **Continuity checker line filter**: `parseContradictions` no longer silently
  drops contradiction lines shorter than 6 characters. Any non-empty line from the
  model is a valid report.
- **Tooltip DOM leak**: `initTooltips` now removes any existing `#sm-tooltip`
  element before creating a new one, preventing duplicate tooltips when the
  settings panel is re-rendered.
- **Tooltip width clamping**: left position is now clamped using the tooltip's
  actual `offsetWidth` rather than a hardcoded 260 px constant that clipped wider
  tooltips.
- **Ollama model list**: `fetchOllamaModels` now filters out entries with missing
  or non-string names before sorting, preventing downstream errors on malformed API
  responses.
- **Catch-up UI yield**: the catch-up loop now yields to the browser event loop
  via `setTimeout(0)` at the start of each chunk so the cancel button remains
  responsive even when individual model calls complete quickly.
- **`saveCharacterMemories` guard**: returns early if `memories` is not an array,
  preventing `undefined` from being written into `extension_settings` on unexpected
  call sites.
- **`chatMetadata` null guards**: all save paths that write to
  `chatMetadata[META_KEY]` now initialize `chatMetadata` itself if it is
  `null`/`undefined` before accessing the nested key. Affects `saveArcs`,
  `runCompaction`, `setFreshStart`, `updateLastActive`, `saveSceneHistory`,
  `saveSessionMemories`, the summary textarea handler, and both clear-chat handlers
  in `index.js`.
- **sm-extract slash command** now calls `saveSettingsDebounced()` and
  `updateSessionUI()` after extraction so the UI reflects the new state immediately.
- **Recap overlay**: the away recap popup is now dismissed on the first AI response
  after it is shown, rather than persisting until manually closed.
- **`summaryEnd` clamp**: `summaryEnd` is now clamped to the current chat length
  before use. If messages were deleted since the last compaction, a stale
  `summaryEnd` pointing past the end of the array would cause the progressive
  update path to process zero new messages and stall indefinitely.
- **Telemetry persistence**: `saveSettingsDebounced()` is now called immediately
  after the retrieval telemetry write in `injectMemories` (`retrieval_count` and
  `last_confirmed_ts`). Previously these writes were lost if the browser tab
  closed before the next explicit settings save.
- **`memory-utils.js` timestamp inference**: uses `Number.isFinite` to guard
  against non-numeric `ts` values when inferring timestamps for promoted entries.
- **`injectSessionMemories`** is now fully async so telemetry writes complete
  before the function returns.

## [1.2.0] - 2026-04-09

### Added

- **Semantic embedding deduplication**: memory candidates are now compared using
  vector similarity via Ollama's `/api/embed` endpoint instead of word overlap.
  Catches near-paraphrase duplicates that Jaccard misses - e.g. "Finn is
  Senjin's anchor" and "Finn serves as Senjin's emotional foundation" are
  correctly identified as the same fact. Falls back to word-overlap
  automatically when no embedding model is available.
  - New settings panel section: embedding model, URL, and keep-in-memory toggle.
  - Defaults to `nomic-embed-text` - already installed by most users via
    SillyTavern's Vector Storage extension.
  - All candidate and existing memory texts are embedded in a single batch API
    call per verification pass, minimizing model swap overhead on constrained
    hardware.
- **Per-type storage cap**: long-term memory storage is now capped per type
  (derived from `Max memories per character / 4`). At the default of 25, no
  single type can exceed 7 entries. When a new entry would push a type over its
  cap, the lowest-priority existing entry of that type is evicted first. Scales
  automatically when users raise the overall limit.
- **Cross-tier memory awareness**: the short-term summary is now aware of
  long-term and session memory contents and avoids restating facts already
  stored at other tiers. Session extraction skips facts already captured in
  long-term memory.
- **Dedicated memory LLM sources**: Smart Memory can now use a dedicated Ollama
  instance, any OpenAI-compatible API, or the WebLLM extension for memory work,
  keeping the main roleplay model free.
- **Away recap popup**: the away recap is now shown as a dismissible modal popup
  on return rather than silently injected into the AI context.
- Session prompt injection now prepends a compact **Current scene state** block
  synthesized from the latest session memories.
- Second-stage memory candidate verifier filters malformed, low-signal, and
  uncertain entries before persistence.
- Multi-dimensional retention scoring: confidence, persona relevance, intimacy
  relevance, retrieval count, last-confirmed timestamp, keyword frequency, and
  expiration weight (permanent/session/scene) all influence which memories
  survive trimming.
- Protected-slot injection: long-term and session injection reserve slots for
  high-continuity types so they cannot be crowded out by lower-priority entries.
- Retrieval telemetry on injected memories (`retrieval_count`,
  `last_confirmed_ts`) so frequently recalled entries are retained more
  reliably over time.
- Consolidation now uses `reconcileTypeEntries` to replace updated base entries
  in-place rather than appending promoted entries as duplicates.
- Consolidation thresholds are now configurable per type in the settings panel.

### Changed

- "Catch Up - Extract All from Full Chat" button renamed to **Memorize Chat**.
- "Clear Chat Context" button renamed to **Forget This Chat**.
- Per-extraction limit changed from 4 total new entries to 2 per type - prevents
  a burst of similar events from flooding one type in a single pass.
- Arc injection budget raised from 200 to 400 tokens so all tracked arcs fit
  without truncation.
- Long-term and session memory loading now auto-migrates additional metadata
  defaults for legacy entries without breaking existing stores.

### Fixed

- Extraction and compaction no longer fire on swipes - only accepted messages
  are processed.
- All manual extract and clear buttons are blocked while Memorize Chat is
  running to prevent conflicting writes.
- Confirmation required before Memorize Chat when memories already exist, to
  prevent accidental near-duplicate accumulation on repeat runs.
- Scene catch-up now correctly walks all heuristic scene breaks across the full
  chat history instead of only detecting the last scene.
- Consolidation now runs after each catch-up chunk rather than only at the end,
  preventing near-duplicate buildup during long processing passes.
- Stop tokens passed explicitly in Ollama API calls to prevent the memory model
  from continuing into roleplay output.

## [1.1.0] - 2026-04-05

### Features

- Added consolidation to session memory
- Consolidation now works per-type of memory instead of bundling them all together.
- Consolidation thresholds are now exposed in the settings panel with decent defaults.
- Importance-aware trimming for long-term and session memories.

### Fixed

- Changed consolidation behavior so already consolidated memories don't get
  consolidated again, ending up with a superficial single memory in the end.
- Consolidation happens more often so it's faster and less likely to lose detail.

## [1.0.2] - 2026-04-04

### Fixed

- Max Response Length slider being set to 5 tokens when scene break detection
  ran concurrently with extraction. The AI detection path uses a responseLength
  of 5 (yes/no answer) which corrupted SillyTavern's `TempResponseLength`
  singleton for the same reason as the 1.0.1 fix. Scene detection is now
  awaited before extraction starts.

## [1.0.1] - 2026-04-03

### Fixed

- Max Response Length slider in SillyTavern being permanently changed to the
  extraction response length (500-600 tokens) after Smart Memory ran in the
  background. Caused by compaction and extraction concurrently modifying
  SillyTavern's global `amount_gen` via its `TempResponseLength` singleton.
  Compaction now runs sequentially before extraction so they never race.

## [1.0.0] - 2026-04-03

Initial public release.

### Features

- Short-term memory: automatic context summarization with progressive compaction
- Long-term memory: persistent per-character facts, relationships, preferences,
  and events across all sessions with auto-consolidation
- Session memory: within-chat details including scene descriptions, revelations,
  developments, and named objects or places
- Scene detection: heuristic detection of time skips and location changes with
  scene history injection
- Story arcs: open narrative thread tracking with automatic resolution detection
- Away recap: "Previously on..." summary generated on return after configurable
  absence threshold
- Continuity checker: manual contradiction detection against established facts
- Token usage display: live bar showing injection footprint per memory tier
- Catch Up: full chat history processing in chunks for onboarding existing chats
- Slash commands: `/sm-check`, `/sm-summarize`, `/sm-extract`, `/sm-recap`
- Group chat guard: Smart Memory disables itself with a warning in group chats
  (group chat support planned for a future release)
