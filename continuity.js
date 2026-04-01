/**
 * Continuity checker - manually triggered check for contradictions.
 *
 * Gathers established facts from the current summary and memories, then
 * asks the model whether the latest AI response contradicts any of them.
 * Returns a list of contradiction strings, or an empty array if clean.
 *
 * Manual-only: runs only when the user clicks the "Check Continuity" button.
 * Auto-checking every message is too expensive on local hardware.
 */

import { generateRaw } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, MEMORY_TYPES } from './constants.js';
import { buildContinuityPrompt } from './prompts.js';
import { loadCharacterMemories } from './longterm.js';
import { loadSessionMemories } from './session.js';

/**
 * Collects all established facts into a single text block.
 * Includes: short-term summary, long-term memories, session memories.
 * @param {string} characterName
 * @returns {string}
 */
function gatherEstablishedFacts(characterName) {
  const context = getContext();
  const meta = context.chatMetadata?.[META_KEY];
  const parts = [];

  // Short-term summary
  if (meta?.summary) {
    parts.push('-- STORY SUMMARY --\n' + meta.summary);
  }

  // Long-term memories
  if (characterName) {
    const longterm = loadCharacterMemories(characterName);
    if (longterm.length > 0) {
      const text = longterm.map((m) => `[${m.type}] ${m.content}`).join('\n');
      parts.push('-- LONG-TERM MEMORIES --\n' + text);
    }
  }

  // Session memories
  const session = loadSessionMemories();
  if (session.length > 0) {
    const text = session.map((m) => `[${m.type}] ${m.content}`).join('\n');
    parts.push('-- SESSION DETAILS --\n' + text);
  }

  return parts.join('\n\n');
}

/**
 * Parses the continuity check response into an array of contradiction strings.
 * Returns [] if the model responded NONE.
 * @param {string} text
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
 * Runs a continuity check against the last AI message.
 * @param {string} characterName
 * @returns {Promise<string[]>} array of contradiction descriptions, or []
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

    const response = await generateRaw({
      prompt,
      quietToLoud: false,
      responseLength: settings.continuity_response_length ?? 300,
    });

    console.log('[SmartMemory] Continuity check response:', response);

    return parseContradictions(response);
  } catch (err) {
    console.error('[SmartMemory] Continuity check failed:', err);
    return [];
  }
}
