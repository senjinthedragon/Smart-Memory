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
 * Story arc tracking: open plot threads stored in chatMetadata.
 *
 * Extracts unresolved narrative threads (promises, goals, mysteries, tensions)
 * from the conversation and keeps them injected into context so the model
 * stays oriented toward where the story is going, not just the last message.
 * Arcs can be marked resolved by the model or manually deleted by the user.
 *
 * loadArcs               - returns the stored arc array for the current chat
 * saveArcs               - persists the arc array to chatMetadata
 * deleteArc              - removes a single arc by index
 * clearArcs              - empties all arcs for the current chat
 * arcSimilarity          - returns {score, semantic} between two arc strings (cosine primary, Jaccard fallback)
 * extractArcs            - runs extraction against the conversation, deduplicates, and updates the arc list
 * injectArcs             - pushes active arcs into the prompt via setExtensionPrompt
 * loadArcSummaries       - returns the stored arc summary array for the current chat
 * clearArcSummaries      - empties all arc summaries for the current chat
 * loadPersistentArcs     - returns the character-level persistent arc array
 * savePersistentArcs     - writes a persistent arc array to character-level storage
 * mergePersistentArcs    - merges character-level persistent arcs into chatMetadata on chat open
 * loadGroupPersistentArcs  - returns the group-level persistent arc array
 * saveGroupPersistentArcs  - writes a persistent arc array to group-level storage
 * mergeGroupPersistentArcs - merges group-level persistent arcs into chatMetadata on chat open
 * pruneOrphanedGroupArcs  - removes group arc stores for groups that no longer exist
 * promoteArc             - marks a chat arc as persistent and saves it to character or group level
 * demoteArc              - removes the persistent flag from an arc and cleans character or group level
 * resolveArc             - manually marks an arc as resolved (moves to resolved panel)
 * resolveArcWithSummary  - resolves an arc and generates an arc summary for canon
 * reopenArc              - removes the resolved flag from a persistent arc and reactivates it
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
  saveSettingsDebounced,
} from '../../../../script.js';
import { generateMemoryExtract } from './generate.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { estimateTokens, MODULE_NAME, META_KEY, PROMPT_KEY_ARCS } from './constants.js';
import { buildArcExtractionPrompt, buildArcSummaryPrompt } from './prompts.js';
import { parseArcOutput } from './parsers.js';
import { loadSceneHistory } from './scenes.js';
import { loadSessionMemories } from './session.js';
import { smLog } from './logging.js';
import { getEmbeddingBatch, cosineSimilarity } from './embeddings.js';
import { invalidateUnifiedCache } from './unified-inject.js';
import { getCharacterContainer, getGroupContainer } from './scope.js';
import { MACRO_NAMES, setMacroContent, isMacroActive } from './macros.js';
import { reportTierTrimStats } from './trim-stats.js';

// ---- Deduplication ------------------------------------------------------

/**
 * Jaccard word-overlap similarity between two arc content strings.
 * Retained as the fallback when embeddings are unavailable.
 * @param {string} a
 * @param {string} b
 * @returns {number} Similarity in [0, 1].
 */
function arcJaccard(a, b) {
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const bWords = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let intersection = 0;
  for (const w of aWords) if (bWords.has(w)) intersection++;
  return intersection / (aWords.size + bWords.size - intersection);
}

/**
 * Returns the semantic similarity between two arc strings.
 * Uses cosine similarity on embeddings when available, falling back to Jaccard.
 * Arc descriptions are full sentences with rich narrative content, making
 * semantic similarity substantially more reliable than word overlap alone.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<{score: number, semantic: boolean}>}
 */
async function arcSimilarity(a, b) {
  const aKey = a.toLowerCase().trim();
  const bKey = b.toLowerCase().trim();
  const vectorMap = await getEmbeddingBatch([aKey, bKey]);
  const aVec = vectorMap.get(aKey);
  const bVec = vectorMap.get(bKey);
  if (aVec && bVec) {
    return { score: cosineSimilarity(aVec, bVec), semantic: true };
  }
  return { score: arcJaccard(a, b), semantic: false };
}

