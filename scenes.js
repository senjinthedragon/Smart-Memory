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
 * Scene break detection and scene history management.
 *
 * Detects when a scene ends - via regex heuristics (default) or an AI yes/no
 * call (optional, off by default) - then generates a mini-summary of the
 * completed scene and appends it to the per-chat scene history in chatMetadata.
 *
 * detectSceneBreakHeuristic  - pattern-based scene break check (cheap, no model call); includes dawn/sleep/wake patterns
 * loadSceneHistory           - returns the stored scene history array
 * saveSceneHistory           - persists the scene history array to chatMetadata
 * clearSceneHistory          - empties scene history for the current chat
 * summarizeScene             - generates a 2-3 sentence mini-summary of a scene
 * sceneSimilarity            - returns {score, semantic} between two scene summary strings
 * processSceneBreak          - orchestrates detection + summarization + dedup + storage
 * linkMemoriesToLastScene    - attaches memory ids to the most recent scene entry
 * injectSceneHistory         - pushes scene history into the prompt via setExtensionPrompt
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { generateMemoryExtract } from './generate.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { estimateTokens, MODULE_NAME, META_KEY, PROMPT_KEY_SCENES } from './constants.js';
import { buildSceneDetectPrompt, SCENE_SUMMARY_PROMPT } from './prompts.js';
import { detectSceneBreakHeuristic } from './parsers.js';
import { smLog } from './logging.js';
import { getEmbeddingBatch, cosineSimilarity } from './embeddings.js';
import { invalidateUnifiedCache } from './unified-inject.js';

// Re-export so index.js can import directly from scenes.js as before.
export { detectSceneBreakHeuristic };

// ---- Deduplication ------------------------------------------------------

/**
 * Jaccard word-overlap similarity between two scene summary strings.
 * Used as a fallback when embeddings are unavailable.
 * @param {string} a
 * @param {string} b
 * @returns {number} Similarity in [0, 1].
 */
function sceneJaccard(a, b) {
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const bWords = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let intersection = 0;
  for (const w of aWords) if (bWords.has(w)) intersection++;
  return intersection / (aWords.size + bWords.size - intersection);
}

/**
 * Semantic similarity between two scene summary strings.
 * Uses embeddings when available and falls back to Jaccard.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<{score: number, semantic: boolean}>}
 */
export async function sceneSimilarity(a, b) {
  const aKey = a.toLowerCase().trim();
  const bKey = b.toLowerCase().trim();
  const vectorMap = await getEmbeddingBatch([aKey, bKey]);
  const aVec = vectorMap.get(aKey);
  const bVec = vectorMap.get(bKey);
  if (aVec && bVec) {
    return { score: cosineSimilarity(aVec, bVec), semantic: true };
  }
  return { score: sceneJaccard(a, b), semantic: false };
}

// ---- Heuristics ---------------------------------------------------------

/**
 * Asks the model whether the message contains a scene break.
 * More accurate than the heuristic but costs one model call per message.
 * Only used when scene_ai_detect is enabled in settings.
 * @param {string} messageText - The last AI message to inspect.
 * @param {string} [previousMessageText] - The preceding AI message for context.
 * @returns {Promise<boolean>}
 */
async function detectSceneBreakAI(messageText, previousMessageText) {
  try {
    const prompt = buildSceneDetectPrompt(messageText, previousMessageText);
    const response = await generateMemoryExtract(prompt, { responseLength: 5 });
    return response?.trim().toUpperCase().startsWith('YES') ?? false;
  } catch (err) {
    console.error('[SmartMemory] AI scene break detection failed:', err);
    return false;
  }
}

// ---- Storage ------------------------------------------------------------

/**
 * Returns the scene history array for the current chat.
 * @returns {Array<{summary: string, ts: number}>}
 */
export function loadSceneHistory() {
  const context = getContext();
  return context.chatMetadata?.[META_KEY]?.sceneHistory ?? [];
}

/**
 * Persists the scene history array to chatMetadata.
 * @param {Array<{summary: string, ts: number}>} scenes
 */
export async function saveSceneHistory(scenes) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].sceneHistory = scenes;
  await context.saveMetadata();
}

/**
 * Empties scene history for the current chat.
 */
export async function clearSceneHistory() {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    context.chatMetadata[META_KEY].sceneHistory = [];
    await context.saveMetadata();
  }
}

// ---- Scene summary ------------------------------------------------------

/**
 * Generates a 2-3 sentence narrative mini-summary of the messages in a completed scene.
 * The summary is stored in scene history and later injected as past-scene context.
 * @param {Array} sceneMessages - Message objects from the completed scene.
 * @returns {Promise<string|null>} The summary text, or null if generation failed.
 */
export async function summarizeScene(sceneMessages) {
  const settings = extension_settings[MODULE_NAME];
  try {
    const sceneText = sceneMessages
      .filter((m) => m.mes && !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!sceneText.trim()) return null;

    // Truncate to 2000 chars to keep the prompt cost reasonable on local hardware.
    const prompt = SCENE_SUMMARY_PROMPT.replace('{{scene_text}}', sceneText.slice(0, 2000));

    const response = await generateMemoryExtract(prompt, {
      responseLength: settings.scene_summary_length ?? 200,
    });

    return response?.trim() || null;
  } catch (err) {
    console.error('[SmartMemory] Scene summary failed:', err);
    throw err;
  }
}

