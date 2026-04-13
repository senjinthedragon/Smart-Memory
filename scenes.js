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
 * detectSceneBreakHeuristic  - pattern-based scene break check (cheap, no model call)
 * detectSceneBreakAI         - model-based scene break check (accurate, costs a call)
 * loadSceneHistory           - returns the stored scene history array
 * saveSceneHistory           - persists the scene history array to chatMetadata
 * clearSceneHistory          - empties scene history for the current chat
 * summarizeScene             - generates a 2-3 sentence mini-summary of a scene
 * processSceneBreak          - orchestrates detection + summarization + storage
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
import { SCENE_DETECT_PROMPT, SCENE_SUMMARY_PROMPT } from './prompts.js';
import { detectSceneBreakHeuristic } from './parsers.js';

// Re-export so index.js can import directly from scenes.js as before.
export { detectSceneBreakHeuristic };

// ---- Heuristics ---------------------------------------------------------

/**
 * Asks the model whether the message contains a scene break.
 * More accurate than the heuristic but costs one model call per message.
 * Only used when scene_ai_detect is enabled in settings.
 * @param {string} messageText - The last AI message to inspect.
 * @returns {Promise<boolean>}
 */
export async function detectSceneBreakAI(messageText) {
  try {
    const prompt = SCENE_DETECT_PROMPT.replace('{{text}}', messageText.slice(0, 800));
    const response = await generateMemoryExtract(prompt, { responseLength: 5 });
    return response?.trim().toUpperCase().startsWith('YES') ?? false;
  } catch {
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
 * @returns {Promise<boolean>} True if a scene break was detected and processed.
 */
export async function processSceneBreak(lastMessageText, recentMessages) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.scene_enabled) return false;

  const isBreak = settings.scene_ai_detect
    ? await detectSceneBreakAI(lastMessageText)
    : detectSceneBreakHeuristic(lastMessageText);

  if (!isBreak) return false;

  console.log('[SmartMemory] Scene break detected.');

  const summary = await summarizeScene(recentMessages);
  if (!summary) return false;

  const history = loadSceneHistory();
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
    return;
  }

  const history = loadSceneHistory();
  if (history.length === 0) {
    setExtensionPrompt(PROMPT_KEY_SCENES, '', extension_prompt_types.NONE, 0);
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