/**
 * Returns true when two arc strings are similar enough to be considered
 * duplicates. Cosine threshold 0.82 for semantic, 0.4 for Jaccard fallback.
 * Used for single one-off checks (e.g. promoteArc, reopenArc). Bulk operations
 * should use arcIsDuplicateSync with a precomputed vectorMap instead.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
async function arcIsDuplicate(a, b) {
  const { score, semantic } = await arcSimilarity(a, b);
  return score >= (semantic ? 0.82 : 0.4);
}

/**
 * Sync duplicate check using a precomputed embedding map.
 * Falls back to Jaccard when either text is missing from the map.
 * @param {string} a
 * @param {string} b
 * @param {Map<string, number[]>} vectorMap
 * @returns {boolean}
 */
function arcIsDuplicateSync(a, b, vectorMap) {
  const aVec = vectorMap?.get(a.toLowerCase().trim());
  const bVec = vectorMap?.get(b.toLowerCase().trim());
  if (aVec && bVec) return cosineSimilarity(aVec, bVec) >= 0.82;
  return arcJaccard(a, b) >= 0.4;
}

/**
 * Removes duplicate entries from an arc array, keeping the first occurrence
 * when two arcs are flagged as duplicates. Batch-fetches all embeddings in one
 * call so the O(n^2) comparison loop incurs only one round-trip to the embedding
 * backend regardless of array length.
 * Resolved arcs are excluded from deduplication and appended unchanged.
 * @param {Array<{content: string, resolved?: boolean}>} arcs
 * @returns {Promise<Array<{content: string}>>} Deduplicated arc array.
 */
async function deduplicateArcs(arcs) {
  const active = arcs.filter((a) => !a.resolved);
  const resolved = arcs.filter((a) => a.resolved);
  if (active.length <= 1) return arcs;

  const keys = active.map((a) => a.content.toLowerCase().trim());
  const vectorMap = await getEmbeddingBatch(keys);

  const result = [];
  for (const arc of active) {
    let isDup = false;
    for (const prev of result) {
      if (arcIsDuplicateSync(arc.content, prev.content, vectorMap)) {
        isDup = true;
        break;
      }
    }
    if (!isDup) result.push(arc);
  }
  return [...result, ...resolved];
}

// ---- Storage ------------------------------------------------------------

/**
 * Returns the story arc array for the current chat.
 * @returns {Array<{content: string, ts: number}>}
 */
export function loadArcs() {
  const context = getContext();
  return context.chatMetadata?.[META_KEY]?.storyArcs ?? [];
}

/**
 * Persists the story arc array to chatMetadata.
 * @param {Array<{content: string, ts: number}>} arcs
 */
export async function saveArcs(arcs) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].storyArcs = arcs;
  await context.saveMetadata();
}

/**
 * Removes a single arc by its index in the arc array.
 * If the arc is persistent and characterName is provided, also removes it
 * from character-level storage so it no longer appears in future chats.
 * @param {number} index
 * @param {string|null} [characterName]
 */
export async function deleteArc(index, characterName = null) {
  const arcs = loadArcs();
  const arc = arcs[index];
  if (!arc) return;

  if (arc.persistent && characterName) {
    const persistent = loadPersistentArcs(characterName);
    const filtered = [];
    for (const p of persistent) {
      if (!(await arcIsDuplicate(p.content, arc.content))) filtered.push(p);
    }
    if (filtered.length !== persistent.length) {
      savePersistentArcs(characterName, filtered);
    }
  }

  arcs.splice(index, 1);
  await saveArcs(arcs);
}

/**
 * Empties all story arcs for the current chat.
 */
export async function clearArcs() {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    context.chatMetadata[META_KEY].storyArcs = [];
    await context.saveMetadata();
  }
}

// ---- Arc summary storage ------------------------------------------------

/**
 * Returns the arc summaries array for the current chat.
 * Each entry covers one resolved arc with its source scene and memory ids.
 *
 * @returns {Array<{summary: string, arc: string, source_scene_ids: number[], source_memory_ids: string[], ts: number}>}
 */
