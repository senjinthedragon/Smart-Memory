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
  saveSettingsDebounced,
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
import { parseExtractionOutput } from './parsers.js';
import {
  prioritizeMemories,
  reconcileTypeEntries,
  selectProtectedMemories,
  sortByTimeline,
  trimByPriority,
} from './memory-utils.js';
import { batchVerify } from './embeddings.js';

// Maximum new entries accepted per type per extraction pass.
// Prevents one burst of similar events flooding a single type while still
// allowing genuinely diverse new facts through.
const MAX_NEW_PER_TYPE_PER_EXTRACTION = 2;

function incomingPriorityScore(mem) {
  const typeBonus =
    mem.type === 'relationship'
      ? 30
      : mem.type === 'fact'
        ? 20
        : mem.type === 'preference'
          ? 10
          : 0;
  return (mem.importance ?? 2) * 100 + typeBonus + (mem.ts ?? 0) / 1e13;
}

/**
 * Filters a list of candidate memories against existing ones, removing
 * near-duplicates and entries that fail basic quality checks.
 *
 * All texts are embedded in a single batch API call so nomic-embed-text only
 * needs to load once per verification pass rather than once per candidate.
 * Falls back to Jaccard word-overlap when embeddings are unavailable.
 *
 * @param {Array} candidates - Newly extracted memory objects to evaluate.
 * @param {Array} existing   - Currently stored memories to compare against.
 * @returns {Promise<Array>} Candidates that passed all checks.
 */
