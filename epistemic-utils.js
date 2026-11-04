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
 * Pure helpers for chat-scoped epistemic (Perspectives & Secrets) storage.
 *
 * Kept apart from epistemic.js so the storage-isolation rules can be unit
 * tested under plain Node without loading SillyTavern's runtime modules.
 *
 * resolveChatEpistemic - reads a chat's epistemic entries, migrating a legacy
 *   per-character global store into the chat exactly once.
 */

/**
 * Resolves the chat-scoped epistemic entries for a chat metadata block.
 *
 * If the metadata block already holds an `epistemic_knowledge` array (even an
 * empty one) that is authoritative and no legacy data is copied - this is what
 * keeps two chats with the same character from cross-contaminating secrets.
 * Only when the chat has no chat-scoped store at all is a non-empty legacy
 * array migrated in (mutating the block in place).
 *
 * @param {Object|null|undefined} meta - The chatMetadata[META_KEY] block (mutated on migration).
 * @param {Array<Object>|null|undefined} legacyEntries - Legacy global entries for the character.
 * @returns {{ entries: Array<Object>, migrated: boolean }}
 */
export function resolveChatEpistemic(meta, legacyEntries) {
  if (meta && typeof meta === 'object' && Array.isArray(meta.epistemic_knowledge)) {
    return { entries: meta.epistemic_knowledge, migrated: false };
  }

  if (Array.isArray(legacyEntries) && legacyEntries.length > 0) {
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      meta.epistemic_knowledge = legacyEntries.map((entry) => ({ ...entry }));
      return { entries: meta.epistemic_knowledge, migrated: true };
    }
  }

  return { entries: [], migrated: false };
}
