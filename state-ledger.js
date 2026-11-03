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
 * State Ledger: structured current-state snapshots for tracked entities.
 *
 * Tracks mutable physical/operational state for characters, objects, places,
 * and factions. Stored in chatMetadata (chat-scoped, not persistent across
 * chats). Separate from entity registry objects to avoid clobbering during
 * reconciliation passes - coupled via merge, delete, and type-change handlers.
 *
 * isStateLedgerEnabled        - returns true when the feature is active for the current profile
 * loadStateLedger             - returns the full ledger map from chatMetadata
 * saveStateLedger             - persists the ledger to chatMetadata
 * getStateCard                - returns the fields object for a given entity, or null
 * upsertStateCard             - validates, caps, stamps, merges, and prunes one state card write
 * setStateCard                - upserts a state card into the ledger
 * deleteStateCard             - removes a state card entry
 * migrateStateLedgerKey       - migrates a state card to a new key after a type change
 * clearStateLedger            - empties the entire ledger
 * takeStateSnapshot           - records a message-anchored rollback-safe state snapshot
 * rollbackStateToSnapshot     - restores state as of a message index (swipe/delete)
 * runStateCardExtraction      - runs the extraction pass for the current message window
 * injectStateLedger           - pushes the current-state block into the prompt
 * loadAndInjectStateLedger    - restores and re-injects on chat load
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, PROMPT_KEY_STATE_LEDGER, estimateTokens } from './constants.js';
import { buildStateCardPrompt } from './prompts.js';
export {
  MAX_STATE_FIELD_LENGTH,
  MAX_STATE_LEDGER_CARDS,
  capStateFieldValues,
  pruneStateLedger,
} from './parsers.js';
import {
  parseStateCardResponse,
  mergeStateCardFields,
  capStateFieldValues,
  pruneStateLedger,
  MAX_STATE_LEDGER_CARDS,
} from './parsers.js';
import { loadCharacterEntityRegistry, loadSessionEntityRegistry } from './graph-migration.js';
import { generateMemoryExtract } from './generate.js';
import { smLog } from './logging.js';
import { invalidateUnifiedCache } from './unified-inject.js';
import { MACRO_NAMES, setMacroContent, isMacroActive } from './macros.js';
import { reportTierTrimStats } from './trim-stats.js';
import { takeSnapshotOnMeta, rollbackSnapshotOnMeta } from './state-snapshot.js';
import { inferRetconStateUpdate } from './continuity-utils.js';

// ---- Field schema -----------------------------------------------------------

/**
 * Ordered field names per entity type. Order determines injection sequence -
 * the most salient fields appear first.
 */
export const STATE_CARD_FIELDS = {
  character: ['location', 'injuries', 'outfit_disguise', 'mood', 'active_goal', 'carried_items'],
  object: ['owner', 'location', 'condition', 'status'],
  place: ['occupants', 'hazards', 'political_control', 'damage', 'accessibility'],
  faction: ['leadership', 'objective', 'alliances', 'hostility_level'],
};

/** Entity types that can carry a state card. Concept and unknown are excluded. */
export const STATE_CARD_TYPES = new Set(['character', 'object', 'place', 'faction']);

/**
 * Builds the chatMetadata key for a given entity name and type.
 * @param {string} name
 * @param {string} type
 * @returns {string}
 */
function ledgerKey(name, type) {
  return `${name.toLowerCase().trim()}|${type}`;
}

// ---- Feature gate -----------------------------------------------------------

/**
 * Returns true when state ledger extraction is active.
 *
 * @returns {boolean}
 */
export function isStateLedgerEnabled() {
  const s = extension_settings[MODULE_NAME];
  if (!s) return false;
  return !!s.state_ledger_enabled;
}

// ---- Storage ----------------------------------------------------------------

/**
 * Returns the full state ledger map from chatMetadata.
 * Keys are `name|type`; values are field objects.
 *
 * @returns {Object}
 */
