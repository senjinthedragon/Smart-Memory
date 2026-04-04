import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTypeEntries, trimByPriority } from '../memory-utils.js';

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

test('reconcileTypeEntries replaces overlapping base entry with promoted update', () => {
  const base = [{ type: 'relationship', content: 'We are married.' }];
  const promoted = [{ type: 'relationship', content: 'We are married. Happily.' }];

  const reconciled = reconcileTypeEntries(base, promoted, 0.65);

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].content, promoted[0].content);
});

test('reconcileTypeEntries appends genuinely new entries', () => {
  const base = [{ type: 'fact', content: 'The ring is silver.' }];
  const promoted = [{ type: 'fact', content: 'The house has a red door.' }];

  const reconciled = reconcileTypeEntries(base, promoted, 0.7);

  assert.equal(reconciled.length, 2);
  assert.ok(reconciled.some((m) => m.content === 'The ring is silver.'));
  assert.ok(reconciled.some((m) => m.content === 'The house has a red door.'));
});