// ---- Orchestration ------------------------------------------------------

/**
 * Checks the latest message for a scene break and, if found, summarizes
 * the completed scene and appends it to scene history.
 *
 * Uses AI detection if scene_ai_detect is enabled, otherwise heuristics.
 * Respects scene_max_history - oldest scenes are dropped when the limit is exceeded.
 *
 * @param {string} lastMessageText - Text of the last AI message.
 * @param {Array} recentMessages - Messages accumulated since the last scene break.
 * @param {string} [previousAiMessage] - The preceding AI message for context (AI detection only).
 * @returns {Promise<boolean>} True if a scene break was detected and processed.
 */
export async function processSceneBreak(lastMessageText, recentMessages, previousAiMessage) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.scene_enabled) return false;

  // Require a minimum number of messages in the buffer before accepting a
  // scene break. Without this, the heuristic can fire multiple times in quick
  // succession at the start of a new scene (e.g. several messages all
  // describing a morning wake-up), producing duplicate summaries of the same
  // opening beats before the scene has had a chance to develop.
  const minMessages = settings.scene_min_messages ?? 5;
  const nonSystemMessages = recentMessages.filter((m) => !m.is_system);
  if (nonSystemMessages.length < minMessages) {
    smLog(
      `[SmartMemory] Scene break suppressed - only ${nonSystemMessages.length}/${minMessages} messages in buffer.`,
    );
    return false;
  }

  const isBreak = settings.scene_ai_detect
    ? await detectSceneBreakAI(lastMessageText, previousAiMessage)
    : detectSceneBreakHeuristic(lastMessageText);

  if (!isBreak) return false;

  smLog('[SmartMemory] Scene break detected.');

  const summary = await summarizeScene(recentMessages);
  if (!summary) return false;

  const history = loadSceneHistory();

  // Skip if the new summary is too similar to any of the last three stored scenes.
  // Checking a small window guards against scene descriptions that repeat after
  // a few exchanges without triggering a break (e.g. slow-paced ERP scenes).
  // Uses semantic embeddings when available, falling back to Jaccard.
  // Cosine threshold 0.82 catches rephrased versions of the same scene that
  // Jaccard misses due to varied wording.
  const recentScenes = history.slice(-3);
  for (const candidate of recentScenes) {
    const { score, semantic } = await sceneSimilarity(summary, candidate.summary);
    const threshold = semantic ? 0.82 : 0.55;
    if (score >= threshold) {
      smLog(
        `[SmartMemory] Scene summary too similar to a recent scene (${semantic ? 'semantic' : 'jaccard'} ${score.toFixed(3)}) - skipping duplicate.`,
      );
      return false;
    }
  }

  const max = settings.scene_max_history ?? 5;

  // source_memory_ids is populated after extraction via linkMemoriesToLastScene.
  history.push({ summary, ts: Date.now(), source_memory_ids: [] });
  if (history.length > max) history.splice(0, history.length - max);

  await saveSceneHistory(history);
  return true;
}

// ---- Source memory linking ----------------------------------------------

/**
 * Attaches memory ids to the most recent scene entry in history.
 * Called after extraction so each scene knows which memories it produced.
 *
 * Only adds ids that are not already present to avoid duplicates when
 * multiple extraction passes run against the same scene.
 *
 * @param {string[]} memoryIds - Ids of memories extracted during this scene.
 * @returns {Promise<void>}
 */
export async function linkMemoriesToLastScene(memoryIds) {
  if (!memoryIds || memoryIds.length === 0) return;
  const history = loadSceneHistory();
  if (history.length === 0) return;

  const last = history[history.length - 1];
  if (!Array.isArray(last.source_memory_ids)) last.source_memory_ids = [];

  const existing = new Set(last.source_memory_ids);
  for (const id of memoryIds) {
    if (id && !existing.has(id)) {
      last.source_memory_ids.push(id);
      existing.add(id);
    }
  }

  await saveSceneHistory(history);
}

// ---- Injection ----------------------------------------------------------

/**
 * Injects the scene history into the prompt via setExtensionPrompt.
 * Clears the slot if scene detection is disabled or no history exists.
 */
export function injectSceneHistory() {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.scene_enabled) {
    setExtensionPrompt(PROMPT_KEY_SCENES, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SCENES);
    return;
  }

  const history = loadSceneHistory();
  if (history.length === 0) {
    setExtensionPrompt(PROMPT_KEY_SCENES, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SCENES);
    return;
  }

  // Trim to token budget: drop oldest scenes (from the front) until we fit.
  const budget = settings.scene_inject_budget ?? 300;
  const trimmed = [...history];
  while (trimmed.length > 1) {
    const text = trimmed.map((sc, i) => `Scene ${i + 1}: ${sc.summary}`).join('\n');
    if (estimateTokens(text) <= budget) break;
    trimmed.shift();
  }

  const text = trimmed.map((sc, i) => `Scene ${i + 1}: ${sc.summary}`).join('\n');
  const content = `Previous scenes:\n${text}`;

  setExtensionPrompt(
    PROMPT_KEY_SCENES,
    content,
    settings.scene_position ?? extension_prompt_types.IN_PROMPT,
    settings.scene_depth ?? 6,
    false,
    settings.scene_role ?? extension_prompt_roles.SYSTEM,
  );
}
