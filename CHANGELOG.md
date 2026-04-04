# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
