# Smart Memory — Agent & Maintainer Guide

This document describes how the Smart Memory SillyTavern extension is put
together, why the important decisions were made, and what to watch out for when
changing it.

## 1. What the extension does

Smart Memory extracts durable narrative state from a roleplay chat and injects a
small, relevant subset back into the prompt. It is a collection of independent
memory tiers that share:

- a model-source abstraction (`generate.js`) for extraction/summarisation,
- chat-scoped storage in `chatMetadata[META_KEY]`,
- per-character storage in `extension_settings.smart_memory.characters`,
- a shared token-budget and injection pipeline,
- message-anchored snapshots for rollback safety.

The extension never rewrites past chat messages. Repair is forward-only.

## 2. Repository map

| Module                  | Responsibility                                                 |
| ----------------------- | -------------------------------------------------------------- |
| `index.js`              | SillyTavern event wiring, orchestration, group-chat lifecycle  |
| `settings.js`           | Defaults, settings load/migration, settings UI binding         |
| `settings-migration.js` | Pure, unit-testable settings migrations                        |
| `constants.js`          | Module name, metadata keys, prompt keys, id/estimation helpers |
| `generate.js`           | Main / Ollama / OpenAI-compatible / profile model dispatch     |
| `prompts.js`            | Prompt builders for every tier                                 |
| `parsers.js`            | Tolerant parsers for model output                              |
| `longterm.js`           | Long-term memories, consolidation, supersession, triggers      |
| `session.js`            | Session-scoped memories                                        |
| `compaction.js`         | Short-term rolling summary                                     |
| `scenes.js`             | Scene-boundary detection and scene summaries                   |
| `arcs.js`               | Open/resolved story threads and persistent arcs                |
| `canon.js`              | Stable per-character narrative document                        |
| `profiles.js`           | Character/world profiles regenerated from state                |
| `epistemic.js`          | Perspectives & Secrets: per-character knowledge map            |
| `state-ledger.js`       | Structured current-state cards for entities                    |
| `entity-registry.js`    | Pure entity reconciliation/linking logic                       |
| `graph-migration.js`    | Entity registry persistence and migration                      |
| `continuity.js`         | Contradiction checking and durable retcon lifecycle            |
| `continuity-utils.js`   | Pure continuity/validation/retcon helpers                      |
| `memory-utils.js`       | Pure scoring, trimming, epistemic matching helpers             |
| `state-snapshot.js`     | Pure message-anchored snapshot capture/rollback                |
| `unified-inject.js`     | Optional single-block injection mode                           |
| `ui.js`                 | DOM rendering for panels, badges, token bar                    |

Pure modules (`continuity-utils.js`, `memory-utils.js`, `entity-registry.js`,
`state-snapshot.js`, `settings-migration.js`, `similarity.js`, `template-utils.js`)
must not import the SillyTavern runtime. They are exercised directly by
`node --test tests/*.test.js`.

## 3. Memory tiers

| Tier                   | Scope               | Purpose                                 | Default placement |
| ---------------------- | ------------------- | --------------------------------------- | ----------------- |
| Short-term summary     | chat                | rolling compaction summary              | `IN_PROMPT`       |
| Long-term              | character           | durable facts/relationships/preferences | `IN_PROMPT`       |
| Session                | chat                | current-session details                 | `IN_CHAT` depth 3 |
| Scenes                 | chat                | scene summaries/history                 | `IN_CHAT` depth 6 |
| Story arcs             | chat (+ persistent) | open plot threads                       | `IN_CHAT` depth 2 |
| Canon                  | character           | stabilised narrative history            | `IN_PROMPT`       |
| Profiles               | character           | regenerated character/world state       | `IN_PROMPT`       |
| Relationships          | character           | per-pair emotional state                | `IN_CHAT` depth 5 |
| Perspectives & Secrets | chat                | who knows/suspects/conceals what        | `IN_CHAT` depth 2 |
| State Ledger           | chat                | current entity state cards              | `IN_CHAT` depth 2 |

### Injection placement semantics

