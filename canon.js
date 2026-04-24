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
 * Canon is a manually-triggered prose narrative compiled from resolved arc
 * summaries and high-importance long-term memories. It covers who the character
 * is, what has happened, and the current state of key relationships. Stored in
 * extension_settings so it persists across sessions. Injected via its own
 * dedicated slot (smart_memory_canon) independently of the compaction summary,
 * so both coexist and neither overwrites the other.
 *
 * loadCanon     - returns the stored canon for a character (or null)
 * saveCanon     - persists the canon to extension_settings
 * clearCanon    - removes the canon for a character and clears its slot
 * generateCanon - builds and stores a new canon summary
 * injectCanon   - injects canon into the prompt via its own slot
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
  saveSettingsDebounced,
} from '../../../../script.js';
import { generateMemoryExtract } from './generate.js';
import { extension_settings } from '../../../extensions.js';
import { estimateTokens, MODULE_NAME, PROMPT_KEY_CANON } from './constants.js';
import { buildCanonSummaryPrompt } from './prompts.js';
import { loadCharacterMemories } from './longterm.js';
import { loadArcSummaries } from './arcs.js';
import { smLog } from './logging.js';

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
 * Removes the canon summary for a character from extension_settings and clears
 * the injection slot so nothing stale remains in the prompt.
 * @param {string} characterName
 */
export function clearCanon(characterName) {
  if (!characterName) return;
  const char = extension_settings[MODULE_NAME]?.characters?.[characterName];
  if (char) {
    delete char.canon;
    saveSettingsDebounced();
  }
  setExtensionPrompt(PROMPT_KEY_CANON, '', extension_prompt_types.NONE, 0);
}

// ---- Generation ---------------------------------------------------------

/**
 * Generates a canon summary for the given character from arc summaries and
 * high-importance long-term memories, then persists and returns the text.
 *
 * Returns null (with a log message) when no arc summaries exist yet.
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
 * Injects the canon summary into the prompt via its own dedicated slot
 * (smart_memory_canon), independent of the compaction summary slot.
 * Clears the slot if no canon exists or canon is not stored for this character.
 *
 * @param {string} characterName
 */
export function injectCanon(characterName) {
  const settings = extension_settings[MODULE_NAME];

  const canon = loadCanon(characterName);
  if (!canon) {
    setExtensionPrompt(PROMPT_KEY_CANON, '', extension_prompt_types.NONE, 0);
    return;
  }

  // Trim to the canon token budget.
  const budget = settings.canon_inject_budget ?? 800;
  let text = canon.text;
  while (estimateTokens(text) > budget && text.length > 100) {
    const lastPeriod = text.lastIndexOf('.', text.length - 2);
    if (lastPeriod < 0) {
      // No sentence boundary found (e.g. bullet-only canon) - hard-truncate
      // proportionally so the budget is still respected.
      text = text.slice(0, Math.round(text.length * (budget / estimateTokens(text)))).trim();
      break;
    }
    text = text.slice(0, lastPeriod + 1).trim();
  }

  const template = settings.canon_template ?? 'Character history:\n{{canon}}';
  const content = template.replace('{{canon}}', text);

  setExtensionPrompt(
    PROMPT_KEY_CANON,
    content,
    settings.canon_position ?? extension_prompt_types.IN_PROMPT,
    settings.canon_depth ?? 0,
    false,
    settings.canon_role ?? extension_prompt_roles.SYSTEM,
  );
}
