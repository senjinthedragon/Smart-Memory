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
 * Long-term memory: per-character persistent facts stored in extension_settings.
 *
 * Memories survive across all sessions and are injected at the start of every
 * new chat with the same character. A fresh-start flag in chatMetadata can
 * suppress injection for a specific chat.
 *
 * loadCharacterMemories    - returns the stored memory array for a character
 * saveCharacterMemories    - persists the memory array for a character
 * clearCharacterMemories   - deletes all memories for a character
 * formatMemoriesForPrompt  - formats the memory array as [type] content lines
 * extractAndStoreMemories  - runs extraction against recent messages and merges results
 * injectMemories           - pushes memories into the prompt via setExtensionPrompt
 * isFreshStart             - returns whether the current chat has fresh-start enabled
 * setFreshStart            - toggles the fresh-start flag and saves chatMetadata
 */

import {
  generateRaw,
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  MODULE_NAME,
  PROMPT_KEY_LONG,
  MEMORY_TYPES,
  META_KEY,
} from './constants.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from './prompts.js';

// ---- Storage helpers ----------------------------------------------------

/**
 * Returns the memory array for a character, or an empty array if none exist.
 * @param {string} characterName
 * @returns {Array<{type: string, content: string, ts: number}>}
 */
export function loadCharacterMemories(characterName) {
  if (!characterName) return [];
  const chars = extension_settings[MODULE_NAME].characters;
  return chars?.[characterName]?.memories ?? [];
}

/**
 * Persists the memory array for a character into extension_settings.
 * Caller must call saveSettingsDebounced() afterwards.
 * @param {string} characterName
 * @param {Array<{type: string, content: string, ts: number}>} memories
 */
export function saveCharacterMemories(characterName, memories) {
  if (!characterName) return;
  if (!extension_settings[MODULE_NAME].characters) {
    extension_settings[MODULE_NAME].characters = {};
  }
  extension_settings[MODULE_NAME].characters[characterName] = {
    memories,
    lastUpdated: Date.now(),
  };
}

/**
 * Removes all stored memories for a character.
 * Caller must call saveSettingsDebounced() afterwards.
 * @param {string} characterName
 */
export function clearCharacterMemories(characterName) {
  if (!characterName) return;
  if (extension_settings[MODULE_NAME].characters?.[characterName]) {
    delete extension_settings[MODULE_NAME].characters[characterName];
  }
}

// ---- Formatting ---------------------------------------------------------

/**
 * Formats the memory array into [type] content lines for prompt injection
 * or for passing to the extraction prompt as existing context.
 * @param {Array<{type: string, content: string}>} memories
 * @returns {string}
 */
export function formatMemoriesForPrompt(memories) {
  if (!memories || memories.length === 0) return '';
  return memories.map((m) => `[${m.type}] ${m.content}`).join('\n');
}

// ---- Extraction ---------------------------------------------------------

/**
 * Parses "[type] content" tagged lines from the model's extraction output.
 * Lines that don't match the expected format or have unrecognised types are skipped.
 * @param {string} text - Raw model response.
 * @returns {Array<{type: string, content: string, ts: number}>}
 */
function parseExtractionOutput(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];

  const results = [];
  // Matches lines like: [fact] The character is tall.
  const linePattern = /^\[(fact|relationship|preference|event)\]\s+(.+)$/gim;
  let match;

  while ((match = linePattern.exec(text)) !== null) {
    const type = match[1].toLowerCase();
    const content = match[2].trim();
    if (MEMORY_TYPES.includes(type) && content.length > 5) {
      results.push({ type, content, ts: Date.now() });
    }
  }

  return results;
}

/**
 * Merges new memories into the existing set, skipping near-duplicates and
 * trimming to the configured maximum.
 *
 * Duplicate detection uses word-overlap (Jaccard-like): if more than 70% of
 * the words in the new memory also appear in an existing memory, it is
 * considered a duplicate and dropped. This is intentionally conservative -
 * false negatives (keeping a near-duplicate) are less harmful than false
 * positives (discarding genuinely new information).
 *
 * When the merged total exceeds maxTotal, the oldest entries are dropped
 * (splice from the front) to keep the most recent memories.
 *
 * @param {Array} existing - Currently stored memories.
 * @param {Array} incoming - Newly extracted memories to merge in.
 * @param {number} maxTotal - Hard cap on the total number of memories to keep.
 * @returns {Array} The merged memory array.
 */
