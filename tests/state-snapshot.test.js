import test from 'node:test';
import assert from 'node:assert/strict';

import {
  takeSnapshotOnMeta,
  rollbackSnapshotOnMeta,
  findSnapshotIndexForRollback,
  MAX_STATE_SNAPSHOTS,
} from '../state-snapshot.js';
import { resolveChatEpistemic } from '../epistemic-utils.js';

// =========================================================================
// Message-anchored snapshots & rollback on swipe/delete
// =========================================================================

test('rollback: an item added at turn 10 is completely gone after rolling back to turn 9', () => {
  const meta = { state_ledger: {} };

  // State as of turn 9: the ledger has no sword yet.
  takeSnapshotOnMeta(meta, 9);

  // Turn 10 extraction adds an item and records a snapshot.
  meta.state_ledger['sword|object'] = { owner: 'Elara', condition: 'pristine' };
  takeSnapshotOnMeta(meta, 10);
  assert.deepEqual(meta.state_ledger['sword|object'], { owner: 'Elara', condition: 'pristine' });

  // Swipe/delete of turn 10 rolls back to turn 9.
  rollbackSnapshotOnMeta(meta, 9);

  assert.equal(meta.state_ledger['sword|object'], undefined);
  assert.deepEqual(meta.state_ledger, {});
  // The turn-10 snapshot itself is pruned.
  assert.equal(
    meta.state_snapshots.some((s) => s.msg_index === 10),
    false,
  );
});

test('rollback: restores story arcs and perspectives added on the discarded turn', () => {
  const meta = {
    state_ledger: {},
    storyArcs: [],
    epistemic_knowledge: [],
  };

  takeSnapshotOnMeta(meta, 4);

  meta.storyArcs.push({ content: 'Elara swore to return the blade.' });
  meta.epistemic_knowledge.push({ id: 'k1', type: 'knows', subject: 'Elara', content: 'secret' });
  takeSnapshotOnMeta(meta, 5);

  rollbackSnapshotOnMeta(meta, 4);

  assert.deepEqual(meta.storyArcs, []);
  assert.deepEqual(meta.epistemic_knowledge, []);
});

test('rollback: restores the previous durable retcon state', () => {
  const meta = { durable_retcons: [{ id: 'old', fact: 'Elara is an elf.', turns_remaining: 3 }] };

  takeSnapshotOnMeta(meta, 7);

  // A new contradiction is retconned on turn 8.
  meta.durable_retcons.push({ id: 'new', fact: 'Elara has silver eyes.', turns_remaining: 5 });
  takeSnapshotOnMeta(meta, 8);
  assert.equal(meta.durable_retcons.length, 2);

  rollbackSnapshotOnMeta(meta, 7);

  assert.equal(meta.durable_retcons.length, 1);
  assert.equal(meta.durable_retcons[0].id, 'old');
});

test('rollback: picks the latest snapshot at or before the target turn', () => {
  const meta = {};
  takeSnapshotOnMeta(meta, 2);
  meta.state_ledger = { 'a|character': { mood: 'calm' } };
  takeSnapshotOnMeta(meta, 5);
  meta.state_ledger = { 'a|character': { mood: 'furious' } };
  takeSnapshotOnMeta(meta, 9);

  // Roll back to turn 6: should restore the turn-5 snapshot, not turn 2.
  rollbackSnapshotOnMeta(meta, 6);
  assert.deepEqual(meta.state_ledger, { 'a|character': { mood: 'calm' } });
  assert.deepEqual(
    meta.state_snapshots.map((s) => s.msg_index),
    [2, 5],
  );
});

test('rollback: resets tracked state to empty when no snapshot qualifies', () => {
  const meta = { state_ledger: {}, storyArcs: [], epistemic_knowledge: [] };
  takeSnapshotOnMeta(meta, 3);
  meta.state_ledger['ghost|character'] = { mood: 'doomed' };
  // No snapshot was taken for this addition.

  rollbackSnapshotOnMeta(meta, 0);

  assert.deepEqual(meta.state_ledger, {});
  assert.deepEqual(meta.storyArcs, []);
  assert.deepEqual(meta.epistemic_knowledge, []);
  assert.deepEqual(meta.state_snapshots, []);
});

test('snapshot: re-capturing the same message index replaces rather than duplicates', () => {
  const meta = { state_ledger: {} };
  takeSnapshotOnMeta(meta, 3);
  meta.state_ledger['x|object'] = { condition: 'broken' };
  takeSnapshotOnMeta(meta, 3);

  assert.equal(meta.state_snapshots.length, 1);
  assert.deepEqual(meta.state_snapshots[0].state_ledger, { 'x|object': { condition: 'broken' } });
});

