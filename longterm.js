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
 * consolidateMemories      - evaluates unprocessed entries against the stable consolidated base per type
 * injectMemories           - pushes memories into the prompt via setExtensionPrompt
 * isFreshStart             - returns whether the current chat has fresh-start enabled
 * setFreshStart            - toggles the fresh-start flag and saves chatMetadata
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { generateMemoryExtract } from './generate.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  estimateTokens,
  MODULE_NAME,
  PROMPT_KEY_LONG,
  MEMORY_TYPES,
  META_KEY,
} from './constants.js';
import { buildExtractionPrompt, buildLongtermConsolidationPrompt } from './prompts.js';
import { reconcileTypeEntries, trimByPriority } from './memory-utils.js';

// ---- Storage helpers ----------------------------------------------------

/**
 * Returns the memory array for a character, or an empty array if none exist.
 * Migrates legacy entries (no consolidated flag) to consolidated: true on load
 * so existing memories are treated as the stable base.
 * @param {string} characterName
 * @returns {Array<{type: string, content: string, ts: number, consolidated: boolean}>}
 */
export function loadCharacterMemories(characterName) {
  if (!characterName) return [];
  const chars = extension_settings[MODULE_NAME].characters;
  const memories = chars?.[characterName]?.memories ?? [];
  // Migrate: entries without the consolidated flag are pre-existing stable memories.
  // Entries without an importance score default to 2 (medium).
  return memories.map((m) => ({
    ...m,
    consolidated: m.consolidated ?? true,
    importance: m.importance ?? 2,
  }));
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
  // Matches lines like: [fact:2] The character is tall.
  // The importance score (:N) is optional - defaults to 2 if omitted.
  const linePattern = /^\[(fact|relationship|preference|event)(?::([123]))?\]\s+(.+)$/gim;
  let match;

  while ((match = linePattern.exec(text)) !== null) {
    const type = match[1].toLowerCase();
    const importance = match[2] ? parseInt(match[2], 10) : 2;
    const content = match[3].trim();
    if (MEMORY_TYPES.includes(type) && content.length > 5) {
      // New entries start as unprocessed - they will be evaluated against the
      // consolidated base before being promoted.
      results.push({ type, content, importance, ts: Date.now(), consolidated: false });
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
      if (ex.type !== mem.type) return false;
      const exWords = new Set(ex.content.toLowerCase().split(/\s+/));
      const intersection = [...newWords].filter((w) => exWords.has(w)).length;
      const union = new Set([...newWords, ...exWords]).size;
      return intersection / union > 0.7;
    });

    if (!isDuplicate) {
      merged.push(mem);
    }
  }

  // When over the cap, drop the least valuable entries first:
  // sort by importance ascending then age ascending, remove from the tail.
  if (merged.length > maxTotal) {
    merged.sort((a, b) => {
      const ia = a.importance ?? 2;
      const ib = b.importance ?? 2;
      if (ia !== ib) return ib - ia; // higher importance first
      return b.ts - a.ts; // newer first within same importance
    });
    merged.splice(maxTotal);
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

    const response = await generateMemoryExtract(buildExtractionPrompt(chatHistory, existingText), {
      responseLength: settings.longterm_response_length || 600,
    });

    console.log(`[SmartMemory] Raw extraction response for "${characterName}":`, response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    const newMemories = parseExtractionOutput(response);
    if (newMemories.length === 0) {
      console.log('[SmartMemory] No parseable memories in response. Check format above.');
      return 0;
    }

    const maxMemories = settings.longterm_max_memories || 25;
    const merged = mergeMemories(existingMemories, newMemories, maxMemories);
    const added = merged.length - Math.min(existingMemories.length, maxMemories);
    saveCharacterMemories(characterName, merged);

    console.log(
      `[SmartMemory] Saved ${added} new memories for "${characterName}". Total: ${merged.length}`,
    );
    return Math.max(0, added);
  } catch (err) {
    console.error('[SmartMemory] Memory extraction failed:', err);
    throw err;
  }
}

// How many unprocessed entries of a single type must accumulate before
// consolidation fires for that type.
//
// Preference/relationship memories tend to reappear as paraphrases quickly,
// so we run consolidation earlier for those types to reduce duplicate buildup.
const CONSOLIDATION_THRESHOLDS = {
  fact: 4,
  relationship: 3,
  preference: 3,
  event: 4,
};

