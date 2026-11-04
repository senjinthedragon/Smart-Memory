import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrackableGeneration } from '../memory-utils.js';

// SillyTavern emits GENERATION_STARTED(type, options, dryRun). PromptManager's
// post-message dry-run uses type 'normal' with dryRun true and never emits a
// terminal event, so it must NOT open the generation gate (doing so silently
// skips all extraction).

test('isTrackableGeneration: tracks only real normal generations', () => {
  assert.equal(isTrackableGeneration('normal', false), true);
  assert.equal(isTrackableGeneration('normal', undefined), true);
});

test('isTrackableGeneration: ignores dry-run normal generations', () => {
  assert.equal(isTrackableGeneration('normal', true), false);
});

test('isTrackableGeneration: ignores non-normal generation types', () => {
  assert.equal(isTrackableGeneration('quiet', false), false);
  assert.equal(isTrackableGeneration('swipe', false), false);
  assert.equal(isTrackableGeneration('impersonate', false), false);
  assert.equal(isTrackableGeneration('continue', false), false);
});
