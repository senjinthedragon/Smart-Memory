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
 * loadArcs          - returns the stored arc array for the current chat
 * saveArcs          - persists the arc array to chatMetadata
 * deleteArc         - removes a single arc by index
 * clearArcs         - empties all arcs for the current chat
 * extractArcs       - runs extraction against the conversation, deduplicates, and updates the arc list
 * injectArcs        - pushes active arcs into the prompt via setExtensionPrompt
 * loadArcSummaries  - returns the stored arc summary array for the current chat
 * saveArcSummaries  - persists the arc summary array to chatMetadata
 * clearArcSummaries - empties all arc summaries for the current chat
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
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
 * Called when the user manually resolves an arc via the UI.
 * @param {number} index
 */
export async function deleteArc(index) {
  const arcs = loadArcs();
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

/**
 * Generates a paragraph summary for a resolved arc and stores it in the
 * arc summaries list. Collects scene summaries and memory ids that were
 * linked to scenes during the arc for context.
 *
 * Fires once per resolved arc when extraction flags arcs as closed.
 * On Profile A the call is bundled into the same extraction window to
 * avoid adding a standalone model call.
 *
 * @param {string} arcContent - The resolved arc's content string.
 * @returns {Promise<string|null>} The generated summary, or null on failure.
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

  return response?.trim() || null;
}

// ---- Extraction ---------------------------------------------------------

/**
 * Extracts story arcs from the full conversation via the model, resolves any
 * arcs the model flags as closed, and persists the updated arc list.
 * Returns the count of new arcs added.
 * @param {Array} messages - Full context.chat array.
 * @returns {Promise<number>} Count of new arcs added (0 on failure or nothing found).
 */
export async function extractArcs(messages) {
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
      const arcSummaries = loadArcSummaries();
      for (const idx of resolve) {
        const resolved = existing[idx];
        if (!resolved) continue;
        try {
          const summary = await generateArcSummary(resolved.content);
          if (summary) {
            arcSummaries.push({
              summary,
              arc: resolved.content,
              source_scene_ids: [],
              source_memory_ids: [],
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

    // Filter out resolved arcs.
    let afterResolve = existing.filter((_, i) => !resolve.includes(i));

    // Clean up any duplicates that accumulated in storage from previous passes.
    afterResolve = deduplicateArcs(afterResolve);

    // Drop new arcs that are semantically redundant with what remains.
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
