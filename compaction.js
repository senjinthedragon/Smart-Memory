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
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
  getMaxContextSize,
} from '../../../../script.js';
import { generateMemorySummarize } from './generate.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { estimateTokens, MODULE_NAME, PROMPT_KEY_SHORT, META_KEY } from './constants.js';
import { replaceTemplate } from './template-utils.js';
import { buildSummaryPrompt, buildUpdateSummaryPrompt } from './prompts.js';
import { formatSummary } from './parsers.js';
import { loadCharacterMemories } from './longterm.js';
import { loadSessionMemories } from './session.js';
import { invalidateUnifiedCache } from './unified-inject.js';
import { MACRO_NAMES, setMacroContent, isMacroActive } from './macros.js';
import { reportTierTrimStats } from './trim-stats.js';
import { truncateSummaryToBudget } from './memory-utils.js';

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
 * Returns true if the unsummarized portion of the chat has crossed the
 * configured compaction threshold. Only messages after summaryEnd (the last
 * message already included in the existing summary) are counted - this prevents
 * the threshold from firing on every message once a long chat permanently exceeds
 * the percentage, since compaction does not delete messages.
 * @returns {Promise<boolean>}
 */
export async function shouldCompact() {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.compaction_enabled) return false;

  const context = getContext();
  if (!context.chat || context.chat.length < 4) return false;

  // Only measure the unsummarized tail - messages after the last compaction point.
  const summaryEnd = context.chatMetadata?.[META_KEY]?.summaryEnd ?? 0;
  const newMessages = context.chat.slice(summaryEnd);
  if (newMessages.length === 0) return false;

  const maxTokens = getMaxContextSize(settings.compaction_response_length || 0);
  if (maxTokens <= 0) return false;

  // Cheap char-based pre-check: if the rough estimate is below 60% of the
  // threshold there is no way the real tokenizer will disagree enough to matter.
  // Saves the async tokenizer call on the vast majority of messages.
  const roughText = newMessages
    .filter((m) => m.mes && !m.is_system)
    .map((m) => `${m.name}: ${m.mes}`)
    .join('\n');
  const roughRatio = estimateTokens(roughText) / maxTokens;
  if (roughRatio < (settings.compaction_threshold / 100) * 0.6) return false;

  const tokens = await getChatTokenCount(newMessages);
  const ratio = tokens / maxTokens;
  return ratio >= settings.compaction_threshold / 100;
}

/**
 * Generates a structured summary of the current conversation and stores
 * it in chatMetadata. Uses progressive compaction when a prior summary exists:
 * only messages after summaryEnd are processed, extending the existing summary
 * rather than rewriting it from scratch.
 * @param {{includeLastMessage?: boolean, abortCheck?: Function|null}} [options]
 * @returns {Promise<string|null>} The formatted summary, or null on failure/abort.
 */