export function loadStateLedger() {
  const context = getContext();
  return context.chatMetadata?.[META_KEY]?.state_ledger ?? {};
}

/**
 * Persists the full state ledger map to chatMetadata.
 *
 * @param {Object} ledger
 * @returns {Promise<void>}
 */
export async function saveStateLedger(ledger) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].state_ledger = ledger;
  await context.saveMetadata();
}

/**
 * Returns the fields object for the given entity, or null if no card exists.
 *
 * @param {string} name
 * @param {string} type
 * @returns {Object|null}
 */
export function getStateCard(name, type) {
  const ledger = loadStateLedger();
  return ledger[ledgerKey(name, type)] ?? null;
}

/**
 * Returns the chat index to anchor a manual-edit snapshot at. Manual edits
 * happen at the current chat tip; returning -1 when the chat is empty keeps
 * us from writing a meaningless snapshot for a chat with no turns.
 *
 * @returns {number}
 */
function currentChatIndex() {
  const context = getContext();
  const length = context.chat?.length ?? 0;
  return length > 0 ? length - 1 : -1;
}

/**
 * Records a message-anchored snapshot after a manual card edit. Without this,
 * the next swipe/delete rollback would restore an older snapshot and discard
 * the user's manual change.
 */
function snapshotAfterManualEdit() {
  const index = currentChatIndex();
  if (index >= 0) takeStateSnapshot(index);
}

/**
 * Validated single write path for a state card. Every ledger mutation funnels
 * through here so field capping, freshness stamping, collection-aware merging,
 * and ledger pruning are enforced uniformly across extraction, manual edits,
 * and durable retcons.
 *
 * The incoming fields are capped to MAX_STATE_FIELD_LENGTH, stamped with
 * `lastUpdated: Date.now()` (always now - a model cannot spoof freshness),
 * merged on top of the existing card, and the ledger is pruned back to
 * MAX_STATE_LEDGER_CARDS.
 *
 * @param {Object} ledger - The full state ledger map (mutated in place).
 * @param {string} key - Canonical ledger key (`name|type`).
 * @param {Object} fields - Partial or full field object for this entity type.
 * @returns {number} Number of cards pruned from the ledger by this call.
 */
export function upsertStateCard(ledger, key, fields) {
  const capped = capStateFieldValues(fields);
  capped.lastUpdated = Date.now();
  ledger[key] = mergeStateCardFields(ledger[key] ?? {}, capped);
  return pruneStateLedger(ledger);
}

/**
 * Upserts a state card into the ledger. Merges fields on top of any existing
 * card rather than replacing it - sparse update semantics.
 *
 * @param {string} name
 * @param {string} type
 * @param {Object} fields - Partial or full field object for this entity type.
 * @returns {Promise<void>}
 */
export async function setStateCard(name, type, fields) {
  const ledger = loadStateLedger();
  const key = ledgerKey(name, type);
  // Collection-aware merge: a plain item list appends, a `{ removeItems }`
  // descriptor removes matching items, and `''` clears the field outright.
  upsertStateCard(ledger, key, fields);
  await saveStateLedger(ledger);
  snapshotAfterManualEdit();
}

/**
 * Removes the state card for the given entity from the ledger.
 * No-op if the entity has no card.
 *
 * @param {string} name
 * @param {string} type
 * @returns {Promise<void>}
 */
export async function deleteStateCard(name, type) {
  const ledger = loadStateLedger();
  const key = ledgerKey(name, type);
  if (!(key in ledger)) return;
  delete ledger[key];
  await saveStateLedger(ledger);
  snapshotAfterManualEdit();
}

/**
 * Migrates a state card to a new key when an entity's type is changed.
 * The card's field values are preserved as-is - the new type's schema may
 * differ but free-text fields carry over without loss.
 *
 * @param {string} name
 * @param {string} oldType
 * @param {string} newType
 * @returns {Promise<void>}
 */