export function loadArcSummaries() {
  const context = getContext();
  return context.chatMetadata?.[META_KEY]?.arcSummaries ?? [];
}

/**
 * Persists the arc summaries array to chatMetadata.
 * @param {Array} summaries
 */
export async function saveArcSummaries(summaries) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].arcSummaries = summaries;
  await context.saveMetadata();
}

/**
 * Empties all arc summaries for the current chat.
 */
export async function clearArcSummaries() {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    context.chatMetadata[META_KEY].arcSummaries = [];
    await context.saveMetadata();
  }
}

// ---- Persistent arcs (cross-chat) ----------------------------------------

/**
 * Returns the persistent arc array for the given character.
 * Persistent arcs are stored at the character level so they survive
 * across chats and are merged into new chats on load.
 * @param {string} characterName
 * @returns {Array<{content: string, ts: number, persistent: true}>}
 */
export function loadPersistentArcs(characterName) {
  if (!characterName) return [];
  return getCharacterContainer(characterName)?.persistent_arcs ?? [];
}

/**
 * Overwrites the persistent arc array for the given character and persists it.
 * @param {string} characterName
 * @param {Array<{content: string, ts: number, persistent: true}>} arcs
 */
export function savePersistentArcs(characterName, arcs) {
  if (!characterName) return;
  getCharacterContainer(characterName).persistent_arcs = arcs;
  saveSettingsDebounced();
}

/**
 * Returns the persistent arc array for the given group.
 * Group persistent arcs are stored at the group level so they survive
 * across chats and are merged into new group chats on load.
 * @param {string} groupId
 * @returns {Array<{content: string, ts: number, persistent: true}>}
 */
export function loadGroupPersistentArcs(groupId) {
  if (!groupId) return [];
  return getGroupContainer(groupId)?.persistent_arcs ?? [];
}

/**
 * Overwrites the persistent arc array for the given group and persists it.
 * @param {string} groupId
 * @param {Array<{content: string, ts: number, persistent: true}>} arcs
 */
export function saveGroupPersistentArcs(groupId, arcs) {
  if (!groupId) return;
  getGroupContainer(groupId).persistent_arcs = arcs;
  saveSettingsDebounced();
}

/**
 * Removes group arc stores for groups that no longer exist.
 * Called once on chat load. Prevents orphaned entries from accumulating
 * when users create and delete groups frequently.
 */
export function pruneOrphanedGroupArcs() {
  const groupArcs = extension_settings[MODULE_NAME]?.group_arcs;
  if (!groupArcs) return;
  const knownIds = new Set((getContext().groups ?? []).map((g) => String(g.id)));
  let changed = false;
  for (const id of Object.keys(groupArcs)) {
    if (!knownIds.has(id)) {
      delete groupArcs[id];
      changed = true;
    }
  }
  if (changed) saveSettingsDebounced();
}

/**
 * Merges group-level persistent arcs into the current chat's arc list.
 * Called once on chat load so that injection and extraction see persistent
 * arcs as part of the normal arc list without any special-casing elsewhere.
 * Arcs already present in the chat (persistent or otherwise) are skipped.
 * @param {string} groupId
 */
export async function mergeGroupPersistentArcs(groupId) {
  if (!groupId) return;
  const persistent = loadGroupPersistentArcs(groupId);
  if (persistent.length === 0) return;

  const existing = loadArcs();
  const toAdd = [];
  for (const p of persistent) {
    let found = false;
    // Check against all arcs including resolved - a resolved arc should not
    // resurface as active, and a duplicate of an active arc should not be added.
    for (const e of existing) {
      if (await arcIsDuplicate(p.content, e.content)) {
        found = true;
        break;
      }
    }
    if (!found) toAdd.push(p);
  }
  if (toAdd.length === 0) return;

  // Preserve the resolved flag from the persistent store so arcs that were
  // resolved in a previous chat arrive already marked as closed.
  const merged = [...existing, ...toAdd.map((a) => ({ ...a, persistent: true }))];
  await saveArcs(merged);
}

