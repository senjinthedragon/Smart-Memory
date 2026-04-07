# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-04-07

### Added

- Session prompt injection now prepends a compact **Current scene state** block
  synthesized from the latest session memories across `scene`, `development`,
  `detail`, and `revelation` types.
- Added unit coverage for current scene-state block synthesis to ensure newest
  per-type details are selected.
- Introduced a second-stage memory candidate verifier for both long-term and
  session extraction flows. The verifier filters malformed/low-signal lines,
  drops uncertain wording, and suppresses highly redundant candidates before
  persistence.
- Added utility-decay retention scoring signals to memory prioritization:
  confidence, persona relevance, intimacy relevance, retrieval count, and
  last-confirmed timestamp now influence which memories survive trimming.
- Added protected-slot trimming behavior in prompt injection:
  - Long-term injection now reserves slots for relationship/preference/fact
    continuity when possible.
  - Session injection now reserves slots for development/scene continuity when
    possible.
- Added retrieval telemetry updates on injected memories (`retrieval_count`,
  `last_confirmed_ts`) so frequently used memories are retained more reliably
  in future trims.
- Added unit tests for utility scoring and protected-slot selection behavior.

### Changed

- Long-term and session memory loading now auto-migrates additional metadata
  defaults for legacy entries (`confidence`, `persona_relevance`,
  `intimacy_relevance`, `retrieval_count`, `last_confirmed_ts`) without
  breaking existing stores.
- Retention ordering now uses utility-decay scoring instead of only
  expiration/importance/keyword frequency/recency.

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
