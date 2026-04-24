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
 * extractArcs            - runs extraction against the conversation, deduplicates, and updates the arc list
 * injectArcs             - pushes active arcs into the prompt via setExtensionPrompt
 * loadArcSummaries       - returns the stored arc summary array for the current chat
 * clearArcSummaries      - empties all arc summaries for the current chat
 * loadPersistentArcs     - returns the character-level persistent arc array
 * mergePersistentArcs    - merges character-level persistent arcs into chatMetadata on chat open
 * promoteArc             - marks a chat arc as persistent and saves it to character level
 * demoteArc              - removes the persistent flag from an arc and cleans character level
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

// ---- Deduplication ------------------------------------------------------

/**
 * Jaccard word-overlap similarity between two arc content strings.
 * Used to detect near-duplicate arcs with different phrasing.
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
 * Removes duplicate entries from an arc array, keeping the first occurrence
 * when two arcs exceed the similarity threshold.
 * @param {Array<{content: string}>} arcs
 * @param {number} threshold - Jaccard threshold above which arcs are considered duplicates.
 * @returns {Array<{content: string}>} Deduplicated arc array.
 */
function deduplicateArcs(arcs, threshold = 0.4) {
  return arcs.filter(
    (arc, idx) =>
      !arcs.slice(0, idx).some((prev) => arcJaccard(arc.content, prev.content) >= threshold),
  );
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
    const filtered = persistent.filter((p) => arcJaccard(p.content, arc.content) < 0.4);
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
async function saveArcSummaries(summaries) {
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
  return extension_settings[MODULE_NAME]?.characters?.[characterName]?.persistent_arcs ?? [];
}

/**
 * Overwrites the persistent arc array for the given character and persists it.
 * @param {string} characterName
 * @param {Array<{content: string, ts: number, persistent: true}>} arcs
 */
function savePersistentArcs(characterName, arcs) {
  if (!characterName) return;
  if (!extension_settings[MODULE_NAME].characters) extension_settings[MODULE_NAME].characters = {};
  if (!extension_settings[MODULE_NAME].characters[characterName])
    extension_settings[MODULE_NAME].characters[characterName] = {};
  extension_settings[MODULE_NAME].characters[characterName].persistent_arcs = arcs;
  saveSettingsDebounced();
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
  const toAdd = persistent.filter(
    (p) => !existing.some((e) => arcJaccard(p.content, e.content) >= 0.4),
  );
  if (toAdd.length === 0) return;

  const merged = [...existing, ...toAdd.map((a) => ({ ...a, persistent: true }))];
  await saveArcs(merged);
}

/**
 * Marks an arc as persistent: saves it to the character level so it carries
 * into future chats, and updates the persistent flag in the current chat.
 * @param {number} index - Index in the current chat arc array.
 * @param {string} characterName
 */
export async function promoteArc(index, characterName) {
  if (!characterName) return;
  const arcs = loadArcs();
  if (!arcs[index]) return;
  arcs[index].persistent = true;
  await saveArcs(arcs);

  const persistent = loadPersistentArcs(characterName);
  const already = persistent.some((p) => arcJaccard(p.content, arcs[index].content) >= 0.4);
  if (!already) {
    persistent.push({
      content: arcs[index].content,
      ts: arcs[index].ts ?? Date.now(),
      persistent: true,
    });
    savePersistentArcs(characterName, persistent);
  }
}

/**
 * Removes the persistent flag from an arc and cleans it from character-level
 * storage. The arc stays in the current chat as a normal non-persistent arc.
 * @param {number} index - Index in the current chat arc array.
 * @param {string} characterName
 */
export async function demoteArc(index, characterName) {
  if (!characterName) return;
  const arcs = loadArcs();
  if (!arcs[index]) return;
  const content = arcs[index].content;
  delete arcs[index].persistent;
  await saveArcs(arcs);

  const persistent = loadPersistentArcs(characterName);
  const filtered = persistent.filter((p) => arcJaccard(p.content, content) < 0.4);
  if (filtered.length !== persistent.length) {
    savePersistentArcs(characterName, filtered);
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
async function generateArcSummary(arcContent) {
  const settings = extension_settings[MODULE_NAME];

  // Collect the last N scene summaries as context for the arc.
  // Using all available scenes keeps the summary grounded without extra calls.
  const sceneHistory = loadSceneHistory();
  const sceneSummaries = sceneHistory.map((s, i) => `Scene ${i + 1}: ${s.summary}`).join('\n');

  // Gather source_memory_ids from all scenes (deduplicated) and fetch their content.
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
 * @returns {Promise<number>} Count of new arcs added (0 on failure or nothing found).
 */
export async function extractArcs(messages, characterName = null) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.arcs_enabled) return 0;

  try {
    const chatHistory = messages
      .filter((m) => m.mes && !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!chatHistory.trim()) return 0;

    const existing = loadArcs();
    const existingText = existing.map((a) => `[arc] ${a.content}`).join('\n');

    const response = await generateMemoryExtract(
      buildArcExtractionPrompt(chatHistory, existingText),
      { responseLength: settings.arcs_response_length ?? 400 },
    );

    smLog('[SmartMemory] Arc extraction response:', response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    const { add, resolve } = parseArcOutput(response, existing);

    // Generate arc summaries for each resolved arc before removing them.
    // Sequential calls - Ollama serializes anyway and parallel calls risk OOM.
    if (resolve.length > 0) {
      // `existing` is captured before this loop. A concurrent arc-delete via the
      // UI during the model call could make existing[idx] stale, but the window
      // is narrow enough in practice that we accept it here rather than re-fetching.
      const arcSummaries = loadArcSummaries();
      for (const idx of resolve) {
        const resolved = existing[idx];
        if (!resolved) continue;
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
      await saveArcSummaries(arcSummaries);
    }

    // For persistent arcs that were resolved, also clean them from character-level
    // storage so they don't resurface in the next chat.
    if (characterName && resolve.length > 0) {
      const persistentToRemove = resolve.map((i) => existing[i]).filter((a) => a?.persistent);
      if (persistentToRemove.length > 0) {
        let charPersistent = loadPersistentArcs(characterName);
        for (const resolved of persistentToRemove) {
          charPersistent = charPersistent.filter(
            (p) => arcJaccard(p.content, resolved.content) < 0.4,
          );
        }
        savePersistentArcs(characterName, charPersistent);
      }
    }

    // Filter out resolved arcs.
    let afterResolve = existing.filter((_, i) => !resolve.includes(i));

    // Clean up any duplicates that accumulated in storage from previous passes.
    afterResolve = deduplicateArcs(afterResolve);

    // Drop new arcs that are semantically redundant with what remains.
    // 0.4 is intentionally lower than the scene dedup threshold (0.5) - arc
    // content is longer narrative text where Jaccard overlap is naturally
    // sparser, so a lower bar is needed to catch genuine paraphrases.
    const ARC_DEDUP_THRESHOLD = 0.4;
    const dedupedAdd = add.filter(
      (newArc, idx) =>
        !afterResolve.some((ex) => arcJaccard(newArc.content, ex.content) >= ARC_DEDUP_THRESHOLD) &&
        !add
          .slice(0, idx)
          .some((prev) => arcJaccard(newArc.content, prev.content) >= ARC_DEDUP_THRESHOLD),
    );

    const max = settings.arcs_max ?? 10;
    // slice(-max) keeps the most recent arcs when over the limit.
    const merged = [...afterResolve, ...dedupedAdd].slice(-max);

    await saveArcs(merged);
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
    setExtensionPrompt(PROMPT_KEY_ARCS, '', extension_prompt_types.NONE, 0);
    return;
  }

  const arcs = loadArcs();
  if (arcs.length === 0) {
    setExtensionPrompt(PROMPT_KEY_ARCS, '', extension_prompt_types.NONE, 0);
    return;
  }

  // Trim to token budget: drop oldest arcs (from the front) until we fit.
  const budget = settings.arcs_inject_budget ?? 400;
  const trimmed = [...arcs];
  while (trimmed.length > 1) {
    const text = trimmed.map((a) => `- ${a.content}`).join('\n');
    if (estimateTokens(text) <= budget) break;
    trimmed.shift();
  }

  const text = trimmed.map((a) => `- ${a.content}`).join('\n');
  const content = `Active story threads:\n${text}`;

  setExtensionPrompt(
    PROMPT_KEY_ARCS,
    content,
    settings.arcs_position ?? extension_prompt_types.IN_PROMPT,
    settings.arcs_depth ?? 2,
    false,
    settings.arcs_role ?? extension_prompt_roles.SYSTEM,
  );
}