export async function migrateStateLedgerKey(name, oldType, newType) {
  const ledger = loadStateLedger();
  const oldKey = ledgerKey(name, oldType);
  if (!(oldKey in ledger)) return;
  // If the new type is not a state-card type (e.g. 'concept', 'unknown'),
  // discard the card rather than storing it under an unreachable key.
  if (!STATE_CARD_TYPES.has(newType)) {
    delete ledger[oldKey];
  } else {
    const newKey = ledgerKey(name, newType);
    ledger[newKey] = ledger[oldKey];
    delete ledger[oldKey];
  }
  await saveStateLedger(ledger);
}

/**
 * Empties the entire state ledger. Called on Fresh Start and Clear Memories.
 *
 * @returns {Promise<void>}
 */
export async function clearStateLedger() {
  await saveStateLedger({});
}

/**
 * Applies a resolved/accepted durable retcon to the state ledger.
 *
 * When the retcon describes a state-card attribute (an injury, outfit, mood,
 * location, goal, or carried item), the inferred entity's card is updated so
 * the baseline follows the state the story has settled on. Retcons that do not
 * map to the schema (e.g. eye colour) are ignored here and handled by the
 * long-term memory supersession path instead.
 *
 * @param {Object} retcon
 * @returns {boolean} True when a state card field was updated.
 */
export function applyRetconToStateLedger(retcon) {
  const update = inferRetconStateUpdate(retcon);
  if (!update) return false;

  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  const meta = context.chatMetadata[META_KEY];
  if (!meta.state_ledger || typeof meta.state_ledger !== 'object') meta.state_ledger = {};

  const key = ledgerKey(update.name, update.type);
  upsertStateCard(meta.state_ledger, key, update.fields);
  context.saveMetadata()?.catch?.(console.error);
  snapshotAfterManualEdit();
  return true;
}

// ---- Message-anchored snapshots & rollback ----------------------------------

/**
 * Records a snapshot of the chat-scoped mutable state (state ledger, story
 * arcs, perspectives/secrets, durable retcons) tagged with the given message
 * index. Call after an extraction/state-update pass so a later swipe or delete
 * can roll the state back to the last committed turn.
 *
 * @param {number} chatIndex - Chat message index this state reflects.
 * @returns {Object|null} The recorded snapshot.
 */
export function takeStateSnapshot(chatIndex) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  const snapshot = takeSnapshotOnMeta(context.chatMetadata[META_KEY], chatIndex);
  context.saveMetadata()?.catch?.(console.error);
  return snapshot;
}

/**
 * Rolls the chat-scoped mutable state back to the latest snapshot at or before
 * `targetMsgIndex`, pruning every snapshot after it. Used when a message is
 * swiped or deleted so facts, state cards, arcs, secrets, and retcons from the
 * discarded branch never survive.
 *
 * @param {number} targetMsgIndex - Highest chat index whose state should survive.
 * @returns {Object|null} The restored snapshot, or null when reset to empty.
 */
export function rollbackStateToSnapshot(targetMsgIndex) {
  const context = getContext();
  const meta = context.chatMetadata?.[META_KEY];
  if (!meta) return null;
  const restored = rollbackSnapshotOnMeta(meta, targetMsgIndex);
  context.saveMetadata()?.catch?.(console.error);
  return restored;
}

// ---- Extraction -------------------------------------------------------------

/**
 * Runs the state card extraction pass for the current message window.
 *
 * Builds an entity list from both LT and session registries, runs the model
 * against the recent messages, parses the response, and merges the results
 * into the stored ledger as sparse updates.
 *
 * @param {string|string[]|null} characterName - Card character name(s) for LT registry lookup.
 *   Group chats pass every active member so entities are gathered across the whole group.
 * @param {Object[]} messages - Recent messages to extract state from.
 * @param {Function|null} [abortCheck] - Optional zero-arg function; if it returns true the write is skipped (chat switched).
 * @returns {Promise<number>} Number of entity cards updated.
 */