/**
 * Merges character-level persistent arcs into the current chat's arc list.
 * Called once on chat load so that injection and extraction see persistent
 * arcs as part of the normal arc list without any special-casing elsewhere.
 * Arcs already present in the chat (persistent or otherwise) are skipped.
 * @param {string} characterName
 */
export async function mergePersistentArcs(characterName) {
  if (!characterName) return;
  const persistent = loadPersistentArcs(characterName);
  if (persistent.length === 0) return;

  const existing = loadArcs();
  const toAdd = [];
  for (const p of persistent) {
    let found = false;
    // Check against all arcs including resolved - a resolved arc should not
    // resurface as active, and a duplicate of an active arc should not be added.
    for (const e of existing) {
      if (await arcIsDuplicate(p.content, e.content)) {
        found = true;
        break;
      }
    }
    if (!found) toAdd.push(p);
  }
  if (toAdd.length === 0) return;

  // Preserve the resolved flag from the persistent store so arcs that were
  // resolved in a previous chat arrive already marked as closed.
  const merged = [...existing, ...toAdd.map((a) => ({ ...a, persistent: true }))];
  await saveArcs(merged);
}

/**
 * Marks an arc as persistent: saves it to character-level or group-level
 * storage so it carries into future chats, and updates the persistent flag
 * in the current chat. Pass either characterName or groupId, not both.
 * @param {number} index - Index in the current chat arc array.
 * @param {string|null} characterName
 * @param {string|null} [groupId]
 */
export async function promoteArc(index, characterName, groupId = null) {
  if (!characterName && !groupId) return;
  const arcs = loadArcs();
  if (!arcs[index]) return;
  arcs[index].persistent = true;
  await saveArcs(arcs);

  const persistent = groupId ? loadGroupPersistentArcs(groupId) : loadPersistentArcs(characterName);
  let already = false;
  for (const p of persistent) {
    if (await arcIsDuplicate(p.content, arcs[index].content)) {
      already = true;
      break;
    }
  }
  if (!already) {
    persistent.push({
      content: arcs[index].content,
      ts: arcs[index].ts ?? Date.now(),
      persistent: true,
    });
    if (groupId) saveGroupPersistentArcs(groupId, persistent);
    else savePersistentArcs(characterName, persistent);
  }
}

/**
 * Removes the persistent flag from an arc and cleans it from character-level
 * or group-level storage. The arc stays in the current chat as a normal
 * non-persistent arc. Pass either characterName or groupId, not both.
 * @param {number} index - Index in the current chat arc array.
 * @param {string|null} characterName
 * @param {string|null} [groupId]
 */
export async function demoteArc(index, characterName, groupId = null) {
  if (!characterName && !groupId) return;
  const arcs = loadArcs();
  if (!arcs[index]) return;
  const content = arcs[index].content;
  delete arcs[index].persistent;
  await saveArcs(arcs);

  const persistent = groupId ? loadGroupPersistentArcs(groupId) : loadPersistentArcs(characterName);
  const filtered = [];
  for (const p of persistent) {
    if (!(await arcIsDuplicate(p.content, content))) filtered.push(p);
  }
  if (filtered.length !== persistent.length) {
    if (groupId) saveGroupPersistentArcs(groupId, filtered);
    else savePersistentArcs(characterName, filtered);
  }
}

/**
 * Manually marks an arc as resolved, mirroring what the model does during
 * extraction. The arc moves to the Resolved Threads panel in the current chat.
 * For persistent arcs the resolved state is also written to the persistent
 * store so it carries into future chats. Non-persistent arcs are resolved
 * only within the current chat's chatMetadata.
 * @param {number} index - Index in the current chat arc array.
 * @param {string|null} characterName
 * @param {string|null} [groupId]
 */
export async function resolveArc(index, characterName = null, groupId = null) {
  const arcs = loadArcs();
  const arc = arcs[index];
  if (!arc) return;

  arcs[index] = { ...arc, resolved: true };
  await saveArcs(arcs);

  if (!arc.persistent) return;

  if (groupId) {
    const gP = loadGroupPersistentArcs(groupId);
    const match = gP.find((p) => p.content === arc.content);
    if (match) match.resolved = true;
    saveGroupPersistentArcs(groupId, gP);
  } else if (characterName) {
    const cP = loadPersistentArcs(characterName);
    const match = cP.find((p) => p.content === arc.content);
    if (match) match.resolved = true;
    savePersistentArcs(characterName, cP);
  }
}

