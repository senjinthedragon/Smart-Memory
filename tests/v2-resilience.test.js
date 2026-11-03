import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sameGroupId,
  safeStorageKey,
  bumpOperationRevision,
  getOperationRevision,
} from '../memory-utils.js';
import { estimateTokens } from '../constants.js';
import {
  capStateFieldValues,
  pruneStateLedger,
  MAX_STATE_FIELD_LENGTH,
  MAX_STATE_LEDGER_CARDS,
  parseExtractionOutput,
  parseEpistemicRetireIndices,
  parseProfileOutput,
} from '../parsers.js';

test('sameGroupId: matches equivalent string and numeric group IDs', () => {
  assert.equal(sameGroupId('123', 123), true);
  assert.equal(sameGroupId(456, '456'), true);
  assert.equal(sameGroupId('abc', 'abc'), true);
  assert.equal(sameGroupId(null, '123'), false);
  assert.equal(sameGroupId(undefined, undefined), false);
  assert.equal(sameGroupId('123', '456'), false);
});

test('safeStorageKey: protects against prototype pollution keys', () => {
  assert.equal(safeStorageKey('__proto__'), '___proto__');
  assert.equal(safeStorageKey('constructor'), '_constructor');
  assert.equal(safeStorageKey('prototype'), '_prototype');
  assert.equal(safeStorageKey('Elara'), 'Elara');
  assert.equal(safeStorageKey('  Kael  '), 'Kael');
  assert.equal(safeStorageKey(null), '');
  assert.equal(safeStorageKey(undefined), '');
});

test('estimateTokens: Unicode and CJK script weighting', () => {
  // English text: 28 characters -> ~7 tokens
  const eng = 'Hello world, this is a test.';
  assert.equal(estimateTokens(eng), Math.ceil(eng.length / 4));

  // CJK text: 4 Han characters -> ~6 tokens (1.5 tokens each)
  const cjk = '你好世界';
  assert.equal(estimateTokens(cjk), 6);

  // Mixed text: 8 CJK chars + 12 Latin/punctuation chars -> 8 * 1.5 + 12 / 4 = 12 + 3 = 15 tokens
  const mixed = '角色状态：测试世界 (Hello)';
  assert.ok(estimateTokens(mixed) > Math.ceil(mixed.length / 4));
});

test('capStateFieldValues: caps overlong state field values to MAX_STATE_FIELD_LENGTH', () => {
  const overlong = 'x'.repeat(600);
  const fields = { status: overlong, location: 'Tavern' };
  const capped = capStateFieldValues(fields);
  assert.equal(capped.status.length, MAX_STATE_FIELD_LENGTH);
  assert.equal(capped.location, 'Tavern');
});

test('pruneStateLedger: bounds state cards and preserves character cards', () => {
  const ledger = {};
  // Create 105 non-character cards
  for (let i = 0; i < 105; i++) {
    ledger[`item:sword_${i}`] = { name: `Sword ${i}`, type: 'item', lastUpdated: i };
  }
  // And 2 character cards
  ledger['character:Elara'] = { name: 'Elara', type: 'character', lastUpdated: 1 };
  ledger['character:Kael'] = { name: 'Kael', type: 'character', lastUpdated: 2 };

  pruneStateLedger(ledger, MAX_STATE_LEDGER_CARDS);

  // Total size must be <= MAX (100)
  assert.ok(Object.keys(ledger).length <= MAX_STATE_LEDGER_CARDS);
  // Important character cards must be preserved!
  assert.ok('character:Elara' in ledger);
  assert.ok('character:Kael' in ledger);
});

test('parseExtractionOutput: handles nested bracket tags cleanly', () => {
  const input = '[fact:2:permanent:entity=[Nested]] Elara found the lost sword.';
  const res = parseExtractionOutput(input);
  assert.equal(res.length, 1);
  assert.equal(res[0].content, 'Elara found the lost sword.');
  assert.deepEqual(res[0]._raw_entity_names, ['Nested']);
});

test('parseEpistemicRetireIndices: validates positive integers and bounds count to 5', () => {
  const input = '[retire] 1, 2, -3, 0, 4, 5, 6, 7, 8, abc';
  const indices = parseEpistemicRetireIndices(input);
  // Only positive integers, max 5 entries
  assert.ok(indices.size <= 5);
  for (const idx of indices) {
    assert.ok(idx > 0);
  }
});

test('parseProfileOutput: returns null for omitted sections rather than blank strings', () => {
  const partial = '<character_state>Heroic warrior</character_state>';
  const parsed = parseProfileOutput(partial);
  assert.equal(parsed.character_state, 'Heroic warrior');
  assert.equal(parsed.world_state, null);
  assert.equal(parsed.relationship_matrix, null);
});

test('operationRevision: increments on bumpOperationRevision', () => {
  const before = getOperationRevision();
  const bumped = bumpOperationRevision();
  assert.equal(bumped, before + 1);
  assert.equal(getOperationRevision(), bumped);
});
