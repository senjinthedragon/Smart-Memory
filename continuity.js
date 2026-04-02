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
 * Continuity checker: manually triggered contradiction detection.
 *
 * Gathers all established facts (short-term summary, long-term memories,
 * session memories) and asks the model whether the last AI response contradicts
 * any of them. Results are shown in the UI - not auto-applied.
 *
 * Manual-only because running this automatically on every message would be
 * too expensive on local hardware (RTX 2080 / 8GB VRAM).
 *
 * checkContinuity - runs a contradiction check against the last AI message
 */

import { generateMemoryExtract } from './generate.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY } from './constants.js';
import { buildContinuityPrompt } from './prompts.js';
import { loadCharacterMemories } from './longterm.js';
import { loadSessionMemories } from './session.js';

/**
 * Collects all established facts into a single labelled text block.
 * Pulls from the short-term summary, long-term memories, and session memories
 * so the model has the full picture of what is "known" for this chat.
 * @param {string} characterName
 * @returns {string} Multi-section fact block, or empty string if nothing is stored.
 */
function gatherEstablishedFacts(characterName) {
  const context = getContext();
  const meta = context.chatMetadata?.[META_KEY];
  const parts = [];

  if (meta?.summary) {
    parts.push('-- STORY SUMMARY --\n' + meta.summary);
  }

  if (characterName) {
    const longterm = loadCharacterMemories(characterName);
    if (longterm.length > 0) {
      const text = longterm.map((m) => `[${m.type}] ${m.content}`).join('\n');
      parts.push('-- LONG-TERM MEMORIES --\n' + text);
    }
  }

  const session = loadSessionMemories();
  if (session.length > 0) {
    const text = session.map((m) => `[${m.type}] ${m.content}`).join('\n');
    parts.push('-- SESSION DETAILS --\n' + text);
  }

  return parts.join('\n\n');
}

/**
 * Parses the model's continuity check response into an array of contradiction strings.
 * Strips leading bullet/numbering characters. Returns an empty array if the
 * model responded with NONE or produced nothing usable.
 * @param {string} text - Raw model response.
 * @returns {string[]}
 */
function parseContradictions(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];

  return text
    .split('\n')
    .map((line) => line.replace(/^[-•*\d.]+\s*/, '').trim())
    .filter((line) => line.length > 5);
}

/**
 * Runs a continuity check against the last AI message in the current chat.
 * Gathers established facts from all memory tiers and asks the model whether
 * the latest response contradicts any of them.
 * @param {string} characterName - Used to load the correct long-term memories.
 * @returns {Promise<string[]>} Array of contradiction descriptions, or [] if clean or on error.
 */
export async function checkContinuity(characterName) {
  const settings = extension_settings[MODULE_NAME];

  try {
    const context = getContext();
    const lastAiMessage = context.chat
      ?.slice()
      .reverse()
      .find((m) => !m.is_user && !m.is_system && m.mes);

    if (!lastAiMessage) return [];

    const facts = gatherEstablishedFacts(characterName);
    if (!facts.trim()) return [];

    const prompt = buildContinuityPrompt(facts, lastAiMessage.mes);

    const response = await generateMemoryExtract(prompt, {
      responseLength: settings.continuity_response_length ?? 300,
    });

    console.log('[SmartMemory] Continuity check response:', response);

    return parseContradictions(response);
  } catch (err) {
    console.error('[SmartMemory] Continuity check failed:', err);
    return [];
  }
}
