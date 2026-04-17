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
 * setEntityType                - changes the type of an entity in a registry by id
 * deleteEntityById              - removes an entity from a registry and scrubs its id from all memory entities arrays
 * mergeEntitiesByName          - merges a source entity into a target across both registries; source name becomes an alias
 * seedCharacterEntity          - ensures the active character card name exists in the long-term registry on chat load
 * ensureCharacterMigrated      - runs any pending migration steps for a single character's data container
 * ensureChatMigrated           - runs any pending migration steps for the current chat's data container
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, SCHEMA_VERSION, generateMemoryId } from './constants.js';

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
 * Before comparison, both the query and all stored names are apostrophe-
 * normalised: typographic apostrophes (U+2019 RIGHT SINGLE QUOTATION MARK)
 * and Unicode modifier letter apostrophe (U+02BC) are collapsed to a plain
 * ASCII apostrophe so "Jack Daniel\u2019s" matches "Jack Daniel's".
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
function normaliseApostrophes(str) {
  return str.replace(/[\u2019\u02BC]/g, "'");
}

function findEntityByName(rawName, registry) {
  const lower = normaliseApostrophes(rawName).toLowerCase().trim();
  return (
    registry.find(
      (e) =>
        normaliseApostrophes(e.name).toLowerCase() === lower ||
        (e.aliases ?? []).some((a) => normaliseApostrophes(a).toLowerCase() === lower),
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

  // New entity. Use the model-provided type when available; fall back to
  // 'unknown' rather than 'character' so the user can see at a glance which
  // entries the model failed to classify, and correct them if needed.
  const entity = {
    id: generateMemoryId(),
    name: rawName,
    type: classifiedType ?? 'unknown',
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
      const linkedByName = names.some((n) => contentLower.includes(n));
      // Also check the memory's own entities array. A consolidated memory may
      // use pronouns ("she") instead of the entity's name - content substring
      // matching would miss it, but reconcileTypeEntries carries the base
      // entry's entities array forward so the ID is already present.
      const linkedById = Array.isArray(mem.entities) && mem.entities.includes(entity.id);

      if (linkedByName || linkedById) {
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

// ---- Entity type override ---------------------------------------------------

/**
 * Changes the type of an entity in the given registry, identified by id.
 * Mutates the registry in place. Caller is responsible for persisting.
 *
 * @param {string} entityId - The entity's stable UUID.
 * @param {string} newType  - New type string (character|place|object|faction|concept|unknown).
 * @param {Array<Object>} registry - Registry to update (mutated in place).
 */
export function setEntityType(entityId, newType, registry) {
  const entity = registry.find((e) => e.id === entityId);
  if (entity) entity.type = newType;
}

// ---- Entity delete ----------------------------------------------------------

/**
 * Removes an entity from the registry and scrubs its id from every memory's
 * entities array. Does nothing if the id is not found.
 *
 * Mutates both arrays in place. Caller is responsible for persisting.
 *
 * @param {string} entityId - UUID of the entity to remove.
 * @param {Array<Object>} registry - Entity registry array (mutated in place).
 * @param {Array<Object>} memories - Memory array whose entity refs are cleaned up (mutated in place).
 */
export function deleteEntityById(entityId, registry, memories) {
  const idx = registry.findIndex((e) => e.id === entityId);
  if (idx < 0) return;
  registry.splice(idx, 1);
  for (const mem of memories) {
    if (!Array.isArray(mem.entities)) continue;
    const mIdx = mem.entities.indexOf(entityId);
    if (mIdx >= 0) mem.entities.splice(mIdx, 1);
  }
}

// ---- Entity merge -----------------------------------------------------------

/**
 * Merges a source entity into a target entity within a single registry.
 * After the merge:
 * - The source's canonical name and all its aliases are added to the target's
 *   alias list. Future extractions that mention the source name will resolve
 *   to the target entity automatically via the alias lookup in findEntityByName.
 * - All memory_ids from the source are moved to the target (deduplicated).
 * - Every memory in the supplied memories array that referenced the source id
 *   is updated to reference the target id instead.
 * - The source entity is removed from the registry.
 *
 * Both sourceId and targetId must exist in the registry. Mutates the registry
 * and memories arrays in place. Caller is responsible for persisting both.
 *
 * @param {string} sourceId  - UUID of the entity to absorb (will be removed).
 * @param {string} targetId  - UUID of the entity to keep (will gain aliases).
 * @param {Array<Object>} registry - Entity registry array (mutated in place).
 * @param {Array<Object>} memories - Memory array to update entity refs in (mutated in place).
 */
function mergeInRegistry(sourceId, targetId, registry, memories) {
  const sourceIdx = registry.findIndex((e) => e.id === sourceId);
  const target = registry.find((e) => e.id === targetId);
  if (sourceIdx < 0 || !target) return;

  const source = registry[sourceIdx];

  // Absorb source name and aliases into target aliases.
  const newAliases = [source.name, ...(source.aliases ?? [])];
  if (!Array.isArray(target.aliases)) target.aliases = [];
  for (const alias of newAliases) {
    const lower = alias.toLowerCase().trim();
    const alreadyKnown =
      target.name.toLowerCase() === lower ||
      target.aliases.some((a) => a.toLowerCase().trim() === lower);
    if (!alreadyKnown) target.aliases.push(alias);
  }

  // Move memory_ids.
  for (const id of source.memory_ids ?? []) {
    if (!target.memory_ids.includes(id)) target.memory_ids.push(id);
  }

  // Advance last_seen.
  target.last_seen = Math.max(target.last_seen ?? 0, source.last_seen ?? 0);

  // Rewrite entity refs in the memory array.
  for (const mem of memories) {
    if (!Array.isArray(mem.entities)) continue;
    const idx = mem.entities.indexOf(sourceId);
    if (idx >= 0) {
      mem.entities.splice(idx, 1);
      if (!mem.entities.includes(targetId)) mem.entities.push(targetId);
    }
  }

  // Remove source from registry.
  registry.splice(sourceIdx, 1);
}

/**
 * Merges two entities by canonical name across both the long-term and
 * session-scoped registries. The source name (and its aliases) become aliases
 * on the target entity, so future extractions that mention the source name
 * resolve to the target automatically.
 *
 * Operates on both registries independently: if the source name exists in the
 * lt registry, it is merged into the lt target (creating the target if it only
 * exists in session). Vice-versa for session. In the rare case where target
 * only exists in one registry and source only exists in the other, the source
 * entity is renamed to the target name and the canonical name is updated.
 *
 * Mutates all four arrays in place. Caller is responsible for persisting.
 *
 * @param {string} sourceName   - Canonical name of the entity to absorb.
 * @param {string} targetName   - Canonical name of the entity to keep.
 * @param {Array<Object>} ltRegistry       - Long-term entity registry (mutated).
 * @param {Array<Object>} ltMemories       - Long-term memory array (mutated).
 * @param {Array<Object>} sessionRegistry  - Session entity registry (mutated).
 * @param {Array<Object>} sessionMemories  - Session memory array (mutated).
 */
export function mergeEntitiesByName(
  sourceName,
  targetName,
  ltRegistry,
  ltMemories,
  sessionRegistry,
  sessionMemories,
) {
  const sLower = sourceName.toLowerCase().trim();
  const tLower = targetName.toLowerCase().trim();
  if (sLower === tLower) return; // nothing to do

  for (const [registry, memories] of [
    [ltRegistry, ltMemories],
    [sessionRegistry, sessionMemories],
  ]) {
    const source = registry.find(
      (e) =>
        e.name.toLowerCase() === sLower ||
        (e.aliases ?? []).some((a) => a.toLowerCase() === sLower),
    );
    if (!source) continue;

    const target = registry.find(
      (e) =>
        e.id !== source.id &&
        (e.name.toLowerCase() === tLower ||
          (e.aliases ?? []).some((a) => a.toLowerCase() === tLower)),
    );

    if (target) {
      // Both exist in this registry - standard merge.
      mergeInRegistry(source.id, target.id, registry, memories);
    } else {
      // Source exists but target does not - rename source to the target name,
      // keeping the old name as an alias so it is still recognised.
      const oldName = source.name;
      source.name = targetName;
      if (!Array.isArray(source.aliases)) source.aliases = [];
      if (!source.aliases.some((a) => a.toLowerCase() === oldName.toLowerCase())) {
        source.aliases.push(oldName);
      }
    }
  }
}

// ---- Character card entity seeding ------------------------------------------

/**
 * Ensures the active character has a seed entity in the long-term registry.
 * Called on chat load / character change so the main character is always
 * present in the registry from the first message, rather than only appearing
 * once the extraction model first tags them.
 *
 * If an entity with this name (or alias) already exists, nothing is changed.
 * Mutates the registry in place. Caller is responsible for persisting.
 *
 * @param {string} characterName - Canonical name from the character card.
 * @param {Array<Object>} registry - Long-term entity registry (mutated in place).
 */
export function seedCharacterEntity(characterName, registry) {
  if (!characterName || !Array.isArray(registry)) return;
  const existing = findEntityByName(characterName, registry);
  if (existing) return; // already present

  registry.push({
    id: generateMemoryId(),
    name: characterName,
    type: 'character',
    aliases: [],
    first_seen: 0,
    last_seen: 0,
    memory_ids: [],
  });
}

// ---- Per-container schema migration ----------------------------------------
//
// Each container (character store, chat block) carries its own schema_version
// field. On load, the stored version is compared against SCHEMA_VERSION and any
// missing steps are applied in sequence. Steps are never removed - old chats
// may be opened at any point in the future.
//
// Adding a new migration:
//   1. Increment SCHEMA_VERSION in constants.js.
//   2. Add a new numbered entry to CHARACTER_MIGRATIONS and/or CHAT_MIGRATIONS
//      below (whichever containers are affected).
//   3. Do not remove any existing entries.
//
// Version 0 is the implicit starting state for all data written by v1.3.0 or
// earlier (before this versioning system existed).

// ---- Step definitions -------------------------------------------------------

/**
 * CHARACTER migration: version 0 -> 1
 *
 * Adds graph fields to every long-term memory and initialises the entity
 * registry. This covers all data written by v1.3.0 and earlier, which shipped
 * without any graph schema fields.
 *
 * @param {Object} charData - Character data object { memories, entities, ... }
 * @returns {Object} Updated character data with schema_version NOT yet set
 *                   (the runner sets it after all steps complete).
 */
function migrateCharacter_v1(charData) {
  const memories = (charData.memories ?? []).map(applyGraphDefaults);
  const entities = Array.isArray(charData.entities) ? charData.entities : [];
  return { ...charData, memories, entities };
}

/**
 * CHAT migration: version 0 -> 1
 *
 * Adds graph fields to every session memory and initialises the session entity
 * registry. Covers all chat data written by v1.3.0 and earlier.
 *
 * @param {Object} chatMeta - chatMetadata[META_KEY] block.
 * @returns {Object} Updated chat meta block with schema_version NOT yet set.
 */
function migrateChat_v1(chatMeta) {
  const sessionMemories = (chatMeta.sessionMemories ?? []).map(applyGraphDefaults);
  const entities = Array.isArray(chatMeta.entities) ? chatMeta.entities : [];
  return { ...chatMeta, sessionMemories, entities };
}

// ---- Step registries --------------------------------------------------------
// Map<version, stepFn> - add new entries here when SCHEMA_VERSION is bumped.

const CHARACTER_MIGRATIONS = new Map([[1, migrateCharacter_v1]]);

const CHAT_MIGRATIONS = new Map([[1, migrateChat_v1]]);

// ---- Migration runner -------------------------------------------------------

/**
 * Applies all pending migration steps to a data container, returning the
 * updated container. If the container is already at SCHEMA_VERSION the
 * original object is returned unchanged.
 *
 * @param {Object} container - Data object with an optional schema_version field.
 * @param {Map<number, Function>} steps - Ordered map of version -> migration fn.
 * @returns {Object} Container with all pending steps applied and schema_version set.
 */
function applyMigrations(container, steps) {
  let version = container.schema_version ?? 0;
  if (version >= SCHEMA_VERSION) return container;

  let current = container;
  while (version < SCHEMA_VERSION) {
    const step = steps.get(version + 1);
    if (step) {
      current = step(current);
      console.log(`[SmartMemory] Applied migration step v${version + 1}.`);
    }
    version++;
  }
  return { ...current, schema_version: SCHEMA_VERSION };
}

// ---- Public API -------------------------------------------------------------

/**
 * Ensures the stored data for a single character is at the current schema
 * version, running any pending migration steps if not.
 *
 * Safe to call on every chat load for the active character - it is a fast
 * no-op when the container is already up to date.
 *
 * Writes the updated container back to extension_settings and calls
 * saveSettingsDebounced() only when migration actually ran.
 *
 * @param {string} characterName
 * @returns {boolean} True if migration ran, false if already up to date.
 */
export function ensureCharacterMigrated(characterName) {
  if (!characterName) return false;
  const settings = extension_settings[MODULE_NAME];
  if (!settings) return false;

  const charData = settings.characters?.[characterName];
  if (!charData) return false;

  if ((charData.schema_version ?? 0) >= SCHEMA_VERSION) return false;

  console.log(
    `[SmartMemory] Migrating character "${characterName}" to schema v${SCHEMA_VERSION}...`,
  );
  const migrated = applyMigrations(charData, CHARACTER_MIGRATIONS);
  if (!settings.characters) settings.characters = {};
  settings.characters[characterName] = migrated;
  saveSettingsDebounced();

  console.log(`[SmartMemory] Character "${characterName}" migration complete.`);
  return true;
}

/**
 * Ensures the chatMetadata block for the current chat is at the current schema
 * version, running any pending migration steps if not.
 *
 * Safe to call on every chat load - it is a fast no-op when the container is
 * already up to date or when no chat is loaded.
 *
 * Writes the updated block back to chatMetadata and calls saveMetadata() only
 * when migration actually ran.
 *
 * @returns {Promise<boolean>} True if migration ran, false if already up to date.
 */
export async function ensureChatMigrated() {
  const context = getContext();
  if (!context.chatMetadata) return false;

  const meta = context.chatMetadata[META_KEY];
  if (!meta) return false;

  if ((meta.schema_version ?? 0) >= SCHEMA_VERSION) return false;

  console.log(`[SmartMemory] Migrating chat data to schema v${SCHEMA_VERSION}...`);
  context.chatMetadata[META_KEY] = applyMigrations(meta, CHAT_MIGRATIONS);
  await context.saveMetadata();

  console.log('[SmartMemory] Chat data migration complete.');
  return true;
}