test('snapshot: retains at most MAX_STATE_SNAPSHOTS, dropping the oldest', () => {
  const meta = {};
  for (let i = 0; i < MAX_STATE_SNAPSHOTS + 5; i++) {
    takeSnapshotOnMeta(meta, i);
  }

  assert.equal(meta.state_snapshots.length, MAX_STATE_SNAPSHOTS);
  // The oldest five (0..4) are gone; the newest index remains.
  assert.equal(meta.state_snapshots[0].msg_index, 5);
  assert.equal(
    meta.state_snapshots[meta.state_snapshots.length - 1].msg_index,
    MAX_STATE_SNAPSHOTS + 4,
  );
});

test('snapshot: captures are deep clones (later mutation does not rewrite history)', () => {
  const meta = { state_ledger: {} };
  meta.state_ledger['a|character'] = { mood: 'calm' };
  takeSnapshotOnMeta(meta, 1);

  meta.state_ledger['a|character'].mood = 'furious';

  assert.equal(meta.state_snapshots[0].state_ledger['a|character'].mood, 'calm');
});

test('findSnapshotIndexForRollback: returns -1 for empty/invalid input', () => {
  assert.equal(findSnapshotIndexForRollback([], 5), -1);
  assert.equal(findSnapshotIndexForRollback(null, 5), -1);
  assert.equal(findSnapshotIndexForRollback([{ msg_index: 10 }], 5), -1);
});

// =========================================================================
// Chat-scoped epistemic storage isolation
// =========================================================================

test('epistemic: two chats with the same character never share entries', () => {
  const chatA = { epistemic_knowledge: [{ id: 'a1', content: 'A secret' }] };
  const chatB = { epistemic_knowledge: [] };

  const a = resolveChatEpistemic(chatA, [{ id: 'legacy', content: 'legacy' }]);
  const b = resolveChatEpistemic(chatB, [{ id: 'legacy', content: 'legacy' }]);

  // An existing (even empty) chat-scoped store is authoritative - no legacy copy.
  assert.equal(a.migrated, false);
  assert.equal(b.migrated, false);
  assert.equal(chatA.epistemic_knowledge.length, 1);
  assert.equal(chatB.epistemic_knowledge.length, 0);

  chatA.epistemic_knowledge.push({ id: 'a2', content: 'Another secret' });
  assert.equal(chatB.epistemic_knowledge.length, 0, 'chat B must not see chat A entries');
});

test('epistemic: a chat with no store migrates legacy once, into that chat only', () => {
  const meta = {};
  const legacy = [{ id: 'l1', type: 'knows', subject: 'Elara', content: 'she is the heir' }];

  const first = resolveChatEpistemic(meta, legacy);
  assert.equal(first.migrated, true);
  assert.equal(first.entries.length, 1);
  assert.equal(meta.epistemic_knowledge.length, 1);

  // The migrated entry is a clone - mutating it does not touch the legacy array.
  meta.epistemic_knowledge[0].content = 'changed';
  assert.equal(legacy[0].content, 'she is the heir');

  // A second read no longer migrates.
  const second = resolveChatEpistemic(meta, legacy);
  assert.equal(second.migrated, false);
  assert.equal(second.entries.length, 1);
});

test('epistemic: an empty legacy store leaves the chat empty', () => {
  const meta = {};
  const result = resolveChatEpistemic(meta, []);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.entries, []);
  assert.equal(meta.epistemic_knowledge, undefined);
});

// =========================================================================
// N3: rollback rewinds the extraction cursor
// =========================================================================

test('rollback: rewinds lastExtractCutoff to the rollback target', () => {
  const meta = { state_ledger: {}, lastExtractCutoff: 12 };
  takeSnapshotOnMeta(meta, 9);
  takeSnapshotOnMeta(meta, 10);

  rollbackSnapshotOnMeta(meta, 8);

  // The latest snapshot at or before 8 is 9? No - 9 > 8, so none qualifies.
  // The cursor must still rewind so the rewritten branch is re-extracted.
  assert.equal(meta.lastExtractCutoff, 8);
});

test('rollback: rewinds lastExtractCutoff to the surviving snapshot turn', () => {
  const meta = { state_ledger: {}, lastExtractCutoff: 12 };
  takeSnapshotOnMeta(meta, 7);
  takeSnapshotOnMeta(meta, 10);

  rollbackSnapshotOnMeta(meta, 9);

  assert.equal(meta.lastExtractCutoff, 9);
});

test('rollback: does not advance a cutoff that is already behind the target', () => {
  const meta = { state_ledger: {}, lastExtractCutoff: 2 };
  takeSnapshotOnMeta(meta, 7);

  rollbackSnapshotOnMeta(meta, 9);

  assert.equal(meta.lastExtractCutoff, 2);
});

test('rollback: clamps lastExtractCutoff at zero for the first turn', () => {
  const meta = { state_ledger: {}, lastExtractCutoff: 5 };
  takeSnapshotOnMeta(meta, 0);

  rollbackSnapshotOnMeta(meta, -1);

  assert.equal(meta.lastExtractCutoff, 0);
});
