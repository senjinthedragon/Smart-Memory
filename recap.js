/**
 * Smart Memory - SillyTavern Extension
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/smart-memory
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
 * Away recap: generates a "Previously on..." summary when the user returns
 * to a chat after being away longer than the configured threshold.
 *
 * The recap is injected once at the top of context and automatically cleared
 * after the first AI response so it doesn't linger into subsequent turns.
 *
 * updateLastActive - records the current time as lastActive in chatMetadata
 * getAwayHours    - returns hours since last active (0 if below threshold)
 * generateRecap   - generates the recap text via the model
 * injectRecap     - pushes the recap into the prompt with an appropriate header
 * clearRecap      - removes the recap injection (called after first AI response)
 */

import { generateQuietPrompt, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, PROMPT_KEY_RECAP } from './constants.js';
import { RECAP_PROMPT } from './prompts.js';

/**
 * Records the current timestamp as lastActive in chatMetadata.
 * Called on chat load and after each AI response to keep the clock accurate.
 * Uses the debounced save to avoid hammering storage on every message.
 */
export function updateLastActive() {
    const context = getContext();
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    context.chatMetadata[META_KEY].lastActive = Date.now();
    context.saveMetadataDebounced?.();
}

/**
 * Checks whether a recap should be generated based on time away.
 * Returns the gap in hours if it meets the threshold, or 0 if not.
 * @returns {number} Hours since last active, or 0 if below threshold.
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
 * @returns {Promise<string|null>} The recap text, or null on failure.
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
 * Injects the recap into the prompt with a context-appropriate header.
 * The header distinguishes short gaps ("Picking up where you left off")
 * from long ones ("You've been away for N days").
 * @param {string|null} recap - The recap text to inject, or null to clear.
 */
export function injectRecap(recap) {
    if (!recap) {
        setExtensionPrompt(PROMPT_KEY_RECAP, '', extension_prompt_types.NONE, 0);
        return;
    }
    const hoursAway = Math.round(getAwayHours() * 10) / 10;
    const header = hoursAway > 24
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
 * Clears the recap injection slot. Called after the first AI response
 * so the recap doesn't persist into subsequent turns.
 */
export function clearRecap() {
    setExtensionPrompt(PROMPT_KEY_RECAP, '', extension_prompt_types.NONE, 0);
}