function mergeMemories(existing, incoming, maxTotal) {
  const merged = [...existing];

  for (const mem of incoming) {
    const newWords = new Set(mem.content.toLowerCase().split(/\s+/));
    const isDuplicate = merged.some((ex) => {
      const exWords = new Set(ex.content.toLowerCase().split(/\s+/));
      const intersection = [...newWords].filter((w) => exWords.has(w)).length;
      const union = new Set([...newWords, ...exWords]).size;
      return intersection / union > 0.7;
    });

    if (!isDuplicate) {
      merged.push(mem);
    }
  }

  // Drop oldest entries first when over the limit.
  if (merged.length > maxTotal) {
    merged.splice(0, merged.length - maxTotal);
  }

  return merged;
}

/**
 * Extracts memorable facts from recent chat messages via the model and merges
 * them into the character's stored memories. Safe to fire-and-forget.
 * @param {string} characterName
 * @param {Array} recentMessages - Last N message objects from context.chat.
 * @returns {Promise<number>} Count of new memories added (0 on failure or nothing found).
 */
export async function extractAndStoreMemories(characterName, recentMessages) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.longterm_enabled || !characterName) return 0;

  try {
    const chatHistory = recentMessages
      .filter((m) => m.mes && !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!chatHistory.trim()) return 0;

    const existingMemories = loadCharacterMemories(characterName);
    const existingText = formatMemoriesForPrompt(existingMemories);

    const response = await generateRaw({
      prompt: buildExtractionPrompt(chatHistory, existingText),
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      quietToLoud: false,
      responseLength: settings.longterm_response_length || 600,
    });

    console.log(
      `[SmartMemory] Raw extraction response for "${characterName}":`,
      response,
    );

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    const newMemories = parseExtractionOutput(response);
    if (newMemories.length === 0) {
      console.log(
        '[SmartMemory] No parseable memories in response. Check format above.',
      );
      return 0;
    }

    const maxMemories = settings.longterm_max_memories || 25;
    const merged = mergeMemories(existingMemories, newMemories, maxMemories);
    saveCharacterMemories(characterName, merged);

    console.log(
      `[SmartMemory] Saved ${newMemories.length} new memories for "${characterName}". Total: ${merged.length}`,
    );
    return newMemories.length;
  } catch (err) {
    console.error('[SmartMemory] Memory extraction failed:', err);
    return 0;
  }
}

// ---- Injection ----------------------------------------------------------

/**
 * Injects the character's stored memories into the prompt.
 * Clears the injection slot if fresh-start is active, no character is set,
 * or the character has no memories yet.
 * @param {string} characterName
 * @param {boolean} [freshStart=false] - If true, suppress injection for this chat.
 */
export function injectMemories(characterName, freshStart = false) {
  const settings = extension_settings[MODULE_NAME];

  if (!settings.longterm_enabled || freshStart || !characterName) {
    setExtensionPrompt(PROMPT_KEY_LONG, '', extension_prompt_types.NONE, 0);
    return;
  }

  const memories = loadCharacterMemories(characterName);
  if (memories.length === 0) {
    setExtensionPrompt(PROMPT_KEY_LONG, '', extension_prompt_types.NONE, 0);
    return;
  }

  const memoryText = formatMemoriesForPrompt(memories);
  const template =
    settings.longterm_template ||
    '[Memories from previous conversations:\n{{memories}}]';
  const content = template.replace('{{memories}}', memoryText);

  setExtensionPrompt(
    PROMPT_KEY_LONG,
    content,
    settings.longterm_position ?? extension_prompt_types.IN_PROMPT,
    settings.longterm_depth ?? 2,
    false,
    settings.longterm_role ?? extension_prompt_roles.SYSTEM,
  );
}

// ---- Fresh-start helpers ------------------------------------------------

/**
 * Returns whether the current chat has fresh-start enabled.
 * When true, long-term memories are not injected for this chat.
 * @returns {boolean}
 */
export function isFreshStart() {
  const context = getContext();
  return context.chatMetadata?.[META_KEY]?.freshStart === true;
}

/**
 * Toggles the fresh-start flag for the current chat and saves chatMetadata.
 * @param {boolean} value
 */
export async function setFreshStart(value) {
  const context = getContext();
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].freshStart = value;
  await context.saveMetadata();
}
