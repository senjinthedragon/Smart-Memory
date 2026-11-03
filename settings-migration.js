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
 * migrateEpistemicStateLedgerPlacement - normalises the epistemic and
 *   state-ledger injection placement to IN_CHAT depth 2.
 */

/**
 * Migrates the epistemic/state-ledger injection placement to the intended
 * near-the-end position.
 *
 * Depth only applies to IN_CHAT (position 1) in SillyTavern. IN_PROMPT
 * (position 2) ignores depth entirely and places the block at the very top of
 * the prompt, which is not what either tier wants. Two historical defaults are
 * normalised:
 *
 *   - legacy default:  IN_CHAT depth 1  (position 1, depth 1)
 *   - interim default: IN_PROMPT depth 0/2 (position 2, depth 0 or 2)
 *
 * Both move to IN_CHAT depth 2, so the block sits near the end of the prompt and
 * the configured depth is actually honoured. An explicit custom position/depth
 * (e.g. position 0 or depth 4) is preserved.
 *
 * Persists a one-time migration flag `migrated_legacy_placement = true` so that
 * subsequent reloads never revert a user who deliberately chooses the old
 * placement after migration. When the flag is already set, settings are left
 * completely untouched.
 *
 * Mutates and returns the supplied settings object.
 *
 * @param {Object} settings - The extension_settings[MODULE_NAME] object.
 * @param {{ IN_CHAT?: number }} [promptTypes] - extension_prompt_types (IN_CHAT defaults to 1).
 * @param {number} [targetDepth=2] - Target depth (defaults to 2).
 * @returns {Object} The same settings object.
 */
export function migrateEpistemicStateLedgerPlacement(settings, promptTypes = {}, targetDepth = 2) {
  if (!settings || typeof settings !== 'object') return settings;
  if (settings.migrated_legacy_placement) return settings;

  const inChat = Number.isFinite(promptTypes.IN_CHAT) ? promptTypes.IN_CHAT : 1;
  const depth = Number.isFinite(targetDepth) ? targetDepth : 2;

  // The two defaults that need normalising. Compare position and depth together
  // so an explicit custom choice is never overwritten.
  const isLegacyPlacement = (position, currentDepth) => position === 1 && currentDepth === 1;
  const isInterimPlacement = (position, currentDepth) =>
    position === 2 && (currentDepth === 0 || currentDepth === 2);

  for (const tier of ['epistemic', 'state_ledger']) {
    const position = settings[`${tier}_position`];
    const currentDepth = settings[`${tier}_depth`];
    if (isLegacyPlacement(position, currentDepth) || isInterimPlacement(position, currentDepth)) {
      settings[`${tier}_position`] = inChat;
      settings[`${tier}_depth`] = depth;
    }
  }

  settings.migrated_legacy_placement = true;
  return settings;
}