export async function runCompaction({ includeLastMessage = false, abortCheck = null } = {}) {
  const settings = extension_settings[MODULE_NAME];
  const context = getContext();

  try {
    const meta = context.chatMetadata?.[META_KEY];
    const existingSummary = meta?.summary;
    // summaryEnd is the chat array index of the last message already included
    // in the existing summary. Messages after this index are "new" for the update.
    // Clamp to the current chat length: if messages were deleted since the last
    // summary, summaryEnd could point past the end of the array, which would
    // cause the update path to process zero new messages and stall.
    const rawSummaryEnd = meta?.summaryEnd ?? 0;
    const summaryEnd = Math.min(rawSummaryEnd, context.chat.length);

    // Build a brief digest of what is already stored at other tiers so the
    // summary can focus on narrative flow rather than restating known facts.
    // Capped to avoid overwhelming local model context windows.
    const characterName = context.name2 || context.characterName || null;
    const longtermMemories = characterName
      ? loadCharacterMemories(characterName).filter((m) => !m.superseded_by)
      : [];
    const sessionMemories = loadSessionMemories().filter((m) => !m.superseded_by);
    // Build a digest of what is stored at other tiers so the summary can skip
    // restating known facts. Cap by token budget rather than entry count so a
    // few very long memories don't overflow the model context window.
    const DIGEST_TOKEN_BUDGET = 400;
    const storedDigestParts = [];
    if (longtermMemories.length > 0) {
      let ltLines = [];
      let ltTokens = 0;
      for (const m of longtermMemories) {
        const line = `[${m.type}] ${m.content}`;
        const est = estimateTokens(line);
        if (ltTokens + est > DIGEST_TOKEN_BUDGET) break;
        ltLines.push(line);
        ltTokens += est;
      }
      if (ltLines.length > 0) {
        storedDigestParts.push(`Long-term memories:\n${ltLines.join('\n')}`);
      }
    }
    if (sessionMemories.length > 0) {
      let sesLines = [];
      let sesTokens = 0;
      for (const m of sessionMemories) {
        const line = `[${m.type}] ${m.content}`;
        const est = estimateTokens(line);
        if (sesTokens + est > DIGEST_TOKEN_BUDGET) break;
        sesLines.push(line);
        sesTokens += est;
      }
      if (sesLines.length > 0) {
        storedDigestParts.push(`Session memories:\n${sesLines.join('\n')}`);
      }
    }
    const storedMemories = storedDigestParts.join('\n\n');

    let raw;

    // If the summary already covers the full chat, there is nothing new to
    // process. Return the existing summary unchanged rather than falling through
    // to the full-compaction path, which would replace it with a narrower window.
    if (existingSummary && summaryEnd >= context.chat.length) return existingSummary;

    if (existingSummary && summaryEnd > 0 && summaryEnd < context.chat.length) {
      // Progressive path: feed only the new messages to the update prompt.
      // Exclude the trailing AI message unless the caller explicitly wants the
      // full chat (e.g. Memorize Chat, where the user chose to memorize everything).
      const rawNewMessages = context.chat.slice(summaryEnd);
      const lastNew = rawNewMessages[rawNewMessages.length - 1];
      const newMessages =
        !includeLastMessage && lastNew && !lastNew.is_user && !lastNew.is_system
          ? rawNewMessages.slice(0, -1)
          : rawNewMessages;
      const newEvents = newMessages
        .filter((m) => m.mes && !m.is_system)
        .map((m) => `${m.name}: ${m.mes}`)
        .join('\n\n');

      if (!newEvents.trim()) return existingSummary;

      const updatePrompt = replaceTemplate(
        replaceTemplate(
          buildUpdateSummaryPrompt(storedMemories),
          '{{existing_summary}}',
          existingSummary,
        ),
        '{{new_events}}',
        newEvents,
      );

      raw = await generateMemorySummarize(updatePrompt, {
        responseLength: settings.compaction_response_length || 2000,
        includeLastMessage,
        // The prompt body already contains {{new_events}} and {{existing_summary}},
        // so sending the full chat as priorMessages would duplicate the new messages.
        chatMessages: [],
      });
    } else {
      // Full compaction: first time or fresh chat with no existing summary.
      raw = await generateMemorySummarize(buildSummaryPrompt(storedMemories), {
        responseLength: settings.compaction_response_length || 2000,
        includeLastMessage,
      });
    }

    if (!raw || raw.trim() === '') return null;

    // The chat may have been switched while the model call was in flight.
    // Bail before touching chatMetadata/saveMetadata so the previous chat's
    // summary is never written into the newly-opened chat.
    if (abortCheck?.()) return null;

    const summary = formatSummary(raw);

    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    context.chatMetadata[META_KEY].summary = summary;
    context.chatMetadata[META_KEY].summaryUpdated = Date.now();
    // Record how far into the chat this summary covers so the next compaction
    // knows where "new" messages begin. When the trailing AI message was excluded
    // (normal roleplay path), point back one so the next compaction picks it up.
    // When the caller asked for the full chat (Memorize Chat), the last message
    // was included so the boundary is the full length.
    const lastChatMsg = context.chat[context.chat.length - 1];
    context.chatMetadata[META_KEY].summaryEnd =
      !includeLastMessage && lastChatMsg && !lastChatMsg.is_user && !lastChatMsg.is_system
        ? context.chat.length - 1
        : context.chat.length;
    await context.saveMetadata();

    return summary;
  } catch (err) {
    console.error('[SmartMemory] Compaction failed:', err);
    throw err;
  }
}

/**
 * Injects the summary string into the prompt via setExtensionPrompt.
 * Clears the slot if summary is empty or null.
 * @param {string} summary - The summary text to inject.
 */
export function injectSummary(summary) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.compaction_enabled || !summary) {
    setMacroContent(MACRO_NAMES.shortterm, '');
    setExtensionPrompt(PROMPT_KEY_SHORT, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SHORT);
    return;
  }

  // Truncate to the token budget - response_length doubles as the injection cap.
  // Sections 8 (Current Moment) and 9 (Next Beat) are at the END of the
  // summary, so a naive end cut would discard exactly the content the model
  // needs to continue the scene. The helper trims earlier narrative sections
  // first and keeps the tail anchored.
  const budget = settings.compaction_response_length ?? 2000;
  const fullTokens = estimateTokens(summary);
  const summaryText = truncateSummaryToBudget(summary, budget);

  const template = settings.compaction_template || 'Story so far:\n{{summary}}';
  const content = replaceTemplate(template, '{{summary}}', summaryText);
  reportTierTrimStats(PROMPT_KEY_SHORT, estimateTokens(content), fullTokens);

  setMacroContent(MACRO_NAMES.shortterm, content);
  if (isMacroActive(MACRO_NAMES.shortterm)) {
    setExtensionPrompt(PROMPT_KEY_SHORT, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SHORT);
    return;
  }

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
    setMacroContent(MACRO_NAMES.shortterm, '');
    setExtensionPrompt(PROMPT_KEY_SHORT, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SHORT);
  }
  return summary || null;
}
