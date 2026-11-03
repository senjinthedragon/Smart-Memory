import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens } from '../constants.js';
import {
  mergeStateCardFields,
  pruneStateLedger,
  parseProfileOutput,
  MAX_STATE_LEDGER_CARDS,
} from '../parsers.js';

test('estimateTokens: astral CJK is counted once per code point', () => {
  // One astral Han extension B character (U+20000) is 2 UTF-16 units, 1 code point.
  const astral = '\u{20000}';
  assert.equal(astral.length, 2);
  // 1 non-Latin code point * 1.5 => ceil(1.5) = 2
  assert.equal(estimateTokens(astral), 2);
});

test('estimateTokens: Cyrillic/Greek/Hebrew/emoji count as non-Latin', () => {
  for (const s of ['Мария', 'Δέλτα', 'שלום', '😀😀']) {
    assert.ok(estimateTokens(s) > Math.ceil(s.length / 4), `${s} should exceed Latin rate`);
  }
});

test('estimateTokens: pure Latin is unchanged at 4 chars per token', () => {
  const s = 'Hello world, this is a test.';
  assert.equal(estimateTokens(s), Math.ceil(s.length / 4));
});

test('mergeStateCardFields: stamps a fresh lastUpdated timestamp', () => {
  const before = Date.now();
  const merged = mergeStateCardFields({ location: 'tavern' }, { mood: 'calm' });
  assert.ok(typeof merged.lastUpdated === 'number');
  assert.ok(merged.lastUpdated >= before);
});

test('pruneStateLedger: evicts the stalest cards first, not the earliest inserted', () => {
  const ledger = {};
  // A current card inserted first but refreshed most recently.
  ledger['obj:current|object'] = { type: 'object', lastUpdated: 1_000_000 };
  for (let i = 0; i < 105; i++) {
    ledger[`obj:stale_${i}|object`] = { type: 'object', lastUpdated: 100 + i };
  }
  // Character card must survive regardless of timestamp.
  ledger['char:Elara|character'] = { type: 'character', lastUpdated: 1 };

  pruneStateLedger(ledger, MAX_STATE_LEDGER_CARDS);

  assert.ok(Object.keys(ledger).length <= MAX_STATE_LEDGER_CARDS);
  assert.ok('obj:current|object' in ledger, 'recently-refreshed card must survive');
  assert.ok('char:Elara|character' in ledger, 'character card must survive');
  assert.ok(!('obj:stale_0|object' in ledger), 'stalest card must be evicted first');
});

test('parseProfileOutput: distinguishes absent (null) from present-but-empty (empty string)', () => {
  const parsed = parseProfileOutput(
    '<character_state>Hero</character_state><world_state></world_state>',
  );
  assert.equal(parsed.character_state, 'Hero');
  assert.equal(parsed.world_state, ''); // present but empty -> can clear
  assert.equal(parsed.relationship_matrix, null); // absent -> preserve
});
