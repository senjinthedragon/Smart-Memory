import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCurrentSceneStateBlock,
  memoryUtilityScore,
  prioritizeMemories,
  reconcileTypeEntries,
  selectProtectedMemories,
  sortByTimeline,
  trimByPriority,
} from '../memory-utils.js';

test('trimByPriority keeps high-importance memories over low-importance ones', () => {
  const memories = [
    { type: 'fact', content: 'low old', importance: 1, ts: 1000 },
    { type: 'fact', content: 'high old', importance: 3, ts: 900 },
    { type: 'fact', content: 'medium new', importance: 2, ts: 3000 },
  ];

  const trimmed = trimByPriority(memories, 2);
  const contents = trimmed.map((m) => m.content);

  assert.equal(trimmed.length, 2);
  assert.ok(contents.includes('high old'));
  assert.ok(contents.includes('medium new'));
  assert.ok(!contents.includes('low old'));
});

test('trimByPriority favors permanent expiration over scene when importance ties', () => {
  const memories = [
    { type: 'event', content: 'temporary tavern chatter', importance: 2, expiration: 'scene', ts: 5000 },
    { type: 'event', content: 'major oath was sworn', importance: 2, expiration: 'permanent', ts: 1000 },
  ];

  const trimmed = trimByPriority(memories, 1);
  assert.equal(trimmed[0].content, 'major oath was sworn');
});

test('prioritizeMemories boosts recurring keywords compared to one-off details', () => {
  const prioritized = prioritizeMemories([
    { type: 'fact', content: 'The relic is hidden in the crypt vault', importance: 2, expiration: 'session', ts: 1000 },
    { type: 'event', content: 'They opened the crypt gate at midnight', importance: 2, expiration: 'session', ts: 900 },
    { type: 'detail', content: 'A lantern flickered once near the doorway', importance: 2, expiration: 'scene', ts: 3000 },
  ]);

  assert.equal(prioritized[0].content, 'The relic is hidden in the crypt vault');
  assert.equal(prioritized[1].content, 'They opened the crypt gate at midnight');
});

test('reconcileTypeEntries replaces overlapping base entry with promoted update', () => {
  const base = [{ type: 'relationship', content: 'We are married.', ts: 1234 }];
  const promoted = [{ type: 'relationship', content: 'We are married. Happily.', ts: 9999 }];

  const reconciled = reconcileTypeEntries(base, promoted, 0.65);

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].content, promoted[0].content);
  assert.equal(reconciled[0].ts, 1234);
});

test('reconcileTypeEntries appends genuinely new entries', () => {
  const base = [{ type: 'fact', content: 'The ring is silver.' }];
  const promoted = [{ type: 'fact', content: 'The house has a red door.' }];

  const reconciled = reconcileTypeEntries(base, promoted, 0.7);

  assert.equal(reconciled.length, 2);
  assert.ok(reconciled.some((m) => m.content === 'The ring is silver.'));
  assert.ok(reconciled.some((m) => m.content === 'The house has a red door.'));
});

test('reconcileTypeEntries infers timestamp for new promoted entries from timeline pool', () => {
  const base = [{ type: 'event', content: 'We escaped the city.', ts: 2000 }];
  const unprocessed = [{ type: 'event', content: 'We escaped the city at dawn.', ts: 3000 }];
  const promoted = [{ type: 'event', content: 'We escaped the city at dawn via the east gate.', ts: 9999 }];

  const reconciled = reconcileTypeEntries(base, promoted, 0.7, [...base, ...unprocessed]);
  const added = reconciled.find((m) => m.content === promoted[0].content);

  assert.ok(added);
  assert.equal(added.ts, 3000);
});

test('sortByTimeline returns memories in chronological order', () => {
  const sorted = sortByTimeline([
    { content: 'late', ts: 300 },
    { content: 'early', ts: 100 },
    { content: 'middle', ts: 200 },
  ]);

  assert.deepEqual(
    sorted.map((m) => m.content),
    ['early', 'middle', 'late'],
  );
});

test('memoryUtilityScore boosts persona and intimacy relevant memories', () => {
  const base = {
    type: 'preference',
    content: 'The user prefers slow-burn affectionate scenes.',
    importance: 2,
    expiration: 'permanent',
    ts: 1000,
  };
  const low = memoryUtilityScore({
    ...base,
    persona_relevance: 0,
    intimacy_relevance: 0,
    retrieval_count: 0,
  });
  const high = memoryUtilityScore({
    ...base,
    persona_relevance: 3,
    intimacy_relevance: 3,
    retrieval_count: 4,
  });
  assert.ok(high > low);
});

test('selectProtectedMemories keeps one memory per required type', () => {
  const memories = [
    { type: 'relationship', content: 'We trust each other deeply.', importance: 3, ts: 1000 },
    { type: 'relationship', content: 'We had a minor disagreement.', importance: 1, ts: 1500 },
    { type: 'preference', content: 'She likes teasing banter.', importance: 2, ts: 1200 },
    { type: 'fact', content: 'She always wears silver rings.', importance: 2, ts: 900 },
  ];
  const selected = selectProtectedMemories(memories, ['relationship', 'preference', 'fact']);
  assert.equal(selected.length, 3);
  assert.ok(selected.some((m) => m.type === 'relationship' && m.content.includes('trust')));
  assert.ok(selected.some((m) => m.type === 'preference'));
  assert.ok(selected.some((m) => m.type === 'fact'));
});

test('buildCurrentSceneStateBlock keeps newest scene-oriented memories', () => {
  const block = buildCurrentSceneStateBlock([
    { type: 'scene', content: 'Old tavern room.', ts: 10 },
    { type: 'scene', content: 'Rainy balcony at midnight.', ts: 20 },
    { type: 'development', content: 'Trust deepened after the apology.', ts: 30 },
    { type: 'detail', content: 'Her coat is still wet from the storm.', ts: 25 },
    { type: 'revelation', content: 'She admits the letter was forged.', ts: 35 },
  ]);

  assert.match(block, /Rainy balcony at midnight\./);
  assert.match(block, /Trust deepened after the apology\./);
  assert.match(block, /coat is still wet/);
  assert.match(block, /letter was forged/);
  assert.doesNotMatch(block, /Old tavern room/);
});
