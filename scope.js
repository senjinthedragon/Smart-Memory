/**
 * Smart Memory - SillyTavern Extension (fork: badiyee85/Smart-Memory)
 *
 * Memory scope - live SillyTavern wrappers for per-chat isolation.
 *
 * All long-term tier accessors (longterm.js, canon.js, arcs.js, epistemic.js,
 * graph-migration.js) route through getCharacterContainer() / getGroupContainer()
 * so the rest of the extension is unaware of the scope: injection, extraction,
 * UI, and clear paths automatically read and write the scoped container.
 *
 * Pure resolution logic lives in scope-core.js (unit-testable without ST).
 */

import { getCurrentChatId } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { MODULE_NAME, SCHEMA_VERSION } from './constants.js';
import { smLog } from './logging.js';
import {
  MEMORY_SCOPE_CHARACTER,
  MEMORY_SCOPE_CHAT,
  CHARACTER_TIER_KEYS,
  GROUP_TIER_KEYS,
  getScopedContainer,
  deleteScopedContainer,
  seedScopedContainer,
  resolveChatScopeId,
} from './scope-core.js';

export {
  MEMORY_SCOPE_CHARACTER,
  MEMORY_SCOPE_CHAT,
  pinChatScope,
  unpinChatScope,
} from './scope-core.js';

/**
 * Returns the active memory scope: 'character' (shared across chats) or
 * 'chat' (isolated per chat). Unknown values fall back to 'character'.
 * @returns {string}
 */
export function getMemoryScope() {
  return extension_settings[MODULE_NAME]?.memory_scope === MEMORY_SCOPE_CHAT
    ? MEMORY_SCOPE_CHAT
    : MEMORY_SCOPE_CHARACTER;
}

/**
 * Returns true when per-chat isolation is enabled.
 * @returns {boolean}
 */
export function isPerChatScope() {
  return getMemoryScope() === MEMORY_SCOPE_CHAT;
}

/**
 * Returns the current chat id as a string, or null when no chat id is
 * available (e.g. no chat loaded). A null id falls back to the character
 * container, which is safe and matches upstream behaviour.
 * @returns {string|null}
 */
export function getChatScopeId() {
  return resolveChatScopeId(getCurrentChatId());
}

/**
 * Ensures the extension settings store and characters map exist.
 * @returns {Object} The extension_settings[MODULE_NAME] object.
 */
function ensureStore() {
  if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
  if (!extension_settings[MODULE_NAME].characters) {
    extension_settings[MODULE_NAME].characters = {};
  }
  return extension_settings[MODULE_NAME];
}

/**
 * Returns the storage container for the current scope of a character.
 * In chat scope this is characters[characterName].chats[chatId].
 * @param {string} characterName
 * @returns {Object|null}
 */
export function getCharacterContainer(characterName) {
  const s = ensureStore();
  return getScopedContainer(
    s.characters,
    characterName,
    getChatScopeId(),
    getMemoryScope(),
    SCHEMA_VERSION,
  );
}

/**
 * Deletes the storage container for the current scope of a character.
 * In chat scope only the current chat's container is removed.
 * @param {string} characterName
 */
export function deleteCharacterContainer(characterName) {
  const s = ensureStore();
  deleteScopedContainer(s.characters, characterName, getChatScopeId(), getMemoryScope());
}

/**
 * Returns the storage container for the current scope of a group.
 * In chat scope this is group_arcs[groupId].chats[chatId].
 * @param {string} groupId
 * @returns {Object|null}
 */
export function getGroupContainer(groupId) {
  ensureStore();
  if (!extension_settings[MODULE_NAME].group_arcs) {
    extension_settings[MODULE_NAME].group_arcs = {};
  }
  return getScopedContainer(
    extension_settings[MODULE_NAME].group_arcs,
    groupId,
    getChatScopeId(),
    getMemoryScope(),
    SCHEMA_VERSION,
  );
}

/**
 * Deletes the storage container for the current scope of a group.
 * @param {string} groupId
 */
export function deleteGroupContainer(groupId) {
  ensureStore();
  if (!extension_settings[MODULE_NAME].group_arcs) return;
  deleteScopedContainer(
    extension_settings[MODULE_NAME].group_arcs,
    groupId,
    getChatScopeId(),
    getMemoryScope(),
  );
}

/**
 * Seeds the current chat's scoped container from the character-level store.
 * Called when memory scope switches from 'character' to 'chat' so the ongoing
 * chat keeps its accumulated long-term memory. New chats still start clean.
 *
 * @param {string} characterName
 * @returns {boolean} True when tier data was copied.
 */
export function seedCurrentChatFromCharacter(characterName) {
  if (!isPerChatScope() || !characterName) return false;
  const s = ensureStore();
  const copied = seedScopedContainer(
    s.characters,
    characterName,
    getChatScopeId(),
    SCHEMA_VERSION,
    CHARACTER_TIER_KEYS,
  );
  if (copied) {
    smLog(
      `[SmartMemory] Per-chat scope: seeded current chat from character store for "${characterName}".`,
    );
  }
  return copied;
}

/**
 * Seeds the current chat's scoped container from the group-level store.
 * @param {string} groupId
 * @returns {boolean} True when tier data was copied.
 */
export function seedCurrentChatGroupFromGroup(groupId) {
  if (!isPerChatScope() || !groupId) return false;
  if (!extension_settings[MODULE_NAME].group_arcs) return false;
  const copied = seedScopedContainer(
    extension_settings[MODULE_NAME].group_arcs,
    groupId,
    getChatScopeId(),
    SCHEMA_VERSION,
    GROUP_TIER_KEYS,
  );
  if (copied) {
    smLog(`[SmartMemory] Per-chat scope: seeded current chat from group store for "${groupId}".`);
  }
  return copied;
}
