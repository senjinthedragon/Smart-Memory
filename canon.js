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
 * Layer 3 canon summary: stable per-character narrative document.
 *
 * Canon is generated from resolved arc summaries and high-importance
 * long-term memories. It covers who the character is, what has happened,
 * and the current state of key relationships. Stored in extension_settings
 * so it persists across sessions. Injected via the smart_memory_short slot
 * when at least two arc summaries exist (replacing the compaction summary).
 * Manual trigger only to keep model calls minimal on local hardware.
 *
 * loadCanon          - returns the stored canon for a character (or null)
 * saveCanon          - persists the canon to extension_settings
 * clearCanon         - removes the canon for a character
 * generateCanon      - builds and stores a new canon summary
 * injectCanon        - injects canon into the prompt (replaces compaction)
 * shouldUseCanon     - true when enough arc summaries exist to warrant canon
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
  saveSettingsDebounced,
} from '../../../../script.js';
import { generateMemoryExtract } from './generate.js';
import { extension_settings } from '../../../extensions.js';
import { estimateTokens, MODULE_NAME, PROMPT_KEY_SHORT } from './constants.js';
import { buildCanonSummaryPrompt } from './prompts.js';
import { loadCharacterMemories } from './longterm.js';
import { loadArcSummaries } from './arcs.js';
import { smLog } from './logging.js';

// Minimum number of resolved arc summaries before canon is used instead of
// the compaction summary. Two arcs represents "past multiple arcs" per the design.
const CANON_ARC_THRESHOLD = 2;

// ---- Storage ------------------------------------------------------------

/**
 * Returns the stored canon summary for a character, or null if none exists.
 * @param {string} characterName
 * @returns {{text: string, ts: number}|null}
 */
export function loadCanon(characterName) {
  if (!characterName) return null;
  return extension_settings[MODULE_NAME]?.characters?.[characterName]?.canon ?? null;
}

/**
 * Persists a canon summary for a character to extension_settings.
 * Merges with the existing character object so memories and entity registry
 * are not overwritten.
 *
 * @param {string} characterName
 * @param {string} text - The generated canon summary text.
 */
export function saveCanon(characterName, text) {
  if (!characterName || !text) return;
  if (!extension_settings[MODULE_NAME].characters) {
    extension_settings[MODULE_NAME].characters = {};
  }
  const existing = extension_settings[MODULE_NAME].characters[characterName] ?? {};
  extension_settings[MODULE_NAME].characters[characterName] = {
    ...existing,
    canon: { text, ts: Date.now() },
  };
  saveSettingsDebounced();
}

/**
 * Removes the canon summary for a character from extension_settings.
 * @param {string} characterName
 */
export function clearCanon(characterName) {
  if (!characterName) return;
  const char = extension_settings[MODULE_NAME]?.characters?.[characterName];
  if (!char) return;
  delete char.canon;
  saveSettingsDebounced();
}

// ---- Generation ---------------------------------------------------------

/**
 * Returns true when enough arc summaries exist to warrant using canon instead
 * of the compaction summary.
 *
 * @returns {boolean}
 */
export function shouldUseCanon() {
  return loadArcSummaries().length >= CANON_ARC_THRESHOLD;
}

/**
 * Generates a canon summary for the given character from arc summaries and
 * high-importance long-term memories, then persists and injects it.
 *
 * Manual trigger only on local hardware. Profile B may call this automatically
 * after each arc closes, but that is handled by the caller.
 *
 * @param {string} characterName
 * @returns {Promise<string|null>} The generated canon text, or null on failure.
 */
export async function generateCanon(characterName) {
  if (!characterName) return null;

  const settings = extension_settings[MODULE_NAME];
  const arcSummaries = loadArcSummaries();
  if (arcSummaries.length === 0) {
    smLog('[SmartMemory] Canon generation skipped - no arc summaries available.');
    return null;
  }

  // Use high-importance (importance >= 2) long-term memories as the foundation.
  // Cap at 30 to keep the prompt cost manageable on local hardware.
  const memories = loadCharacterMemories(characterName)
    .filter((m) => !m.superseded_by && (m.importance ?? 1) >= 2)
    .slice(0, 30);
  const memoriesText = memories.map((m) => `[${m.type}] ${m.content}`).join('\n');

  const arcTexts = arcSummaries.map((s) => s.summary);
  const prompt = buildCanonSummaryPrompt(characterName, arcTexts, memoriesText);

  const response = await generateMemoryExtract(prompt, {
    responseLength: settings.canon_response_length ?? 600,
  });

  if (!response?.trim()) return null;

  const text = response.trim();
  saveCanon(characterName, text);
  smLog(
    `[SmartMemory] Canon summary generated for "${characterName}" (${estimateTokens(text)} tokens).`,
  );
  return text;
}

// ---- Injection ----------------------------------------------------------

/**
 * Injects the canon summary into the prompt via the smart_memory_short slot,
 * replacing the compaction summary when canon is active.
 *
 * Does nothing if no canon exists or shouldUseCanon() returns false.
 * Returns true if canon was injected, false otherwise (so the caller knows
 * whether to fall back to compaction injection).
 *
 * @param {string} characterName
 * @returns {boolean} True if canon was injected.
 */
export function injectCanon(characterName) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.compaction_enabled) return false;

  const canon = loadCanon(characterName);
  if (!canon || !shouldUseCanon()) return false;

  // Trim to the compaction token budget.
  const budget = settings.compaction_inject_budget ?? 600;
  let text = canon.text;
  while (estimateTokens(text) > budget && text.length > 100) {
    // Trim from the end, one sentence at a time.
    const lastPeriod = text.lastIndexOf('.', text.length - 2);
    if (lastPeriod < 0) break;
    text = text.slice(0, lastPeriod + 1).trim();
  }

  const template = settings.compaction_template ?? 'Story so far:\n{{summary}}';
  const content = template.replace('{{summary}}', text);

  setExtensionPrompt(
    PROMPT_KEY_SHORT,
    content,
    settings.compaction_position ?? extension_prompt_types.IN_PROMPT,
    settings.compaction_depth ?? 0,
    false,
    settings.compaction_role ?? extension_prompt_roles.SYSTEM,
  );

  return true;
}
