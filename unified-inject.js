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
 * Unified injection mode: merges all active tier content into a single
 * IN_PROMPT block instead of injecting each tier into its own named slot.
 *
 * injectUnified        - reads individual tier slots, composes them, clears
 *                        the individual slots, and injects the merged block
 * maybeInjectUnified   - calls injectUnified only when the setting is enabled
 * clearUnifiedSlot     - clears the unified slot and the stored breakdown
 * getUnifiedTierBreakdown - returns per-tier token counts from the last pass
 *                          so updateTokenDisplay can still render tier colours
 */

import {
  extension_settings,
  extension_prompts,
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import {
  MODULE_NAME,
  PROMPT_KEY_SHORT,
  PROMPT_KEY_LONG,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_CANON,
  PROMPT_KEY_UNIFIED,
} from './constants.js';
import { estimateTokens } from './constants.js';

/**
 * Canonical tier ordering for the unified block.
 *
 * Most-stable content comes first; most-immediate content comes last so the
 * model sees active goals and session details closest to its response
 * (recency bias in transformer attention).
 */
const TIER_ORDER = [
  { key: PROMPT_KEY_CANON, label: 'Canon', color: '#a05870' },
  { key: PROMPT_KEY_PROFILES, label: 'Profiles', color: '#5a9ea0' },
  { key: PROMPT_KEY_LONG, label: 'Long-term', color: '#4a6fa5' },
  { key: PROMPT_KEY_SHORT, label: 'Short-term', color: '#5a8e5a' },
  { key: PROMPT_KEY_SCENES, label: 'Scenes', color: '#a07840' },
  { key: PROMPT_KEY_SESSION, label: 'Session', color: '#8e5a8e' },
  { key: PROMPT_KEY_ARCS, label: 'Arcs', color: '#7a6ea5' },
];

/** All individual keys that unified mode absorbs. */
const INDIVIDUAL_KEYS = TIER_ORDER.map((t) => t.key);

/**
 * Per-tier token breakdown from the last injectUnified call.
 * Exported so updateTokenDisplay can render per-tier colours even though all
 * content lives in one slot.
 * @type {Array<{key: string, label: string, color: string, tokens: number}>}
 */
let lastTierBreakdown = [];

/**
 * Returns the per-tier token breakdown from the last injectUnified call.
 * @returns {Array<{key: string, label: string, color: string, tokens: number}>}
 */
export function getUnifiedTierBreakdown() {
  return lastTierBreakdown;
}

/**
 * Clears the unified injection slot and resets the stored breakdown.
 */
export function clearUnifiedSlot() {
  setExtensionPrompt(PROMPT_KEY_UNIFIED, '', extension_prompt_types.NONE, 0);
  lastTierBreakdown = [];
}

/**
 * Reads all individual tier slots (as written by their respective injectors),
 * records per-tier token counts, clears the individual slots, and injects
 * the merged content into PROMPT_KEY_UNIFIED as a single IN_PROMPT block.
 *
 * Call this after all individual injectors have run for a given generation
 * cycle. Tiers with no content are skipped silently.
 */
export function injectUnified() {
  // Snapshot content and token counts before we clear anything.
  const populated = TIER_ORDER.map((tier) => ({
    ...tier,
    content: extension_prompts[tier.key]?.value ?? '',
  })).filter((t) => t.content.length > 0);

  lastTierBreakdown = populated.map((t) => ({
    key: t.key,
    label: t.label,
    color: t.color,
    tokens: estimateTokens(t.content),
  }));

  // Clear every individual slot - the unified block replaces them all.
  for (const key of INDIVIDUAL_KEYS) {
    setExtensionPrompt(key, '', extension_prompt_types.NONE, 0);
  }

  if (populated.length === 0) {
    setExtensionPrompt(PROMPT_KEY_UNIFIED, '', extension_prompt_types.NONE, 0);
    return;
  }

  const unified = populated.map((t) => t.content).join('\n\n');

  setExtensionPrompt(
    PROMPT_KEY_UNIFIED,
    unified,
    extension_prompt_types.IN_PROMPT,
    0,
    false,
    extension_prompt_roles.SYSTEM,
  );
}

/**
 * Calls injectUnified if the unified_injection setting is enabled.
 * Drop this call after every batch injection point (chat load, extraction
 * pass, compaction, scene break, group character switch, catch-up).
 */
export function maybeInjectUnified() {
  const settings = extension_settings[MODULE_NAME];
  if (settings.unified_injection) injectUnified();
}
