/**
 * Smart Memory - SillyTavern Extension (fork: badiyee85/Smart-Memory)
 *
 * Memory scope core - pure storage resolution for per-chat isolation.
 *
 * Upstream Smart Memory stores every long-term tier (memories, relationship
 * history, canon, persistent arcs, epistemic knowledge, entity registry) in a
 * single per-character container inside extension_settings, shared across all
 * chats with the same character. This module adds an optional per-chat scope:
 *
 *   scope 'character' (default) -> characters[characterName]
 *   scope 'chat'                -> characters[characterName].chats[chatId]
 *
 * This file is intentionally free of SillyTavern imports so it can run under
 * `node --test` (same convention as similarity.js / memory-utils.js).
 */

export const MEMORY_SCOPE_CHARACTER = 'character';
export const MEMORY_SCOPE_CHAT = 'chat';

/** Long-term tier fields stored on the character container. */
export const CHARACTER_TIER_KEYS = [
  'memories',
  'relationship_history',
  'canon',
  'persistent_arcs',
  'epistemic_knowledge',
  'entities',
];

/** Long-term tier fields stored on the group container. */
export const GROUP_TIER_KEYS = ['persistent_arcs'];

/**
 * Returns true when a container holds any non-empty tier data.
 * A freshly created chat container is treated as empty.
 *
 * @param {Object} container
 * @param {string[]} [keys] - Tier keys to inspect.
 * @returns {boolean}
 */
export function containerHasData(container, keys = CHARACTER_TIER_KEYS) {
  if (!container || typeof container !== 'object') return false;
  return keys.some((key) => {
    const value = container[key];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
  });
}

/**
 * Returns the storage container for a character (or group) under the given
 * scope. In chat scope the container is nested under `.chats[chatId]` so each
 * chat gets its own isolated long-term tiers. When no chat id is available
 * (or scope is character), the top-level container is returned.
 *
 * Containers are created on demand. New chat containers are stamped with the
 * current schema version so the migration runner treats them as up to date.
 *
 * @param {Object} store - The `characters` (or `group_arcs`) map from extension_settings.
 * @param {string} name - Character name or group id.
 * @param {string|null} chatId - Current chat id (from getCurrentChatId()).
 * @param {string} scope - MEMORY_SCOPE_CHARACTER or MEMORY_SCOPE_CHAT.
 * @param {number} [schemaVersion] - Schema version to stamp on newly created chat containers.
 * @returns {Object|null} The container, or null when name is falsy.
 */
export function getScopedContainer(store, name, chatId, scope, schemaVersion) {
  if (!name) return null;
  if (!store[name]) store[name] = {};
  const base = store[name];
  if (scope !== MEMORY_SCOPE_CHAT || chatId == null) return base;
  if (!base.chats) base.chats = {};
  if (!base.chats[chatId]) {
    base.chats[chatId] = {};
    if (schemaVersion != null) base.chats[chatId].schema_version = schemaVersion;
  }
  return base.chats[chatId];
}

/**
 * Deletes the storage container for a character (or group) under the given
 * scope. In chat scope only the current chat's nested container is removed;
 * the character-level data is left untouched. In character scope the whole
 * entry is removed (upstream behaviour).
 *
 * @param {Object} store - The `characters` (or `group_arcs`) map from extension_settings.
 * @param {string} name - Character name or group id.
 * @param {string|null} chatId - Current chat id (from getCurrentChatId()).
 * @param {string} scope - MEMORY_SCOPE_CHARACTER or MEMORY_SCOPE_CHAT.
 */
export function deleteScopedContainer(store, name, chatId, scope) {
  if (!name || !store[name]) return;
  if (scope !== MEMORY_SCOPE_CHAT || chatId == null) {
    delete store[name];
    return;
  }
  const base = store[name];
  if (base.chats) {
    delete base.chats[chatId];
    if (Object.keys(base.chats).length === 0) delete base.chats;
  }
}

// ---- Chat-scope pinning (long-running jobs) ---------------------------------
//
// Memorize Chat and similar multi-chunk jobs can run for minutes while the
// user switches to another chat. Without pinning, the per-chat namespace
// resolves at write time and would silently land in the wrong chat. Jobs pin
// the chat id they started on for their whole duration.
let pinnedChatId = null;
let pinDepth = 0;

/**
 * Pins the chat scope to a specific chat id for the duration of a job.
 * Nested pins keep the outer (job-origin) chat id.
 * @param {string|number|null} chatId
 */
export function pinChatScope(chatId) {
  if (pinDepth === 0) pinnedChatId = chatId == null ? null : String(chatId);
  pinDepth++;
}

/**
 * Releases one pin level. The pin is cleared only when the outermost job ends.
 */
export function unpinChatScope() {
  pinDepth = Math.max(0, pinDepth - 1);
  if (pinDepth === 0) pinnedChatId = null;
}

/**
 * Resolves the effective chat id: the pinned id when a job is running,
 * otherwise the live chat id.
 * @param {string|number|null} liveChatId
 * @returns {string|null}
 */
export function resolveChatScopeId(liveChatId) {
  if (pinnedChatId != null) return pinnedChatId;
  return liveChatId == null ? null : String(liveChatId);
}

/**
 * Seeds a chat-scoped container from its top-level container. Used when the
 * user switches memory scope from 'character' to 'chat' so the current chat
 * keeps its accumulated long-term memory while new chats still start clean.
 *
 * Deep-copies tier data. No-op when the chat container already has data or
 * when there is nothing to copy.
 *
 * @param {Object} store - The `characters` (or `group_arcs`) map from extension_settings.
 * @param {string} name - Character name or group id.
 * @param {string|null} chatId - Current chat id (from getCurrentChatId()).
 * @param {number} [schemaVersion] - Schema version to stamp on the seeded container.
 * @param {string[]} [keys] - Tier keys to copy.
 * @returns {boolean} True when at least one tier was copied.
 */
export function seedScopedContainer(
  store,
  name,
  chatId,
  schemaVersion,
  keys = CHARACTER_TIER_KEYS,
) {
  if (!name || chatId == null || !store[name]) return false;
  const base = store[name];
  const scoped = getScopedContainer(store, name, chatId, MEMORY_SCOPE_CHAT, schemaVersion);
  if (containerHasData(scoped, keys)) return false;

  let copied = false;
  for (const key of keys) {
    if (base[key] !== undefined && base[key] !== null) {
      scoped[key] = JSON.parse(JSON.stringify(base[key]));
      copied = true;
    }
  }
  if (schemaVersion != null) scoped.schema_version = schemaVersion;
  return copied;
}
