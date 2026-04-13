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
 * Shared constants and utilities used across all modules.
 *
 * Defines the extension/module name, chatMetadata key, setExtensionPrompt
 * injection keys, and the valid memory type enums for both long-term and
 * session memory. Also exports estimateTokens for injection budget checks
 * and generateMemoryId for stable UUID assignment.
 */

/** Extension name as registered in extension_settings. */
export const MODULE_NAME = 'smart_memory';

/** Directory name used for template loading. */
export const EXT_DIR = 'Smart-Memory';

// Keys passed to setExtensionPrompt - each tier has its own named slot.
export const PROMPT_KEY_SHORT = 'smart_memory_short';
export const PROMPT_KEY_LONG = 'smart_memory_long';
export const PROMPT_KEY_SESSION = 'smart_memory_session';
export const PROMPT_KEY_SCENES = 'smart_memory_scenes';
export const PROMPT_KEY_ARCS = 'smart_memory_arcs';
// One-shot corrective note injected after a continuity check finds contradictions.
// Cleared automatically after the next AI response is rendered.
export const PROMPT_KEY_REPAIR = 'smart_memory_repair';
// Stateful character/world profiles regenerated from graph state.
export const PROMPT_KEY_PROFILES = 'smart_memory_profiles';

/** Valid type tags for long-term memory entries. */
export const MEMORY_TYPES = ['fact', 'relationship', 'preference', 'event'];

/** Valid type tags for session memory entries. */
export const SESSION_TYPES = ['scene', 'revelation', 'development', 'detail'];

/** Top-level key under chatMetadata where all per-chat state is stored. */
export const META_KEY = 'smartMemory';

/**
 * Graph schema version stored in extension_settings.smart_memory.graph_schema_version.
 * The migration pass in graph-migration.js runs once when the stored version is
 * absent or lower than this value, then sets this value to mark completion.
 */
export const GRAPH_SCHEMA_VERSION = 1;

/**
 * Rough token estimate for a string. Uses the standard ~4 chars-per-token
 * heuristic - accurate enough for budget enforcement without needing an async
 * tokenizer call.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil((text?.length ?? 0) / 4);
}

/**
 * Generates a stable UUID v4 for a new memory entry.
 * Uses crypto.randomUUID() when available (all modern browsers), with a
 * Math.random()-based fallback for environments that lack it.
 * @returns {string} UUID v4 string.
 */
export function generateMemoryId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: RFC 4122-compliant v4 UUID via Math.random().
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
