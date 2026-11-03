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

const freshGate = () => ({
  pending: 0,
  inProgress: false,
  awaitingPair: null,
  lastTerminalAt: -Infinity,
});

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
  s = correlateGenerationGate(s, 'stopped', 200);
  assert.equal(s.pending, 1);
  assert.equal(s.inProgress, true);
  assert.equal(s.awaitingPair, 'ended');
  s = correlateGenerationGate(s, 'ended', 200 + GENERATION_TERMINAL_COALESCE_MS / 2);
  assert.equal(s.pending, 1, 'the ENDED pair must not dequeue a second generation');
  assert.equal(s.inProgress, true);
  assert.equal(s.awaitingPair, null);

  // A later, distinct terminal for B does clear.
  s = correlateGenerationGate(s, 'stopped', 600);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

test('generation gate: MESSAGE_RECEIVED consumes the completed generation slot', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  s = correlateGenerationGate(s, 'complete', 50);
  assert.equal(s.inProgress, false, 'normal completion lets extraction run');
  assert.equal(s.pending, 0, 'normal completion authoritatively consumes its slot');
  assert.equal(s.awaitingPair, null, 'normal completion clears stale pair expectations');

  // The trailing terminal is now stale and must not change the clear gate.
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

// ---- H-1: terminal coalescing must not cross generation boundaries -----------

test('generation gate: stale terminal then start then real terminal within the window still clears', () => {
  let s = freshGate();
  // A stale terminal for an already-cleared gate must not arm the coalescing
  // marker for the generation that starts immediately afterwards.
  s = correlateGenerationGate(s, 'terminal', 0);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);

  s = correlateGenerationGate(s, 'start', 10);
  assert.equal(s.pending, 1);
  assert.equal(s.inProgress, true);

  // The real terminal lands inside the old 100ms window; it must clear.
  s = correlateGenerationGate(s, 'terminal', 50);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

test('generation gate: start A / terminal A / start B / terminal B inside one window clears', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // A
  s = correlateGenerationGate(s, 'terminal', 10); // A clears
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);

  s = correlateGenerationGate(s, 'start', 20); // B
  assert.equal(s.pending, 1);
  assert.equal(s.inProgress, true);

  s = correlateGenerationGate(s, 'terminal', 30); // B clears - not swallowed as A's duplicate
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

test('generation gate: STOPPED+ENDED for one generation at the same epoch clears once', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  s = correlateGenerationGate(s, 'terminal', 0);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);

  // The trailing ENDED is a no-op, not a second dequeue or a stuck gate.
  s = correlateGenerationGate(s, 'terminal', 0);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

test('generation gate: complete consumes its slot and the trailing terminal is stale', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  s = correlateGenerationGate(s, 'complete', 20);
  assert.equal(s.pending, 0, 'MESSAGE_RECEIVED authoritatively consumes the completed slot');
  assert.equal(s.inProgress, false, 'normal completion opens the gate');

  // A later terminal belongs to the already-completed generation and is a no-op.
  s = correlateGenerationGate(s, 'terminal', 40);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

// ---- H-2: event-kind-aware terminal pairing ----------------------------------

test('generation gate: a delayed STOPPED/ENDED pair for A never consumes B', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // generation A
  s = correlateGenerationGate(s, 'start', 10); // generation B
  assert.equal(s.pending, 2);

  // A's delayed cancel: STOPPED then ENDED, both for A.
  s = correlateGenerationGate(s, 'stopped', 20);
  assert.equal(s.pending, 1, "A's STOPPED consumes A's slot only");
  assert.equal(s.awaitingPair, 'ended');
  s = correlateGenerationGate(s, 'ended', 30);
  assert.equal(s.pending, 1, 'the ENDED pairs with A - it is not B');
  assert.equal(s.awaitingPair, null);

  // B's own real STOPPED must consume B's slot...
  s = correlateGenerationGate(s, 'stopped', 40);
  assert.equal(s.pending, 0, "B's real STOPPED must consume");
  assert.equal(s.inProgress, false);

  // ...and B's trailing ENDED is a stale no-op, not a second dequeue.
  s = correlateGenerationGate(s, 'ended', 50);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

test('generation gate: a matched STOPPED/ENDED pair for one generation counts once', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  s = correlateGenerationGate(s, 'stopped', 10);
  assert.equal(s.pending, 0, 'the STOPPED consumes the single pending generation');
  assert.equal(s.inProgress, false);

  // The slot was already consumed by the STOPPED, so the trailing ENDED is a
  // stale no-op and must not dequeue a second (non-existent) generation.
  s = correlateGenerationGate(s, 'ended', 20);
  assert.equal(s.pending, 0, 'the paired ENDED must not dequeue a second time');
  assert.equal(s.inProgress, false);
});

test('generation gate: a normal ENDED with no STOPPED clears the gate', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  s = correlateGenerationGate(s, 'ended', 10);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
  assert.equal(s.awaitingPair, null, 'a lone ENDED does not arm a pair');
});

test('generation gate: a lone ENDED consumes its slot and a trailing STOPPED is stale', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  s = correlateGenerationGate(s, 'ended', 10);
  // The lone ENDED consumed the slot and did not arm awaitingPair, so a
  // following STOPPED is stale and a no-op.
  assert.equal(s.pending, 0);
  assert.equal(s.awaitingPair, null);
  s = correlateGenerationGate(s, 'stopped', 20);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

// ---- H-3: the outstanding pair's timestamp must survive a start --------------

test('generation gate: a delayed ENDED for A after start B is collapsed, not consumed', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // A
  s = correlateGenerationGate(s, 'stopped', 10); // A stops; expects its ENDED
  assert.equal(s.pending, 0);
  assert.equal(s.awaitingPair, 'ended');

  s = correlateGenerationGate(s, 'start', 20); // B starts before A's ENDED lands
  assert.equal(s.pending, 1);
  assert.equal(s.awaitingPair, 'ended', 'the outstanding pair survives the start');
  assert.equal(
    s.lastTerminalAt,
    10,
    'the pair timestamp must survive the start so the collapse window is valid',
  );

  s = correlateGenerationGate(s, 'ended', 30); // A's delayed ENDED pairs with A's STOPPED
  assert.equal(s.pending, 1, "B's slot must NOT be consumed");
  assert.equal(s.inProgress, true);
  assert.equal(s.awaitingPair, null);
});

test('generation gate: delayed ENDED for B after start C is collapsed, not consumed', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // A
  s = correlateGenerationGate(s, 'start', 10); // B
  s = correlateGenerationGate(s, 'stopped', 20); // A
  s = correlateGenerationGate(s, 'ended', 30); // A pair, collapsed
  s = correlateGenerationGate(s, 'stopped', 40); // B stops; expects its ENDED
  assert.equal(s.pending, 0);
  assert.equal(s.awaitingPair, 'ended');

  s = correlateGenerationGate(s, 'start', 50); // C starts before B's ENDED lands
  assert.equal(s.pending, 1);

  s = correlateGenerationGate(s, 'ended', 60); // B's delayed ENDED pairs with B's STOPPED
  assert.equal(s.pending, 1, "C's slot must NOT be consumed");
  assert.equal(s.inProgress, true);
  assert.equal(s.awaitingPair, null);
});

test('generation gate: a stale pair marker older than the window still consumes', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  s = correlateGenerationGate(s, 'stopped', 10);
  s = correlateGenerationGate(s, 'start', 20);
  // The ENDED arrives far outside the coalescing window, so it is a genuinely
  // new terminal and must consume the pending generation.
  s = correlateGenerationGate(s, 'ended', 10 + GENERATION_TERMINAL_COALESCE_MS + 1);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
});