/**
 * Resolves an arc and generates an arc summary for it so it can contribute
 * to canon generation. Combines resolveArc with a generateArcSummary call.
 * Callers should trigger canon regeneration on Profile B after this returns.
 * Returns true if the summary was generated successfully, false otherwise.
 * @param {number} index - Index in the current chat arc array.
 * @param {string|null} characterName
 * @param {string|null} [groupId]
 * @returns {Promise<boolean>}
 */
export async function resolveArcWithSummary(index, characterName = null, groupId = null) {
  const arcs = loadArcs();
  const arc = arcs[index];
  if (!arc) return false;

  const content = arc.content;
  await resolveArc(index, characterName, groupId);

  try {
    const result = await generateArcSummary(content);
    if (!result) return false;
    const summaries = loadArcSummaries();
    summaries.push({
      summary: result.summary,
      arc: content,
      ts: Date.now(),
      source_scene_ids: result.sourceSceneTs,
      source_memory_ids: result.sourceMemoryIds,
    });
    await saveArcSummaries(summaries);
    return true;
  } catch (err) {
    console.error('[SmartMemory] Arc summary generation failed:', err);
    return false;
  }
}

/**
 * Re-opens a resolved pinned arc. If an equivalent active arc already exists,
 * the resolved copy is removed instead to avoid duplication. Otherwise the
 * resolved flag is stripped and the arc rejoins the active list. The persistent
 * store is updated to match in both cases.
 * @param {number} index - Index in the current chat arc array.
 * @param {string|null} characterName
 * @param {string|null} [groupId]
 */
export async function reopenArc(index, characterName, groupId = null) {
  const arcs = loadArcs();
  if (!arcs[index]) return;
  const arcContent = arcs[index].content;

  // Check for a duplicate among currently active arcs. If one exists, the
  // thread is already being tracked - just discard this resolved copy.
  const activeArcs = arcs.filter((a, i) => !a.resolved && i !== index);
  for (const active of activeArcs) {
    if (await arcIsDuplicate(arcContent, active.content)) {
      arcs.splice(index, 1);
      await saveArcs(arcs);
      if (groupId) {
        const gP = loadGroupPersistentArcs(groupId);
        saveGroupPersistentArcs(
          groupId,
          gP.filter((p) => p.content !== arcContent),
        );
      } else if (characterName) {
        const cP = loadPersistentArcs(characterName);
        savePersistentArcs(
          characterName,
          cP.filter((p) => p.content !== arcContent),
        );
      }
      return;
    }
  }

  // No duplicate active arc - strip the resolved flag and reactivate.
  delete arcs[index].resolved;
  await saveArcs(arcs);

  if (groupId) {
    const gP = loadGroupPersistentArcs(groupId);
    const match = gP.find((p) => p.content === arcContent);
    if (match) {
      delete match.resolved;
      saveGroupPersistentArcs(groupId, gP);
    }
  } else if (characterName) {
    const cP = loadPersistentArcs(characterName);
    const match = cP.find((p) => p.content === arcContent);
    if (match) {
      delete match.resolved;
      savePersistentArcs(characterName, cP);
    }
  }
}

// ---- Extraction ---------------------------------------------------------

/**
 * Generates a paragraph summary for a resolved arc. Collects scene summaries
 * and memory ids that were linked to scenes during the arc for context, and
 * returns them alongside the summary so the caller can store backlinks.
 *
 * Fires once per resolved arc when extraction flags arcs as closed.
 * On Profile A the call is bundled into the same extraction window to
 * avoid adding a standalone model call.
 *
 * @param {string} arcContent - The resolved arc's content string.
 * @returns {Promise<{summary: string, sourceSceneTs: number[], sourceMemoryIds: string[]}|null>}
 */
