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
 * Pure entity-registry reconciliation logic.
 *
 * Extracted from graph-migration.js so it carries no SillyTavern runtime
 * imports and can be unit tested directly under Node. graph-migration.js
 * re-exports reconcileEntityRegistry with the same signature and adds logging
 * around this core implementation.
 */

// Generic honorific/title words that must never be used as standalone link
// tokens. Splitting a name like "King Aldric" into single words would otherwise
// let the token "king" match unrelated content such as "Mira is making a
// potion" ("making" contains "king"), or a title like "Lady" match "ladybird".
const HONORIFIC_TITLES = new Set([
  'king',
  'queen',
  'prince',
  'princess',
  'lord',
  'lady',
  'sir',
  'madam',
  'dr',
  'doctor',
  'captain',
  'commander',
  'baron',
  'baroness',
  'duke',
  'duchess',
]);

/**
 * Escapes regular-expression metacharacters in a literal string so it can be
 * embedded in a RegExp built from user/entity-provided text.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Scripts written without inter-word spaces. An ASCII word-boundary regex cannot
// link a CJK/Thai name correctly (there is no \b between two ideographs), so
// those names are matched with a plain substring test instead - reusing the
// Unicode lookaround below would treat every neighbouring ideograph as a word
// character and never link anything.
const CJK_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * Returns true when the name uses a script that is written without spaces
 * between words (Han, Hiragana, Katakana, Hangul, Thai).
 *
 * @param {string} name
 * @returns {boolean}
 */
function isCjkName(name) {
  return CJK_SCRIPT_RE.test(String(name ?? ''));
}

/**
 * Builds a predicate that reports whether `text` mentions `name`.
 *
 * Latin/Cyrillic/Greek/Arabic and other space-delimited scripts use Unicode
 * lookaround boundaries so accented names ("Zoë", "José", "Ødegård") link
 * correctly while "Ann" still never matches "Joanna" and "Eli" never matches
 * "believes". CJK/Thai names use a lowercase substring test because those
 * scripts have no spaces between words.
 *
 * @param {string} name - Already lowercased/trimmed name or alias token.
 * @returns {(text: string) => boolean}
 */
function buildNameMatcher(name) {
  if (isCjkName(name)) {
    const needle = String(name).toLowerCase();
    return (text) =>
      String(text ?? '')
        .toLowerCase()
        .includes(needle);
  }
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'iu');
  return (text) => pattern.test(String(text ?? ''));
}

/**
 * Returns true for an entity seeded from the character card. Seeded characters
 * have no message index yet (first_seen === 0) and must survive registry
 * pruning even before any memory has been linked to them.
 *
 * @param {Object} entity
 * @returns {boolean}
 */
function isSeededCharacter(entity) {
  return entity?.first_seen === 0 && entity?.type === 'character';
}

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
 * Re-linking uses Unicode-aware word-boundary matching on lowercased content so
 * accented and non-Latin scripts ("Zoë", "José", "Ødegård", "Мария") link
 * correctly. CJK/Thai names, which have no inter-word spaces, use substring
 * matching instead and get a lower length floor. Names shorter than 3
 * characters are skipped (2 for CJK), and generic honorific titles ("king",
 * "lady", ...) are never split out of multi-word names, so "King Aldric" cannot
 * link via the substring "king" in "making".
 *
 * When `currentMemories` is empty the registry itself is preserved - only the
 * now-stale memory_ids are cleared. This prevents an empty/consolidation pass
 * from wiping seeded characters and other entities that will be re-linked once
 * memories exist again.
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
    // Nothing to link against yet. Clear stale links but keep the entities
    // themselves - especially seeded character entities with first_seen === 0.
    for (const entity of entityRegistry) {
      entity.memory_ids = [];
    }
    return;
  }

  const currentIdSet = new Set(currentMemories.map((m) => m.id).filter(Boolean));

  for (const entity of entityRegistry) {
    // Pass 1: prune stale IDs.
    entity.memory_ids = (entity.memory_ids ?? []).filter((id) => currentIdSet.has(id));

    // Pass 2: re-link by name/alias word-boundary match.
    // Also include individual words from multi-word names (min 4 chars, minus
    // honorific titles) so "Asher" in content matches the entity "Asher Somel",
    // while "King" in "King Aldric" never matches "making".
    const rawNames = [entity.name, ...(entity.aliases ?? [])].map((n) => n.toLowerCase().trim());
    // CJK/Thai names are dense: two characters is already a full name, whereas a
    // two-letter Latin name ("Eli") is usually a fragment. Use a lower length
    // floor for spaceless scripts so names like "艾拉" are still linkable.
    const meetsMinLength = (n, latinMin) => (isCjkName(n) ? n.length >= 2 : n.length >= latinMin);
    const names = [
      ...new Set([
        ...rawNames.filter((n) => meetsMinLength(n, 3)),
        ...rawNames.flatMap((n) =>
          n.split(/\s+/).filter((w) => meetsMinLength(w, 4) && !HONORIFIC_TITLES.has(w)),
        ),
      ]),
    ];

    if (names.length === 0) continue;

    const nameMatchers = names.map(buildNameMatcher);

    for (const mem of currentMemories) {
      if (entity.memory_ids.includes(mem.id)) continue; // already linked

      const linkedByName = nameMatchers.some((matches) => matches(mem.content));
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

  // Remove entities that ended up with no linked memories - except seeded
  // character entities, which exist before their first memory is extracted and
  // must not disappear just because they have not been tagged yet. If any other
  // entity reappears in a future extraction it will be re-added via upsertEntity.
  entityRegistry.splice(
    0,
    entityRegistry.length,
    ...entityRegistry.filter((e) => (e.memory_ids ?? []).length > 0 || isSeededCharacter(e)),
  );
}