// ---- H-3 follow-up: a resolved pair must not linger past its cleared slot ----

test('generation gate: a cleared pair does not swallow the next generation normal ended', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // A
  s = correlateGenerationGate(s, 'stopped', 10); // A stops; expects its ENDED
  s = correlateGenerationGate(s, 'ended', 20); // A's pair resolves
  assert.equal(s.pending, 0);
  assert.equal(s.awaitingPair, null, 'the resolved pair must not linger');

  s = correlateGenerationGate(s, 'start', 30); // C
  s = correlateGenerationGate(s, 'ended', 40); // C's normal ENDED, inside the window
  assert.equal(s.pending, 0, "C's normal ENDED must consume, not be swallowed");
  assert.equal(s.inProgress, false);
  assert.equal(s.awaitingPair, null);
});

test('generation gate: an ENDED that resolves a cleared pair leaves awaitingPair null', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0);
  s = correlateGenerationGate(s, 'stopped', 10);
  assert.equal(s.awaitingPair, 'ended');

  // The slot is already cleared (pending 0); the awaited ENDED still arrives.
  s = correlateGenerationGate(s, 'ended', 20);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
  assert.equal(s.awaitingPair, null, 'the trailing ENDED resolves the pair');
});

// ---- H-4: documented "prefer extraction safety" policy -----------------------