SillyTavern's `setExtensionPrompt` takes `(key, value, position, depth, scan,
role)`. `position` is one of:

- `extension_prompt_types.IN_PROMPT` (`2`) — prepended at the top of the prompt.
  **Depth is ignored.**
- `extension_prompt_types.IN_CHAT` (`1`) — inserted into the chat at `depth`
  messages before the generation point.
- `extension_prompt_types.NONE` (`0`) — clear the slot.

Epistemic and State Ledger are deliberately injected at **`IN_CHAT`, depth 2**
(near the end of the prompt). `IN_PROMPT` looked like "near the generation
point" because it has a depth value, but SillyTavern ignores depth for
`IN_PROMPT` and places the block at the very top. All fallbacks in
`epistemic.js` / `state-ledger.js` follow the same rule
(`settings.*_position ?? IN_CHAT`, `settings.*_depth ?? 2`).

## 4. Storage model

- **Chat-scoped** (`context.chatMetadata[META_KEY]`): summary, scene history,
  arcs, arc summaries, epistemic knowledge, state ledger, durable retcons,
  pending repair, budget overrides, `lastExtractCutoff`, `state_snapshots`.
- **Character-scoped** (`extension_settings.smart_memory.characters[name]`):
  long-term memories, entity registry, profiles, canon, persistent arcs,
  relationship history.
- **Group-scoped** (`extension_settings.smart_memory.group_arcs`): persistent
  group arcs.

Chat-scoped data is intentionally isolated so different chats/AU branches with
the same character never cross-contaminate secrets or extracted state.

## 5. Rollback and state snapshots

The core invariant: **state from a discarded branch must never survive.**

`state-snapshot.js` stores a bounded history (`MAX_STATE_SNAPSHOTS = 20`) of
deep-cloned snapshots tagged with the highest chat index they reflect:

```js
{
  msg_index,
  state_ledger,
  storyArcs,
  epistemic,
  durable_retcons,
}
```

Snapshots are taken:

- after each extraction pass (`takeStateSnapshot(snapshotCutoff)`),
- after auto-continuity creates a durable retcon,
- after manual state mutations: state-card set/delete, arc save/delete,
  epistemic save/clear (N2 fix), so a later swipe cannot wipe a manual edit.

On `MESSAGE_SWIPED`, `MESSAGE_DELETED`, or an edit to an already-extracted
message, `rollbackSnapshotOnMeta(meta, target)` restores the newest snapshot at
or before `target`, prunes later snapshots, and **rewinds
`meta.lastExtractCutoff`** so the rewritten branch is extracted again instead of
being skipped (N3 fix).

`MESSAGE_EDITED` handling in `index.js` additionally rewinds
`sceneBufferLastIndex` and refreshes the UI. If the edit is newer than the last
extraction cutoff, no rollback is needed.

## 6. Continuity and durable retcons

`checkContinuity` gives the model the **recent transcript as ground truth** plus
baseline notes (card, summary, memories), and requires each reported
contradiction to quote both the response and the baseline verbatim.
`validateIssue` then rejects:

- non-permanent categories,
- trivial/stopword-only quotes,
- active in-story transformations of the same trait,
- transitions already depicted in the transcript.

Two precision rules worth preserving:

1. **Attribute noun gate (3.6).** If an issue is about `eyes`, a transcript
   sentence about a `cloak` or `hair` must not suppress it. When the issue's
   `attributeNouns` set is non-empty, the sentence must mention one of them.
2. **Possessive subject linkers (3.5).** `"The spell turned Elara's eyes
green"` is an active transformation. Character names from the issue fact and
   the possessive `s` token are valid linkers between the verb and the trait.

### Durable retcon lifecycle

A confirmed contradiction creates a retcon:

```js
{
  (id, fact, quote, category, as_of_msg, created_at, turns_remaining);
}
```

It is re-injected for `RETCON_TURNS` AI turns. When it **auto-expires** or the
**user accepts** the changed state (echoes the quote), Smart Memory follows the
state instead of fighting it (N4 fix):

- the old long-term memory matching `retcon.fact` is retired via
  `superseded_by`,
- the resolved fact becomes a new active baseline memory,
- if the retcon maps to a state-card attribute (injury, outfit, mood, location,
  goal, carried item), the entity card is updated.

This prevents an endless re-flag loop after the retcon window closes.

### Group chats

- `advanceDurableRetcons` runs **once per full group round**, in
  `onGroupWrapperFinished` — never per member.
- The durable retcon note is re-injected for **every member** in the round;
  only the one-shot anchored repair note is limited to the first member.

## 7. Entity linking precision

`entity-registry.js` links memories to entities by name/alias. ASCII `\b` is
wrong for non-Latin scripts, so (N1 fix):

- CJK/Hiragana/Katakana/Hangul/Thai names use lowercase substring matching
  (those scripts have no inter-word spaces) and a lower length floor (2 chars).
- All other scripts use Unicode lookaround boundaries:
  `(?<![\p{L}\p{N}_])name(?![\p{L}\p{N}_])` with `iu` flags.

This links `Zoë`, `Éowyn`, `José`, `Ødegård`, `Мария`, and `艾拉`, while still
rejecting `King Aldric` → “making”, `Ann` → “Joanna”, and `Eli` → “believes”.

## 8. Epistemic subject matching

