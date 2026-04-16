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
 * reconcileEntityRegistry      - repairs entity registry links after memories are replaced (e.g. post-consolidation)
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

/**
 * Parses a raw entity token from the extraction output into a name and an
 * optional pre-classified type. Tokens may be plain names ("Alex") or
 * name/type pairs ("Alex/character") when the model provides classification.
 *
 * @param {string} token - Raw token string from _raw_entity_names.
 * @returns {{name: string, classifiedType: string|null}}
 */
function parseEntityToken(token) {
  const slashIdx = token.indexOf('/');
  if (slashIdx < 0) return { name: token, classifiedType: null };
  const name = token.slice(0, slashIdx).trim();
  const type = token
    .slice(slashIdx + 1)
    .trim()
    .toLowerCase();
  const VALID_TYPES = ['character', 'place', 'object', 'faction', 'concept'];
  return { name, classifiedType: VALID_TYPES.includes(type) ? type : null };
}

function upsertEntity(rawName, memoryId, messageIndex, registry, classifiedType = null) {
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

  // New entity. Use the model-provided type when available; default to
  // 'character' when the model omitted the classification - it is the most
  // common entity type in RP and no keyword heuristic can reliably infer
  // type from made-up or scenario-specific names.
  const entity = {
    id: generateMemoryId(),
    name: rawName,
    type: classifiedType ?? 'character',
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
    .map((n) => {
      const { name, classifiedType } = parseEntityToken(n.trim());
      return upsertEntity(name, mem.id, messageIndex, registry, classifiedType);
    });

  mem.entities = ids;
  delete mem._raw_entity_names;
}

// ---- Entity registry reconciliation ----------------------------------------

/**
 * Repairs entity registry links after memory IDs change (e.g. after consolidation
 * replaces old memories with new ones that have fresh IDs).
 *
 * Two-pass repair:
 * 1. Prune - remove any memory_ids in the registry that no longer exist in the
 *    current memory list (stale refs from memories that were replaced).
 * 2. Re-link - for each entity, scan current memories whose content contains the
 *    entity's canonical name or any of its aliases, and add those memory IDs.
 *    Also updates the memory's own entities array so both sides stay consistent.
 *
 * Re-linking uses simple substring matching on lowercased content. Names shorter
 * than 3 characters are skipped to avoid spurious matches (e.g. "a", "an").
 *
 * Mutates the registry and memory objects in place. Caller is responsible for
 * persisting both the registry and the memories after this call.
 *
 * @param {Array<Object>} entityRegistry - Entity registry to repair (mutated in place).
 * @param {Array<Object>} currentMemories - Current full memory list (mutated in place).
 */
export function reconcileEntityRegistry(entityRegistry, currentMemories) {
  if (!Array.isArray(entityRegistry) || entityRegistry.length === 0) return;
  if (!Array.isArray(currentMemories) || currentMemories.length === 0) {
    // No current memories - remove all entity entries (nothing left to link to).
    entityRegistry.splice(0);
    return;
  }

  const currentIdSet = new Set(currentMemories.map((m) => m.id).filter(Boolean));

  for (const entity of entityRegistry) {
    // Pass 1: prune stale IDs.
    entity.memory_ids = (entity.memory_ids ?? []).filter((id) => currentIdSet.has(id));

    // Pass 2: re-link by name/alias substring match.
    const names = [entity.name, ...(entity.aliases ?? [])]
      .map((n) => n.toLowerCase().trim())
      .filter((n) => n.length >= 3);

    if (names.length === 0) continue;

    for (const mem of currentMemories) {
      if (entity.memory_ids.includes(mem.id)) continue; // already linked

      const contentLower = (mem.content ?? '').toLowerCase();
      if (names.some((n) => contentLower.includes(n))) {
        entity.memory_ids.push(mem.id);

        // Keep the memory's own entities array in sync.
        if (!Array.isArray(mem.entities)) mem.entities = [];
        if (!mem.entities.includes(entity.id)) {
          mem.entities.push(entity.id);
        }
      }
    }

    // Update last_seen to the highest valid_from/ts among still-linked memories.
    if (entity.memory_ids.length > 0) {
      const linked = currentMemories.filter((m) => entity.memory_ids.includes(m.id));
      entity.last_seen = Math.max(...linked.map((m) => m.valid_from ?? m.ts ?? 0));
    }
  }

  // Remove any entities that ended up with no linked memories. They contribute
  // nothing to timeline, entity overlap scoring, or the panel display. If the
  // entity reappears in a future extraction it will be re-added via upsertEntity.
  const before = entityRegistry.length;
  entityRegistry.splice(
    0,
    entityRegistry.length,
    ...entityRegistry.filter((e) => e.memory_ids.length > 0),
  );
  if (entityRegistry.length < before) {
    console.log(
      `[SmartMemory] Pruned ${before - entityRegistry.length} entity entries with no linked memories.`,
    );
  }
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
