import test from 'node:test';
import assert from 'node:assert/strict';
import {
  unionSourceRanges,
  memorySupportedAfterRollback,
  correlateGenerationGate,
  isDuplicateChatLoad,
  recapCompletionOwnsSlot,
  GENERATION_TERMINAL_COALESCE_MS,
} from '../memory-utils.js';

// ---- M-1: impossible provenance ranges must never be trusted ----------------

test('unionSourceRanges: negative range forces source_incomplete and is dropped', () => {
  const u = unionSourceRanges([{ source_messages: [[99, -1]], source_chat_id: 'c' }]);
  assert.equal(u.source_incomplete, true);
  assert.deepEqual(u.source_messages, []);
});

test('unionSourceRanges: reversed range forces source_incomplete even alongside a valid one', () => {
  const reversed = unionSourceRanges([{ source_messages: [[9, 3]], source_chat_id: 'c' }]);
  assert.equal(reversed.source_incomplete, true);
  assert.deepEqual(reversed.source_messages, []);

  const mixed = unionSourceRanges([
    {
      source_messages: [
        [1, 2],
        [9, 3],
      ],
      source_chat_id: 'c',
    },
  ]);
  assert.equal(mixed.source_incomplete, true);
  // The valid interval is still carried, but the union is not trustworthy.
  assert.deepEqual(mixed.source_messages, [[1, 2]]);
});

test('unionSourceRanges: non-integer / short ranges force source_incomplete', () => {
  for (const bad of [[['x', null]], [[1.5, 2]], [[1]], [[0, -0.5]], [null]]) {
    const u = unionSourceRanges([{ source_messages: bad, source_chat_id: 'c' }]);
    assert.equal(u.source_incomplete, true, `expected incomplete for ${JSON.stringify(bad)}`);
  }
});

test('memorySupportedAfterRollback: keeps a memory whose range is negative or reversed', () => {
  // Previously [[99, -1]] was accepted, start 99 > target 5, so the memory was
  // wrongly pruned. Conservative behavior is to keep it.
  assert.equal(
    memorySupportedAfterRollback({ source_messages: [[99, -1]], source_chat_id: 'c' }, 5, 'c'),
    true,
  );
  assert.equal(
    memorySupportedAfterRollback({ source_messages: [[9, 3]], source_chat_id: 'c' }, 5, 'c'),
    true,
  );
});

test('memorySupportedAfterRollback: any malformed range keeps the memory', () => {
  const malformed = [
    [
      [1, 2],
      ['x', null],
    ],
    [[5, '9']],
    [[1.2, 3]],
    [[4]],
    [null],
    [[-1, 4]],
  ];
  for (const ranges of malformed) {
    assert.equal(
      memorySupportedAfterRollback({ source_messages: ranges, source_chat_id: 'c' }, 5, 'c'),
      true,
      `expected keep for ${JSON.stringify(ranges)}`,
    );
  }
});

test('memorySupportedAfterRollback: still prunes a fully valid range past the target', () => {
  assert.equal(
    memorySupportedAfterRollback({ source_messages: [[10, 20]], source_chat_id: 'c' }, 5, 'c'),
    false,
  );
  // A valid range list with a surviving earlier start is kept.
  assert.equal(
    memorySupportedAfterRollback(
      {
        source_messages: [
          [1, 2],
          [10, 20],
        ],
        source_chat_id: 'c',
      },
      5,
      'c',
    ),
    true,
  );
});

// ---- M-2: numeric vs string chat ids stay consistent -------------------------

test('unionSourceRanges: mixed numeric/string chat ids normalize to one canonical string', () => {
  const u = unionSourceRanges([
    { source_messages: [[1, 2]], source_chat_id: 1 },
    { source_messages: [[10, 12]], source_chat_id: '1' },
  ]);
  assert.equal(u.source_incomplete, false);
  assert.equal(u.source_chat_id, '1');
});

test('unionSourceRanges: single numeric contributor is returned in string form', () => {
  const u = unionSourceRanges([{ source_messages: [[1, 2]], source_chat_id: 7 }]);
  assert.equal(u.source_incomplete, false);
  assert.equal(u.source_chat_id, '7');
});

