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
 * loadArcs    - returns the stored arc array for the current chat
 * saveArcs    - persists the arc array to chatMetadata
 * deleteArc   - removes a single arc by index
 * clearArcs   - empties all arcs for the current chat
 * extractArcs - runs extraction against the conversation and updates the arc list
 * injectArcs  - pushes active arcs into the prompt via setExtensionPrompt
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { generateMemoryExtract } from './generate.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { estimateTokens, MODULE_NAME, META_KEY, PROMPT_KEY_ARCS } from './constants.js';
import { buildArcExtractionPrompt } from './prompts.js';
import { parseArcOutput } from './parsers.js';

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

    console.log('[SmartMemory] Arc extraction response:', response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    const { add, resolve } = parseArcOutput(response, existing);

    // Filter out resolved arcs, then append new ones.
    const afterResolve = existing.filter((_, i) => !resolve.includes(i));
    const max = settings.arcs_max ?? 10;
    // slice(-max) keeps the most recent arcs when over the limit.
    const merged = [...afterResolve, ...add].slice(-max);

    await saveArcs(merged);
    return add.length;
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
