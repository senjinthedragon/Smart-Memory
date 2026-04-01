/**
 * Away recap - generates a "Previously on..." summary when the user
 * returns to a chat after being away for longer than the threshold.
 *
 * The recap is injected once at the top of context and cleared after
 * the first AI response so it doesn't persist into future turns.
 */

import {
  generateQuietPrompt,
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, PROMPT_KEY_RECAP } from './constants.js';
import { RECAP_PROMPT } from './prompts.js';

/**
 * Records the current time as last-active in chat metadata.
 * Call on chat load and after each user message.
 */
export function updateLastActive() {
  const context = getContext();
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].lastActive = Date.now();
  context.saveMetadataDebounced?.();
}

/**
 * Checks whether a recap should be generated based on time away.
 * Returns the gap in hours, or 0 if the threshold isn't met.
 * @returns {number} hours since last active (0 = no recap needed)
 */
export function getAwayHours() {
  const context = getContext();
  const meta = context.chatMetadata?.[META_KEY];
  if (!meta?.lastActive) return 0;

  const gapHours = (Date.now() - meta.lastActive) / (1000 * 60 * 60);
  const threshold = extension_settings[MODULE_NAME].recap_threshold_hours ?? 4;
  return gapHours >= threshold ? gapHours : 0;
}

/**
 * Generates a "Previously on..." recap using the current chat context.
 * @returns {Promise<string|null>}
 */
export async function generateRecap() {
  const settings = extension_settings[MODULE_NAME];
  try {
    const response = await generateQuietPrompt({
      quietPrompt: RECAP_PROMPT,
      skipWIAN: true,
      responseLength: settings.recap_response_length ?? 300,
      removeReasoning: true,
    });
    return response?.trim() || null;
  } catch (err) {
    console.error('[SmartMemory] Recap generation failed:', err);
    return null;
  }
}

/**
 * Injects the recap into context.
 * @param {string|null} recap
 */
export function injectRecap(recap) {
  if (!recap) {
    setExtensionPrompt(PROMPT_KEY_RECAP, '', extension_prompt_types.NONE, 0);
    return;
  }
  const hoursAway = Math.round(getAwayHours() * 10) / 10;
  const header =
    hoursAway > 24
      ? `[You've been away for ${Math.round(hoursAway / 24)} day(s). Previously in this story:]`
      : `[Picking up where you left off:]`;

  setExtensionPrompt(
    PROMPT_KEY_RECAP,
    `${header}\n${recap}`,
    extension_prompt_types.IN_PROMPT,
    0,
    false,
    extension_prompt_roles.SYSTEM,
  );
}

/**
 * Clears the recap injection. Call after the first AI response.
 */
export function clearRecap() {
  setExtensionPrompt(PROMPT_KEY_RECAP, '', extension_prompt_types.NONE, 0);
}