test('unionSourceRanges + rollback: mixed-id union is not "complete-then-kept-forever"', () => {
  const u = unionSourceRanges([
    { source_messages: [[1, 2]], source_chat_id: 1 },
    { source_messages: [[10, 12]], source_chat_id: '1' },
  ]);
  assert.equal(u.source_incomplete, false);
  const consolidated = {
    source_messages: u.source_messages,
    source_chat_id: u.source_chat_id,
    source_incomplete: u.source_incomplete,
  };
  // The host reports the string form; the numeric/id-normalized provenance must
  // still be recognized as THIS chat and pruned (earliest start 1 survives a
  // rollback to 0? no - 1 > 0, so it is unsupported). The key point is that it
  // is not misclassified as another chat and retained forever.
  assert.equal(memorySupportedAfterRollback(consolidated, 0, '1'), false);
  // And it is kept when an earlier source actually survives the rollback point.
  assert.equal(memorySupportedAfterRollback(consolidated, 5, '1'), true);
});

test('memorySupportedAfterRollback: numeric and string current ids behave identically', () => {
  const numericStored = { source_messages: [[10, 20]], source_chat_id: 1 };
  const stringStored = { source_messages: [[10, 20]], source_chat_id: '1' };
  for (const current of [1, '1']) {
    assert.equal(memorySupportedAfterRollback(numericStored, 5, current), false);
    assert.equal(memorySupportedAfterRollback(stringStored, 5, current), false);
    assert.equal(memorySupportedAfterRollback(numericStored, 15, current), true);
  }
  // A genuinely different chat is always kept.
  assert.equal(memorySupportedAfterRollback(numericStored, 5, '2'), true);
  assert.equal(memorySupportedAfterRollback(numericStored, 5, 2), true);
});

// ---- M-3: generation gate FIFO correlation ----------------------------------

const freshGate = () => ({ pending: 0, inProgress: false, lastTerminalAt: -Infinity });

