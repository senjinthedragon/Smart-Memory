/**
 * Session memory — detailed within-session facts stored in chatMetadata.
 *
 * This is the middle tier between:
 *   - Short-term (compaction): broad story summary, covers old messages
 *   - Session memory (this): detailed facts from the current chat
 *   - Long-term: distilled facts that persist across all sessions
 *
 * Session memories are more detailed than long-term (specific details,
 * scene descriptions, named objects) but don't survive past this chat.
 * They're for the kind of detail the vector extension captures, without
 * requiring an embedding model.
 */

import { generateRaw, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, PROMPT_KEY_SESSION, SESSION_TYPES } from './constants.js';
import { SESSION_EXTRACTION_SYSTEM, buildSessionExtractionPrompt } from './prompts.js';

// ─── Storage (chatMetadata) ───────────────────────────────────────────────────

export function loadSessionMemories() {
    const context = getContext();
    return context.chatMetadata?.[META_KEY]?.sessionMemories ?? [];
}

export async function saveSessionMemories(memories) {
    const context = getContext();
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    context.chatMetadata[META_KEY].sessionMemories = memories;
    await context.saveMetadata();
}

export async function clearSessionMemories() {
    const context = getContext();
    if (context.chatMetadata?.[META_KEY]) {
        context.chatMetadata[META_KEY].sessionMemories = [];
        await context.saveMetadata();
    }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function parseSessionOutput(text) {
    if (!text || text.trim().toUpperCase() === 'NONE') return [];
    const results = [];
    const pattern = /^\[(scene|revelation|development|detail)\]\s+(.+)$/gim;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const type = match[1].toLowerCase();
        const content = match[2].trim();
        if (SESSION_TYPES.includes(type) && content.length > 3) {
            results.push({ type, content, ts: Date.now() });
        }
    }
    return results;
}

function deduplicateSession(existing, incoming, max) {
    const merged = [...existing];
    for (const mem of incoming) {
        const words = new Set(mem.content.toLowerCase().split(/\s+/));
        const isDuplicate = merged.some(ex => {
            const exWords = new Set(ex.content.toLowerCase().split(/\s+/));
            const intersection = [...words].filter(w => exWords.has(w)).length;
            return intersection / Math.max(words.size, exWords.size) > 0.65;
        });
        if (!isDuplicate) merged.push(mem);
    }
    if (merged.length > max) merged.splice(0, merged.length - max);
    return merged;
}

// ─── Extraction ───────────────────────────────────────────────────────────────

/**
 * Extracts session-level details from recent messages and merges them
 * into chatMetadata. Returns count of new items saved.
 * @param {Array} recentMessages
 * @returns {Promise<number>}
 */
export async function extractSessionMemories(recentMessages) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.session_enabled) return 0;

    try {
        const chatHistory = recentMessages
            .filter(m => m.mes && !m.is_system)
            .map(m => `${m.name}: ${m.mes}`)
            .join('\n\n');

        if (!chatHistory.trim()) return 0;

        const existing = loadSessionMemories();
        const existingText = existing.map(m => `[${m.type}] ${m.content}`).join('\n');

        const response = await generateRaw({
            prompt: buildSessionExtractionPrompt(chatHistory, existingText),
            systemPrompt: SESSION_EXTRACTION_SYSTEM,
            quietToLoud: false,
            responseLength: settings.session_response_length ?? 500,
        });

        console.log('[SmartMemory] Session extraction response:', response);

        if (!response || response.trim().toUpperCase() === 'NONE') return 0;

        const incoming = parseSessionOutput(response);
        if (incoming.length === 0) return 0;

        const max = settings.session_max_memories ?? 30;
        const merged = deduplicateSession(existing, incoming, max);
        await saveSessionMemories(merged);

        return incoming.length;
    } catch (err) {
        console.error('[SmartMemory] Session extraction failed:', err);
        return 0;
    }
}

// ─── Injection ────────────────────────────────────────────────────────────────

export function formatSessionMemories(memories) {
    if (!memories || memories.length === 0) return '';
    return memories.map(m => `[${m.type}] ${m.content}`).join('\n');
}

export function injectSessionMemories() {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.session_enabled) {
        setExtensionPrompt(PROMPT_KEY_SESSION, '', extension_prompt_types.NONE, 0);
        return;
    }

    const memories = loadSessionMemories();
    if (memories.length === 0) {
        setExtensionPrompt(PROMPT_KEY_SESSION, '', extension_prompt_types.NONE, 0);
        return;
    }

    const template = settings.session_template ?? '[Details from this session:\n{{session}}]';
    const content = template.replace('{{session}}', formatSessionMemories(memories));

    setExtensionPrompt(
        PROMPT_KEY_SESSION,
        content,
        settings.session_position ?? extension_prompt_types.IN_PROMPT,
        settings.session_depth ?? 1,
        false,
        settings.session_role ?? extension_prompt_roles.SYSTEM,
    );
}