/**
 * Runs a consolidation pass on the stored memories for a character.
 *
 * New approach: maintains a stable consolidated base per memory type. When
 * enough unprocessed entries accumulate for a given type, the model evaluates
 * only that batch against the base for that type - it may drop duplicates, fold
 * new details into existing base entries, or add genuinely new entries. The
 * base itself is never rewritten, only extended.
 *
 * Consolidation fires per-type independently - a burst of new [fact] entries
 * does not trigger [relationship] consolidation.
 *
 * @param {string} characterName
 * @returns {Promise<number>} Number of memories removed by consolidation (0 on no change or failure).
 */
export async function consolidateMemories(characterName) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.longterm_consolidate || !characterName) return 0;

  const memories = loadCharacterMemories(characterName);
  let totalRemoved = 0;

  for (const type of MEMORY_TYPES) {
    const base = memories.filter((m) => m.type === type && m.consolidated);
    const unprocessed = memories.filter((m) => m.type === type && !m.consolidated);

    const threshold = CONSOLIDATION_THRESHOLDS[type] ?? 4;
    if (unprocessed.length < threshold) continue;

    try {
      const baseText = formatMemoriesForPrompt(base);
      const batchText = formatMemoriesForPrompt(unprocessed);

      const response = await generateMemoryExtract(
        buildLongtermConsolidationPrompt(type, baseText, batchText),
        { responseLength: Math.max(400, (base.length + unprocessed.length) * 60) },
      );

      console.log(`[SmartMemory] Consolidation response for [${type}]:`, response);

      if (!response || response.trim().toUpperCase() === 'NONE') {
        // Model found nothing to add - mark unprocessed as consolidated as-is.
        unprocessed.forEach((m) => (m.consolidated = true));
        continue;
      }

      // Parse the model's output - these are the entries to add/update in the base.
      const incoming = parseExtractionOutput(response);

      // Mark all incoming as consolidated since they've been through the process.
      const promoted = incoming.map((m) => ({ ...m, consolidated: true }));

      // Reconcile promoted entries with the base so "updated" base entries
      // replace older variants instead of being appended as duplicates.
      const reconciledType = reconcileTypeEntries(base, promoted, 0.7);

      // Replace this type's entries. Other types are untouched.
      const otherTypes = memories.filter((m) => m.type !== type);
      memories.splice(0, memories.length, ...otherTypes, ...reconciledType);

      const before = base.length + unprocessed.length;
      const after = reconciledType.length;
      const removed = before - after;
      totalRemoved += Math.max(0, removed);

      console.log(
        `[SmartMemory] [${type}] consolidation: ${unprocessed.length} unprocessed -> ${promoted.length} promoted. Base: ${base.length}. Removed: ${Math.max(0, removed)}.`,
      );
    } catch (err) {
      console.error(`[SmartMemory] Consolidation failed for type [${type}]:`, err);
      // On failure, mark unprocessed as consolidated so they don't block future passes.
      unprocessed.forEach((m) => (m.consolidated = true));
    }
  }

  const maxMemories = settings.longterm_max_memories || 25;
  const finalMemories = trimByPriority(memories, maxMemories);
  if (
    totalRemoved > 0 ||
    finalMemories.length !== memories.length ||
    memories.some((m) => m.consolidated)
  ) {
    saveCharacterMemories(characterName, finalMemories);
  }

  return totalRemoved;
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

  // Trim to token budget: sort so low-importance old entries are dropped first.
  // Primary sort: importance ascending (1 before 3). Secondary: age ascending (oldest first).
  // This way a low-importance old entry is always dropped before a high-importance new one.
  const budget = settings.longterm_inject_budget ?? 500;
  const trimmed = [...memories].sort((a, b) => {
    const ia = a.importance ?? 2;
    const ib = b.importance ?? 2;
    if (ia !== ib) return ib - ia; // higher importance first
    return b.ts - a.ts; // newer first within same importance
  });
  while (trimmed.length > 1 && estimateTokens(formatMemoriesForPrompt(trimmed)) > budget) {
    trimmed.pop();
  }

  const memoryText = formatMemoriesForPrompt(trimmed);
  const template =
    settings.longterm_template || '[Memories from previous conversations:\n{{memories}}]';
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