export async function generateArcSummary(arcContent) {
  const settings = extension_settings[MODULE_NAME];

  // Use only the most recent scenes as context. The arc being summarized was
  // active and resolved in the recent portion of the chat; attributing it to
  // scenes from much earlier in the chat inflates source provenance and adds
  // noise to canon generation.
  const sceneHistory = loadSceneHistory().slice(-5);
  const sceneSummaries = sceneHistory.map((s, i) => `Scene ${i + 1}: ${s.summary}`).join('\n');

  // Gather source_memory_ids from these scenes (deduplicated).
  const allMemoryIds = new Set(sceneHistory.flatMap((s) => s.source_memory_ids ?? []));
  const sessionMemories = loadSessionMemories();
  const linkedMemories = sessionMemories
    .filter((m) => m.id && allMemoryIds.has(m.id) && !m.superseded_by)
    .slice(0, 20); // cap to keep prompt cost manageable on local hardware
  const memoriesText = linkedMemories.map((m) => `[${m.type}] ${m.content}`).join('\n');

  const prompt = buildArcSummaryPrompt(arcContent, sceneSummaries, memoriesText);
  const response = await generateMemoryExtract(prompt, {
    responseLength: settings.arc_summary_response_length ?? 300,
  });

  if (!response?.trim()) return null;
  return {
    summary: response.trim(),
    sourceSceneTs: sceneHistory.map((s) => s.ts),
    sourceMemoryIds: [...allMemoryIds],
  };
}

// ---- Extraction ---------------------------------------------------------

/**
 * Extracts story arcs from the full conversation via the model, resolves any
 * arcs the model flags as closed, and persists the updated arc list.
 * Returns the count of new arcs added.
 * @param {Array} messages - Full context.chat array.
 * @param {string|null} [characterName] - Active character, used to clean persistent arcs when resolved.
 * @param {Function|null} [abortCheck] - Optional zero-arg function; if it returns true the function
 *   bails out before any chatMetadata write. Used by the automatic extraction path to abort when
 *   the user switches chats mid-extraction.
 * @returns {Promise<number>} Count of new arcs added (0 on failure or nothing found).
 */
