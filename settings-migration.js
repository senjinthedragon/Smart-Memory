/**
 * Smart Memory - SillyTavern Extension
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/Smart-Memory
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Pure settings-migration helpers.
 *
 * These live apart from settings.js so they can be unit-tested under plain Node
 * without loading SillyTavern's runtime modules (script.js, extensions.js).
 * settings.js imports and calls them from loadSettings().
 *
 * migrateEpistemicStateLedgerPlacement - moves legacy IN_CHAT depth-1 injections
 *   for the epistemic and state-ledger tiers to the in-prompt placement.
 */

/**
 * Migrates the legacy epistemic/state-ledger injection placement.
 *
 * Older defaults injected both tiers at IN_CHAT depth 1 (position 1, depth 1),
 * which let stale extracted state override the active dialogue turn. This moves
 * untouched old defaults to the in-prompt placement (position 2, depth 2). A
 * user who explicitly changed the position or depth is left alone.
 *
 * Persists a one-time migration flag `migrated_legacy_placement = true` so
 * that subsequent reloads never revert a user who deliberately chooses
 * position 1 and depth 1 after migration.
 *
 * Mutates and returns the supplied settings object.
 *
 * @param {Object} settings - The extension_settings[MODULE_NAME] object.
 * @param {{ IN_PROMPT?: number }} [promptTypes] - extension_prompt_types (IN_PROMPT defaults to 2).
 * @param {number} [targetDepth=2] - Default depth (defaults to 2).
 * @returns {Object} The same settings object.
 */
export function migrateEpistemicStateLedgerPlacement(settings, promptTypes = {}, targetDepth = 2) {
  if (!settings || typeof settings !== 'object') return settings;
  if (settings.migrated_legacy_placement) return settings;

  const inPrompt = Number.isFinite(promptTypes.IN_PROMPT) ? promptTypes.IN_PROMPT : 2;
  const depth = Number.isFinite(targetDepth) ? targetDepth : 2;

  if (settings.epistemic_position === 1 && settings.epistemic_depth === 1) {
    settings.epistemic_position = inPrompt;
    settings.epistemic_depth = depth;
  }
  if (settings.state_ledger_position === 1 && settings.state_ledger_depth === 1) {
    settings.state_ledger_position = inPrompt;
    settings.state_ledger_depth = depth;
  }

  settings.migrated_legacy_placement = true;
  return settings;
}
