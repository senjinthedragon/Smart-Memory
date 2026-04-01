/**
 * Scene break detection and scene history.
 *
 * Detects when a scene ends (via heuristics or AI check) and generates
 * a mini-summary of the completed scene. Scene history is stored in
 * chatMetadata and injected as compact past-scene context.
 */

import {
  generateRaw,
  generateQuietPrompt,
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, PROMPT_KEY_SCENES } from './constants.js';
import { SCENE_DETECT_PROMPT, SCENE_SUMMARY_PROMPT } from './prompts.js';

// ─── Heuristics ───────────────────────────────────────────────────────────────

const SCENE_BREAK_PATTERNS = [
  // Time skips
  /\b(later that (day|night|evening|morning)|the next (day|morning|evening|night)|hours later|days later|the following (day|morning|week)|some time later|meanwhile|after (a while|some time)|that (evening|night|afternoon|morning))\b/i,
  // Location transitions
  /\b(arrived at|walked into|stepped into|entered the|found (himself|herself|themselves) in|made (his|her|their) way to|headed (to|toward|towards))\b/i,
  // Explicit scene markers
  /^[-*~]{3,}$/m,
  /\*\s*\*\s*\*/,
];

/**
 * Cheap heuristic: check if the last AI message contains scene-break signals.
 * @param {string} messageText
 * @returns {boolean}
 */
export function detectSceneBreakHeuristic(messageText) {
  return SCENE_BREAK_PATTERNS.some((pattern) => pattern.test(messageText));
}

/**
 * AI-based scene break detection. More accurate but costs a model call.
 * @param {string} messageText
 * @returns {Promise<boolean>}
 */
export async function detectSceneBreakAI(messageText) {
  try {
    const prompt = SCENE_DETECT_PROMPT.replace(
      '{{text}}',
      messageText.slice(0, 800),
    );
    const response = await generateRaw({
      prompt,
      quietToLoud: false,
      responseLength: 5,
    });
    return response?.trim().toUpperCase().startsWith('YES') ?? false;
  } catch {
    return false;
  }
}

// ─── Scene storage ────────────────────────────────────────────────────────────

export function loadSceneHistory() {
  const context = getContext();
  return context.chatMetadata?.[META_KEY]?.sceneHistory ?? [];
}

export async function saveSceneHistory(scenes) {
  const context = getContext();
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].sceneHistory = scenes;
  await context.saveMetadata();
}

export async function clearSceneHistory() {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    context.chatMetadata[META_KEY].sceneHistory = [];
    await context.saveMetadata();
  }
}

// ─── Scene summary ────────────────────────────────────────────────────────────

/**
 * Generates a mini-summary of recently completed scene messages.
 * @param {Array} sceneMessages - messages from the completed scene
 * @returns {Promise<string|null>}
 */
export async function summarizeScene(sceneMessages) {
  const settings = extension_settings[MODULE_NAME];
  try {
    const sceneText = sceneMessages
      .filter((m) => m.mes && !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!sceneText.trim()) return null;

    const prompt = SCENE_SUMMARY_PROMPT.replace(
      '{{scene_text}}',
      sceneText.slice(0, 2000),
    );

    const response = await generateRaw({
      prompt,
      quietToLoud: false,
      responseLength: settings.scene_summary_length ?? 200,
    });

    return response?.trim() || null;
  } catch (err) {
    console.error('[SmartMemory] Scene summary failed:', err);
    return null;
  }
}

/**
 * Detects a scene break in the latest message and, if found, summarizes
 * the completed scene and appends it to scene history.
 *
 * @param {string} lastMessageText
 * @param {Array} recentMessages - messages since the last scene break
 * @returns {Promise<boolean>} true if a scene break was detected and processed
 */
export async function processSceneBreak(lastMessageText, recentMessages) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.scene_enabled) return false;

  // Detection: use AI if configured, otherwise heuristic
  let isBreak;
  if (settings.scene_ai_detect) {
    isBreak = await detectSceneBreakAI(lastMessageText);
  } else {
    isBreak = detectSceneBreakHeuristic(lastMessageText);
  }

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

// ─── Injection ────────────────────────────────────────────────────────────────

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

  const text = history.map((s, i) => `Scene ${i + 1}: ${s.summary}`).join('\n');
  const content = `[Previous scenes:\n${text}]`;

  setExtensionPrompt(
    PROMPT_KEY_SCENES,
    content,
    settings.scene_position ?? extension_prompt_types.IN_PROMPT,
    settings.scene_depth ?? 3,
    false,
    settings.scene_role ?? extension_prompt_roles.SYSTEM,
  );
}
