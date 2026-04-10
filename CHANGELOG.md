# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 1.3.0

### Fixed

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
