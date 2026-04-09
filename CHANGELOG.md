# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- Per-extraction limit changed from 4 total new entries to 2 per type - prevents
  a burst of similar events from flooding one type in a single pass.
- Arc injection budget raised from 200 to 400 tokens so all tracked arcs fit
  without truncation.
- All injection templates changed from bracket-wrapped (`[Story so far: ...]`)
  to plain text to prevent bracket notation bleeding into RP output.
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
