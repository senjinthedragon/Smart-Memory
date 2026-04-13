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
 * Graph schema migration and entity registry management.
 *
 * applyGraphDefaults           - non-destructively adds graph fields to a memory object
 * loadCharacterEntityRegistry  - returns the entity registry for a character from extension_settings
 * saveCharacterEntityRegistry  - persists the entity registry for a character
 * loadSessionEntityRegistry    - returns the session-scoped entity registry from chatMetadata
 * saveSessionEntityRegistry    - persists the session-scoped entity registry to chatMetadata
 * runGraphMigration            - one-shot migration pass: assigns IDs and graph fields to all
 *                                existing memories, initialises entity registries, writes version marker
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, GRAPH_SCHEMA_VERSION, generateMemoryId } from './constants.js';

// ---- Graph defaults ---------------------------------------------------------

/**
 * Returns a copy of the given memory object with all graph fields filled in.
 * Existing values are never overwritten - this is a safe defaults pass only.
 *
 * New graph fields added to every memory:
 *   id              - stable UUID, generated fresh if absent
 *   source_messages - chat message ids that evidence this memory (populated going forward)
 *   entities        - entity ids referenced by this memory (populated going forward)
 *   time_scope      - scope level: scene | session | arc | global
 *   valid_from      - message index when this became true (null = unknown)
 *   valid_to        - message index when this stopped being true (null = still current)
 *   supersedes      - ids of memories this replaces
 *   superseded_by   - id of the memory that replaced this one (null = still current)
 *   contradicts     - ids of memories this conflicts with (unresolved)
 *
 * @param {Object} mem - Existing memory object.
 * @returns {Object} New memory object with graph fields applied.
 */
export function applyGraphDefaults(mem) {
  return {
    ...mem,
    id: mem.id ?? generateMemoryId(),
    source_messages: mem.source_messages ?? [],
    entities: mem.entities ?? [],
    time_scope: mem.time_scope ?? 'global',
    valid_from: mem.valid_from ?? null,
    valid_to: mem.valid_to ?? null,
    supersedes: mem.supersedes ?? [],
    superseded_by: mem.superseded_by ?? null,
    contradicts: mem.contradicts ?? [],
  };
}

// ---- Entity registry: long-term (extension_settings) -------------------------

/**
 * Returns the entity registry for a character from extension_settings.
 * Returns an empty array if no registry exists yet.
 *
 * Entity objects follow the schema from MEMORY_GRAPH.md section 1.2:
 *   { id, name, type, aliases, first_seen, last_seen, memory_ids }
 *
 * @param {string} characterName
 * @returns {Array<Object>}
 */
export function loadCharacterEntityRegistry(characterName) {
  if (!characterName) return [];
  return extension_settings[MODULE_NAME]?.characters?.[characterName]?.entities ?? [];
}

/**
 * Persists the entity registry for a character into extension_settings.
 * Merges with the existing character object so the memories array and other
 * fields are not overwritten.
 *
 * Caller must call saveSettingsDebounced() afterwards if not doing so already.
 *
 * @param {string} characterName
 * @param {Array<Object>} entities
 */
export function saveCharacterEntityRegistry(characterName, entities) {
  if (!characterName || !Array.isArray(entities)) return;
  if (!extension_settings[MODULE_NAME].characters) {
    extension_settings[MODULE_NAME].characters = {};
  }
  const existing = extension_settings[MODULE_NAME].characters[characterName] ?? {};
  extension_settings[MODULE_NAME].characters[characterName] = {
    ...existing,
    entities,
  };
}

// ---- Entity registry: session-scoped (chatMetadata) -------------------------

/**
 * Returns the session-scoped entity registry from chatMetadata for the
 * current chat. Returns an empty array if none exists yet.
 *
 * @returns {Array<Object>}
 */
export function loadSessionEntityRegistry() {
  const context = getContext();
  return context.chatMetadata?.[META_KEY]?.entities ?? [];
}

/**
 * Persists the session-scoped entity registry to chatMetadata.
 * Does not call saveMetadata() - caller is responsible for that.
 *
 * @param {Array<Object>} entities
 * @returns {Promise<void>}
 */
export async function saveSessionEntityRegistry(entities) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].entities = entities;
  await context.saveMetadata();
}

// ---- One-shot migration pass -----------------------------------------------

/**
 * Runs the graph schema migration if it has not yet been applied.
 *
 * Checks extension_settings.smart_memory.graph_schema_version against the
 * current GRAPH_SCHEMA_VERSION constant. If absent or lower, performs:
 *   1. Assigns a stable UUID id to every long-term memory that lacks one.
 *   2. Adds all remaining graph fields (source_messages, entities, time_scope,
 *      valid_from, valid_to, supersedes, superseded_by, contradicts) with safe
 *      defaults. Existing fields are never overwritten.
 *   3. Does the same for session memories in the current chat (if any).
 *   4. Initialises an empty entity registry for each character and for the
 *      current session if no registry exists yet.
 *   5. Writes the GRAPH_SCHEMA_VERSION marker to extension_settings and saves.
 *
 * Migration is non-destructive - no memories are deleted or altered beyond
 * receiving new fields. Safe to call on every chat load; it is a fast no-op
 * once the version marker is set.
 *
 * @returns {Promise<boolean>} True if migration ran, false if already up to date.
 */
export async function runGraphMigration() {
  const settings = extension_settings[MODULE_NAME];
  if (!settings) return false;

  if ((settings.graph_schema_version ?? 0) >= GRAPH_SCHEMA_VERSION) return false;

  console.log('[SmartMemory] Running graph schema migration to v' + GRAPH_SCHEMA_VERSION + '...');

  // --- Migrate all long-term character memories ----------------------------
  const characters = settings.characters ?? {};
  for (const [name, charData] of Object.entries(characters)) {
    if (!Array.isArray(charData?.memories)) continue;

    const migrated = charData.memories.map(applyGraphDefaults);
    // Initialise an empty entity registry for this character if none exists.
    const entities = Array.isArray(charData.entities) ? charData.entities : [];

    settings.characters[name] = {
      ...charData,
      memories: migrated,
      entities,
    };
  }

  // --- Migrate current session memories ------------------------------------
  // Only runs when a chat is actually loaded. On first load before any chat
  // is opened this block is skipped cleanly; session memories are migrated
  // via applyGraphDefaults in loadSessionMemories on the first access.
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]?.sessionMemories) {
    context.chatMetadata[META_KEY].sessionMemories =
      context.chatMetadata[META_KEY].sessionMemories.map(applyGraphDefaults);

    // Initialise session entity registry if not already present.
    if (!Array.isArray(context.chatMetadata[META_KEY].entities)) {
      context.chatMetadata[META_KEY].entities = [];
    }

    await context.saveMetadata();
  }

  // --- Write version marker and persist settings ---------------------------
  settings.graph_schema_version = GRAPH_SCHEMA_VERSION;
  saveSettingsDebounced();

  console.log('[SmartMemory] Graph migration complete.');
  return true;
}
