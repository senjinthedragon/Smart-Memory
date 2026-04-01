/**
 * Short-term memory: token-threshold-triggered structured summarization.
 *
 * Progressive compaction: tracks the index of the last message included in
 * the existing summary. On subsequent compactions, only new messages are
 * fed to the model and the existing summary is extended rather than rewritten.
 */

import { generateQuietPrompt, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, getMaxContextSize } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { MODULE_NAME, PROMPT_KEY_SHORT, META_KEY } from './constants.js';
import { SUMMARY_PROMPT, UPDATE_SUMMARY_PROMPT } from './prompts.js';

/**
 * Counts tokens across the non-system chat messages.
 * @param {Array} chat
 * @returns {Promise<number>}
 */
async function getChatTokenCount(chat) {
    const text = chat
        .filter(m => m.mes && !m.is_system)
        .map(m => `${m.name}: ${m.mes}`)
        .join('\n');
    return await getTokenCountAsync(text, 0);
}

/**
 * Returns true if the current chat has crossed the compaction threshold.
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
    return ratio >= (settings.compaction_threshold / 100);
}

/**
 * Strips the <analysis> scratchpad and unwraps the <summary> block.
 * @param {string} raw
 * @returns {string}
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
 * only new messages since the last compaction are processed, and the existing
 * summary is extended rather than rewritten.
 *
 * Returns the formatted summary string, or null on failure.
 * @returns {Promise<string|null>}
 */
export async function runCompaction() {
    const settings = extension_settings[MODULE_NAME];
    const context = getContext();

    try {
        const meta = context.chatMetadata?.[META_KEY];
        const existingSummary = meta?.summary;
        const summaryEnd = meta?.summaryEnd ?? 0;  // index of last message included in existing summary

        let raw;

        if (existingSummary && summaryEnd > 0 && summaryEnd < context.chat.length) {
            // Progressive: only new messages since last compaction
            const newMessages = context.chat.slice(summaryEnd);
            const newEvents = newMessages
                .filter(m => m.mes && !m.is_system)
                .map(m => `${m.name}: ${m.mes}`)
                .join('\n\n');

            if (!newEvents.trim()) return existingSummary;

            const updatePrompt = UPDATE_SUMMARY_PROMPT
                .replace('{{existing_summary}}', existingSummary)
                .replace('{{new_events}}', newEvents);

            raw = await generateQuietPrompt({
                quietPrompt: updatePrompt,
                quietToLoud: false,
                skipWIAN: true,
                responseLength: settings.compaction_response_length || 1500,
                removeReasoning: true,
            });
        } else {
            // Full compaction (first time or fresh chat)
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

        // Persist to chat metadata
        if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
        context.chatMetadata[META_KEY].summary = summary;
        context.chatMetadata[META_KEY].summaryUpdated = Date.now();
        context.chatMetadata[META_KEY].summaryEnd = context.chat.length;
        await context.saveMetadata();

        return summary;
    } catch (err) {
        console.error('[SmartMemory] Compaction failed:', err);
        return null;
    }
}

/**
 * Injects the stored summary into the prompt via setExtensionPrompt.
 * @param {string} summary
 */
export function injectSummary(summary) {
    const settings = extension_settings[MODULE_NAME];
    if (!summary) {
        setExtensionPrompt(PROMPT_KEY_SHORT, '', extension_prompt_types.NONE, 0);
        return;
    }

    const template = settings.compaction_template || '[Story so far:\n{{summary}}]';
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
 * Loads and re-injects a previously stored summary from chatMetadata.
 * Called on CHAT_LOADED / CHAT_CHANGED.
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
