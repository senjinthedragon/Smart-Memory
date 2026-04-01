/**
 * Long-term memory: per-character persistent facts across sessions.
 *
 * After every N messages, a background call extracts memorable facts
 * from the recent exchange. Facts are stored per-character in
 * extension_settings and injected into context on chat load.
 *
 * Memory types: fact, relationship, preference, event
 */

import { generateRaw, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, PROMPT_KEY_LONG, MEMORY_TYPES, META_KEY } from './constants.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from './prompts.js';

// ─── Storage helpers ──────────────────────────────────────────────────────────

/**
 * Returns the memory array for a character, or empty array.
 * @param {string} characterName
 * @returns {Array<{type: string, content: string, ts: number}>}
 */
export function loadCharacterMemories(characterName) {
    if (!characterName) return [];
    const chars = extension_settings[MODULE_NAME].characters;
    return chars?.[characterName]?.memories ?? [];
}

/**
 * Persists the memory array for a character.
 * @param {string} characterName
 * @param {Array} memories
 */
export function saveCharacterMemories(characterName, memories) {
    if (!characterName) return;
    if (!extension_settings[MODULE_NAME].characters) {
        extension_settings[MODULE_NAME].characters = {};
    }
    extension_settings[MODULE_NAME].characters[characterName] = {
        memories,
        lastUpdated: Date.now(),
    };
}

/**
 * Removes all memories for a character.
 * @param {string} characterName
 */
export function clearCharacterMemories(characterName) {
    if (!characterName) return;
    if (extension_settings[MODULE_NAME].characters?.[characterName]) {
        delete extension_settings[MODULE_NAME].characters[characterName];
    }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Formats the stored memory array into a readable string for injection.
 * @param {Array} memories
 * @returns {string}
 */
export function formatMemoriesForPrompt(memories) {
    if (!memories || memories.length === 0) return '';
    return memories.map(m => `[${m.type}] ${m.content}`).join('\n');
}

// ─── Extraction ───────────────────────────────────────────────────────────────

/**
 * Parses "[type] content" lines from the model's extraction output.
 * @param {string} text
 * @returns {Array<{type: string, content: string, ts: number}>}
 */
function parseExtractionOutput(text) {
    if (!text || text.trim().toUpperCase() === 'NONE') return [];

    const results = [];
    const linePattern = /^\[(fact|relationship|preference|event)\]\s+(.+)$/gim;
    let match;

    while ((match = linePattern.exec(text)) !== null) {
        const type = match[1].toLowerCase();
        const content = match[2].trim();
        if (MEMORY_TYPES.includes(type) && content.length > 5) {
            results.push({ type, content, ts: Date.now() });
        }
    }

    return results;
}

/**
 * Deduplicates and limits new memories against existing ones.
 * Simple string-similarity check: skip if content is >70% word-overlap with an existing memory.
 * @param {Array} existing
 * @param {Array} incoming
 * @param {number} maxTotal
 * @returns {Array}
 */
function mergeMemories(existing, incoming, maxTotal) {
    const merged = [...existing];

    for (const mem of incoming) {
        const newWords = new Set(mem.content.toLowerCase().split(/\s+/));
        const isDuplicate = merged.some(ex => {
            const exWords = new Set(ex.content.toLowerCase().split(/\s+/));
            const intersection = [...newWords].filter(w => exWords.has(w)).length;
            const union = new Set([...newWords, ...exWords]).size;
            return intersection / union > 0.7;
        });

        if (!isDuplicate) {
            merged.push(mem);
        }
    }

    // Trim to max, keeping most recent
    if (merged.length > maxTotal) {
        merged.splice(0, merged.length - maxTotal);
    }

    return merged;
}

/**
 * Extracts memorable facts from recent chat messages and merges them
 * into the character's stored memories. Fire-and-forget safe.
 * @param {string} characterName
 * @param {Array} recentMessages  - last N message objects
 * @returns {Promise<void>}
 */
export async function extractAndStoreMemories(characterName, recentMessages) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.longterm_enabled || !characterName) return 0;

    try {
        const chatHistory = recentMessages
            .filter(m => m.mes && !m.is_system)
            .map(m => `${m.name}: ${m.mes}`)
            .join('\n\n');

        if (!chatHistory.trim()) return 0;

        const existingMemories = loadCharacterMemories(characterName);
        const existingText = formatMemoriesForPrompt(existingMemories);

        const response = await generateRaw({
            prompt: buildExtractionPrompt(chatHistory, existingText),
            systemPrompt: EXTRACTION_SYSTEM_PROMPT,
            quietToLoud: false,
            responseLength: settings.longterm_response_length || 600,
        });

        console.log(`[SmartMemory] Raw extraction response for "${characterName}":`, response);

        if (!response || response.trim().toUpperCase() === 'NONE') return 0;

        const newMemories = parseExtractionOutput(response);
        if (newMemories.length === 0) {
            console.log('[SmartMemory] No parseable memories in response. Check format above.');
            return 0;
        }

        const maxMemories = settings.longterm_max_memories || 25;
        const merged = mergeMemories(existingMemories, newMemories, maxMemories);
        saveCharacterMemories(characterName, merged);

        console.log(`[SmartMemory] Saved ${newMemories.length} new memories for "${characterName}". Total: ${merged.length}`);
        return newMemories.length;
    } catch (err) {
        console.error('[SmartMemory] Memory extraction failed:', err);
        return 0;
    }
}

// ─── Injection ────────────────────────────────────────────────────────────────

/**
 * Injects the character's stored memories into the prompt.
 * If freshStart is true or no memories exist, clears the injection.
 * @param {string} characterName
 * @param {boolean} freshStart
 */
export function injectMemories(characterName, freshStart = false) {
    const settings = extension_settings[MODULE_NAME];

    if (!settings.longterm_enabled || freshStart || !characterName) {
        setExtensionPrompt(PROMPT_KEY_LONG, '', extension_prompt_types.NONE, 0);
        return;
    }

    const memories = loadCharacterMemories(characterName);
    if (memories.length === 0) {
        setExtensionPrompt(PROMPT_KEY_LONG, '', extension_prompt_types.NONE, 0);
        return;
    }

    const memoryText = formatMemoriesForPrompt(memories);
    const template = settings.longterm_template || '[Memories from previous conversations:\n{{memories}}]';
    const content = template.replace('{{memories}}', memoryText);

    setExtensionPrompt(
        PROMPT_KEY_LONG,
        content,
        settings.longterm_position ?? extension_prompt_types.IN_PROMPT,
        settings.longterm_depth ?? 2,
        false,
        settings.longterm_role ?? extension_prompt_roles.SYSTEM,
    );
}

// ─── Fresh-start helpers ──────────────────────────────────────────────────────

/**
 * Returns whether the current chat has fresh-start enabled.
 * @returns {boolean}
 */
export function isFreshStart() {
    const context = getContext();
    return context.chatMetadata?.[META_KEY]?.freshStart === true;
}

/**
 * Toggles the fresh-start flag for the current chat and saves metadata.
 * @param {boolean} value
 */
export async function setFreshStart(value) {
    const context = getContext();
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    context.chatMetadata[META_KEY].freshStart = value;
    await context.saveMetadata();
}
