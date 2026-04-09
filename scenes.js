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
 * detectSceneBreakHeuristic - pattern-based scene break check (cheap, no model call)
 * detectSceneBreakAI        - model-based scene break check (accurate, costs a call)
 * loadSceneHistory          - returns the stored scene history array
 * saveSceneHistory          - persists the scene history array to chatMetadata
 * clearSceneHistory         - empties scene history for the current chat
 * summarizeScene            - generates a 2-3 sentence mini-summary of a scene
 * processSceneBreak         - orchestrates detection + summarization + storage
 * injectSceneHistory        - pushes scene history into the prompt via setExtensionPrompt
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

// ---- Heuristics ---------------------------------------------------------

// Patterns that reliably signal a scene transition in roleplay prose.
// Grouped by category for easier tuning: time skips, location transitions,
// and explicit separator markers authors use between scenes.
const SCENE_BREAK_PATTERNS = [
  // Time skips - relative (hours/days/weeks/months/years later)
  /\b(later that (day|night|evening|morning)|the next (day|morning|evening|night)|hours later|days later|weeks later|months later|years? later|a (few )?(hours?|days?|weeks?|months?|years?) (later|passed|had passed)|the following (day|morning|week|month|year)|some time later|meanwhile|after (a while|some time)|that (evening|night|afternoon|morning))\b/i,
  // Time skips - absolute jumps ("a year passed", "three months went by")
  /\b(a (year|month|week|decade)|several (years?|months?|weeks?|days?)|[a-z]+ (years?|months?|weeks?|days?) (passed|went by|had passed|had gone by))\b/i,
  // Location transitions - arriving at a named or distinct new place.
  // Deliberately narrow: "entered the room" is not a scene break, but
  // "arrived at the castle" or "found himself in a foreign city" is.
  /\b(arrived at (the|a|an)\s+\w+|found (himself|herself|themselves|myself|yourself) (in|at) (a|an|the)\s+\w+|made (his|her|their|my|your) way (to|into) (the|a|an)\s+\w+|fled (to|into) (the|a|an)\s+\w+|escaped (to|into) (the|a|an)\s+\w+)\b/i,
  // Location transitions - establishing a new base or camp.
  /\b(settled (in|into|down in)|made (a|his|her|their|my) (home|camp|base) (in|at)|took (shelter|refuge) (in|at|among))\b/i,
  // Explicit separator markers (---, ***, * * *)
  /^[-*~]{3,}$/m,
  /\*\s*\*\s*\*/,
];

/**
 * Checks the message text against known scene-break patterns.
 * Fast and free - no model call required.
 * @param {string} messageText - The last AI message to inspect.
 * @returns {boolean} True if a scene break pattern is detected.
 */
export function detectSceneBreakHeuristic(messageText) {
  return SCENE_BREAK_PATTERNS.some((pattern) => pattern.test(messageText));
}

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

  history.push({ summary, ts: Date.now() });
  if (history.length > max) history.splice(0, history.length - max);

  await saveSceneHistory(history);
  return true;
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
    settings.scene_depth ?? 3,
    false,
    settings.scene_role ?? extension_prompt_roles.SYSTEM,
  );
}
