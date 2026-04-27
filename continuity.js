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
 * Continuity checker: manually triggered contradiction detection and optional
 * auto-repair injection.
 *
 * Gathers all established facts (short-term summary, long-term memories,
 * session memories) and asks the model whether the last AI response contradicts
 * any of them. Results are shown in the UI - not auto-applied.
 *
 * When auto-repair is enabled and contradictions are found, a second model call
 * generates a brief corrective note that is injected into the prompt for the
 * next AI turn, then automatically cleared after that response is rendered.
 *
 * Manual-only because running this automatically on every message would be
 * too expensive on local hardware (RTX 2080 / 8GB VRAM).
 *
 * checkContinuity     - runs a contradiction check against the last AI message
 * generateRepair      - generates a corrective note from a contradiction list
 * injectRepair        - stores the repair note and injects it into the prompt
 * clearRepair         - removes the pending repair from storage and the prompt
 * loadAndInjectRepair - restores a stored repair injection on chat load
 */

import { generateMemoryExtract } from './generate.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { MODULE_NAME, META_KEY, PROMPT_KEY_REPAIR } from './constants.js';
import { buildContinuityPrompt, buildRepairPrompt } from './prompts.js';
import { loadCharacterMemories } from './longterm.js';
import { loadSessionMemories } from './session.js';
import { parseContradictions } from './parsers.js';
import { smLog } from './logging.js';

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

  // The character card is the canonical source of truth - check it first.
  // Characters may contradict their card (wrong gender, species, etc.) in ways
  // that no extracted memory would catch, especially in a fresh chat.
  // Look up by name so group chat checks use the responder's card, not the
  // ST-active character (context.characterId) which may be a different member.
  const char = context.characters?.find((c) => c.name === characterName);
  if (char) {
    const cardParts = [];
    if (char.description) cardParts.push(char.description);
    if (char.personality) cardParts.push('Personality: ' + char.personality);
    if (char.scenario) cardParts.push('Scenario: ' + char.scenario);
    if (cardParts.length > 0) {
      parts.push('-- CHARACTER CARD --\n' + cardParts.join('\n'));
    }
  }

  if (meta?.summary) {
    parts.push('-- STORY SUMMARY --\n' + meta.summary);
  }

  if (characterName) {
    const longterm = loadCharacterMemories(characterName).filter((m) => !m.superseded_by);
    if (longterm.length > 0) {
      const text = longterm.map((m) => `[${m.type}] ${m.content}`).join('\n');
      parts.push('-- LONG-TERM MEMORIES --\n' + text);
    }
  }

  const session = loadSessionMemories().filter((m) => !m.superseded_by);
  if (session.length > 0) {
    const text = session.map((m) => `[${m.type}] ${m.content}`).join('\n');
    parts.push('-- SESSION DETAILS --\n' + text);
  }

  return parts.join('\n\n');
}

// chatMetadata key under META_KEY where the pending repair note is stored.
const REPAIR_KEY = 'pendingRepair';

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

    smLog('[SmartMemory] Continuity check response:', response);

    return parseContradictions(response);
  } catch (err) {
    console.error('[SmartMemory] Continuity check failed:', err);
    throw err;
  }
}

/**
 * Generates a brief corrective context note from a list of contradictions.
 * Called after checkContinuity finds issues and auto-repair is enabled.
 * @param {string[]} contradictions - Array of contradiction descriptions.
 * @param {string} characterName - Used to load the correct long-term memories.
 * @returns {Promise<string>} The corrective note text.
 */
export async function generateRepair(contradictions, characterName) {
  const settings = extension_settings[MODULE_NAME];
  const facts = gatherEstablishedFacts(characterName);
  const prompt = buildRepairPrompt(contradictions, facts);

  const note = await generateMemoryExtract(prompt, {
    responseLength: settings.continuity_response_length ?? 300,
  });

  smLog('[SmartMemory] Repair note generated:', note);
  return typeof note === 'string' ? note.trim() : null;
}

/**
 * Stores a repair note in chatMetadata and injects it into the prompt at
 * depth 0 IN_CHAT so it sits immediately before the next AI response.
 * The note is one-shot - clearRepair() removes it after the next render.
 * @param {string} repairNote - The corrective note text.
 */
export function injectRepair(repairNote) {
  const context = getContext();
  if (!context.chatMetadata) return;
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY][REPAIR_KEY] = repairNote;
  context.saveMetadata()?.catch(console.error);

  setExtensionPrompt(
    PROMPT_KEY_REPAIR,
    `[Continuity correction - apply to this response: ${repairNote}]`,
    extension_prompt_types.IN_CHAT,
    0,
    false,
    extension_prompt_roles.SYSTEM,
  );
}

/**
 * Removes the pending repair note from chatMetadata and clears the injection
 * slot. Called after the next AI message is rendered.
 */
export function clearRepair() {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    delete context.chatMetadata[META_KEY][REPAIR_KEY];
    context.saveMetadata()?.catch(console.error);
  }
  setExtensionPrompt(PROMPT_KEY_REPAIR, '', extension_prompt_types.NONE, 0);
}

/**
 * Restores a stored repair injection on chat load. If a repair note was queued
 * before the chat was closed or switched, this re-injects it so it is still
 * active for the next AI turn.
 */
export function loadAndInjectRepair() {
  const context = getContext();
  const repair = context.chatMetadata?.[META_KEY]?.[REPAIR_KEY];
  if (repair) {
    setExtensionPrompt(
      PROMPT_KEY_REPAIR,
      `[Continuity correction - apply to this response: ${repair}]`,
      extension_prompt_types.IN_CHAT,
      0,
      false,
      extension_prompt_roles.SYSTEM,
    );
  } else {
    setExtensionPrompt(PROMPT_KEY_REPAIR, '', extension_prompt_types.NONE, 0);
  }
}