async function verifyLongtermCandidates(candidates, existing) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const bannedPhrases = ['maybe', 'might be', 'possibly', 'i think', 'perhaps', 'seems like'];
  const seen = new Set();

  // Apply quality filters before embedding - no point embedding entries we'll discard.
  const filtered = candidates.filter((mem) => {
    const text = String(mem.content || '').trim();
    if (text.length < 8 || text.length > 280) return false;
    const lower = text.toLowerCase();
    if (bannedPhrases.some((p) => lower.includes(p))) return false;
    const key = `${mem.type}|${lower}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (filtered.length === 0) return [];

  // Batch-embed all candidates and existing memories in one API call.
  const { passed } = await batchVerify(filtered, existing);
  return filtered.filter((m) =>
    passed.has(
      String(m.content || '')
        .toLowerCase()
        .trim(),
    ),
  );
}

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
    expiration: m.expiration ?? 'permanent',
    confidence: m.confidence ?? 0.7,
    persona_relevance: m.persona_relevance ?? (m.type === 'relationship' ? 3 : 1),
    intimacy_relevance: m.intimacy_relevance ?? (m.type === 'preference' ? 3 : 1),
    retrieval_count: m.retrieval_count ?? 0,
    // Fall back to 0 (not Date.now()) when both fields are absent so legacy
    // entries don't receive an artificial recency boost in memoryUtilityScore.
    last_confirmed_ts: m.last_confirmed_ts ?? m.ts ?? 0,
  }));
}

/**
 * Persists the memory array for a character into extension_settings.
 * Caller must call saveSettingsDebounced() afterwards.
 * @param {string} characterName
 * @param {Array<{type: string, content: string, ts: number}>} memories
 */
export function saveCharacterMemories(characterName, memories) {
  if (!characterName || !Array.isArray(memories)) return;
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
  return sortByTimeline(memories)
    .map((m) => `[${m.type}] ${m.content}`)
    .join('\n');
}

// ---- Extraction ---------------------------------------------------------

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
/**
 * Merges new memories into the existing set with two layers of churn control:
 *
 * 1. Per-type extraction cap: at most MAX_NEW_PER_TYPE_PER_EXTRACTION entries
 *    per type are accepted per pass. Prevents a burst of similar events from
 *    flooding one type while the rest accumulate normally.
 *
 * 2. Per-type storage cap: derived from maxTotal / number of types (rounded up).
 *    When a new entry would push a type over its cap, the lowest-priority entry
 *    of that type is evicted first so the total stays balanced. Cloud users who
 *    raise maxTotal get proportionally larger per-type budgets automatically.
 *
 * @param {Array} existing - Currently stored memories.
 * @param {Array} incoming - Newly extracted memories (already deduped by verifyLongtermCandidates).
 * @param {number} maxTotal - Hard cap on total stored memories (from settings).
 * @returns {Array} The merged memory array.
 */
function mergeMemories(existing, incoming, maxTotal) {
  const merged = [...existing];

  // Per-type cap derived from the overall max - equal split across all types.
  // At 25 total -> 7 per type (ceil(25/4)), at 50 -> 13, at 100 -> 25.
  const perTypeCap = Math.ceil(maxTotal / MEMORY_TYPES.length);

  // Track how many new entries we've accepted per type this pass.
  const addedPerType = new Map();

  // Sort incoming by priority so when we hit the per-type cap we keep the best.
  const sorted = [...incoming].sort((a, b) => incomingPriorityScore(b) - incomingPriorityScore(a));

  for (const mem of sorted) {
    const typeAdded = addedPerType.get(mem.type) ?? 0;
    if (typeAdded >= MAX_NEW_PER_TYPE_PER_EXTRACTION) continue;

    // If this type is already at the per-type storage cap, evict the
    // lowest-priority existing entry of this type before adding the new one -
    // but only if the new entry actually outscores the one we'd displace.
    // Without this guard a burst of low-priority new entries could displace
    // high-priority existing ones that are far more valuable to keep.
    const typeEntries = merged.filter((m) => m.type === mem.type);
    if (typeEntries.length >= perTypeCap) {
      const prioritized = prioritizeMemories(typeEntries);
      // Last entry in prioritized is lowest priority.
      const toEvict = prioritized[prioritized.length - 1];
      if (incomingPriorityScore(mem) <= incomingPriorityScore(toEvict)) continue;
      const evictIdx = merged.findIndex(
        (m) => m.type === toEvict.type && m.content === toEvict.content,
      );
      if (evictIdx >= 0) merged.splice(evictIdx, 1);
    }

    merged.push(mem);
    addedPerType.set(mem.type, typeAdded + 1);
  }

  // Final safety trim to maxTotal in case types were already over cap before
  // this pass (e.g. migrating from an older version without the cap).
  if (merged.length > maxTotal) {
    const prioritized = prioritizeMemories(merged);
    merged.splice(0, merged.length, ...prioritized);
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

    const response = await generateMemoryExtract(
      buildExtractionPrompt(chatHistory, existingText, characterName),
      {
        responseLength: settings.longterm_response_length || 600,
      },
    );

    console.log(`[SmartMemory] Raw extraction response for "${characterName}":`, response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    const newMemories = await verifyLongtermCandidates(
      parseExtractionOutput(response),
      existingMemories,
    );
    if (newMemories.length === 0) {
      console.log('[SmartMemory] No parseable memories in response. Check format above.');
      return 0;
    }

    const maxMemories = settings.longterm_max_memories || 25;
    const merged = mergeMemories(existingMemories, newMemories, maxMemories);
    // Count how many of the new candidates actually survived dedup and made it
    // into the merged set, regardless of whether older entries were displaced.
    const existingKeys = new Set(existingMemories.map((m) => `${m.type}|${m.content}`));
    const added = merged.filter((m) => !existingKeys.has(`${m.type}|${m.content}`)).length;
    saveCharacterMemories(characterName, merged);

    console.log(
      `[SmartMemory] Saved ${added} new memories for "${characterName}". Total: ${merged.length}`,
    );
    return added;
  } catch (err) {
    console.error('[SmartMemory] Memory extraction failed:', err);
    throw err;
  }
}

// How many unprocessed entries of a single type must accumulate before
// consolidation fires for that type.
//
// User-configurable via settings panel; defaults preserve earlier tuned values.
const DEFAULT_CONSOLIDATION_THRESHOLDS = {
  fact: 4,
  relationship: 3,
  preference: 3,
  event: 4,
};

function getConsolidationThresholds(settings) {
  return {
    fact: Math.max(
      2,
      settings.longterm_consolidation_threshold_fact ?? DEFAULT_CONSOLIDATION_THRESHOLDS.fact,
    ),
    relationship: Math.max(
      2,
      settings.longterm_consolidation_threshold_relationship ??
        DEFAULT_CONSOLIDATION_THRESHOLDS.relationship,
    ),
    preference: Math.max(
      2,
      settings.longterm_consolidation_threshold_preference ??
        DEFAULT_CONSOLIDATION_THRESHOLDS.preference,
    ),
    event: Math.max(
      2,
      settings.longterm_consolidation_threshold_event ?? DEFAULT_CONSOLIDATION_THRESHOLDS.event,
    ),
  };
}

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
 * @param {boolean} [force=false] - If true, consolidate all types regardless of threshold.
 *   Used by the catch-up final pass to flush any entries that never accumulated enough
 *   to hit the threshold during per-chunk consolidation.
 * @returns {Promise<number>} Number of memories removed by consolidation (0 on no change or failure).
 */
export async function consolidateMemories(characterName, force = false) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.longterm_consolidate || !characterName) return 0;
  const thresholds = getConsolidationThresholds(settings);

  const memories = loadCharacterMemories(characterName);
  let totalRemoved = 0;
  let dirty = false;

  for (const type of MEMORY_TYPES) {
    const base = memories.filter((m) => m.type === type && m.consolidated);
    const unprocessed = memories.filter((m) => m.type === type && !m.consolidated);

    const threshold = thresholds[type] ?? DEFAULT_CONSOLIDATION_THRESHOLDS.fact;
    if (!force && unprocessed.length < threshold) continue;
    if (unprocessed.length === 0) continue;

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
        dirty = true;
        continue;
      }

      // Parse the model's output - these are the entries to add/update in the base.
      const incoming = parseExtractionOutput(response);

      // Mark all incoming as consolidated since they've been through the process.
      const promoted = incoming.map((m) => ({ ...m, consolidated: true }));

      // Reconcile promoted entries with the base so "updated" base entries
      // replace older variants instead of being appended as duplicates.
      const reconciledType = reconcileTypeEntries(base, promoted, 0.7, [...base, ...unprocessed]);

      // Replace this type's entries. Other types are untouched.
      const otherTypes = memories.filter((m) => m.type !== type);
      memories.splice(0, memories.length, ...otherTypes, ...reconciledType);

      const before = base.length + unprocessed.length;
      const after = reconciledType.length;
      const removed = before - after;
      totalRemoved += Math.max(0, removed);
      dirty = true;

      console.log(
        `[SmartMemory] [${type}] consolidation: ${unprocessed.length} unprocessed -> ${promoted.length} promoted. Base: ${base.length}. Removed: ${Math.max(0, removed)}.`,
      );
    } catch (err) {
      console.error(`[SmartMemory] Consolidation failed for type [${type}]:`, err);
      // On failure, mark unprocessed as consolidated so they don't block future passes.
      // Set dirty before the forEach so a mid-loop error still triggers the save.
      dirty = true;
      unprocessed.forEach((m) => (m.consolidated = true));
    }
  }

  const maxMemories = settings.longterm_max_memories || 25;
  const finalMemories = sortByTimeline(trimByPriority(memories, maxMemories));
  if (dirty || finalMemories.length !== memories.length) {
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
 * @param {boolean} [updateTelemetry=false] - If true, increment retrieval_count for injected memories.
 *   Only pass true from the post-extraction path (one real AI response turn). All other callers
 *   (chat load, settings change, etc.) leave telemetry unchanged to avoid inflating the signal.
 */
export function injectMemories(characterName, freshStart = false, updateTelemetry = false) {
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
  const protectedSet = new Set(
    selectProtectedMemories(memories, ['relationship', 'preference', 'fact']),
  );
  const trimmed = prioritizeMemories(memories);
  // Use the injection format for budget estimation so the check matches what is actually injected.
  while (
    trimmed.length > 1 &&
    estimateTokens(trimmed.map((m) => `- ${m.content}`).join('\n')) > budget
  ) {
    let idx = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (!protectedSet.has(trimmed[i])) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      trimmed.splice(idx, 1);
    } else {
      break;
    }
  }

  // Diversity floor: cap entries per type so a flood of near-duplicate
  // variants of one type (e.g. many preference entries about the same topic)
  // cannot crowd out other types entirely. Cap is proportional to budget so
  // larger budgets allow more entries per type without being too restrictive.
  // Formula: max(2, floor(budget / 150)) gives 2 at 200 tokens, 3 at 500, 6 at 900.
  const perTypeCap = Math.max(2, Math.floor(budget / 150));
  const typeCount = new Map();
  const diversified = trimmed.filter((m) => {
    const count = typeCount.get(m.type) ?? 0;
    if (count >= perTypeCap) return false;
    typeCount.set(m.type, count + 1);
    return true;
  });
  trimmed.splice(0, trimmed.length, ...diversified);

  // Only update retrieval telemetry when called from a real AI response turn.
  // Skipping on chat load, settings changes etc. prevents the signal from
  // saturating too quickly and becoming meaningless.
  if (updateTelemetry) {
    const recalled = new Set(trimmed.map((m) => `${m.type}|${m.content}`));
    const updated = memories.map((m) => {
      const key = `${m.type}|${m.content}`;
      if (!recalled.has(key)) return m;
      return {
        ...m,
        retrieval_count: (m.retrieval_count ?? 0) + 1,
        last_confirmed_ts: Date.now(),
      };
    });
    saveCharacterMemories(characterName, updated);
    saveSettingsDebounced();
  }

  // Format for injection: plain bullet list without [type] tags.
  // The [type] format is kept in formatMemoriesForPrompt for the extraction/consolidation
  // pipeline - those prompts need it. The RP model does not, and bracket notation
  // bleeds into story output when the model sees it repeatedly in context.
  const memoryText = trimmed.map((m) => `- ${m.content}`).join('\n');
  const template =
    settings.longterm_template || 'Memories from previous conversations:\n{{memories}}';
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
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].freshStart = value;
  await context.saveMetadata();
}