export async function extractArcs(messages, characterName = null, abortCheck = null) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.arcs_enabled) return 0;

  try {
    const chatHistory = messages
      .filter((m) => m.mes && !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!chatHistory.trim()) return 0;

    const existing = loadArcs();
    // Only show active arcs to the model - resolved arcs are closed threads and
    // should be invisible to extraction to prevent duplicate resolutions.
    const activeExisting = existing.filter((a) => !a.resolved);
    const existingText = activeExisting.map((a) => `[arc] ${a.content}`).join('\n');

    const response = await generateMemoryExtract(
      buildArcExtractionPrompt(chatHistory, existingText),
      { responseLength: settings.arcs_response_length ?? 400 },
    );

    smLog('[SmartMemory] Arc extraction response:', response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    // Parse against activeExisting so resolve indices map correctly to active arcs.
    const { add: rawAdd, resolve } = parseArcOutput(response, activeExisting);

    // Filter new arc candidates against current session memories using semantic
    // similarity. Scene details and established facts that slipped past the
    // keyword filter in parseArcOutput tend to be high-similarity matches for
    // existing session entries - if a candidate scores >= 0.78 against any
    // session memory it is almost certainly a rephrased scene detail, not a
    // genuine open thread. Falls back to Jaccard when embeddings are unavailable
    // so the filter still catches the most obvious overlaps without embeddings.
    let add = rawAdd;
    if (rawAdd.length > 0) {
      const sessionMemories = loadSessionMemories();
      if (sessionMemories.length > 0) {
        const sessionTexts = sessionMemories.map((m) => m.content.toLowerCase().trim());
        const arcTexts = rawAdd.map((a) => a.content.toLowerCase().trim());
        const vectorMap = await getEmbeddingBatch([...sessionTexts, ...arcTexts]);
        const useEmbeddings = vectorMap.size > 0;

        add = rawAdd.filter((arc) => {
          const arcKey = arc.content.toLowerCase().trim();
          const arcVec = vectorMap.get(arcKey);
          for (const mem of sessionMemories) {
            const memKey = mem.content.toLowerCase().trim();
            let score;
            if (useEmbeddings && arcVec) {
              const memVec = vectorMap.get(memKey);
              if (memVec) score = cosineSimilarity(arcVec, memVec);
            }
            // Fall back to Jaccard when vectors are unavailable for this pair.
            if (score === undefined) score = arcJaccard(arc.content, mem.content);
            // 0.78 cosine / 0.45 Jaccard - lower than arc dedup thresholds
            // because arc descriptions and session details are phrased differently
            // even when they describe the same thing.
            if (score >= (useEmbeddings && arcVec ? 0.78 : 0.45)) return false;
          }
          return true;
        });

        smLog(
          `[SmartMemory] Arc session-filter: ${rawAdd.length} candidates -> ${add.length} kept`,
        );
      }
    }

    // Convert resolve indices to arc objects immediately, before any async work.
    // Storing content rather than indices means subsequent loadArcs() re-fetches
    // after async summarization can match by content instead of stale positions -
    // safe against concurrent UI edits (delete, add) during the model call window.
    const resolvedArcObjects = resolve.map((i) => activeExisting[i]).filter(Boolean);

    // Generate arc summaries for each resolved arc before removing them.
    // Sequential calls - Ollama serializes anyway and parallel calls risk OOM.
    if (resolvedArcObjects.length > 0) {
      const arcSummaries = loadArcSummaries();
      for (const resolved of resolvedArcObjects) {
        try {
          const result = await generateArcSummary(resolved.content);
          if (result) {
            arcSummaries.push({
              summary: result.summary,
              arc: resolved.content,
              source_scene_ids: result.sourceSceneTs,
              source_memory_ids: result.sourceMemoryIds,
              ts: Date.now(),
            });
            smLog(`[SmartMemory] Arc summary generated for: "${resolved.content.slice(0, 60)}"`);
          }
        } catch (err) {
          console.error('[SmartMemory] Arc summary generation failed:', err);
          // Non-fatal - arc is still resolved even if summarization fails.
        }
      }
      if (abortCheck?.()) return 0;
      await saveArcSummaries(arcSummaries);
    }

    // For persistent arcs that were resolved, mark them as resolved in
    // character-level storage so the state carries into future chats.
    // They are kept in the store so the user can still see and re-open them.
    if (characterName && resolvedArcObjects.length > 0) {
      const persistentToResolve = resolvedArcObjects.filter((a) => a?.persistent);
      if (persistentToResolve.length > 0) {
        const charPersistent = loadPersistentArcs(characterName);
        for (const resolved of persistentToResolve) {
          const match = charPersistent.find((p) => p.content === resolved.content);
          if (match) match.resolved = true;
        }
        if (abortCheck?.()) return 0;
        savePersistentArcs(characterName, charPersistent);
      }
    }

    // Re-load the current arc list after all async summarization work. Matching
    // by content (not stale indices) means any UI edits during the async window
    // are reflected in what we keep.
    const currentArcs = loadArcs();
    const resolvedContentSet = new Set(resolvedArcObjects.map((a) => a.content));
    // Persistent arcs get a resolved flag rather than being removed; non-persistent
    // arcs are deleted as before.
    let afterResolve = currentArcs
      .map((a) => {
        if (!resolvedContentSet.has(a.content)) return a;
        return a.persistent ? { ...a, resolved: true } : null;
      })
      .filter(Boolean);

    // Clean up any duplicates that accumulated in storage from previous passes.
    // deduplicateArcs skips resolved arcs automatically.
    afterResolve = await deduplicateArcs(afterResolve);

    // Drop new arcs that are semantically redundant with active arcs.
    // Resolved arcs are excluded - a resolved thread does not block a genuinely
    // new instance of the same arc from being added as active.
    const activeAfterResolve = afterResolve.filter((a) => !a.resolved);

    // Batch-fetch embeddings for all texts we'll compare in the dedup loops below.
    // Avoids one getEmbeddingBatch call per pair (O(n*m) calls reduced to one).
    const addKeys = add.map((a) => a.content.toLowerCase().trim());
    const activeKeys = activeAfterResolve.map((a) => a.content.toLowerCase().trim());
    const addVectorMap = await getEmbeddingBatch([...addKeys, ...activeKeys]);

    const dedupedAdd = [];
    for (const newArc of add) {
      let isDup = false;
      for (const ex of activeAfterResolve) {
        if (arcIsDuplicateSync(newArc.content, ex.content, addVectorMap)) {
          isDup = true;
          break;
        }
      }
      if (!isDup) {
        for (const prev of dedupedAdd) {
          if (arcIsDuplicateSync(newArc.content, prev.content, addVectorMap)) {
            isDup = true;
            break;
          }
        }
      }
      if (!isDup) dedupedAdd.push(newArc);
    }

    const max = settings.arcs_max ?? 10;

    // Re-load one final time just before saving. The async dedup phase above
    // may have yielded long enough for a UI edit (delete, inline save) to write
    // chatMetadata. Re-fetching here ensures those edits are not overwritten.
    // Apply resolved state and new arcs on top of whatever is current.
    // Resolved arcs are kept but sit outside the max cap - they are not injected
    // and should not push active threads out of the budget.
    const finalBase = loadArcs()
      .map((a) => {
        if (!resolvedContentSet.has(a.content)) return a;
        return a.persistent ? { ...a, resolved: true } : null;
      })
      .filter(Boolean);
    const finalActive = finalBase.filter((a) => !a.resolved);
    const finalResolved = finalBase.filter((a) => a.resolved);
    const finalNew = dedupedAdd.filter((n) => !finalActive.some((a) => a.content === n.content));
    const merged = [...finalActive, ...finalNew].slice(-max);

    if (abortCheck?.()) return 0;
    await saveArcs([...merged, ...finalResolved]);
    return dedupedAdd.length;
  } catch (err) {
    console.error('[SmartMemory] Arc extraction failed:', err);
    throw err;
  }
}

