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
 * Session memory: detailed within-chat facts stored in chatMetadata.
 *
 * Sits between short-term (broad narrative summary) and long-term (distilled
 * cross-session facts). Session memories are more granular than long-term -
 * capturing scene details, named objects, specific revelations - but do not
 * survive past the current chat.
 *
 * loadSessionMemories        - returns the current session memory array
 * saveSessionMemories        - persists the session memory array to chatMetadata
 * clearSessionMemories       - empties session memories for the current chat
 * extractSessionMemories     - runs extraction against recent messages and merges results
 * consolidateSessionMemories - evaluates unprocessed entries against the consolidated base per type
 * formatSessionMemories      - formats the memory array as [type] content lines
 * injectSessionMemories      - pushes session memories into the prompt via setExtensionPrompt
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
  META_KEY,
  PROMPT_KEY_SESSION,
  SESSION_TYPES,
} from './constants.js';
import { buildSessionExtractionPrompt, buildSessionConsolidationPrompt } from './prompts.js';
import { reconcileTypeEntries, trimByPriority } from './memory-utils.js';

// ---- Storage (chatMetadata) ---------------------------------------------

/**
 * Returns the session memory array for the current chat.
 * Migrates legacy entries (no consolidated flag) to consolidated: true on load
 * so existing memories are treated as the stable base.
 * @returns {Array<{type: string, content: string, ts: number, consolidated: boolean}>}
 */
export function loadSessionMemories() {
  const context = getContext();
  const memories = context.chatMetadata?.[META_KEY]?.sessionMemories ?? [];
  // Migrate: entries without the consolidated flag are pre-existing stable memories.
  // Entries without an importance score default to 2 (medium).
  return memories.map((m) => ({
    ...m,
    consolidated: m.consolidated ?? true,
    importance: m.importance ?? 2,
  }));
}

/**
 * Persists the session memory array to chatMetadata.
 * @param {Array<{type: string, content: string, ts: number}>} memories
 */
export async function saveSessionMemories(memories) {
  const context = getContext();
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].sessionMemories = memories;
  await context.saveMetadata();
}

/**
 * Empties session memories for the current chat.
 */
export async function clearSessionMemories() {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    context.chatMetadata[META_KEY].sessionMemories = [];
    await context.saveMetadata();
  }
}

// ---- Parsing ------------------------------------------------------------

/**
 * Parses "[type] content" tagged lines from the model's session extraction output.
 * Lines with unrecognised types or very short content are skipped.
 * @param {string} text - Raw model response.
 * @returns {Array<{type: string, content: string, ts: number}>}
 */
function parseSessionOutput(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];
  const results = [];
  // Matches lines like: [scene:2] Candlelit tavern, late evening.
  // The importance score (:N) is optional - defaults to 2 if omitted.
  const pattern = /^\[(scene|revelation|development|detail)(?::([123]))?\]\s+(.+)$/gim;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const type = match[1].toLowerCase();
    const importance = match[2] ? parseInt(match[2], 10) : 2;
    const content = match[3].trim();
    if (SESSION_TYPES.includes(type) && content.length > 3) {
      // New entries start as unprocessed - they will be evaluated against the
      // consolidated base before being promoted.
      results.push({ type, content, importance, ts: Date.now(), consolidated: false });
    }
  }
  return results;
}

/**
 * Merges new session memories into the existing set, skipping near-duplicates
 * and trimming to the configured maximum.
 *
 * Uses a word-overlap ratio: if the intersection of words between a new item
 * and any existing item exceeds 65% of the larger set's word count, the new
 * item is treated as a duplicate. This threshold is slightly looser than
 * long-term (70%) since session details tend to be more specific and verbose.
 *
 * When over the limit, the oldest entries are dropped from the front.
 *
 * @param {Array} existing - Currently stored session memories.
 * @param {Array} incoming - Newly extracted items to merge in.
 * @param {number} max - Hard cap on total session memories.
 * @returns {Array} The merged array.
 */
