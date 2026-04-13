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
 * clearSessionEntityRegistry   - empties the session-scoped entity registry in chatMetadata
 * resolveEntityNames           - maps raw extracted name strings to entity ids, upserting new entities
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

/**
 * Empties the session-scoped entity registry from chatMetadata.
 * Should be called alongside clearSessionMemories() so entity ids do not
 * refer to memories that no longer exist after a chat clear.
 */
export async function clearSessionEntityRegistry() {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    context.chatMetadata[META_KEY].entities = [];
    await context.saveMetadata();
  }
}

// ---- Entity normalizer ------------------------------------------------------

/**
 * Looks up an entity in the registry by name.
 *
 * Matching priority:
 * 1. Case-insensitive exact match against the canonical name.
 * 2. Case-insensitive exact match against any recorded alias.
 *
 * Fuzzy matching is intentionally not used here - entity names are short and
 * near-exact matches are likely coincidental rather than genuine aliases
 * (e.g. "Alex" and "Alexa" should not collapse automatically). Alias
 * accumulation over time handles genuine variant spellings organically.
 *
 * @param {string} rawName - Name as it appeared in the extraction output.
 * @param {Array<Object>} registry - Current entity registry array.
 * @returns {Object|null} The matching entity, or null if not found.
 */
function findEntityByName(rawName, registry) {
  const lower = rawName.toLowerCase().trim();
  return (
    registry.find(
      (e) =>
        e.name.toLowerCase() === lower || (e.aliases ?? []).some((a) => a.toLowerCase() === lower),
    ) ?? null
  );
}

/**
 * Finds or creates an entity for a raw name, then links the given memory id
 * and message index to it. Mutates the registry in place.
 *
 * If the name matches an existing entity the entity is updated in place:
 * - memoryId is added to memory_ids if not already present.
 * - last_seen is advanced to messageIndex if higher.
 * - The raw name is added to aliases if it differs from the canonical name
 *   and is not already recorded (preserves spelling variants seen in chat).
 *
 * If no match is found a new entity is created with type 'character' as the
 * default. Entity type inference (character vs place vs object vs faction) is
 * planned for a later pass; defaulting to 'character' is correct for the vast
 * majority of names that appear in roleplay extraction output.
 *
 * @param {string} rawName - Name as it appeared in the extraction output.
 * @param {string} memoryId - Stable id of the memory that references this entity.
 * @param {number} messageIndex - Index of the latest message triggering this extraction.
 * @param {Array<Object>} registry - Entity registry array to mutate.
 * @returns {string} The entity id (existing or newly created).
 */
// Keywords that suggest non-character entity types.
const PLACE_PATTERNS =
  /\b(city|town|village|castle|forest|mountain|river|sea|ocean|room|hall|inn|tavern|dungeon|kingdom|realm|world|island|house|building|tower|temple|shrine|camp|cave|ruins|road|street|district|region|country|territory|land|valley|lake|bay|port|market|quarter|website|server|platform|system|network|database|space|station|base|facility|lab|school|hospital|shop|store|office|academy|guild|manor|estate|garden|park)\b/i;
const OBJECT_PATTERNS =
  /\b(sword|blade|staff|wand|ring|amulet|book|scroll|map|key|gem|stone|artifact|relic|device|machine|tool|weapon|shield|armor|helm|cloak|potion|letter|contract|token|seal|orb|crystal|vr|headset|console|app|file|document|report|code|program|system)\b/i;
const FACTION_PATTERNS =
  /\b(guild|order|faction|clan|tribe|army|company|organization|group|party|council|court|empire|union|alliance|brotherhood|sisterhood|cult|church|institution|corporation|team)\b/i;

/**
 * Infers a rough entity type from the raw name string using keyword heuristics.
 * Falls back to 'character' (the most common entity type in RP) when nothing matches.
 *
 * @param {string} name
 * @returns {'character'|'place'|'object'|'faction'|'concept'}
 */
function inferEntityType(name) {
  if (FACTION_PATTERNS.test(name)) return 'faction';
  if (PLACE_PATTERNS.test(name)) return 'place';
  if (OBJECT_PATTERNS.test(name)) return 'object';
  return 'character';
}

function upsertEntity(rawName, memoryId, messageIndex, registry) {
  const existing = findEntityByName(rawName, registry);

  if (existing) {
    if (!existing.memory_ids.includes(memoryId)) {
      existing.memory_ids.push(memoryId);
    }
    existing.last_seen = Math.max(existing.last_seen, messageIndex);

    // Record new spelling variants as aliases.
    const lower = rawName.toLowerCase().trim();
    const alreadyKnown =
      existing.name.toLowerCase() === lower ||
      (existing.aliases ?? []).some((a) => a.toLowerCase() === lower);
    if (!alreadyKnown) {
      existing.aliases = existing.aliases ?? [];
      existing.aliases.push(rawName);
    }

    return existing.id;
  }

  // New entity - infer a rough type from the name. This is a lightweight
  // heuristic; the model does not tag types in the extraction output.
  const entity = {
    id: generateMemoryId(),
    name: rawName,
    type: inferEntityType(rawName),
    aliases: [],
    first_seen: messageIndex,
    last_seen: messageIndex,
    memory_ids: [memoryId],
  };
  registry.push(entity);
  return entity.id;
}

/**
 * Resolves an array of raw entity names extracted from a memory's
 * _raw_entity_names field into entity ids, upserting new entities into the
 * registry as needed.
 *
 * After calling this function:
 * - mem.entities is populated with the resolved ids.
 * - The registry is updated in place (caller is responsible for persisting it).
 * - mem._raw_entity_names is deleted (transient field, not stored).
 *
 * Safe to call with an empty rawNames list - produces no side effects in that case.
 *
 * @param {Object} mem - Memory object (mutated in place).
 * @param {Array<string>} rawNames - Raw entity name strings from _raw_entity_names.
 * @param {number} messageIndex - Message index at extraction time, used for first_seen/last_seen.
 * @param {Array<Object>} registry - Entity registry to upsert into (mutated in place).
 */
export function resolveEntityNames(mem, rawNames, messageIndex, registry) {
  if (!Array.isArray(rawNames) || rawNames.length === 0) {
    delete mem._raw_entity_names;
    return;
  }

  const ids = rawNames
    .filter((n) => n && n.trim().length > 0)
    .map((n) => upsertEntity(n.trim(), mem.id, messageIndex, registry));

  mem.entities = ids;
  delete mem._raw_entity_names;
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
