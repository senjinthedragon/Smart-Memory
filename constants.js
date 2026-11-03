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
 *
 * PROMPT_KEY_TRIGGERED is the secondary IN_CHAT slot used by the activation
 * triggers feature to inject contextually relevant long-term memories closer
 * to the prompt when their trigger keywords appear in the current turn.
 * PROMPT_KEY_RELATIONSHIPS is the slot for persistent relationship state -
 * per-pair emotional deltas accumulated across sessions.
 * PROMPT_KEY_EPISTEMIC is the slot for perspective-scoped knowledge - what
 * each character knows, suspects, believes, or is concealing.
 * PROMPT_KEY_STATE_LEDGER is the slot for structured current-state snapshots
 * of tracked entities (characters, objects, places, factions).
 */

/** Extension name as registered in extension_settings. */
export const MODULE_NAME = 'smart_memory';

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
// Stable per-character narrative document compiled from resolved arc summaries.
export const PROMPT_KEY_CANON = 'smart_memory_canon';
// Single unified block used when unified_injection mode is enabled.
// All individual tier slots are cleared and their content merged here instead.
export const PROMPT_KEY_UNIFIED = 'smart_memory_unified';
// Secondary IN_CHAT slot for long-term memories whose activation triggers match
// the current turn. These are injected closer to the prompt in addition to
// appearing at the end of the main PROMPT_KEY_LONG block.
export const PROMPT_KEY_TRIGGERED = 'smart_memory_triggered';
// Persistent relationship state - per-pair emotional deltas accumulated across
// sessions. Only pairs relevant to the current chat are injected.
export const PROMPT_KEY_RELATIONSHIPS = 'smart_memory_relationships';
// Perspective-scoped knowledge block for the responding character: what they
// know, suspect, believe, and are concealing, extracted at scene breaks.
export const PROMPT_KEY_EPISTEMIC = 'smart_memory_epistemic';
// Structured current-state snapshot for tracked entities (characters, objects,
// places, factions). Extracted and updated each extraction cycle.
export const PROMPT_KEY_STATE_LEDGER = 'smart_memory_state_ledger';

/** Valid type tags for long-term memory entries. */
export const MEMORY_TYPES = ['fact', 'relationship', 'preference', 'event'];

/** Valid type tags for session memory entries. */
export const SESSION_TYPES = ['scene', 'revelation', 'development', 'detail'];

/** Top-level key under chatMetadata where all per-chat state is stored. */
export const META_KEY = 'smartMemory';

/**
 * Current schema version for stored memory data (long-term and session).
 *
 * This value is written into each data container (character store and
 * chatMetadata block) when migration runs. On load, the stored version is
 * compared against this constant and any missing steps are applied in order.
 *
 * Rules:
 * - Bump this value only when a new migration step is added to graph-migration.js.
 * - Do not bump it between releases unless a new migration step ships with the bump.
 * - Migration steps are never removed - old chats may be opened at any point.
 * - Version 0 is the implicit state for any container that has no stored version
 *   (i.e. all data written by v1.3.0 or earlier, before this system existed).
 */
export const SCHEMA_VERSION = 9;

/**
 * Maximum tokens any external generation source is allowed to produce for a
 * memory task. Generous enough that thinking/reasoning models can complete
 * their reasoning block before writing output; finite to prevent runaway
 * generation from a model that never self-terminates.
 */
export const MEMORY_GENERATION_BUDGET = 8192;

/**
 * Maximum number of superseded (retired) entries kept in storage per memory tier.
 * Older retired entries are dropped from the front when the pool exceeds this limit.
 * Keeps storage and the "Show retired" panel manageable when consolidation is disabled.
 */
export const MAX_RETIRED_POOL = 100;

/**
 * Rough token estimate for a string.
 *
 * Uses the standard ~4 chars-per-token heuristic for Latin scripts - accurate
 * enough for budget enforcement without needing an async tokenizer call.
 * Non-Latin scripts (CJK, Thai, Arabic, Devanagari, ...) tokenize far less
 * efficiently (roughly 1.5 tokens per character), so counting them at the
 * Latin rate would badly under-estimate CJK/Arabic prompts. Script runs are
 * counted separately and summed.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // Non-Latin characters (CJK, Thai, Arabic, Devanagari, etc.) tokenize to ~1.5 tokens each.
  // Latin characters average ~0.25 tokens each (4 chars per token).
  const nonLatinMatch = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Devanagari}]/gu,
  );
  const nonLatinCount = nonLatinMatch ? nonLatinMatch.length : 0;
  const latinCount = text.length - nonLatinCount;
  return Math.ceil(nonLatinCount * 1.5 + latinCount / 4);
}

/**
 * Generates a UUID v4 for a new memory entry.
 * Falls back to a manual implementation when crypto.randomUUID() is unavailable
 * (non-secure HTTP contexts accessed from a remote device).
 * @returns {string} UUID v4 string.
 */
export function generateMemoryId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Manual UUID v4 fallback for non-secure contexts.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