// ---- Injection ----------------------------------------------------------

/**
 * Injects active story arcs into the prompt via setExtensionPrompt.
 * Clears the slot if arc tracking is disabled or no arcs exist.
 */
export function injectArcs() {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.arcs_enabled) {
    setMacroContent(MACRO_NAMES.arcs, '');
    setExtensionPrompt(PROMPT_KEY_ARCS, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_ARCS);
    return;
  }

  const arcs = loadArcs().filter((a) => !a.resolved);
  if (arcs.length === 0) {
    setMacroContent(MACRO_NAMES.arcs, '');
    setExtensionPrompt(PROMPT_KEY_ARCS, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_ARCS);
    return;
  }

  // Trim to token budget: drop oldest arcs (from the front) until we fit.
  // If a single arc still exceeds the budget, hard-truncate its content so the
  // injection is always within the cap regardless of individual entry length.
  const budget = settings.arcs_inject_budget ?? 400;
  const fullTokens = estimateTokens(
    `Active story threads:\n${arcs.map((a) => `- ${a.content}`).join('\n')}`,
  );
  const trimmed = [...arcs];
  while (trimmed.length > 1) {
    const text = trimmed.map((a) => `- ${a.content}`).join('\n');
    if (estimateTokens(text) <= budget) break;
    trimmed.shift();
  }

  let text = trimmed.map((a) => `- ${a.content}`).join('\n');
  if (estimateTokens(text) > budget) {
    const ratio = budget / estimateTokens(text);
    text = text.slice(0, Math.floor(text.length * ratio)).trim();
  }
  const content = `Active story threads:\n${text}`;
  reportTierTrimStats(PROMPT_KEY_ARCS, estimateTokens(content), fullTokens);

  setMacroContent(MACRO_NAMES.arcs, content);
  if (isMacroActive(MACRO_NAMES.arcs)) {
    setExtensionPrompt(PROMPT_KEY_ARCS, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_ARCS);
    return;
  }

  setExtensionPrompt(
    PROMPT_KEY_ARCS,
    content,
    settings.arcs_position ?? extension_prompt_types.IN_PROMPT,
    settings.arcs_depth ?? 2,
    false,
    settings.arcs_role ?? extension_prompt_roles.SYSTEM,
  );
}