test('generation gate: an immediate real cancel still clears the gate', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  assert.equal(s.pending, 1);
  assert.equal(s.inProgress, true);
  s = correlateGenerationGate(s, 'terminal', 50);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

test('generation gate: a delayed old terminal does not clear a newer generation', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // generation A
  s = correlateGenerationGate(s, 'start', 100); // generation B starts before A's stop
  assert.equal(s.pending, 2);

  s = correlateGenerationGate(s, 'terminal', 200); // A's delayed GENERATION_STOPPED
  assert.equal(s.pending, 1);
  assert.equal(s.inProgress, true, "B's gate must remain set");

  s = correlateGenerationGate(s, 'terminal', 300); // B's own stop
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

test('generation gate: STOPPED+ENDED for one aborted generation dequeue only once', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // A
  s = correlateGenerationGate(s, 'start', 100); // B

  // stopGeneration() emits STOPPED, then hideStopButton() emits ENDED.
  s = correlateGenerationGate(s, 'terminal', 200);
  assert.equal(s.pending, 1);
  assert.equal(s.inProgress, true);
  s = correlateGenerationGate(s, 'terminal', 200 + GENERATION_TERMINAL_COALESCE_MS / 2);
  assert.equal(s.pending, 1, 'the ENDED pair must not dequeue a second generation');
  assert.equal(s.inProgress, true);

  // A later, distinct terminal for B does clear.
  s = correlateGenerationGate(s, 'terminal', 600);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

test('generation gate: MESSAGE_RECEIVED opens the gate but retains the pending slot', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  s = correlateGenerationGate(s, 'complete', 50);
  assert.equal(s.inProgress, false, 'normal completion lets extraction run');
  assert.equal(s.pending, 1, 'the trailing terminal still owns a slot');

  s = correlateGenerationGate(s, 'terminal', 60);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

test('generation gate: stale terminal with no pending generation is a no-op', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'terminal', 10);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

test('generation gate: reset (chat switch) clears pending and gate', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  s = correlateGenerationGate(s, 'start', 10);
  s = correlateGenerationGate(s, 'reset', 20);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

// ---- L-2: duplicate chat-load coalescing -------------------------------------

test('isDuplicateChatLoad: same normalized id coalesces within the window', () => {
  const metaA = {};
  assert.equal(isDuplicateChatLoad({ id: '1', meta: metaA }, { id: '1', meta: metaA }, 50), true);
  // id is authoritative even when metadata differs.
  assert.equal(isDuplicateChatLoad({ id: '1', meta: metaA }, { id: '1', meta: null }, 50), true);
});

test('isDuplicateChatLoad: different ids never coalesce', () => {
  assert.equal(isDuplicateChatLoad({ id: '1', meta: null }, { id: '2', meta: null }, 10), false);
});

test('isDuplicateChatLoad: null chat id falls back to the chatMetadata reference', () => {
  const metaA = {};
  const metaB = {};
  assert.equal(isDuplicateChatLoad({ id: null, meta: metaA }, { id: null, meta: metaA }, 10), true);
  assert.equal(
    isDuplicateChatLoad({ id: null, meta: metaA }, { id: null, meta: metaB }, 10),
    false,
  );
  // A genuine switch to a new chat with no id still bumps.
  assert.equal(isDuplicateChatLoad({ id: null, meta: metaB }, { id: null, meta: metaB }, 10), true);
});

test('isDuplicateChatLoad: id settling from null to a value still coalesces', () => {
  const metaA = {};
  // Event 1 saw no id; event 2 settled to the id of the same load.
  assert.equal(isDuplicateChatLoad({ id: null, meta: metaA }, { id: '5', meta: metaA }, 20), true);
  assert.equal(isDuplicateChatLoad({ id: '5', meta: metaA }, { id: null, meta: metaA }, 20), true);
});

test('isDuplicateChatLoad: window expiry and absent identity never coalesce', () => {
  const metaA = {};
  assert.equal(isDuplicateChatLoad({ id: '1', meta: metaA }, { id: '1', meta: metaA }, 300), false);
  assert.equal(isDuplicateChatLoad({ id: '1', meta: metaA }, { id: '1', meta: metaA }, 900), false);
  // No id and no metadata: cannot prove duplication, so treat as a switch.
  assert.equal(isDuplicateChatLoad({ id: null, meta: null }, { id: null, meta: null }, 5), false);
});

// ---- L-1: detached recap ownership -------------------------------------------

test('recapCompletionOwnsSlot: same chat + same handle still owns the slot', () => {
  const meta = {};
  const handle = {};
  assert.equal(
    recapCompletionOwnsSlot({
      capturedMeta: meta,
      currentMeta: meta,
      capturedHandle: handle,
      activeHandle: handle,
    }),
    true,
  );
  // An idle slot (e.g. a duplicate event reset activeRecapHandle) is still ours.
  assert.equal(
    recapCompletionOwnsSlot({
      capturedMeta: meta,
      currentMeta: meta,
      capturedHandle: handle,
      activeHandle: null,
    }),
    true,
  );
});

test('recapCompletionOwnsSlot: a different chat makes the completion stale', () => {
  const metaA = {};
  const metaB = {};
  const handle = {};
  assert.equal(
    recapCompletionOwnsSlot({
      capturedMeta: metaA,
      currentMeta: metaB,
      capturedHandle: handle,
      activeHandle: handle,
    }),
    false,
  );
});

test('recapCompletionOwnsSlot: a different active handle makes the completion stale', () => {
  const meta = {};
  assert.equal(
    recapCompletionOwnsSlot({
      capturedMeta: meta,
      currentMeta: meta,
      capturedHandle: {},
      activeHandle: {},
    }),
    false,
  );
});

test('recapCompletionOwnsSlot: null metadata on both sides is not stale', () => {
  const handle = {};
  assert.equal(
    recapCompletionOwnsSlot({
      capturedMeta: null,
      currentMeta: null,
      capturedHandle: handle,
      activeHandle: handle,
    }),
    true,
  );
});