`matchSubjectToMember` resolves model-emitted subjects to canonical group
members (N7 fix). Both sides are cleaned: lowercase, strip possessive
`'s`/`’s`, punctuation, and honorific titles (`lady`, `lord`, `sir`, `captain`,
`dr`, `doctor`, `king`, `queen`, `prince`, `princess`). Matching is
**bidirectional** token containment plus exact/title-stripped equality:

- `Elara` → `Elara Voss`
- `Kael Draven` → `Kael`
- `Lady Elara` → `Elara`
- `Elara` → `Lady Elara`

If more than one member matches, the result is `null` and a warning is logged —
misattributing a secret is worse than dropping it. Arbitrary substring matching
is never used (`Evan` must not match `Evangeline Cole`).

## 9. Design decisions

- **Precision over recall.** A missed memory is recoverable on the next pass; a
  wrong secret or a spurious correction corrupts the story.
- **Forward-only repair.** The checker never asks the model to retract,
  rewind, or re-narrate written events.
- **Chat isolation.** Epistemic knowledge, state, arcs, and retcons live in
  `chatMetadata`, not global settings.
- **Snapshot before/after mutation.** Every state-changing path that is not a
  normal extraction pass records a snapshot so rollback cannot undo manual
  edits.
- **Pure cores, runtime shells.** Validation, matching, snapshots, and migration
  live in runtime-free modules and are unit-tested under plain Node.
- **Feature gates are honest.** Disabled tiers clear their prompt slot rather
  than leaving stale content behind.

## 10. Testing and tooling

```bash
npm test            # regression harness + node --test tests/*.test.js
npm run test:unit   # unit tests only
npm run lint        # eslint .
npm run format:check
npm run format      # prettier --write
```

The regression harness (`test-harness.mjs`) replays golden model responses so
prompt/parse changes can be checked without a live model.

## 11. Revision history

### v2.1 adversarial resilience fixes (current)

- **Branch revision guarding.** Added synchronous `operationRevision` / `bumpOperationRevision()` token bumped on chat change, swipe, edit, delete, and abort. Async pipelines abort before writing state if `branchChanged()`.
- **State Ledger allowlist enforcement.** Enforced strict allowlist matching active entities/characters, rejecting hallucinated cards. Bounded cards to 100 with character-preferential pruning; capped field strings to 500 characters.
- **Unicode-aware token budgeting.** `estimateTokens` weights non-Latin scripts (CJK, Arabic, Thai, Devanagari) at 1.5 tokens/char to prevent context blowout.
- **Multi-controller aborts & abort-aware sleep.** Abort controllers are tracked in a Set; retry sleep is abort-aware so cancellations immediately stop network requests.
- **Metadata bounding.** Arc summaries capped at 50, canon prompt arc input capped at 20, epistemic entries capped at 100 per chat; mass retirement guarded and clamped to 5 positive integers.
- **Prototype pollution protection.** `safeStorageKey` guards object keys (`__proto__`, `constructor`, `prototype`).
- **Group ID normalization.** `sameGroupId` unifies string vs numeric group ID comparisons across UI, settings, and memory tiers.
- **Profile partial output merging.** Partial model XML outputs merge into existing profiles without blanking omitted sections.
- **Unified cache invalidation.** Invalidation added to relationship history and triggered memory clear paths; reinjection wired to settings toggle.

### v2 critique fixes

- **N1** Unicode-aware entity boundaries; CJK/Thai substring fallback.
- **N2** Snapshots on manual state mutations (state cards, arcs, epistemic).
- **N3** Mid-chat edit/delete rewinds `lastExtractCutoff` and state.
- **N4** Durable retcons follow state on expiry/acceptance; group note applies to
  all members and lifetime decrements once per round.
- **N5/F6/F7** Epistemic + State Ledger placement corrected to `IN_CHAT` depth 2
  with migration of both legacy and interim defaults.
- **3.5** Possessive subject names link verbs to traits.
- **3.6** Attribute-noun gate prevents unrelated sentences from suppressing a
  contradiction.
- **3.6/N7** Bidirectional, title-aware epistemic subject matching.

### Earlier work

- Message-anchored rollback state, durable retcons, chat-scoped epistemic store,
  entity/continuity precision fixes.
- Critique regressions: over-suppression, partial healing wipes, group name
  ambiguity, markdown summary parsing.
- Architecture overhaul: temporal drift, concurrency, group chat, robustness.

## 12. Contribution checklist

1. Keep pure logic out of SillyTavern-importing modules so it stays testable.
2. Add a unit test for every behavioural change.
3. Run `npm test`, `npm run lint`, and `npm run format:check`.
4. Update `CHANGELOG.md` under `[Unreleased]`.
5. If a default changes, add a one-time migration guarded by a flag; never
   overwrite an explicit user choice.
6. If a rollback-visible state is mutated outside extraction, take a snapshot.