function deduplicateSession(existing, incoming, max) {
  const merged = [...existing];
  for (const mem of incoming) {
    const words = new Set(mem.content.toLowerCase().split(/\s+/));
    const isDuplicate = merged.some((ex) => {
      if (ex.type !== mem.type) return false;
      const exWords = new Set(ex.content.toLowerCase().split(/\s+/));
      const intersection = [...words].filter((w) => exWords.has(w)).length;
      // Normalise against the larger set to avoid short strings
      // matching too aggressively against long ones.
      return intersection / Math.max(words.size, exWords.size) > 0.65;
    });
    if (!isDuplicate) merged.push(mem);
  }
  // When over the cap, drop the least valuable entries first:
  // sort by importance ascending then age ascending, remove from the tail.
  if (merged.length > max) {
    merged.sort((a, b) => {
      const ia = a.importance ?? 2;
      const ib = b.importance ?? 2;
      if (ia !== ib) return ib - ia; // higher importance first
      return b.ts - a.ts; // newer first within same importance
    });
    merged.splice(max);
  }
  return merged;
}

// ---- Extraction ---------------------------------------------------------

/**
 * Extracts session-level details from recent messages via the model and merges
 * them into chatMetadata. Returns the count of new items saved.
 * @param {Array} recentMessages - Last N message objects from context.chat.
 * @returns {Promise<number>} Count of new items added (0 on failure or nothing found).
 */
export async function extractSessionMemories(recentMessages) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.session_enabled) return 0;

  try {
    const chatHistory = recentMessages
      .filter((m) => m.mes && !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!chatHistory.trim()) return 0;

    const existing = loadSessionMemories();
    const existingText = existing.map((m) => `[${m.type}] ${m.content}`).join('\n');

    const response = await generateMemoryExtract(
      buildSessionExtractionPrompt(chatHistory, existingText),
      { responseLength: settings.session_response_length ?? 500 },
    );

    console.log('[SmartMemory] Session extraction response:', response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    const incoming = parseSessionOutput(response);
    if (incoming.length === 0) return 0;

    const max = settings.session_max_memories ?? 30;
    const merged = deduplicateSession(existing, incoming, max);
    const added = merged.length - Math.min(existing.length, max);
    await saveSessionMemories(merged);

    return Math.max(0, added);
  } catch (err) {
    console.error('[SmartMemory] Session extraction failed:', err);
    throw err;
  }
}

// ---- Consolidation ------------------------------------------------------

// How many unprocessed entries of a single type must accumulate before
// consolidation fires for that type.
const SESSION_CONSOLIDATION_THRESHOLD = 4;

/**
 * Runs a consolidation pass on session memories for the current chat.
 *
 * Maintains a stable consolidated base per session memory type. When enough
 * unprocessed entries accumulate for a given type, the model evaluates only
 * that batch against the base - it may drop duplicates, fold new details into
 * existing base entries, or add genuinely new entries. The base is never
 * rewritten, only extended.
 *
 * Fires per-type independently - a burst of new [scene] entries does not
 * trigger [detail] consolidation.
 *
 * @returns {Promise<number>} Number of memories removed by consolidation (0 on no change or failure).
 */
