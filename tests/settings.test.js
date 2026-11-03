import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateEpistemicStateLedgerPlacement } from '../settings-migration.js';

// These tests cover the migration core that loadSettings() runs on startup.
// settings.js itself imports the SillyTavern runtime (script.js/extensions.js),
// so the pure helper is extracted to settings-migration.js and called from
// loadSettings() to keep this behaviour verifiable under plain Node.
//
// Depth only applies to IN_CHAT (position 1) in SillyTavern. IN_PROMPT
// (position 2) ignores depth and sits at the very top, so both the legacy
// IN_CHAT depth-1 default and the interim IN_PROMPT default are normalised to
// IN_CHAT depth 2 - near the end of the prompt, where depth is honoured.

test('loadSettings migration: legacy IN_CHAT depth-1 default moves to IN_CHAT depth 2', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 1,
    state_ledger_position: 1,
    state_ledger_depth: 1,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 1 }, 2);

  assert.equal(settings.epistemic_position, 1);
  assert.equal(settings.epistemic_depth, 2);
  assert.equal(settings.state_ledger_position, 1);
  assert.equal(settings.state_ledger_depth, 2);
  assert.equal(settings.migrated_legacy_placement, true);
});

test('loadSettings migration: interim IN_PROMPT depth-0 default moves to IN_CHAT depth 2', () => {
  const settings = {
    epistemic_position: 2,
    epistemic_depth: 0,
    state_ledger_position: 2,
    state_ledger_depth: 0,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 1 }, 2);

  assert.equal(settings.epistemic_position, 1);
  assert.equal(settings.epistemic_depth, 2);
  assert.equal(settings.state_ledger_position, 1);
  assert.equal(settings.state_ledger_depth, 2);
  assert.equal(settings.migrated_legacy_placement, true);
});

test('loadSettings migration: interim IN_PROMPT depth-2 default moves to IN_CHAT depth 2', () => {
  const settings = {
    epistemic_position: 2,
    epistemic_depth: 2,
    state_ledger_position: 2,
    state_ledger_depth: 2,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 1 }, 2);

  assert.equal(settings.epistemic_position, 1);
  assert.equal(settings.epistemic_depth, 2);
  assert.equal(settings.state_ledger_position, 1);
  assert.equal(settings.state_ledger_depth, 2);
  assert.equal(settings.migrated_legacy_placement, true);
});

test('loadSettings migration: the target IN_CHAT depth-2 placement is left unchanged', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 2,
    state_ledger_position: 1,
    state_ledger_depth: 2,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 1 }, 2);

  assert.equal(settings.epistemic_position, 1);
  assert.equal(settings.epistemic_depth, 2);
  assert.equal(settings.state_ledger_position, 1);
  assert.equal(settings.state_ledger_depth, 2);
  assert.equal(settings.migrated_legacy_placement, true);
});

test('loadSettings migration: sets migrated_legacy_placement flag and does not re-migrate if already set', () => {
  const settings = {
    migrated_legacy_placement: true,
    epistemic_position: 1,
    epistemic_depth: 1,
    state_ledger_position: 2,
    state_ledger_depth: 0,
  };

  // User explicitly chose these placements after migration.
  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 1 }, 2);

  // Must NOT be overwritten.
  assert.equal(settings.epistemic_position, 1);
  assert.equal(settings.epistemic_depth, 1);
  assert.equal(settings.state_ledger_position, 2);
  assert.equal(settings.state_ledger_depth, 0);
});

test('loadSettings migration: uses the supplied IN_CHAT value', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 1,
    state_ledger_position: 2,
    state_ledger_depth: 0,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 9 }, 2);

  assert.equal(settings.epistemic_position, 9);
  assert.equal(settings.state_ledger_position, 9);
  assert.equal(settings.epistemic_depth, 2);
  assert.equal(settings.migrated_legacy_placement, true);
});

test('loadSettings migration: defaults IN_CHAT to 1 and depth to 2 when omitted', () => {
  const settings = { epistemic_position: 1, epistemic_depth: 1 };
  migrateEpistemicStateLedgerPlacement(settings);
  assert.equal(settings.epistemic_position, 1);
  assert.equal(settings.epistemic_depth, 2);
  assert.equal(settings.migrated_legacy_placement, true);
});

test('loadSettings migration: an explicit custom position is preserved', () => {
  const settings = {
    // Position changed but depth left at the old default - user customised it.
    epistemic_position: 0,
    epistemic_depth: 1,
    state_ledger_position: 3,
    state_ledger_depth: 1,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 1 }, 2);

  assert.equal(settings.epistemic_position, 0);
  assert.equal(settings.epistemic_depth, 1);
  assert.equal(settings.state_ledger_position, 3);
  assert.equal(settings.state_ledger_depth, 1);
  assert.equal(settings.migrated_legacy_placement, true);
});

test('loadSettings migration: an explicit custom depth is preserved', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 4,
    state_ledger_position: 1,
    state_ledger_depth: 3,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 1 }, 2);

  assert.equal(settings.epistemic_position, 1);
  assert.equal(settings.epistemic_depth, 4);
  assert.equal(settings.state_ledger_position, 1);
  assert.equal(settings.state_ledger_depth, 3);
  assert.equal(settings.migrated_legacy_placement, true);
});

test('loadSettings migration: migrates each tier independently', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 1,
    // Already migrated to the target - must stay put.
    state_ledger_position: 1,
    state_ledger_depth: 2,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 1 }, 2);

  assert.equal(settings.epistemic_position, 1);
  assert.equal(settings.epistemic_depth, 2);
  assert.equal(settings.state_ledger_position, 1);
  assert.equal(settings.state_ledger_depth, 2);
  assert.equal(settings.migrated_legacy_placement, true);
});

test('loadSettings migration: is idempotent and tolerates missing fields', () => {
  const settings = {
    epistemic_position: 1,
    epistemic_depth: 1,
    state_ledger_position: 2,
    state_ledger_depth: 0,
  };

  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 1 }, 2);
  // Second call with migrated_legacy_placement true.
  migrateEpistemicStateLedgerPlacement(settings, { IN_CHAT: 1 }, 2);

  assert.equal(settings.epistemic_position, 1);
  assert.equal(settings.epistemic_depth, 2);
  assert.equal(settings.state_ledger_position, 1);
  assert.equal(settings.state_ledger_depth, 2);
  assert.equal(settings.migrated_legacy_placement, true);

  // No throw on non-object input.
  assert.equal(migrateEpistemicStateLedgerPlacement(null), null);
  assert.equal(migrateEpistemicStateLedgerPlacement(undefined), undefined);
});