export async function runStateCardExtraction(characterName, messages, abortCheck = null) {
  if (!isStateLedgerEnabled()) return 0;

  try {
    const chatExcerpt = messages
      .filter((m) => m.mes && !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!chatExcerpt.trim()) return 0;

    // Build entity list from both registries, filtered to types in scope.
    // Group chats pass an array so entities from every active member are
    // included instead of only the selected character.
    const characterNames = Array.isArray(characterName)
      ? characterName.filter(Boolean)
      : characterName
        ? [characterName]
        : [];
    const ltEntities = characterNames.flatMap((name) => loadCharacterEntityRegistry(name));
    const sessionEntities = loadSessionEntityRegistry();
    const seen = new Set();
    const entityList = [];
    for (const e of [...ltEntities, ...sessionEntities]) {
      if (!STATE_CARD_TYPES.has(e.type)) continue;
      const k = ledgerKey(e.name, e.type);
      if (seen.has(k)) continue;
      seen.add(k);
      entityList.push({ name: e.name, type: e.type });
    }

    if (entityList.length === 0) return 0;

    const prompt = buildStateCardPrompt(chatExcerpt, entityList);

    const response = await generateMemoryExtract(prompt, { responseLength: 400 });
    smLog('[SmartMemory] State ledger raw response:', response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    const updates = parseStateCardResponse(response);
    if (updates.size === 0) {
      smLog('[SmartMemory] State ledger extraction produced no parseable updates.');
      return 0;
    }

    // Merge updates into the existing ledger with collection-aware add/remove
    // semantics so a partial removal never wipes untargeted items.
    if (abortCheck?.()) return 0;
    const ledger = loadStateLedger();

    // Strict (name, type) whitelist. Only the canonical key for an entity the
    // extension already knows about (present in a registry) may be merged, and
    // every active character is seeded as its canonical `name|character` card.
    // This rejects hallucinated entities AND type-confused cards (e.g.
    // "elara|place" for the character Elara) so they can never enter the ledger
    // or the injected prompt.
    const allowedKeys = new Set(entityList.map((e) => ledgerKey(e.name, e.type)));
    for (const name of characterNames) {
      allowedKeys.add(ledgerKey(name, 'character'));
    }

    let count = 0;
    let pruned = 0;
    for (const [key, fields] of updates) {
      if (!allowedKeys.has(key)) {
        smLog(`[SmartMemory] State ledger: rejected unknown entity card "${key}".`);
        continue;
      }
      // Every write goes through the validated upsert so cap + lastUpdated
      // stamping + prune are enforced here as well as on the manual/retcon paths.
      pruned += upsertStateCard(ledger, key, fields);
      count++;
    }

    // Keep the ledger bounded - prune oldest low-priority (non-character) cards
    // first so metadata cannot grow without limit across long chats.
    if (pruned > 0) {
      smLog(
        `[SmartMemory] State ledger: pruned ${pruned} card(s) over the ${MAX_STATE_LEDGER_CARDS} cap.`,
      );
    }
    await saveStateLedger(ledger);

    smLog(`[SmartMemory] State ledger: updated ${count} entity cards.`);
    return count;
  } catch (err) {
    smLog('[SmartMemory] State ledger extraction failed:', err.message);
    return 0;
  }
}

// ---- Injection --------------------------------------------------------------

/**
 * Formats one line per entity with non-empty fields, grouped by type.
 * Returns an empty string when the ledger is empty.
 *
 * @param {Object} ledger - The full state ledger map.
 * @param {number|null} [lastSeenMsg] - Highest message index reflected in the ledger.
 * @returns {string}
 */
function buildStateLedgerBlock(ledger, lastSeenMsg = null) {
  const entries = Object.entries(ledger);
  if (entries.length === 0) return '';

  // Group by type for a readable block.
  const byType = {};
  for (const [key, fields] of entries) {
    const [name, type] = key.split('|');
    if (!name || !type || !STATE_CARD_TYPES.has(type)) continue;
    const schema = STATE_CARD_FIELDS[type];
    if (!schema) continue;
    const values = schema.map((f) => fields[f]).filter((v) => v && v.trim());
    if (values.length === 0) continue;
    const displayName = fields._name || name;
    const line = `${displayName} [${type}]: ${values.join(' | ')}`;
    if (!byType[type]) byType[type] = [];
    byType[type].push(line);
  }

  const lines = [`[State Ledger as of turn #${lastSeenMsg ?? 'current'}]:`];
  for (const type of ['character', 'object', 'place', 'faction']) {
    if (byType[type]) lines.push(...byType[type]);
  }

  // A ledger whose cards all have empty fields yields no content lines - treat
  // it as empty so the injection slot is cleared rather than header-only.
  if (lines.length === 1) return '';

  return lines.join('\n');
}

/**
 * Injects the state ledger block into the prompt.
 * Clears the slot when the feature is disabled or the ledger is empty.
 *
 * @param {boolean} [updateTelemetry=false] - Whether to update the token usage bar.
 */
export function injectStateLedger(updateTelemetry = false) {
  const settings = extension_settings[MODULE_NAME];

  const clear = () => {
    setMacroContent(MACRO_NAMES.state_ledger, '');
    setExtensionPrompt(PROMPT_KEY_STATE_LEDGER, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_STATE_LEDGER);
    if (updateTelemetry) updateStateLedgerTelemetry(0);
  };

  if (!isStateLedgerEnabled()) {
    clear();
    return;
  }

  const ledger = loadStateLedger();
  const context = getContext();
  const cutoff = context.chatMetadata?.[META_KEY]?.lastExtractCutoff;
  const block = buildStateLedgerBlock(ledger, Number.isInteger(cutoff) ? cutoff : null);

  if (!block) {
    clear();
    return;
  }

  // Apply token budget cap.
  const budget = settings.state_ledger_inject_budget ?? 200;
  let content = block;
  const fullTokens = estimateTokens(content);
  if (fullTokens > budget) {
    const blockLines = content.split('\n');
    while (blockLines.length > 1 && estimateTokens(blockLines.join('\n')) > budget) {
      blockLines.pop();
    }
    content = blockLines.join('\n');
  }
  reportTierTrimStats(PROMPT_KEY_STATE_LEDGER, estimateTokens(content), fullTokens);

  setMacroContent(MACRO_NAMES.state_ledger, content);
  if (isMacroActive(MACRO_NAMES.state_ledger)) {
    setExtensionPrompt(PROMPT_KEY_STATE_LEDGER, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_STATE_LEDGER);
  } else {
    setExtensionPrompt(
      PROMPT_KEY_STATE_LEDGER,
      content,
      settings.state_ledger_position ?? extension_prompt_types.IN_CHAT,
      settings.state_ledger_depth ?? 2,
      false,
      settings.state_ledger_role ?? extension_prompt_roles.SYSTEM,
    );
  }

  invalidateUnifiedCache(PROMPT_KEY_STATE_LEDGER);
  if (updateTelemetry) updateStateLedgerTelemetry(estimateTokens(content));
}

/**
 * Restores and re-injects the state ledger on chat load or character change.
 * No extraction is run - only the stored ledger is re-injected.
 */
export function loadAndInjectStateLedger() {
  injectStateLedger(false);
}

// ---- Telemetry (token usage bar) --------------------------------------------

/**
 * Updates the state ledger slice of the token usage bar.
 * No-op when the bar element is not present in the DOM.
 *
 * @param {number} tokens - Estimated token count of the injected block.
 */
function updateStateLedgerTelemetry(tokens) {
  const el = document.querySelector('.sm-token-bar-state_ledger');
  if (!el) return;
  el.style.setProperty('--sm-tokens', tokens);
  el.setAttribute('data-tokens', tokens);
}
