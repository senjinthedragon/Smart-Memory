import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateEpistemicStateLedgerPlacement } from '../settings-migration.js';

// These tests cover the migration core that loadSettings() runs on startup.
// settings.js itself imports the SillyTavern runtime (script.js/extensions.js),
// so the pure helper is extracted to settings-migration.js and called from
// loadSettings() to keep this behaviour verifiable under plain Node.

test('loadSettings migration: legacy epistemic/state-ledger depth-1 defaults move to IN_PROMPT depth 0', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 1,
    state_ledger_position: 1,
    state_ledger_depth: 1,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_PROMPT: 2 });

  assert.equal(settings.epistemic_position, 2);
  assert.equal(settings.epistemic_depth, 0);
  assert.equal(settings.state_ledger_position, 2);
  assert.equal(settings.state_ledger_depth, 0);
});

test('loadSettings migration: uses the supplied IN_PROMPT value', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 1,
    state_ledger_position: 1,
    state_ledger_depth: 1,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_PROMPT: 7 });

  assert.equal(settings.epistemic_position, 7);
  assert.equal(settings.state_ledger_position, 7);
});

test('loadSettings migration: defaults IN_PROMPT to 2 when omitted', () => {
  const settings = { epistemic_position: 1, epistemic_depth: 1 };
  migrateEpistemicStateLedgerPlacement(settings);
  assert.equal(settings.epistemic_position, 2);
  assert.equal(settings.epistemic_depth, 0);
});

test('loadSettings migration: an explicit custom position is preserved', () => {
  const settings = {
    // Position changed but depth left at the old default - user customised it.
    epistemic_position: 0,
    epistemic_depth: 1,
    state_ledger_position: 3,
    state_ledger_depth: 1,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_PROMPT: 2 });

  assert.equal(settings.epistemic_position, 0);
  assert.equal(settings.epistemic_depth, 1);
  assert.equal(settings.state_ledger_position, 3);
  assert.equal(settings.state_ledger_depth, 1);
});

test('loadSettings migration: an explicit custom depth is preserved', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 4,
    state_ledger_position: 1,
    state_ledger_depth: 0,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_PROMPT: 2 });

  assert.equal(settings.epistemic_position, 1);
  assert.equal(settings.epistemic_depth, 4);
  assert.equal(settings.state_ledger_position, 1);
  assert.equal(settings.state_ledger_depth, 0);
});

test('loadSettings migration: migrates each tier independently', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 1,
    // Already migrated - must stay put.
    state_ledger_position: 2,
    state_ledger_depth: 0,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_PROMPT: 2 });

  assert.equal(settings.epistemic_position, 2);
  assert.equal(settings.epistemic_depth, 0);
  assert.equal(settings.state_ledger_position, 2);
  assert.equal(settings.state_ledger_depth, 0);
});

test('loadSettings migration: is idempotent and tolerates missing fields', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 1,
    state_ledger_position: 1,
    state_ledger_depth: 1,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_PROMPT: 2 });
  migrateEpistemicStateLedgerPlacement(settings, { IN_PROMPT: 2 });

  assert.equal(settings.epistemic_position, 2);
  assert.equal(settings.epistemic_depth, 0);
  assert.equal(settings.state_ledger_position, 2);
  assert.equal(settings.state_ledger_depth, 0);

  // No throw on non-object input.
  assert.equal(migrateEpistemicStateLedgerPlacement(null), null);
  assert.equal(migrateEpistemicStateLedgerPlacement(undefined), undefined);
});