export async function consolidateSessionMemories() {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.session_enabled) return 0;

  const memories = loadSessionMemories();
  let totalRemoved = 0;

  for (const type of SESSION_TYPES) {
    const base = memories.filter((m) => m.type === type && m.consolidated);
    const unprocessed = memories.filter((m) => m.type === type && !m.consolidated);

    if (unprocessed.length < SESSION_CONSOLIDATION_THRESHOLD) continue;

    try {
      const baseText = base.map((m) => `[${m.type}] ${m.content}`).join('\n');
      const batchText = unprocessed.map((m) => `[${m.type}] ${m.content}`).join('\n');

      const response = await generateMemoryExtract(
        buildSessionConsolidationPrompt(type, baseText, batchText),
        { responseLength: Math.max(400, (base.length + unprocessed.length) * 60) },
      );

      console.log(`[SmartMemory] Session consolidation response for [${type}]:`, response);

      if (!response || response.trim().toUpperCase() === 'NONE') {
        // Nothing to add - mark unprocessed as consolidated as-is.
        unprocessed.forEach((m) => (m.consolidated = true));
        continue;
      }

      // Parse the model's output - these are the entries to add/update in the base.
      const incoming = parseSessionOutput(response);
      // Mark all incoming as consolidated since they've been through the process.
      const promoted = incoming.map((m) => ({ ...m, consolidated: true }));

      // Reconcile promoted entries with the base so "updated" base entries
      // replace older variants instead of being appended as duplicates.
      const reconciledType = reconcileTypeEntries(base, promoted, 0.65);

      // Replace this type's entries. Other types are untouched.
      const otherTypes = memories.filter((m) => m.type !== type);
      memories.splice(0, memories.length, ...otherTypes, ...reconciledType);

      const before = base.length + unprocessed.length;
      const after = reconciledType.length;
      const removed = before - after;
      totalRemoved += Math.max(0, removed);

      console.log(
        `[SmartMemory] Session [${type}] consolidation: ${unprocessed.length} unprocessed -> ${promoted.length} promoted. Base: ${base.length}. Removed: ${Math.max(0, removed)}.`,
      );
    } catch (err) {
      console.error(`[SmartMemory] Session consolidation failed for type [${type}]:`, err);
      // On failure, mark unprocessed as consolidated so they don't block future passes.
      unprocessed.forEach((m) => (m.consolidated = true));
    }
  }

  const max = settings.session_max_memories ?? 30;
  const finalMemories = trimByPriority(memories, max);
  if (
    totalRemoved > 0 ||
    finalMemories.length !== memories.length ||
    memories.some((m) => m.consolidated)
  ) {
    await saveSessionMemories(finalMemories);
  }

  return totalRemoved;
}

// ---- Injection ----------------------------------------------------------

/**
 * Formats the session memory array as [type] content lines.
 * @param {Array<{type: string, content: string}>} memories
 * @returns {string}
 */
export function formatSessionMemories(memories) {
  if (!memories || memories.length === 0) return '';
  return memories.map((m) => `[${m.type}] ${m.content}`).join('\n');
}

/**
 * Injects session memories into the prompt via setExtensionPrompt.
 * Clears the slot if session memory is disabled or no memories exist.
 */
export function injectSessionMemories() {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.session_enabled) {
    setExtensionPrompt(PROMPT_KEY_SESSION, '', extension_prompt_types.NONE, 0);
    return;
  }

  const memories = loadSessionMemories();
  if (memories.length === 0) {
    setExtensionPrompt(PROMPT_KEY_SESSION, '', extension_prompt_types.NONE, 0);
    return;
  }

  // Trim to token budget: sort so low-importance old entries are dropped first.
  // Primary sort: importance descending (3 before 1). Secondary: age descending (newest first).
  const budget = settings.session_inject_budget ?? 400;
  const trimmed = [...memories].sort((a, b) => {
    const ia = a.importance ?? 2;
    const ib = b.importance ?? 2;
    if (ia !== ib) return ib - ia; // higher importance first
    return b.ts - a.ts; // newer first within same importance
  });
  while (trimmed.length > 1 && estimateTokens(formatSessionMemories(trimmed)) > budget) {
    trimmed.pop();
  }

  const template = settings.session_template ?? '[Details from this session:\n{{session}}]';
  const content = template.replace('{{session}}', formatSessionMemories(trimmed));

  setExtensionPrompt(
    PROMPT_KEY_SESSION,
    content,
    settings.session_position ?? extension_prompt_types.IN_PROMPT,
    settings.session_depth ?? 1,
    false,
    settings.session_role ?? extension_prompt_roles.SYSTEM,
  );
}