test('generation gate: an unresolved old pair defers to the watchdog (documented safety policy)', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // A
  s = correlateGenerationGate(s, 'stopped', 10); // A stops; expects its ENDED
  s = correlateGenerationGate(s, 'start', 20); // B starts before A's pair resolves
  assert.equal(s.pending, 1);
  assert.equal(s.awaitingPair, 'ended');

  // `start A -> stopped A -> start B -> ended B` is indistinguishable from a
  // delayed `ended A`. The deliberate "prefer extraction safety" policy treats
  // it as A's outstanding pair and HOLDS B's gate. This is the trade-off: a
  // wrongly-cleared gate could extract partial streaming text (data corruption),
  // whereas a held gate only delays extraction and is bounded by the 90s
  // watchdog and by chat switch/reset.
  s = correlateGenerationGate(s, 'ended', 30);
  assert.equal(s.pending, 1, 'the gate stays held for B');
  assert.equal(s.inProgress, true);
  assert.equal(s.awaitingPair, null);

  // The watchdog or a chat switch ultimately resets the gate.
  s = correlateGenerationGate(s, 'reset', 40);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
  assert.equal(s.awaitingPair, null);
});

test('generation gate: a held unresolved pair recovers via reset (watchdog/chat-switch)', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // A
  s = correlateGenerationGate(s, 'stopped', 10); // A -> awaiting ENDED
  s = correlateGenerationGate(s, 'start', 20); // B
  s = correlateGenerationGate(s, 'ended', 30); // collapses as A's presumed pair
  assert.deepEqual(s, {
    pending: 1,
    inProgress: true,
    awaitingPair: null,
    lastTerminalAt: 30,
  });

  s = correlateGenerationGate(s, 'reset', 90000); // watchdog / chat switch
  assert.deepEqual(s, {
    pending: 0,
    inProgress: false,
    awaitingPair: null,
    lastTerminalAt: -Infinity,
  });
});

// ---- H-5: MESSAGE_RECEIVED must self-heal ambiguous pending accounting -------

test('generation gate: complete self-heals an ambiguously collapsed ENDED slot', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // A
  s = correlateGenerationGate(s, 'stopped', 10); // A awaits ENDED
  s = correlateGenerationGate(s, 'start', 20); // B
  s = correlateGenerationGate(s, 'complete', 25); // B committed a message
  assert.equal(s.pending, 0, 'MESSAGE_RECEIVED consumes B authoritatively');
  assert.equal(s.inProgress, false);
  assert.equal(s.awaitingPair, null);

  // The following ENDED could be A's old complement or B's terminal. Either way
  // it is stale after the authoritative completion and cannot retain a slot.
  s = correlateGenerationGate(s, 'ended', 30);
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
  assert.equal(s.awaitingPair, null);
});

test('generation gate: a subsequent completed generation has no poisoned pending slot', () => {
  let s = freshGate();
  s = correlateGenerationGate(s, 'start', 0); // A
  s = correlateGenerationGate(s, 'stopped', 10); // A awaits ENDED
  s = correlateGenerationGate(s, 'start', 20); // B
  s = correlateGenerationGate(s, 'complete', 25); // B consumes its slot
  s = correlateGenerationGate(s, 'ended', 30); // stale A/B terminal

  s = correlateGenerationGate(s, 'start', 100); // C
  s = correlateGenerationGate(s, 'complete', 110); // C consumes its slot
  s = correlateGenerationGate(s, 'ended', 120); // stale C terminal
  assert.equal(s.pending, 0);
  assert.equal(s.inProgress, false);
  assert.equal(s.awaitingPair, null);
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

test('recapCompletionOwnsSlot: null metadata with no load ids is not ownership', () => {
  const handle = {};
  // null === null is not proof of ownership: without a load id a stale recap
  // must not assume it still owns the current chat's UI.
  assert.equal(
    recapCompletionOwnsSlot({
      capturedMeta: null,
      currentMeta: null,
      capturedHandle: handle,
      activeHandle: handle,
    }),
    false,
  );
});

// ---- M-2b: recap ownership must be proven, not assumed -----------------------

test('recapCompletionOwnsSlot: a load-id mismatch makes the completion stale', () => {
  const handle = {};
  assert.equal(
    recapCompletionOwnsSlot({
      capturedMeta: null,
      currentMeta: null,
      capturedHandle: handle,
      activeHandle: handle,
      capturedLoadId: 3,
      currentLoadId: 4,
    }),
    false,
  );
});

test('recapCompletionOwnsSlot: null metadata with matching load ids still owns the slot', () => {
  const handle = {};
  assert.equal(
    recapCompletionOwnsSlot({
      capturedMeta: null,
      currentMeta: null,
      capturedHandle: handle,
      activeHandle: handle,
      capturedLoadId: 7,
      currentLoadId: 7,
    }),
    true,
  );
});

test('recapCompletionOwnsSlot: mismatched non-null metadata fails even with matching load ids', () => {
  const metaA = {};
  const metaB = {};
  const handle = {};
  assert.equal(
    recapCompletionOwnsSlot({
      capturedMeta: metaA,
      currentMeta: metaB,
      capturedHandle: handle,
      activeHandle: handle,
      capturedLoadId: 7,
      currentLoadId: 7,
    }),
    false,
  );
});
