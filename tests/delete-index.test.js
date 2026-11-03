import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeletedIndexFromRefs } from '../memory-utils.js';

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
