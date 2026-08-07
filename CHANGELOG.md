# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Per-chat memory scope (`memory_scope = 'chat'`).** Long-term tiers (memories, relationship history, canon, persistent arcs, epistemic knowledge, entity registry) can be isolated per chat instead of shared across all chats with the same character. Enabled via the Memory scope selector in settings; default remains per-character. Switching to per-chat seeds the current chat from the character store so an ongoing chat keeps its memory; new chats start clean. Non-destructive: character-level data is left untouched and can be returned to at any time. Storage nests per-chat containers under `characters[characterName].chats[chatId]`, schema-versioned like every other container. Group persistent arcs are scoped the same way under `group_arcs[groupId].chats[chatId]`. Pure scope-resolution logic lives in `scope-core.js` and is covered by `tests/scope.test.js`.

## [1.8.1] - 2026-07-02

### Added

- **`{{smartmemory-triggered}}` macro for contextually triggered memories.**
  Keyword-triggered long-term memories can now be placed via macro in instruct
  templates, consistent with all other memory tiers. Previously the triggered
  slot had no macro equivalent, so Force Macro Injection mode hid the depth
  setting with no alternative. The depth setting remains available in advanced
  mode for non-macro users.
- **ST Connection Profile as Memory LLM source.** A new "ST Connection Profile"
  option in the Memory LLM source dropdown lets users select any saved SillyTavern
  connection profile for extraction and summarization. The profile's URL, model,
  and API credentials are used automatically - no re-entry needed. Supports all
  Chat Completion and Text Completion profile types. Useful for users who already
  have their extraction model configured as an ST connection profile and want to
  avoid duplicating settings.

## [1.8.0] - 2026-07-02

### Added

- **Epistemic entry supersession.** Existing Perspectives & Secrets entries are
  now passed into each extraction prompt as a numbered list. The model outputs
  `[retire] <n>` for any entry the scene explicitly resolves or contradicts -
  a `[suspects]` entry is retired when the character confirms the fact as
  `[knows]`, a `[hiding]` entry when the secret is revealed, and so on. Retired
  entries are removed before new ones are merged in, so the injected knowledge
  block stays clean rather than accumulating contradictions over a long chat.
  No extra model call - retire lines are mixed into the same extraction response.
- **Manually resolving an arc now generates an arc summary for canon.**
  The arc checkmark previously moved the arc to the Resolved Threads panel
  but never produced an arc summary, so canon generation had nothing to work
  with. The checkmark now generates a summary on resolution, and on Profile B
  canon regenerates automatically. A separate trash button has been added to
  delete an arc without summarising it.
- **Configurable Memory LLM generation budget.** A new advanced-mode slider
  in the Memory LLM settings section lets users raise the token ceiling for
  extraction calls beyond the default 8192. Users who run verbose thinking
  models that abort before producing output can increase this limit. An
  Unlimited (-1) checkbox is also available for users who accept the risk of
  runaway generation on their local hardware.
- **Configurable injection refresh period for cloud API prompt cache stability.**
  A new advanced-mode slider sets the minimum number of AI messages that must pass
  before long-term and session memory slots are re-injected into the prompt. Default
  is 1 (every message, current behaviour). Setting it higher keeps the injected block
  stable between updates so cloud API providers can cache the prompt and charge less
  per token. Recent events are still visible in chat history during the gap between
  refreshes. Short-term (compaction) and other tiers inject immediately when they
  update and are unaffected by this setting.
- **OpenAI Compatible source retries on transient errors.** Failed requests due
  to 5xx responses, network-level errors (gateway timeouts, connection resets),
  or HTTP 429 rate-limit responses are retried up to 3 times with a 3-second
  delay between attempts. This handles free-tier cloud providers that occasionally
  drop or throttle requests without permanently failing the extraction pass.
- **OpenAI Compatible source no longer requires a local proxy for cloud APIs.**
  Remote/cloud providers (Nvidia NIM, OpenRouter, OpenAI, etc.) are now routed
  through SillyTavern's own server-side proxy, which avoids the CORS restrictions
  those services impose on direct browser connections. Local servers (localhost
  and private network addresses) are still contacted directly as before - no
  behaviour change for KoboldCpp, llama.cpp, or any other locally hosted server.
