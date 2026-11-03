import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens } from '../constants.js';
import { migrateLegacyCharacterKeys } from '../settings-migration.js';
import { computeSourceRange, memorySupportedAfterRollback } from '../memory-utils.js';
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

test('parseProfileOutput: all-present-but-empty returns clearable object, not null', () => {
  const parsed = parseProfileOutput(
    '<character_state></character_state><world_state></world_state><relationship_matrix></relationship_matrix>',
  );
  assert.notEqual(parsed, null);
  assert.equal(parsed.character_state, '');
  assert.equal(parsed.world_state, '');
  assert.equal(parsed.relationship_matrix, '');
});

test('parseProfileOutput: no tags at all still returns null', () => {
  assert.equal(parseProfileOutput('just some prose'), null);
  assert.equal(parseProfileOutput(''), null);
});

test('migrateLegacyCharacterKeys: moves underscore-encoded keys to NUL form', () => {
  const settings = {
    characters: {
      _constructor: { memories: ['a'] },
      _prototype: { canon: { text: 'x' } },
      ___proto__: { memories: ['b'] },
      Elara: { memories: ['c'] },
    },
  };
  const changed = migrateLegacyCharacterKeys(settings);
  assert.equal(changed, true);
  assert.ok('\u0000constructor' in settings.characters);
  assert.ok('\u0000prototype' in settings.characters);
  assert.ok('\u0000__proto__' in settings.characters);
  assert.ok(!('_constructor' in settings.characters));
  assert.ok(!('_prototype' in settings.characters));
  assert.ok(!('___proto__' in settings.characters));
  assert.deepEqual(settings.characters.Elara, { memories: ['c'] });
});

test('migrateLegacyCharacterKeys: does not overwrite an existing NUL key and is idempotent', () => {
  const settings = {
    characters: {
      _constructor: { memories: ['legacy'] },
      '\u0000constructor': { memories: ['current'] },
    },
  };
  assert.equal(migrateLegacyCharacterKeys(settings), false);
  assert.deepEqual(settings.characters['\u0000constructor'], { memories: ['current'] });
  // Second run is a no-op.
  assert.equal(migrateLegacyCharacterKeys(settings), false);
});

test('migrateLegacyCharacterKeys: tolerates missing characters map', () => {
  assert.equal(migrateLegacyCharacterKeys({}), false);
  assert.equal(migrateLegacyCharacterKeys(null), false);
});

test('computeSourceRange: reports real indices and completeness', () => {
  const a = { mes: 'a' };
  const b = { mes: 'b' };
  const chat = [{ mes: 'x' }, a, { mes: 'y' }, b];
  assert.deepEqual(computeSourceRange([a, b], chat), { start: 1, end: 3, complete: true });
  // Partial lookup (one message cloned / not present) => incomplete.
  const c = { mes: 'c' };
  assert.deepEqual(computeSourceRange([a, c], chat), { start: 1, end: 1, complete: false });
  // No messages or none locatable.
  assert.deepEqual(computeSourceRange([], chat), { start: 0, end: 0, complete: false });
  assert.deepEqual(computeSourceRange([c], chat), { start: 0, end: 0, complete: false });
});

test('memorySupportedAfterRollback: prunes only when provenance is complete and fully after target', () => {
  const mem = { source_messages: [[10, 20]], source_chat_id: 'c' };
  // earliest support (10) survives a rollback to 15 => keep
  assert.equal(memorySupportedAfterRollback(mem, 15, 'c'), true);
  // earliest support (10) is after a rollback to 5 => not supported
  assert.equal(memorySupportedAfterRollback(mem, 5, 'c'), false);
});

test('memorySupportedAfterRollback: keeps uncertain, other-chat, and provenance-less memories', () => {
  assert.equal(memorySupportedAfterRollback({ source_messages: [[10, 20]] }, 5, 'c'), true); // no chat id
  assert.equal(
    memorySupportedAfterRollback({ source_messages: [[10, 20]], source_incomplete: true }, 5, 'c'),
    true,
  );
  assert.equal(
    memorySupportedAfterRollback({ source_messages: [[10, 20]], source_chat_id: 'other' }, 5, 'c'),
    true,
  );
  assert.equal(memorySupportedAfterRollback({}, 5, 'c'), true);
  assert.equal(memorySupportedAfterRollback({ source_messages: [] }, 5, 'c'), true);
});
