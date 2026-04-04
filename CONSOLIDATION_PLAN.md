# Consolidation Redesign Plan

## Problem

Long-term and session memories accumulate redundant entries over time. Each
extraction pass adds new entries that partially overlap with existing ones -
same facts in different wording, same scenes described twice, same relationship
dynamics restated with minor variation. The current consolidation runs after
every extraction batch and rewrites the entire memory list, which causes
progressive detail loss: each pass compresses a little more until only 1-2
vague summaries remain.

## Design

### Core idea

Maintain a **stable consolidated base** per memory type. Newly extracted
memories are held as **unprocessed** until enough accumulate to warrant a
consolidation pass. When the threshold is reached, only the unprocessed batch
is evaluated against the base - not the base itself. The base never gets
rewritten, only extended.

Each new memory is classified as one of:
- **Duplicate** - already captured in the base, drop it
- **New detail** - adds something to an existing base entry, fold it in
- **Genuinely new** - not covered at all, add it to the base

### Per-type isolation

Consolidation compares within category only:
- Long-term: `fact` vs `fact`, `relationship` vs `relationship`,
  `preference` vs `preference`, `event` vs `event`
- Session: `scene` vs `scene`, `revelation` vs `revelation`,
  `development` vs `development`, `detail` vs `detail`

No cross-category comparison - a `scene` entry is never compared against a
`revelation` entry.

### Threshold

Consolidation fires when the **unprocessed count for a given type** reaches a
threshold (suggested: 3-5 entries). This keeps each consolidation pass small
and fast, completing within the time a user is typing their next message.

### Data model changes

#### Long-term memory entries

Add a `consolidated` boolean flag:

```js
{
  type: 'fact',
  content: '...',
  ts: 1234567890,
  consolidated: true   // part of the stable base
}
```

New entries from extraction start with `consolidated: false`.

#### Session memory entries

Same `consolidated` flag added to session memory entries.

### Prompt changes

Replace the current "rewrite the whole list" consolidation prompt with a
targeted prompt that:
- Shows the existing consolidated base for this type (read-only context)
- Shows the small batch of unprocessed entries
- Asks the model to classify each unprocessed entry: drop / fold in / keep
- For "fold in": specifies which base entry to extend and what detail to add
- For "keep": adds the entry as-is to the base
- Stricter instructions: never remove base entries, never paraphrase base
  entries, only output what changes

### Trigger changes

#### Current behaviour
- Consolidation runs after every extraction batch that adds new memories
- Sends the entire memory list to the model

#### New behaviour
- After extraction, check unprocessed count per type
- If any type has >= threshold unprocessed entries, run consolidation for
  that type only
- Each type consolidates independently - a burst of new `fact` entries
  doesn't trigger `relationship` consolidation

### Affected files

- **`longterm.js`** - data model (add `consolidated` flag), consolidation
  logic, prompt call
- **`session.js`** - data model (add `consolidated` flag), new consolidation
  function (session currently has no consolidation at all)
- **`prompts.js`** - new consolidation prompt replacing the current one;
  separate prompts for long-term and session may be needed given different
  type vocabularies
- **`index.js`** - update consolidation trigger logic in both the background
  extraction path and the catch-up loop; add session consolidation call

### What does NOT change

- The injection layer - consolidated and unprocessed entries are both injected,
  the flag is internal bookkeeping only
- The viewer UI - no changes needed, entries look the same to the user
- The token budget trimming - still drops oldest entries first when over budget
- The max memories cap - still applies to the total count

## Future: importance-aware trimming

Currently when memories exceed the token budget, oldest entries are dropped
first regardless of value. "They are husband and wife" should outlast "they
had pasta for dinner."

A good approach would be to add an `importance` score (e.g. 1-3) to each
memory entry at extraction time, so trimming can prefer dropping low-importance
old entries before high-importance ones. Age would still be a tiebreaker.

This is intentionally deferred until after consolidation is complete:

- Consolidation reduces redundancy, which means the budget lasts longer and
  trimming fires less often
- The two features don't interfere with each other
- Adding importance scoring is a clean, self-contained change that can be
  designed and tested independently

## Implementation steps

- [ ] Add `consolidated` flag to long-term memory entries; migrate existing
      entries (treat all existing as `consolidated: true`)
- [ ] Rewrite `consolidateMemories` in `longterm.js` to use the new per-type,
      unprocessed-batch approach
- [ ] Write new consolidation prompt(s) in `prompts.js`
- [ ] Add `consolidated` flag to session memory entries
- [ ] Write `consolidateSessionMemories` in `session.js`
- [ ] Update trigger logic in `index.js` for both background path and catch-up
- [ ] Test: long-term consolidation runs at threshold, base stays stable
- [ ] Test: session consolidation runs at threshold, base stays stable
- [ ] Test: duplicate entries are dropped, new details are folded in
- [ ] Test: cross-type entries are not compared against each other
- [ ] Lint, commit, bump version