- **Scene break heuristic patterns expanded.** Five new pattern groups have been
  added: wake from unconsciousness or injury ("regained consciousness", "came to
  their senses", "opened their eyes to find"); return transitions ("returned to
  the X", "made their way back to"); formal arrival phrasing ("upon
  arriving/reaching/entering the X"); time anchors ("the morning after", "by
  morning/nightfall/dawn/dusk"); and extended time skips ("in the days/weeks that
  followed"). Patterns are intentionally narrow to avoid false positives on
  common mid-scene phrasing.
- **The continuity repair note is now shown in the settings panel with a
  Cancel button.** When a correction is queued, the panel shows the exact
  text that will be injected into the next prompt, so users can read it and
  cancel it if they disagree. Clicking Cancel removes the queued correction
  before it fires.
- **A toast notification appears when a continuity repair is queued.** Both
  the auto-check and manual check paths now show a brief toast when a
  correction is successfully queued for the next response, so users know a
  repair fired without having to keep the settings panel open.

### Changed

- **Progressive compaction no longer double-sends new messages on Ollama and
  OpenAI-compat sources.** The update prompt embeds the new conversation events
  as text via `{{new_events}}`, but `generateMemorySummarize` was also prepending
  the full recent chat as prior messages for context. The new messages were
  therefore sent twice, inflating the request and confusing some models. The
  update path now passes an empty prior-message list - the prompt body already
  has both the existing summary and the new events.
- **Compaction threshold check now skips the async tokenizer when clearly below
  budget.** `shouldCompact` runs on every AI message. It was calling ST's async
  `getTokenCountAsync` even on short chats that can't possibly be over the
  threshold. A cheap character-count estimate now short-circuits the check when
  the rough token count is under 60% of the threshold, eliminating the tokenizer
  call for most messages.
- **Arc deduplication now batches embedding lookups per operation.** The
  `deduplicateArcs` function and the new-arc comparison loop inside `extractArcs`
  were calling `getEmbeddingBatch` once per pair of arc strings. Both now
  collect all texts and issue a single batch call before the comparison loop,
  reducing embedding round-trips from O(n^2) to O(1) per operation.
- **Retired memory pool is now capped at 100 entries per tier.** Previously the
  pool grew without bound when consolidation was disabled - every superseded
  memory stayed in storage forever. The pool is now trimmed from the front
  (oldest first) when it exceeds 100 entries in either the long-term or session
  tier. The cap is high enough that a user would need to supersede hundreds of
  memories in one chat before anything is dropped.
- **The extraction and compaction pipeline is now deferred past ST's event
  emit.** SillyTavern awaits all `CHARACTER_MESSAGE_RENDERED` listeners before
  saving the chat file. Previously, Smart Memory's multi-second model calls ran
  inside that await, blocking ST's save in non-streaming mode. The pipeline now
  starts via `setTimeout(fn, 0)` so the handler returns immediately and ST
  proceeds to save without waiting. Compaction and scene detection are also
  gated on `!extractionRunning` so a re-entrant handler call cannot start either
  one concurrently with an in-progress extraction from the previous turn.
- **Char-truncation floor raised to generation budget on Ollama and OpenAI-compat
  paths.** Extraction and summarization output was truncated at `responseLength * 4`
  characters after stripping thinking blocks. On thinking models the tight per-tier
  `responseLength` values (300-600 tokens) could silently cut off items at the end
  of a dense extraction response. The floor is now
  `Math.max(responseLength, generation_budget) * 4` so the user-configured
  generation budget is always the effective ceiling. When the generation budget is
  set to Unlimited (-1), truncation is skipped entirely.
- **Per-tier injection budget sliders now go up to 4000 tokens** (previously
  capped between 600 and 2000 depending on the tier). Users running cloud models
  or large local context windows can now set higher per-tier budgets in advanced
  mode without editing settings directly.
- **Auto-tune budgets and unified injection** have been moved from Developer
  settings to the Configuration section and are no longer marked experimental.
  Both features are stable. Auto-tune sits directly below the total budget
  slider; unified injection is in the advanced-only block.
- **Macro tokens reference** is now visible in both simple and advanced mode
  (previously advanced-only), repositioned to just above Hardware profile so it
  no longer appears to group the options below it. Tooltip formatting fixed -
  newlines now render correctly, macro order matches the extension panel
  injection order.
- **Unknown-typed entities now show a hint in the entity panel** when the state
  ledger is enabled. Entities the model failed to classify default to type
  `unknown`, which does not support state cards. Previously the state card
  section was silently absent; now a small info line prompts the user to change
  the type via the existing type badge to unlock the state card editor.

### Fixed

- **Retired memories are no longer permanently deleted by the injection
  telemetry pass.** The telemetry branch in `injectMemories` and
  `injectSessionMemories` was saving only the filtered active-memory array back
  to storage, wiping every superseded entry on each AI response turn. The
  "Show retired memories" toggle was always empty as a result, and supersession
  history was silently lost. Both functions now reload the full (unfiltered)
  array before saving, preserving the retired pool.
- **Epistemic deduplication now correctly uses semantic embeddings.**
  `getEmbeddingBatch` returns a `Map<string, number[]>` keyed by text, but
  the epistemic dedup path was indexing it with numeric positions
  (`embeddings?.[i]`), which always returns `undefined` on a `Map`. Dedup
  silently fell back to Jaccard for every epistemic extraction pass even when
  embeddings were configured and working. Fixed to use `.get(content.trim())`
  matching every other caller in the codebase.
- **Chat-switch data corruption in several unguarded modules.** A family of
  functions did not have the `chatLoadId` abort guard introduced for the main
  extraction path in v1.7.x: `consolidateSessionMemories`, `processSceneBreak`,
  `runStateCardExtraction`, and `generateProfiles`. A mid-run chat switch could
  write old-chat data into the new chat's `chatMetadata`. All four functions
  now accept an `abortCheck` callback and skip their final write if the chat has
  changed. The catch-up runner also now cancels automatically on chat switch.
- **Re-running compaction when the summary is already current no longer
  replaces it with a narrower window.** When `summaryEnd` was at or beyond the
  current chat length (e.g. after Memorize Chat run twice), the progressive
  path condition failed and the full-compaction path re-summarized from a
  60%-context window, potentially replacing a comprehensive summary with a
  worse one. An early return now preserves the existing summary when there is
  nothing new to process.
- **Triggered long-term memories now respect the witnessed-by filter.** The
  secondary `PROMPT_KEY_TRIGGERED` injection slot was formatting triggered
  memories as plain bullets without applying `shouldInjectMemory`, injecting
  memories the responding character should not have seen even when secondhand
  framing was set to omit non-witnessed memories. The triggered slot now
  applies the same witness check as the main block.
- **State ledger entity names are now injected with correct capitalization.**
  The ledger key lowercases the entity name for stable merging, and the
  injection formatter was recovering the display name from that lowercased key.
  The original-case name is now stored as `_name` in each ledger entry and used
  for display, so names like "Elara" appear correctly rather than "elara".
- **Continuity checker now includes the active user persona in established
  facts.** Previously only the AI character's card and extracted memories were
  checked against - accurate descriptions of the user's character could be
  flagged as contradictions if they hadn't been extracted into long-term
  memories. The user persona description is now always included so the checker
  has the full picture of both sides of the conversation.
- **Auto-continuity check results now appear in the settings panel.** When
  the Profile B auto-check finds contradictions, they are now listed in the
  Continuity section of the settings panel so the user can read them - the
  same display as the manual Check button. Previously only the badge count
  was updated and the actual contradictions were invisible.
- **Auto-repair failure is now reported in the settings panel** instead of
  silently logging as "Auto-continuity check failed" (which was misleading -
  the check had succeeded). If repair generation fails the contradictions
  panel now shows a message indicating the correction could not be generated.
- **Activity loader toasts no longer cross-dismiss each other.** The toast
  for a finished continuity check was not being dismissed because
  `toastr.clear()` resolves by queue position rather than element identity.
  When extraction then started and finished, it dismissed the stale
  continuity toast instead of its own, leaving the extraction toast lingering.
  Switched to direct DOM removal which targets the correct element every time.
- **Model test output no longer breaks out of its display panel.** The model
  test tier renderer was injecting raw model output into an HTML template
  string containing a `<textarea>`. A response containing `</textarea>` would
  break out of the element, allowing arbitrary HTML to render. All dynamic
  content is now set via jQuery `.text()` and `.val()` instead of string
  interpolation.
- **Aborting an in-flight generation no longer clears a concurrent request's
  controller.** The `memoryAbortController` was being set to `null`
  unconditionally in the `finally` block of both `generateOllama` and
  `generateOpenAICompat`. A second concurrent request (for example, a
  continuity check overlapping with an extraction) could clear the first's
  controller after the second one set a new one, making the new request
  unabortable. Each call now captures its own controller reference and only
  nulls the module-level variable if it still holds that same reference.
- **Extraction cutoff is now snapshotted before model calls begin.** The index
  marking how far extraction has progressed was being computed from
  `context.chat` after all model calls completed. On slow local hardware,
  messages arriving during a multi-second extraction pass were silently
  skipped: the cutoff advanced past them before they were ever fed to the
  model. The cutoff is now captured at the start of each extraction pass,
  before any `await`, so late-arriving messages are always included in the
  next pass.
- **Cross-registry entity merge now relinks memory refs in both directions.**
  When merging an entity that exists only in the long-term registry into a
  target that exists only in the session registry, the long-term memories
  referencing the source entity had their entity ID removed but the
  replacement target ID was never added. The memories became entity-orphans
  invisible in the graph. The merge now adds the target ID after removing the
  source ID, matching the behaviour of the session-to-long-term direction.
- **Catch-up inject failures no longer abort the entire catch-up run.** The
  `injectMemories` and `injectSessionMemories` calls inside the catch-up loop
  had no error handling, so a transient failure in either would throw and stop
  processing all remaining chunks. Both calls are now wrapped with `.catch` so
  the run continues even if an inject step fails.
- **Catch-up now advances `lastExtractCutoff` after each processed chunk.**
  Previously the cutoff was never updated during catch-up, so the next normal
  extraction pass would re-process the entire window that catch-up had already
  covered. The cutoff is now updated per chunk using the chat index of the last
  message processed, matching the behaviour of the normal extraction path.

## [1.7.15] - 2026-05-30

### Fixed

- **Memory graph node tooltip no longer clips at the bottom for tall nodes.**
  The tooltip height was measured while the element was hidden, returning 0
  and falling back to an 80px estimate. Tooltips taller than that were
  positioned incorrectly and clipped at the bottom of the canvas. The tooltip
  is now rendered off-screen before measuring so the clamp uses the real height.

## [1.7.14] - 2026-05-30

### Fixed

- **Memory graph node tooltip no longer clips on small screens.** The tooltip
  was already flipped to the left when a node was near the right edge, but a
  missing final clamp meant nodes near the left edge could still push it
  off-screen. The tooltip now stays within canvas bounds on all sides.

## [1.7.13] - 2026-05-30

### Fixed

- **Docs pages now show the correct version number.** The version references in
  `docs/index.html`, `docs/infographic.html`, and `docs/architecture.html` were
  not updated during the 1.7.9-1.7.12 release cycle.

## [1.7.12] - 2026-05-30

### Fixed

- **Memory graph, search results, and state card merge overlays now render
  correctly on mobile.** All three were implemented as `position:fixed` divs
  and suffered the same stacking context issue as the recap overlay fixed in
  1.7.11. Converted to `<dialog>` elements with `showModal()`. The graph
  overlay also no longer requires a page refresh to close - the close button
  and Escape key work correctly in the browser top layer.

## [1.7.11] - 2026-05-30

### Fixed

- **Away recap now renders correctly on mobile.** The overlay was implemented
  as a `position:fixed` div, which gets trapped inside SillyTavern's
  transformed ancestors on mobile and renders inside the navbar rather than
  over the full screen. Switched to a `<dialog>` element with `showModal()`,
  which renders in the browser's top layer and is immune to ancestor stacking
  contexts.

## [1.7.10] - 2026-05-30

### Fixed

- **Manually resolving an arc via the checkmark now moves it to the Resolved
  Threads panel instead of deleting it.** For pinned arcs the resolved state
  is written to the persistent store so it carries into future chats, matching
  the behaviour of model-resolved arcs. Non-pinned arcs are resolved within
  the current chat only.
- **Away recap no longer disappears when another extension re-renders the last
  message after chat load.** Some extensions (e.g. SillyTavern Expressions)
  fire `CHARACTER_MESSAGE_RENDERED` on an existing message during their
  initialization pass. The recap dismissal logic in that handler was redundant -
  `GENERATION_STARTED` and `MESSAGE_SENT` already handle all legitimate dismissal
  cases - and has been removed. The recap now stays visible until the user
  explicitly dismisses it or a real new generation begins.
- **Away recap can now be dismissed programmatically by external extensions.**
  Dispatching a `smart_memory:dismiss_recap` DOM event removes the recap overlay.
  This allows companion extensions (such as Discord Connector) to clear a
  blocking recap when the user is not physically present to click Dismiss.
- **Status bar no longer shows a stale extraction count after switching chats.**
  The "N items stored for X" message set at the end of an extraction pass was
  never cleared on chat change, so switching to a different character or a new
  chat left the previous character's count visible until the next extraction ran.

## [1.7.9] - 2026-05-27

### Fixed

- **OpenAI-compatible URLs with a trailing `/v1` now work correctly.** Many
  providers document their API URL with `/v1` included (e.g.
  `https://text.novelai.net/oa/v1`). The extension already appends `/v1`
  itself, so a user-supplied suffix caused doubled paths and 404 errors. Both
  the Memory LLM and embedding URL fields now strip a trailing `/v1`
  defensively, so either form works.
- **Extraction no longer silently skips when another extension fires a background
  generation between `MESSAGE_RECEIVED` and `CHARACTER_MESSAGE_RENDERED`.** The
  `GENERATION_STARTED` guard that prevents extraction from running mid-stream was
  incorrectly set for all generation types, including `quiet`. Extensions such as
  Memory Books trigger a quiet generation for their own auto-summary immediately
  after `MESSAGE_RECEIVED`, which raised the flag before Smart Memory's
  `CHARACTER_MESSAGE_RENDERED` handler could run - causing every extraction pass
  to be silently skipped. The guard now only activates for `normal` generations.
- **Trim warning no longer fires spuriously when auto-tune adjusts a budget.**
  `reinjectAfterBudgetChange` was not awaiting the two async inject calls
  (`injectMemories`, `injectSessionMemories`), so `updateTokenDisplay` could run
  before those Promises resolved and see stale load-pass trim data, triggering
  the one-time trim warning incorrectly on the first message after auto-tune ran.
- **Forget This Chat no longer clears Perspectives & Secrets.** Epistemic
  knowledge lives in `extension_settings` and persists across sessions by
  design, but the handler was still calling `clearEpistemicKnowledge` - silently
  destroying cross-session knowledge every time the user cleared a chat. Fixed
  to match the same treatment already applied to state cards.
- **Fresh Start now clears `lastExtractCutoff`.** The Fresh Start handler deleted
  all other chat-scoped metadata but left the extraction cutoff pointer intact.
  On the first extraction run after a Fresh Start the smart window would start
  from the stale cutoff, skipping messages between it and the current tail and
  silently under-extracting.

## [1.7.8] - 2026-05-22

### Fixed

- **Extraction no longer fires on `/continue` generations.** Each `/continue`
  call was incrementing the extraction counter even though the user had not
  committed to the message - the same window arithmetic problem as swipes.
  If the user continued a message twice then swiped it away, the counter was
  inflated and extraction would fire with a window boundary pointing at the
  discarded content. `'continue'` is now skipped in both the solo and group
  chat paths alongside `'swipe'`. The continued content is captured correctly
  on the next extraction pass after a real user message.

## [1.7.7] - 2026-05-22

### Fixed

- **Extraction no longer fires on swipes in group chats.** `GROUP_WRAPPER_FINISHED`
  fires with `type='swipe'` when a group chat member is swiped, but the handler
  only guarded against `'quiet'`. Every group chat swipe was incrementing the
  extraction counter, so extraction fired every N swipes where N is the
  extraction frequency. The fix mirrors the solo-chat swipe guard that was
  already in place.

## [1.7.6] - 2026-05-22

### Fixed

- **Extraction no longer fires on swipes.** SillyTavern passes a `type`
  parameter with `CHARACTER_MESSAGE_RENDERED` - values such as `'swipe'`,
  `'impersonate'`, and `'quiet'` indicate the message was not accepted by the
  user. Smart Memory now checks this parameter directly and skips extraction for
  non-accepted generations. The length-comparison fallback is kept for older ST
  versions that do not pass the parameter. A secondary bug where the first swipe
  after opening a chat was always treated as a new message (because the length
  tracker was reset to zero on chat load) is also fixed.

- **Short-term summary** no longer contains raw HTML markup when generated by
  models that associate `<summary>` with HTML context. The compaction prompt
  now uses `[SUMMARY]` / `[/SUMMARY]` markers instead of the HTML-like
  `<summary>` tag. HTML tags are also stripped from the extracted content as a
  safety net. Existing summaries stored in `<summary>` format are still parsed
  correctly.

## [1.7.5] - 2026-05-16

### Added

- **Auto-tune budgets** applies immediately when the checkbox is enabled, using
  whatever trim data has already been collected in the current session. Previously
  it only ran after the next injection pass.
- **Group character token bar rows are now clickable.** Clicking a character's
  row in the per-character token bar selects that character for memory
  inspection, replacing the separate "Viewing memories for" dropdown. Rows show
  a pointer cursor and a hover highlight to signal interactivity.

### Fixed

- **Auto-extraction** now triggers correctly when SillyTavern streaming is
  disabled. The previous guard used ST's `is_send_press` flag to block
  intermediate streaming renders, but that flag is still set when
  `CHARACTER_MESSAGE_RENDERED` fires in non-streaming mode, silently preventing
  extraction from ever running. Replaced with an internal flag cleared by
  `MESSAGE_RECEIVED`, which ST guarantees fires before
  `CHARACTER_MESSAGE_RENDERED` in both streaming and non-streaming paths.
- **Auto-tune budgets** no longer shrinks tier budgets below their defaults.
  Previously the only lower bound was 50 tokens, so tiers with light content
  could be squeezed far below their factory values. Each tier's default is now
  used as a hard floor - auto-tune can grow a budget above the default when
  demand justifies it, but never below.
- **Auto-tune budgets in group chats** now sizes budgets for the greediest
  character seen in the session rather than whichever character injected last.
  A high water mark tracks the maximum token demand per tier across all injection
  passes, so a character with lighter memories can no longer push the budget down
  below what a heavier character in the same chat needs.
- **Auto-tune budgets** now re-tunes immediately when switching the group
  character panel selector. Previously the selector switch would reinject the
  new character's memories at the wrong budget and leave the trim indicator
  without self-correcting until the next generation.

## [1.7.4] - 2026-05-16

### Fixed

- **Embedding API key** no longer causes a startup crash. The import of
  `saveSettingsDebounced` in `embeddings.js` was incorrectly pointing to
  `extensions.js`, which does not export that function. Corrected to import
  from `script.js` alongside every other module in the project.

## [1.7.3] - 2026-05-15

### Fixed

- **Memory edit and delete** now correctly target the selected memory when retired
  entries are present. Previously, the edit and delete buttons used a sorted display
  index to look up the memory in storage, causing the wrong memory to be modified
  whenever the sort order differed from the storage order. Both buttons now look up
  by memory ID.
- **Embedding API key** is now correctly sent with requests to OpenAI-compatible
  embedding backends. The key was previously stored in SillyTavern's secrets store,
  but ST's secrets API requires `allowKeysExposure: true` in config.yaml to retrieve
  a secret value client-side - a setting most users do not have. In practice the key
  was saved but never included in requests, causing 401 errors. The key is now stored
  in extension settings alongside other Smart Memory configuration. Note: this means
  the key is no longer in the secrets store and is stored in plain text in ST's
  settings file, consistent with how the extraction API key has always been handled.

## [1.7.2] - 2026-05-14

### Fixed

- **Force macro injection mode** now correctly activates `{{smartmemory-unified}}`
  in instruct templates when unified injection is enabled. Previously, force mode
  had no effect on the unified macro, leaving instruct template users with no way
  to place the unified block.

## [1.7.1] - 2026-05-14

### Added

- **Embedding API key**: OpenAI-compatible embedding sources now support an optional
  API key for backends that require authentication (such as KoboldCpp). The key is
  stored securely in SillyTavern's secrets store and never written to extension settings.

## [1.7.0] - 2026-05-13

### Added

- **Macro injection**: all 9 Smart Memory macros can be placed anywhere in a
  character card or instruct template to control exactly where memory content appears
  in the prompt, rather than relying on automatic injection depth and position settings.
  The 8 per-tier macros are: `{{smartmemory-shortterm}}`, `{{smartmemory-longterm}}`,
  `{{smartmemory-session}}`, `{{smartmemory-scenes}}`, `{{smartmemory-arcs}}`,
  `{{smartmemory-relationships}}`, `{{smartmemory-canon}}`, `{{smartmemory-profiles}}`.
  A ninth macro, `{{smartmemory-unified}}`, works alongside unified injection mode and
  injects the full merged block wherever the token is placed - letting users control
  the placement of the unified block the same way individual macros control per-tier
  placement. Per-tier macros are inactive when unified injection is on (unified owns
  those tiers); the unified macro is inactive when unified injection is off. Auto-detection
  activates macro mode per tier when a token is found in the character card system prompt,
  description, personality, scenario, or example messages. A "Force macro injection mode"
  toggle in Configuration (advanced) activates all applicable macros at once for use with
  instruct templates that cannot be auto-detected from card fields.

- **Source-message provenance**: long-term and session memories now record which
  message range they were extracted from. A **jump-to-source** button appears on
  each memory entry when provenance is available - click it to scroll the chat
  directly to the messages that produced the memory. The button is shown on session
  memories whenever provenance is present, and on long-term memories only when the
  source chat matches the current chat. Clicking the button closes the extensions
  panel, scrolls the chat to the source range, and flashes the messages in the
  range with a pulsing outline so they are easy to spot on landing. The jump button
  is positioned before the edit button; only the delete button is styled in red -
  edit and jump use the theme's default text color.

- **Smart extraction window**: automatic extraction no longer re-processes
  messages it has already seen. Each extraction pass records a cutoff index in
  `chatMetadata`; the next pass starts from that cutoff rather than from a fixed
  lookback. A minimum context floor (two extraction intervals) ensures the model
  always has enough context for quality output even when few new messages have
  arrived. The Memorize Chat and per-tier Extract Now buttons are unaffected and
  continue to use their fixed windows.

- **Pinned arc transfers for group chats**: story arcs can now be pinned in group
  chats, bringing them to parity with solo chats. Pinned arcs are stored against
  the group ID and automatically merged into new chats for that group on load.
  On each chat load, stored group arc data for groups that no longer exist is
  pruned automatically, preventing accumulation for users who create and remove
  groups frequently.

- **Resolved state for pinned arcs**: pinned arcs that get resolved by extraction
  are now kept rather than deleted. They move into a separate **Resolved Threads**
  section below the active arc list - collapsed by default and hidden entirely
  when empty. Resolved arcs appear with strikethrough text and a muted border,
  are not injected into context, and carry their resolved state into future chats
  via the persistent store. A **re-open** button reactivates a thread if the
  story revisits it (with a duplicate check against current active arcs); a
  **remove** button discards it from both the panel and the persistent store.
  New extraction passes treat resolved arcs as invisible so a fresh instance of a
  similar thread can be added as active without being blocked as a duplicate.

- **Extraction model test**: a **Test Extraction Model** button in the settings
  panel runs a fixed 30-message roleplay scenario through every enabled extraction
  tier (long-term memories, session memories, story arcs). Results are shown
  tier-by-tier with prev/next navigation - each tier displays the model's raw
  output alongside a hint explaining what a capable model should find. If any tier
  returns empty output the test reports an immediate failure naming the tier, so
  users can quickly identify whether their configured model is suitable without
  reading through all tiers.

- **Relationship History**: long-term per-character relationship state is now
  tracked across sessions as a set of named pairs. After each extraction pass, the
  model reviews the scene and emits delta lines describing how the relationship
  between two characters has shifted - descriptors such as `warm`, `cautious`,
  `distant` together with a magnitude (`low`, `medium`, `high`). Each pair is
  stored under a `subject→target` key in the character's persistent record and
  updated on every pass so the state always reflects the most recent emotional
  arc. On injection, only pairs whose names appear in the recent message window
  (or current group chat member list) are included, keeping the block compact.
  New pairs can be seeded from the character card excerpt when the model does not
  yet know a relationship; they can also be added, edited, and deleted manually
  from the settings panel. Relationship History is cleared alongside long-term
  memories when **Clear Memories** or **Fresh Start** is used. Schema v7 adds
  the `relationship_history` field to all character records. The token budget is
  drawn from a new `Relationship History` slice in the budget breakdown, funded
  by reducing the arc and canon ratios by a small amount within the existing 3100
  token default so the total default budget does not increase.

- **Per-descriptor magnitudes for relationship history**: each relationship
  descriptor now carries its own magnitude (`low`, `medium`, or `high`) rather
  than a single shared magnitude for the whole pair. The output format is
  `word(magnitude)` - e.g. `trusting(high), cautious(medium)`. Updates use a
  union merge: existing descriptors are preserved unless explicitly removed with
  a `!` prefix, new descriptors are added or update the magnitude of an existing
  entry with the same word. This replaces the previous full-replacement model so
  descriptors accumulate correctly over multiple extraction passes. The add and
  edit forms in the settings panel use the same `word(magnitude)` format.

- **Status message during relationship history extraction**: the extraction
  status indicator in the settings panel now shows `Extracting relationship
  history...` while the relationship history model call is in progress, matching
  the feedback already shown for other extraction tiers.

- **Contextual relevance for long-term memories**: the hybrid scorer now applies a
  bonus to memories whose content words overlap with the current chat turn, so
  memories about what is actually being discussed right now rise to the top of the
  injection budget. The bonus is 40 pts per significant content word hit (capped at
  three), with a higher 80 pt bonus reserved for LLM-suggested trigger keywords
  (Profile B, not yet implemented) that add signal beyond what is in the content
  itself. Memories that score a contextual hit are also placed at the end of the
  main injection block and injected a second time into a secondary in-chat slot
  closer to the prompt (configurable depth, default 4) so the roleplay model sees
  them right before it responds. Schema v6 adds a `triggers` field to all memories.
  On Profile B (hosted models) and when the **Generate contextual triggers**
  setting is enabled (off by default), this field is populated at write time via
  a short model call that asks the extraction LLM to suggest synonyms, hypernyms,
  situational cues, and associated reactions for each new memory - words that would
  signal relevance even when the exact memory vocabulary is not present in the turn.
  LLM-suggested triggers score at 80 pts per hit (versus 40 pts for plain
  content-word overlap) so memories with strong semantic relevance surface ahead of
  memories that merely share vocabulary with the current turn. On Profile A without
  the toggle, content-word overlap handles the baseline. Trigger generation applies
  to both long-term memories and session memories.

- **Perspectives & Secrets**: a new extraction tier that builds a per-character
  knowledge map at every scene break. For each named character in the scene, the
  model emits tagged entries describing five distinct epistemic states: `[knows]`
  (confirmed facts), `[suspects]` (unconfirmed beliefs), `[believes]` (false beliefs
  the character is certain of), `[unaware]` (things they do not know at all), and
  `[hiding]` (things they know but are actively concealing from a specific other
  character). On injection, only entries where the responding character is the
  subject are included, so each character receives their own private knowledge block
  rather than a shared one. This lets the AI maintain perspective-accurate
  behaviour - playing ignorance correctly, sustaining deceptions, and never acting
  on information the character could not have.

  Long-term memories now carry a `witnessed_by` field recording which characters
  were present when the memory was extracted. Memories from scenes the responding
  character was not in are prefixed `[secondhand]` in the long-term injection block,
  flagging them as hearsay rather than direct experience. This can be disabled in
  favour of omitting non-witnessed memories entirely.

  Deduplication uses the same embedding-primary, Jaccard-fallback approach as other
  tiers with a 0.70 threshold. Entries are stored in the character's persistent
  record and survive across sessions. The token budget (200 tokens by default) is
  funded from within the shared total by a small reduction to the arc and canon
  ratios. Schema v8 adds `epistemic_knowledge: []` to all character records and
  backfills `witnessed_by: []` on existing long-term memories.

  On Profile A (local/low-VRAM hardware) the feature is off by default; a per-section
  override toggle enables it when the local model is reasoning-capable. Entries can
  be added, edited, and deleted manually from the **Perspectives & Secrets** section
  in the settings panel. The `{{smartmemory-epistemic}}` macro is also available for
  placement-controlled injection. The extraction model test now includes a separate
  Mira/Sera/Ryn/Dael scene designed to exercise all five epistemic tags.

- **State Ledger**: tracks the current observable physical and operational state of
  named entities (characters, objects, places, factions) as a compact snapshot.
  Extracted per session from the same message window as other extraction tiers;
  injected as a tightly formatted block near the current action so the AI stays
  grounded in what is visible right now rather than relying on scattered memories.

  Supported entity types and their fields:
  - character: location, injuries, outfit/disguise, mood, active goal, carried items
  - object: owner, location, condition, status
  - place: occupants, hazards, political control, damage, accessibility
  - faction: leadership, objective, alliances, hostility level

  State cards are chat-scoped - current state does not carry over when a new chat
  begins. Each state card is stored under a `name|type` key in `chatMetadata` and
  kept in sync with the entity registry: type changes migrate the card to the new
  key; merges with conflicting cards open a modal to pick which card survives; delete
  warns before discarding a populated card. Cards can also be created and edited
  manually from the entity panel below each entity row.

  Extraction runs sequentially after other tiers to stay within VRAM limits. The
  parser silently drops placeholder values (`unknown`, `none`, `not mentioned`, etc.)
  that weaker models emit instead of omitting unknown fields. On Profile A the feature
  is off by default; a per-section override enables it when the local model is
  reasoning-capable. The token budget (200 tokens by default) is funded by a small
  reduction to the arc and canon ratios (schema v9 adds `state_ledger: {}` to all
  chat metadata). The `{{smartmemory-stateledger}}` macro is available for
  placement-controlled injection. The extraction model test now includes a dungeon
  scene designed to exercise current-vs-past state, sparse output, and multiple
  entity types.

- **Catch-up runs Epistemic and State Ledger**: the catch-up handler now runs
  Perspectives & Secrets and State Ledger extraction alongside all other tiers.
  Epistemic extraction fires at each detected scene break and once more on the
  final scene buffer so knowledge from the last scene is never lost. State Ledger
  extraction runs after each chunk. Both tiers are gated by their feature flags
  and by `isFreshStart` so they are skipped when the chat has no prior context.

- **AI scene break detection in catch-up**: when **Use AI detection** is enabled
  for scenes, catch-up now uses `detectSceneBreakAI` instead of the heuristic.
  A progress counter (`Detecting scene breaks... (n/total)`) updates the status
  line on every AI message so long catch-up runs stay visible.

- **Partner change as a scene break trigger**: the AI scene detection prompt now
  recognises a change in intimate partner as a new-scene signal. Two separate
  encounters with different people in the same location were previously treated
  as one continuous scene; they are now split at the point where a previous
  partner has left and a new one arrived.

- **Perspectives & Secrets spoiler wall**: `believes` (false beliefs) and
  `hiding` (active concealments) entries are now grouped behind a collapsible
  spoiler block at the bottom of the entry list. The block is always rendered so
  the user can tell whether any spoiler-type entries exist - when empty it shows
  "No false beliefs or hidden secrets found." Opening it requires confirming a
  warning dialog to prevent accidental reveals in mystery or secret-role
  scenarios. The summary uses a lock/unlock icon and amber styling to distinguish
  it from the regular list, and swaps to "click to hide" when open.

- **Per-chat Perspectives & Secrets budget auto-grow**: when the knowledge block
  exceeds the current injection budget, a dialog offers to increase the budget
  for this roleplay. In normal flow the budget grows by 100 tokens per
  confirmation; after catch-up a single dialog sets the exact size needed plus
  100 tokens of headroom so the next scene break does not immediately overflow
  again. The override is stored per-chat in `chatMetadata` and does not change
  the settings slider.

- **Trim indicator on the token usage bar**: each segment of the token usage bar
  now shows a red underline when that tier is actively trimming content to fit its
  budget. The hover tooltip extends to show how many tokens were dropped alongside
  the injected count. The indicator resets on every chat switch so it only reflects
  the current state.

- **One-time trim notification**: the first time any memory tier trims content in
  a chat, a toast notification appears directing the user to the token bar in
  settings. The notification fires at most once per chat and never repeats for that
  chat, so it is visible to users who do not regularly open the settings panel
  without becoming intrusive.

- **Auto-tune budget allocation (experimental)**: an opt-in toggle in Developer
  settings automatically redistributes the per-tier token budget after each
  extraction pass based on observed demand. Tiers using less than their budget give
  the surplus to tiers that are trimming content. The configured total budget acts
  as a hard cap - auto-tune never increases total memory usage beyond what the
  slider allows. Sliders update live so the reallocation is visible. Disabled by
  default so manually tuned advanced budgets are not overwritten. Note: the system
  does not account for the rest of the context window (character card, chat
  messages, system prompt) - the total budget slider remains the user's safety
  valve against crowding out actual roleplay.

- **OKLCH perceptually uniform colors throughout**: all colored UI elements -
  token bar tier slices, memory type badges, row tint backgrounds, the type-picker
  widget, and the force graph memory node colors - now use the OKLCH color space
  for perceptually uniform hue separation. Token bar tiers use 10 hues at 36-degree
  intervals at `oklch(62% 0.14)`. Memory type badges (long-term and session) use
  8 hues at 45-degree intervals at `oklch(57% 0.10)` - lower chroma so they read as
  clearly distinct from the bar slices. Type-picker hover states lighten to
  `oklch(70% 0.10)` within the same hue. The force graph uses the same 8 badge
  colors for memory nodes so the graph and the settings panel stay in sync.
  Because all hues share the same lightness and chroma they read as a cohesive
  family rather than a collection of unrelated colors.

### Fixed

- **`crypto.randomUUID` unavailable on HTTP**: memory ID generation failed with
  `TypeError: crypto.randomUUID is not a function` when SillyTavern was accessed
  over plain HTTP from a remote device. A manual UUID v4 fallback is now used
  when `crypto.randomUUID` is not available.

- **Arc extraction noise on small local models**: two filters now work in
  combination to reduce false positives from 8B models that misfile
  established facts and scene details as story arcs. A keyword filter in the
  parser requires every new arc candidate to contain at least one signal of a
  genuine open thread - goal or obligation language (`must`, `needs to`,
  `promised`), incompleteness markers (`unknown`, `unclear`, `remains open`),
  unknown-actor framing (`someone`, `the identity of`), or open question
  structure (`who is`, `whether`). A second semantic filter in the extraction
  pass compares each candidate against current session memories; candidates
  that score above the similarity threshold are treated as rephrased scene
  details and dropped. The semantic filter falls back to keyword matching
  when embeddings are not available. The model test fixture was also rewritten
  with a scenario designed to have three explicitly open threads that do not
  resolve within the conversation, giving a clearer pass/fail baseline for
  the arc tier.

- **AI scene break detection accuracy**: truncation limits in the detection
  prompt were cutting off transition signals before the model could read them
  (600/800 character limits). Limits raised to 1000/1200 characters and the
  YES criteria softened to detect location changes that do not include explicit
  landmark language. This resolves cases where catch-up found only 1-2 scenes
  in a long roleplay that had many transitions.

- **Heuristic scene break patterns expanded**: added sleep/fall-asleep patterns,
  relaxed wake-up detection (no longer requires dawn markers), movement verbs
  leading to a new location, and extended location-arrival patterns for multi-word
  place names and possessives. The heuristic is now more likely to catch natural
  RP transitions during catch-up when AI detection is off.

## [1.6.11] - 2026-05-10

### Added

- **OpenAI-compatible embedding source**: semantic deduplication now works with
  any server that implements the `/v1/embeddings` endpoint - not just Ollama. A
  new "Embedding source" selector in the deduplication settings lets you choose
  between Ollama (existing behaviour) and OpenAI Compatible (sends requests to
  `/v1/embeddings` with the standard request/response format). Works with hosted
  services, vLLM, llama.cpp, KoboldCpp, and any other OpenAI-compatible inference
  server that exposes embeddings.

## [1.6.10] - 2026-05-06

### Fixed

- **"Add memory" field now appears even when the memory list is empty**: the add
  form for long-term memories and session memories was only rendered after the
  list items, so it was never shown when there were no memories yet. The early
  return that caused this has been removed so the form always renders.

- **Manually added memories no longer go to the wrong character**: when switching
  from a solo chat to a group chat where the selected character had no memories,
  the add form from the previous character was left in the DOM because the cleanup
  step was skipped by the same early return. Typing a memory and clicking Add
  would silently save it to the previous character instead. The form is now always
  torn down and rebuilt with the correct character when the panel re-renders.

## [1.6.9] - 2026-05-05

### Fixed

- **"Generating recap" toast no longer appears twice (again)**: the `recapRunning`
  boolean added in v1.6.8 was reset inside the same block that runs on every chat
  load, so it was always false by the time the guard checked it. The guard now
  uses a chatMetadata object reference (`recapRunningForChat`) instead of a flag,
  so it survives the reset and correctly prevents a second recap from starting
  while the first is in progress.

- **Recap popup no longer suppressed by SillyTavern's expression system**: the
  `GENERATION_STARTED` handler that dismisses the recap overlay was matching any
  non-quiet generation, which includes the expression/emote generation ST fires
  after each message. This caused the overlay to be removed as soon as expressions
  ran, before the user could see the recap. The handler now only matches
  `type === 'normal'` so expressions and other background calls no longer
  interfere.

- **"Generating recap..." activity indicator no longer stays stuck after
  suppression**: when a message was sent while a recap was being generated, the
  recap popup was correctly suppressed but the status message in the extension
  panel remained visible until the next action. `setStatusMessage('')` is now
  called unconditionally before checking the suppression flag, so the indicator
  always clears when the recap resolves.

- **Stuck "Generating recap..." toast on chat switch**: if the Ollama request
  backing a recap never settled (e.g. dropped by a model swap), the toastr toast
  would remain on screen indefinitely. The toastr handle is now stored at module
  level and cleared in the chat-change reset, so it is always dismissed when the
  user moves to a different chat.

## [1.6.8] - 2026-05-04

### Fixed

- **"Generating recap" toast no longer appears twice on chat open**: if
  SillyTavern fired both CHAT_LOADED and CHAT_CHANGED more than 100ms apart
  while a recap was still being generated, a second recap would start before
  the first had finished, producing a duplicate toast. A `recapRunning` guard
  now prevents a second recap from starting while one is already in progress.

## [1.6.7] - 2026-05-04

### Fixed

- **Profile regeneration no longer runs on chat load**: opening an old chat
  that had never had profiles generated would trigger a full model call
  immediately on load, causing several minutes of unexpected GPU load with
  no visible indicator. Profile regeneration now only runs during extraction
  passes after new messages, which is where it belongs.

- **All background model calls now show the activity indicator**: scheduled
  profile regeneration (Profile B, between extraction passes) and the
  automatic continuity check (Profile B) previously ran silently with no
  toast. Both now show a message while running so it is always clear what
  Smart Memory is doing in the background.

## [1.6.6] - 2026-04-30

### Improved

- **Ollama model fields now use a dropdown with a manual fallback**: both the
  main model and the embedding model selectors are now proper dropdowns that
  load available models from Ollama on settings open. If Ollama cannot be
  reached from the browser (e.g. accessing SillyTavern remotely where CORS
  blocks the fetch), the dropdown is replaced by a plain text input so the
  model name can be typed directly. The refresh button is hidden in fallback
  mode since it would immediately fail again. The embedding model list also
  refreshes automatically when the embedding URL is changed.

## [1.6.5] - 2026-04-30

### Fixed

- **Recap overlay no longer blocks programmatic senders**: the "Previously on..."
  overlay is now dismissed when generation starts (non-quiet), covering a race
  condition where a Discord Bridge message could arrive while the recap model
  call was still running. The overlay would then appear after the message had
  already been injected but before the user could see it. Dismissal on
  `MESSAGE_SENT` handles the case where the overlay is already visible when the
  message arrives; `GENERATION_STARTED` now covers the remaining gap.

## [1.6.4] - 2026-04-29

### Added

- **Activity indicator during background processing**: a non-blocking indicator
  now appears while Smart Memory is running extraction, compaction, or recap
  in the background, giving a clear signal that work is in progress and it is
  not yet safe to send the next message. The indicator disappears automatically
  when the job completes, including on error or chat switch. Can be turned off
  via a new "Show activity indicator while processing" toggle in the
  Configuration section alongside Advanced mode and extraction frequency.
  On by default.

### Fixed

- **All Smart Memory toasts now share the same position**: consolidation and
  compaction toasts previously hardcoded `toast-bottom-right` while the
  activity indicator used ST's global position (`toast-top-center`). The
  mismatched containers caused `fixToastrForDialogs()` to manipulate the
  DOM on every toast hide, producing a visible blink on the sticky activity
  indicator. All Smart Memory notifications now use ST's configured position.

## [1.6.3] - 2026-04-29

### Fixed

- **AI scene break detection prompt restored with explicit criteria**: the
  detection prompt now includes a clear list of what counts as a new scene
  (time skips, location changes, hard narrative breaks) and what does not
  (continuing action, emotional beats, seconds-later follow-ons). The previous
  elaborate version was reverted because the `NO_ACTION_PREAMBLE` prepended to
  it caused small local models to answer NO in all cases - the preamble's
  heavy roleplay-suppression language overrode the YES/NO instruction. Testing
  confirmed the criteria list alone (without the preamble) scores correctly,
  so it has been restored.

## [1.6.2] - 2026-04-28

### Fixed

- **Force graph floating nodes**: several cases where memory nodes appeared
  unconnected to their entity despite the entity existing in the graph have
  been resolved. Reconciliation now runs after every extraction pass (not
  only after consolidation), when the graph is opened as a catch-all, and
  cross-tier so session memories can link to long-term entities. When the
  same entity appears in both the long-term and session registries its
  memory links from both are now merged rather than the session links being
  silently dropped. Entity name matching now also tries individual words
  from multi-word names so a memory mentioning only a first name connects
  to the full-name entity.

- **Force graph freeze on a settled simulation**: clicking or dragging a
  node after the physics had cooled completely caused the canvas to stop
  responding. The render loop was not restarted on mousedown, so position
  updates never made it to screen. Fixed by calling wakeGraph() when a
  drag or pan begins.

## [1.6.1] - 2026-04-28

### Fixed

- **Short-term summary no longer captures unconfirmed swipe content**: the
  compaction and summarization paths now exclude the trailing AI message when
  building the summary, matching the stable extraction window already used by
  long-term, session, and arc tiers. The excluded message is picked up on the
  next compaction once the user has confirmed it by sending a reply.

- **Memorize Chat and recap include the last message**: the stable-window
  exclusion is bypassed for the Memorize Chat button and the away recap, both
  of which are deliberate user actions on a settled chat where the last message
  is confirmed and should be included.

## [1.6.0] - 2026-04-27

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

- **Model-confirmed supersession (method B)**: patterns alone cannot cover every
  way a fact can change in natural language ("confiscated", "hijacked",
  "embezzled", etc.). After pattern matching, any candidate that scored above
  the same-topic similarity threshold against an existing memory but had no
  pattern match is now sent to a narrow binary model prompt ("UPDATE or
  INDEPENDENT?"). The model makes the semantic judgment with minimal context -
  two sentences in, one word out - catching supersessions that patterns miss.
  B runs sequentially after the embedding pass and only fires when a suspicious
  pair exists; quiet extraction passes add zero extra model calls. Patterns
  remain as a no-cost first pass so B is not called for cases the patterns
  already resolve. Tested against five change categories (relationship, belief,
  physical, possession, allegiance) with all passing.

- **Supersession rarely firing for evolved facts**: two separate gaps prevented
  supersession from working in practice. First, the extraction prompts told the
  model not to duplicate existing memories but gave no guidance on how to
  express an update - the model would write "Alex and Finn are now lovers"
  rather than "Alex no longer distrusts Finn", so the detector never recognized
  it as replacing the old entry and both accumulated together. Both the
  long-term and session extraction prompts now explicitly instruct the model to
  use state-change phrasing when a known fact has evolved. Second, the
  state-change pattern list was too narrow - it required "now" to be followed
  by one of four specific verbs (lives/works/is/has) and matched "formerly" but
  not "former". Patterns now cover "are now / is now / can now / now \<any word\>",
  "former(ly)", "has since", "once was/believed/feared/had", physical recovery
  ("healed", "recovered"), possession loss ("lost his/her/the", "stole his/her",
  "was stolen/destroyed"), allegiance changes ("joined the", "left the",
  "defected", "abandoned"), and fate events ("was killed / captured / freed /
  promoted / betrayed / exiled") so a broad range of fact-update phrasings are
  correctly detected across relationship, belief, physical, possession, and
  allegiance changes. All five change categories were verified by running test
  prompts against the extraction model.

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

- **Self-supersession chains in graph**: when a newly extracted memory had
  nearly identical content to an existing one but also contained a state-change
  marker, the supersession linker could produce a chain where a memory retired
  itself - appearing as two identical nodes connected by an arrow in the graph.
  Two guards added: `batchVerify` now treats identical-content pairs as
  duplicates regardless of state-change markers, and the supersession linking
  step verifies that the new and old memories are distinct objects with
  different content before writing the chain.

- **Read-only session commit dialog referenced wrong button labels**: the
  confirmation popup described the choices as "OK" and "Cancel" but the
  `POPUP_TYPE.CONFIRM` dialog renders "Yes" and "No" buttons.

- **Force graph not following the active SillyTavern theme**: the canvas
  renderer used fully hardcoded colors (`#12121e` background, `#ffffff`
  labels, `#8899aa` link edges, `#d4905b` supersession arrows). A
  `getGraphTheme()` helper now reads `--SmartThemeBlurTintColor`,
  `--SmartThemeBodyColor`, `--SmartThemeEmColor`, and
  `--SmartThemeQuoteColor` at render time so the graph matches any ST
  theme without needing to reopen it. The card, toolbar, tooltip, and
  legend borders were updated from hardcoded values to the same CSS
  variables.

- **Graph filter toggle labels and "Show retired memories" button
  wrapping**: the "Session" and "Retired" filter toggles in the graph
  toolbar, and the "Show retired memories" / "Hide retired memories"
  button in the Long-term Memory panel, could wrap to multiple stacked
  lines when the container was narrow. Both now have `white-space: nowrap`
  to stay on a single line.

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
