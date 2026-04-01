/**
 * Story arc tracking — open plot threads stored in chatMetadata.
 *
 * Tracks unresolved narrative threads: promises made, tensions established,
 * character goals, mysteries introduced. Injected as a lightweight
 * "Active story threads" block to keep the AI oriented toward where the
 * story is going rather than just reacting to the last message.
 */

import { generateRaw, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, PROMPT_KEY_ARCS } from './constants.js';
import { ARC_EXTRACTION_SYSTEM, buildArcExtractionPrompt } from './prompts.js';

// ─── Storage ──────────────────────────────────────────────────────────────────

export function loadArcs() {
    const context = getContext();
    return context.chatMetadata?.[META_KEY]?.storyArcs ?? [];
}

export async function saveArcs(arcs) {
    const context = getContext();
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    context.chatMetadata[META_KEY].storyArcs = arcs;
    await context.saveMetadata();
}

export async function deleteArc(index) {
    const arcs = loadArcs();
    arcs.splice(index, 1);
    await saveArcs(arcs);
}

export async function clearArcs() {
    const context = getContext();
    if (context.chatMetadata?.[META_KEY]) {
        context.chatMetadata[META_KEY].storyArcs = [];
        await context.saveMetadata();
    }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function parseArcOutput(text, existingArcs) {
    if (!text || text.trim().toUpperCase() === 'NONE') return { add: [], resolve: [] };

    const toAdd = [];
    const toResolve = [];

    const addPattern = /^\[arc\]\s+(.+)$/gim;
    const resolvedPattern = /^\[resolved\]\s+(.+)$/gim;

    let match;
    while ((match = addPattern.exec(text)) !== null) {
        const content = match[1].trim();
        if (content.length > 5) toAdd.push({ content, ts: Date.now() });
    }

    while ((match = resolvedPattern.exec(text)) !== null) {
        const resolvedText = match[1].trim().toLowerCase();
        // Match against existing arcs by keyword overlap
        existingArcs.forEach((arc, idx) => {
            const arcWords = arc.content.toLowerCase().split(/\s+/);
            const resolvedWords = resolvedText.split(/\s+/);
            const overlap = arcWords.filter(w => resolvedWords.includes(w)).length;
            if (overlap >= 2) toResolve.push(idx);
        });
    }

    return { add: toAdd, resolve: [...new Set(toResolve)] };
}

// ─── Extraction ───────────────────────────────────────────────────────────────

/**
 * Extracts story arcs from the conversation and updates chatMetadata.
 * Returns count of new arcs added.
 * @param {Array} messages
 * @returns {Promise<number>}
 */
export async function extractArcs(messages) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.arcs_enabled) return 0;

    try {
        const chatHistory = messages
            .filter(m => m.mes && !m.is_system)
            .map(m => `${m.name}: ${m.mes}`)
            .join('\n\n');

        if (!chatHistory.trim()) return 0;

        const existing = loadArcs();
        const existingText = existing.map(a => `[arc] ${a.content}`).join('\n');

        const response = await generateRaw({
            prompt: buildArcExtractionPrompt(chatHistory, existingText),
            systemPrompt: ARC_EXTRACTION_SYSTEM,
            quietToLoud: false,
            responseLength: settings.arcs_response_length ?? 400,
        });

        console.log('[SmartMemory] Arc extraction response:', response);

        if (!response || response.trim().toUpperCase() === 'NONE') return 0;

        const { add, resolve } = parseArcOutput(response, existing);

        // Remove resolved arcs (in reverse order to preserve indices)
        const afterResolve = existing.filter((_, i) => !resolve.includes(i));

        // Add new arcs, respect max
        const max = settings.arcs_max ?? 10;
        const merged = [...afterResolve, ...add].slice(-max);

        await saveArcs(merged);
        return add.length;
    } catch (err) {
        console.error('[SmartMemory] Arc extraction failed:', err);
        return 0;
    }
}

// ─── Injection ────────────────────────────────────────────────────────────────

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

    const text = arcs.map(a => `• ${a.content}`).join('\n');
    const content = `[Active story threads:\n${text}]`;

    setExtensionPrompt(
        PROMPT_KEY_ARCS,
        content,
        settings.arcs_position ?? extension_prompt_types.IN_PROMPT,
        settings.arcs_depth ?? 1,
        false,
        settings.arcs_role ?? extension_prompt_roles.SYSTEM,
    );
}
