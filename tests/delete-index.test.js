import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeletedIndexFromRefs, lowerExtractCutoff } from '../memory-utils.js';

// SillyTavern emits MESSAGE_DELETED with the NEW chat length, never the deleted
// index. These tests pin the object-identity diff that recovers the deleted turn.

test('resolveDeletedIndexFromRefs: single mid-chat delete', () => {
  const a = { mes: 'a' };
  const b = { mes: 'b' };
  const c = { mes: 'c' };
  const d = { mes: 'd' };
  const prev = [a, b, c, d];
  const curr = [a, b, d]; // c deleted
  assert.equal(resolveDeletedIndexFromRefs(prev, curr, curr.length), 2);
});

test('resolveDeletedIndexFromRefs: tail delete', () => {
  const a = { mes: 'a' };
  const b = { mes: 'b' };
  const c = { mes: 'c' };
  assert.equal(resolveDeletedIndexFromRefs([a, b, c], [a, b], 2), 2);
});

test('resolveDeletedIndexFromRefs: delete-first', () => {
  const a = { mes: 'a' };
  const b = { mes: 'b' };
  const c = { mes: 'c' };
  assert.equal(resolveDeletedIndexFromRefs([a, b, c], [b, c], 2), 0);
});

test('resolveDeletedIndexFromRefs: "delete from here" range delete', () => {
  const a = { mes: 'a' };
  const b = { mes: 'b' };
  const c = { mes: 'c' };
  const d = { mes: 'd' };
  const prev = [a, b, c, d];
  const curr = [a, b]; // everything from index 2 onward deleted
  assert.equal(resolveDeletedIndexFromRefs(prev, curr, curr.length), 2);
});

test('resolveDeletedIndexFromRefs: identity diff distinguishes duplicate content', () => {
  const a1 = { mes: 'same' };
  const a2 = { mes: 'same' };
  const a3 = { mes: 'same' };
  // Delete the middle duplicate: content is identical, only identity differs.
  assert.equal(resolveDeletedIndexFromRefs([a1, a2, a3], [a1, a3], 2), 1);
});

test('resolveDeletedIndexFromRefs: falls back to the emitted new-length when no snapshot exists', () => {
  assert.equal(resolveDeletedIndexFromRefs(null, [{}, {}], 5), 4);
  assert.equal(resolveDeletedIndexFromRefs(null, [], undefined), 0);
});

// lastExtractCutoff is a high-water mark and must only move backward.
test('lowerExtractCutoff: lowers the cursor for a rollback before it', () => {
  assert.equal(lowerExtractCutoff(10, 3), 3);
  assert.equal(lowerExtractCutoff(10, 9), 9);
});

test('lowerExtractCutoff: never advances the cursor', () => {
  assert.equal(lowerExtractCutoff(1, 3), 1);
  assert.equal(lowerExtractCutoff(5, 5), 5);
});

test('lowerExtractCutoff: leaves an unset cursor unset', () => {
  assert.equal(lowerExtractCutoff(null, 3), null);
  assert.equal(lowerExtractCutoff(undefined, 3), undefined);
});

test('lowerExtractCutoff: clamps the target at zero', () => {
  assert.equal(lowerExtractCutoff(10, -5), 0);
});
