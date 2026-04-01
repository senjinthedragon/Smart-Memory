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
 * Short-term memory: token-threshold-triggered structured summarization.
 *
 * Tracks summaryEnd in chatMetadata so subsequent compactions only process
 * new messages rather than rewriting the whole history from scratch.
 *
 * shouldCompact        - returns true when the chat has crossed the compaction threshold
 * runCompaction        - generates or extends the summary and persists it to chatMetadata
 * injectSummary        - pushes the summary into the prompt via setExtensionPrompt
 * loadAndInjectSummary - restores a stored summary on chat load
 */

import {
  generateQuietPrompt,
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
  getMaxContextSize,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { MODULE_NAME, PROMPT_KEY_SHORT, META_KEY } from './constants.js';
import { SUMMARY_PROMPT, UPDATE_SUMMARY_PROMPT } from './prompts.js';

/**
 * Counts tokens across all non-system chat messages.
 * Used to decide whether compaction is needed.
 * @param {Array} chat - The full chat array from context.
 * @returns {Promise<number>} Estimated token count.
 */
async function getChatTokenCount(chat) {
  const text = chat
    .filter((m) => m.mes && !m.is_system)
    .map((m) => `${m.name}: ${m.mes}`)
    .join('\n');
  return await getTokenCountAsync(text, 0);
}

/**
 * Returns true if the current chat has crossed the configured compaction threshold.
 * Compares current token count against (maxContextSize - responseLength budget).
 * @returns {Promise<boolean>}
 */
export async function shouldCompact() {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.compaction_enabled) return false;

  const context = getContext();
  if (!context.chat || context.chat.length < 4) return false;

  const tokens = await getChatTokenCount(context.chat);
  const maxTokens = getMaxContextSize(settings.compaction_response_length || 0);
  if (maxTokens <= 0) return false;

  const ratio = tokens / maxTokens;
  return ratio >= settings.compaction_threshold / 100;
}

/**
 * Strips the <analysis> scratchpad block and unwraps the <summary> block
 * from the model's raw output. Falls back to the trimmed raw string if
 * no <summary> tags are present.
 * @param {string} raw - Raw model output.
 * @returns {string} Cleaned summary text.
 */
function formatSummary(raw) {
  let result = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim();
  const match = result.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (match) {
    result = match[1].trim();
  }
  return result;
}

/**
 * Generates a structured summary of the current conversation and stores
 * it in chatMetadata. Uses progressive compaction when a prior summary exists:
 * only messages after summaryEnd are processed, extending the existing summary
 * rather than rewriting it from scratch.
 * @returns {Promise<string|null>} The formatted summary, or null on failure.
 */
export async function runCompaction() {
  const settings = extension_settings[MODULE_NAME];
  const context = getContext();

  try {
    const meta = context.chatMetadata?.[META_KEY];
    const existingSummary = meta?.summary;
    // summaryEnd is the chat array index of the last message already included
    // in the existing summary. Messages after this index are "new" for the update.
    const summaryEnd = meta?.summaryEnd ?? 0;

    let raw;

    if (existingSummary && summaryEnd > 0 && summaryEnd < context.chat.length) {
      // Progressive path: feed only the new messages to the update prompt.
      const newMessages = context.chat.slice(summaryEnd);
      const newEvents = newMessages
        .filter((m) => m.mes && !m.is_system)
        .map((m) => `${m.name}: ${m.mes}`)
        .join('\n\n');

      if (!newEvents.trim()) return existingSummary;

      const updatePrompt = UPDATE_SUMMARY_PROMPT.replace(
        '{{existing_summary}}',
        existingSummary,
      ).replace('{{new_events}}', newEvents);

      raw = await generateQuietPrompt({
        quietPrompt: updatePrompt,
        quietToLoud: false,
        skipWIAN: true,
        responseLength: settings.compaction_response_length || 1500,
        removeReasoning: true,
      });
    } else {
      // Full compaction: first time or fresh chat with no existing summary.
      raw = await generateQuietPrompt({
        quietPrompt: SUMMARY_PROMPT,
        quietToLoud: false,
        skipWIAN: true,
        responseLength: settings.compaction_response_length || 1500,
        removeReasoning: true,
      });
    }

    if (!raw || raw.trim() === '') return null;

    const summary = formatSummary(raw);

    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    context.chatMetadata[META_KEY].summary = summary;
    context.chatMetadata[META_KEY].summaryUpdated = Date.now();
    // Record how far into the chat this summary covers so the next compaction
    // knows where "new" messages begin.
    context.chatMetadata[META_KEY].summaryEnd = context.chat.length;
    await context.saveMetadata();

    return summary;
  } catch (err) {
    console.error('[SmartMemory] Compaction failed:', err);
    return null;
  }
}

/**
 * Injects the summary string into the prompt via setExtensionPrompt.
 * Clears the slot if summary is empty or null.
 * @param {string} summary - The summary text to inject.
 */
export function injectSummary(summary) {
  const settings = extension_settings[MODULE_NAME];
  if (!summary) {
    setExtensionPrompt(PROMPT_KEY_SHORT, '', extension_prompt_types.NONE, 0);
    return;
  }

  const template =
    settings.compaction_template || '[Story so far:\n{{summary}}]';
  const content = template.replace('{{summary}}', summary);

  setExtensionPrompt(
    PROMPT_KEY_SHORT,
    content,
    settings.compaction_position ?? extension_prompt_types.IN_PROMPT,
    settings.compaction_depth ?? 0,
    false,
    settings.compaction_role ?? extension_prompt_roles.SYSTEM,
  );
}

/**
 * Loads a previously stored summary from chatMetadata and injects it.
 * Called on CHAT_LOADED / CHAT_CHANGED to restore context after a switch.
 * @returns {string|null} The restored summary, or null if none exists.
 */
export function loadAndInjectSummary() {
  const context = getContext();
  const meta = context.chatMetadata?.[META_KEY];
  const summary = meta?.summary;
  if (summary) {
    injectSummary(summary);
  } else {
    setExtensionPrompt(PROMPT_KEY_SHORT, '', extension_prompt_types.NONE, 0);
  }
  return summary || null;
}
