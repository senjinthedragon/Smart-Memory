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
 * Session memory: detailed within-chat facts stored in chatMetadata.
 *
 * Sits between short-term (broad narrative summary) and long-term (distilled
 * cross-session facts). Session memories are more granular than long-term -
 * capturing scene details, named objects, specific revelations - but do not
 * survive past the current chat.
 *
 * In group chats, each character's memories are tagged with a `character` field
 * and injected only when that character is active. Untagged (legacy) memories
 * are treated as shared and injected for all characters.
 *
 * loadSessionMemories        - returns the current session memory array
 * saveSessionMemories        - persists the session memory array to chatMetadata
 * clearSessionMemories       - empties session memories for the current chat
 * extractSessionMemories     - runs extraction against recent messages and merges results
 * consolidateSessionMemories - evaluates unprocessed entries against the consolidated base per type
 * formatSessionMemories      - formats the memory array as [type] content lines
 * injectSessionMemories      - pushes session memories into the prompt via setExtensionPrompt
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { generateMemoryExtract } from './generate.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  estimateTokens,
  MODULE_NAME,
  META_KEY,
  PROMPT_KEY_SESSION,
  SESSION_TYPES,
} from './constants.js';
import {
  applyGraphDefaults,
  loadSessionEntityRegistry,
  saveSessionEntityRegistry,
  resolveEntityNames,
  reconcileEntityRegistry,
} from './graph-migration.js';
import { buildSessionExtractionPrompt, buildSessionConsolidationPrompt } from './prompts.js';
import { parseSessionOutput } from './parsers.js';
import { batchVerify, getEmbeddingBatch, getHardwareProfile } from './embeddings.js';
import { loadCharacterMemories, formatMemoriesForPrompt } from './longterm.js';
import {
  buildCurrentSceneStateBlock,
  prioritizeMemories,
  hybridPrioritize,
  extractTurnEntityMentions,
  reconcileTypeEntries,
  selectProtectedMemories,
  sortByTimeline,
  trimByPriority,
} from './memory-utils.js';

/**
 * Filters session memory candidates against existing entries, removing
 * near-duplicates and entries that fail basic quality checks. Identifies
 * supersessions (state-change updates that should retire an existing memory).
 *
 * All texts are embedded in a single batch API call so nomic-embed-text only
 * needs to load once per verification pass rather than once per candidate.
 * Falls back to Jaccard word-overlap when embeddings are unavailable.
 *
 * @param {Array} candidates - Newly extracted session memory objects.
 * @param {Array} existing   - Active (non-retired) session memories.
 * @returns {Promise<{verified: Array, superseded: Map<string, string>, confirmed: Set<string>}>}
 *   verified  - Candidates that passed dedup and should be added.
 *   superseded - Map from candidate content (lowercase) to the id of the
 *                existing memory it replaces.
 *   confirmed  - Set of existing memory ids re-extracted this pass (still true).
 */
async function verifySessionCandidates(candidates, existing) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { verified: [], superseded: new Map(), confirmed: new Set() };
  }

  const seen = new Set();
  const filtered = candidates.filter((mem) => {
    const text = String(mem.content || '').trim();
    if (text.length < 5 || text.length > 240) return false;
    const key = `${mem.type}|${text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (filtered.length === 0) return { verified: [], superseded: new Map(), confirmed: new Set() };

  const { passed, superseded, confirmed } = await batchVerify(filtered, existing);
  const verified = filtered.filter((m) =>
    passed.has(
      String(m.content || '')
        .toLowerCase()
        .trim(),
    ),
  );
  return { verified, superseded, confirmed };
}

// ---- Storage (chatMetadata) ---------------------------------------------

/**
 * Returns the session memory array for the current chat.
 * Migrates legacy entries (no consolidated flag) to consolidated: true on load
 * so existing memories are treated as the stable base.
 * @returns {Array<{type: string, content: string, ts: number, consolidated: boolean}>}
 */
export function loadSessionMemories() {
  const context = getContext();
  const memories = context.chatMetadata?.[META_KEY]?.sessionMemories ?? [];
  // Migrate: entries without the consolidated flag are pre-existing stable memories.
  // Entries without an importance score default to 2 (medium).
  // applyGraphDefaults is a safety net for entries that predate the one-shot
  // migration pass. It is non-destructive and only generates a new id when one
  // is truly absent.
  return memories.map((m) =>
    applyGraphDefaults({
      ...m,
      consolidated: m.consolidated ?? true,
      importance: m.importance ?? 2,
      expiration: m.expiration ?? 'session',
      confidence: m.confidence ?? 0.7,
      persona_relevance: m.persona_relevance ?? (m.type === 'development' ? 2 : 1),
      intimacy_relevance: m.intimacy_relevance ?? (m.type === 'development' ? 2 : 1),
      retrieval_count: m.retrieval_count ?? 0,
      // Fall back to 0 (not Date.now()) when both fields are absent so legacy
      // entries don't receive an artificial recency boost in memoryUtilityScore.
      last_confirmed_ts: m.last_confirmed_ts ?? m.ts ?? 0,
    }),
  );
}

/**
 * Persists the session memory array to chatMetadata.
 * @param {Array<{type: string, content: string, ts: number}>} memories
 */
export async function saveSessionMemories(memories) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].sessionMemories = memories;
  await context.saveMetadata();
}

/**
 * Empties session memories for the current chat.
 */
export async function clearSessionMemories() {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    context.chatMetadata[META_KEY].sessionMemories = [];
    await context.saveMetadata();
  }
}

// ---- Parsing ------------------------------------------------------------

/**
 * Merges new session memories into the existing set, skipping near-duplicates
 * and trimming to the configured maximum.
 *
 * Uses a word-overlap ratio: if the intersection of words between a new item
 * and any existing item exceeds 65% of the larger set's word count, the new
 * item is treated as a duplicate. This threshold is slightly looser than
 * long-term (70%) since session details tend to be more specific and verbose.
 *
 * When over the limit, the oldest entries are dropped from the front.
 *
 * @param {Array} existing - Currently stored session memories.
 * @param {Array} incoming - Newly extracted items to merge in.
 * @param {number} max - Hard cap on total session memories.
 * @returns {Array} The merged array.
 */
function deduplicateSession(existing, incoming, max) {
  const merged = [...existing];
  for (const mem of incoming) {
    const words = new Set(mem.content.toLowerCase().split(/\s+/));
    const isDuplicate = merged.some((ex) => {
      if (ex.type !== mem.type) return false;
      const exWords = new Set(ex.content.toLowerCase().split(/\s+/));
      const intersection = [...words].filter((w) => exWords.has(w)).length;
      // Normalise against the larger set to avoid short strings
      // matching too aggressively against long ones.
      return intersection / Math.max(words.size, exWords.size) > 0.65;
    });
    if (!isDuplicate) merged.push(mem);
  }
  // When over the cap, drop the least valuable entries first:
  // sort by expiration/importance/keyword recurrence/age, remove from the tail.
  if (merged.length > max) {
    const prioritized = prioritizeMemories(merged);
    merged.splice(0, merged.length, ...prioritized);
    merged.splice(max);
  }
  return merged;
}

// ---- Extraction ---------------------------------------------------------

/**
 * Returns the name of the character who last spoke, for use in tagging session
 * memories. In group chats, context.name2 reflects the group's primary character
 * and does not update per-speaker, so the last AI message's name is used instead.
 * @returns {string|null}
 */
function getActiveSpeakerName() {
  const context = getContext();
  if (context.groupId && context.chat?.length) {
    const lastAiMsg = context.chat
      .slice()
      .reverse()
      .find((m) => !m.is_user && !m.is_system && m.name);
    if (lastAiMsg?.name) return lastAiMsg.name;
  }
  return context.name2 || context.characterName || null;
}

/**
 * Extracts session-level details from recent messages via the model and merges
 * them into chatMetadata. Returns the count of new items saved.
 *
 * In group chats, the speaking character is identified from the last AI message
 * name. New memories are tagged with that character so each character builds its
 * own session memory set within the shared chatMetadata store. Untagged (legacy)
 * memories are treated as shared and remain visible to all characters.
 *
 * @param {Array} recentMessages - Last N message objects from context.chat.
 * @returns {Promise<number>} Count of new items added (0 on failure or nothing found).
 */
export async function extractSessionMemories(recentMessages) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.session_enabled) return 0;

  try {
    const chatHistory = recentMessages
      .filter((m) => m.mes && !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!chatHistory.trim()) return 0;

    const existingAll = loadSessionMemories();

    // Identify the speaking character so memories can be attributed correctly.
    // In group chats this is the last AI message's name; in 1:1 chats it is the
    // single character loaded in the session.
    const characterName = getActiveSpeakerName();

    // Separate active from retired memories. Only compare against this character's
    // active memories (+ untagged legacy entries) so that group-chat characters
    // don't deduplicate against each other's separate memory stores.
    const existing = existingAll.filter(
      (m) => !m.superseded_by && (!m.character || m.character === characterName),
    );
    // Active memories belonging to other characters - preserved as-is on save.
    const otherCharacterMemories = existingAll.filter(
      (m) => !m.superseded_by && m.character && m.character !== characterName,
    );
    const retiredMemories = existingAll.filter((m) => m.superseded_by);

    const existingText = existing.map((m) => `[${m.type}] ${m.content}`).join('\n');

    // Pass long-term memories so the model skips facts already stored there.
    // Cap to 15 entries to avoid inflating the prompt on local hardware.
    const longtermMemories = characterName ? loadCharacterMemories(characterName) : [];
    const longtermText =
      longtermMemories.length > 0 ? formatMemoriesForPrompt(longtermMemories.slice(0, 15)) : '';

    const response = await generateMemoryExtract(
      buildSessionExtractionPrompt(chatHistory, existingText, longtermText),
      { responseLength: settings.session_response_length ?? 500 },
    );

    console.log('[SmartMemory] Session extraction response:', response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    const {
      verified: incoming,
      superseded: supersessionMap,
      confirmed: confirmedIds,
    } = await verifySessionCandidates(parseSessionOutput(response), existing);
    if (incoming.length === 0) return 0;

    const max = settings.session_max_memories ?? 30;
    const merged = deduplicateSession(existing, incoming, max);

    // Apply supersession links. For each candidate that supersedes an existing
    // memory: mark the old memory as retired (superseded_by + valid_to) and
    // link the new memory back to it (supersedes + valid_from).
    const context = getContext();
    const messageIndex = Math.max(0, (context.chat?.length ?? 1) - 1);

    const newlyRetiredIds = new Set();
    for (const [candText, oldId] of supersessionMap) {
      const newMem = merged.find(
        (m) =>
          String(m.content || '')
            .toLowerCase()
            .trim() === candText,
      );
      const oldMem = existing.find((m) => m.id === oldId);

      if (newMem && oldMem && !oldMem.superseded_by) {
        if (!newMem.supersedes) newMem.supersedes = [];
        if (!newMem.supersedes.includes(oldId)) newMem.supersedes.push(oldId);
        newMem.valid_from = newMem.valid_from ?? messageIndex;

        oldMem.superseded_by = newMem.id;
        oldMem.valid_to = messageIndex;
        newlyRetiredIds.add(oldId);

        console.log(
          `[SmartMemory] Session supersession: "${oldMem.content.slice(0, 60)}" retired by "${newMem.content.slice(0, 60)}"`,
        );
      }
    }

    // Remove newly retired entries from the active merged set.
    const finalActive = merged.filter((m) => !newlyRetiredIds.has(m.id));

    // Tag any new memories with the speaking character so injection can filter
    // by character in group chats. Existing memories already have their tag (or
    // none, for legacy untagged entries).
    for (const mem of finalActive) {
      if (!mem.character && characterName) mem.character = characterName;
    }

    // Confidence decay pass - mirrors the long-term logic.
    const DECAY_THRESHOLD = 10;
    const now = Date.now();
    for (const mem of finalActive) {
      if (confirmedIds.has(mem.id)) {
        mem.last_confirmed_ts = now;
        mem.confidence = Math.min(1.0, (mem.confidence ?? 1.0) + 0.05);
        mem.unconfirmed_since = 0;
      } else {
        mem.unconfirmed_since = (mem.unconfirmed_since ?? 0) + 1;
        if (mem.unconfirmed_since >= DECAY_THRESHOLD) {
          mem.confidence = Math.max(0.3, (mem.confidence ?? 1.0) - 0.02);
        }
      }
    }

    // Resolve entity names to ids for any new memories that carried
    // _raw_entity_names through the pipeline. The session entity registry is
    // loaded from chatMetadata, updated in place, then persisted.
    const entityRegistry = loadSessionEntityRegistry();
    const existingKeys = new Set(existing.map((m) => `${m.type}|${m.content}`));
    for (const mem of finalActive) {
      if (Array.isArray(mem._raw_entity_names)) {
        resolveEntityNames(mem, mem._raw_entity_names, messageIndex, entityRegistry);
      }
    }
    if (entityRegistry.length > 0) {
      await saveSessionEntityRegistry(entityRegistry);
    }

    // Newly retired active memories move to the retired pool.
    const updatedRetired = [
      ...retiredMemories,
      ...existing.filter((m) => newlyRetiredIds.has(m.id)),
    ];

    const added = finalActive.filter((m) => !existingKeys.has(`${m.type}|${m.content}`)).length;
    // Preserve other characters' active memories alongside this character's result.
    await saveSessionMemories([...finalActive, ...otherCharacterMemories, ...updatedRetired]);

    return added;
  } catch (err) {
    console.error('[SmartMemory] Session extraction failed:', err);
    throw err;
  }
}

// ---- Consolidation ------------------------------------------------------

// How many unprocessed entries of a single type must accumulate before
// consolidation fires for that type.
const DEFAULT_SESSION_CONSOLIDATION_THRESHOLD = 3;

/**
 * Runs a consolidation pass on session memories for the current chat.
 *
 * Maintains a stable consolidated base per session memory type. When enough
 * unprocessed entries accumulate for a given type, the model evaluates only
 * that batch against the base - it may drop duplicates, fold new details into
 * existing base entries, or add genuinely new entries. The base is never
 * rewritten, only extended.
 *
 * Fires per-type independently - a burst of new [scene] entries does not
 * trigger [detail] consolidation.
 *
 * @param {boolean} [force=false] - If true, consolidate all types regardless of threshold.
 *   Used by the catch-up final pass to flush any entries that never accumulated enough
 *   to hit the threshold during per-chunk consolidation.
 * @returns {Promise<number>} Number of memories removed by consolidation (0 on no change or failure).
 */
export async function consolidateSessionMemories(force = false) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.session_enabled) return 0;
  const threshold = Math.max(
    2,
    settings.session_consolidation_threshold ?? DEFAULT_SESSION_CONSOLIDATION_THRESHOLD,
  );

  const memories = loadSessionMemories();
  let totalRemoved = 0;
  let dirty = false;

  for (const type of SESSION_TYPES) {
    // Exclude retired memories from consolidation - they've already been replaced.
    const base = memories.filter((m) => m.type === type && m.consolidated && !m.superseded_by);
    const unprocessed = memories.filter(
      (m) => m.type === type && !m.consolidated && !m.superseded_by,
    );

    if (!force && unprocessed.length < threshold) continue;
    if (unprocessed.length === 0) continue;

    try {
      const baseText = base.map((m) => `[${m.type}] ${m.content}`).join('\n');
      const batchText = unprocessed.map((m) => `[${m.type}] ${m.content}`).join('\n');

      const response = await generateMemoryExtract(
        buildSessionConsolidationPrompt(type, baseText, batchText),
        { responseLength: Math.max(400, (base.length + unprocessed.length) * 60) },
      );

      console.log(`[SmartMemory] Session consolidation response for [${type}]:`, response);

      if (!response || response.trim().toUpperCase() === 'NONE') {
        // Nothing to add - mark unprocessed as consolidated as-is.
        unprocessed.forEach((m) => (m.consolidated = true));
        dirty = true;
        continue;
      }

      // Parse the model's output - these are the entries to add/update in the base.
      const incoming = parseSessionOutput(response);
      // Mark all incoming as consolidated since they've been through the process.
      const promoted = incoming.map((m) => ({ ...m, consolidated: true }));

      // Reconcile promoted entries with the base so "updated" base entries
      // replace older variants instead of being appended as duplicates.
      const reconciledType = await reconcileTypeEntries(
        base,
        promoted,
        0.65,
        [...base, ...unprocessed],
        getEmbeddingBatch,
      );

      // Replace this type's entries. Other types are untouched.
      const otherTypes = memories.filter((m) => m.type !== type);
      memories.splice(0, memories.length, ...otherTypes, ...reconciledType);

      const before = base.length + unprocessed.length;
      const after = reconciledType.length;
      const removed = before - after;
      totalRemoved += Math.max(0, removed);
      dirty = true;

      console.log(
        `[SmartMemory] Session [${type}] consolidation: ${unprocessed.length} unprocessed -> ${promoted.length} promoted. Base: ${base.length}. Removed: ${Math.max(0, removed)}.`,
      );
    } catch (err) {
      console.error(`[SmartMemory] Session consolidation failed for type [${type}]:`, err);
      // On failure, mark unprocessed as consolidated so they don't block future passes.
      // Set dirty before the forEach so a mid-loop error still triggers the save.
      dirty = true;
      unprocessed.forEach((m) => (m.consolidated = true));
    }
  }

  const max = settings.session_max_memories ?? 30;
  const finalMemories = sortByTimeline(trimByPriority(memories, max));
  if (dirty || finalMemories.length !== memories.length) {
    // Repair session entity registry links - same stale-ID problem as long-term:
    // consolidation replaces memories with new IDs, orphaning the registry.
    const entityRegistry = loadSessionEntityRegistry();
    if (entityRegistry.length > 0) {
      reconcileEntityRegistry(entityRegistry, finalMemories);
      await saveSessionEntityRegistry(entityRegistry);
    }

    await saveSessionMemories(finalMemories);
  }

  return totalRemoved;
}

// ---- Injection ----------------------------------------------------------

/**
 * Formats the session memory array as plain bullet lines for RP prompt injection.
 * The [type] format is kept internally for the extraction/consolidation pipeline
 * (see the inline formatters in extractSessionMemories and consolidateSessionMemories).
 * Using plain bullets here prevents bracket notation from bleeding into story output.
 * @param {Array<{type: string, content: string}>} memories
 * @returns {string}
 */
export function formatSessionMemories(memories) {
  if (!memories || memories.length === 0) return '';
  return sortByTimeline(memories)
    .map((m) => `- ${m.content}`)
    .join('\n');
}

/**
 * Injects session memories into the prompt via setExtensionPrompt.
 * Clears the slot if session memory is disabled or no memories exist.
 *
 * Only injects memories belonging to the current speaker (plus untagged legacy
 * memories). In group chats this ensures each character sees only its own session
 * context rather than a merged view of all characters' memories.
 *
 * @param {boolean} [updateTelemetry=false] - If true, increment retrieval_count for injected memories.
 *   Only pass true from the post-extraction path (one real AI response turn).
 * @returns {Promise<void>}
 */
export async function injectSessionMemories(updateTelemetry = false) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.session_enabled) {
    setExtensionPrompt(PROMPT_KEY_SESSION, '', extension_prompt_types.NONE, 0);
    return;
  }

  // Only inject active memories for the current character. Untagged (legacy)
  // memories are included for all characters to preserve backward compatibility.
  const speakerName = getActiveSpeakerName();
  const memories = loadSessionMemories().filter(
    (m) => !m.superseded_by && (!m.character || m.character === speakerName),
  );
  if (memories.length === 0) {
    setExtensionPrompt(PROMPT_KEY_SESSION, '', extension_prompt_types.NONE, 0);
    return;
  }

  // Trim to token budget using hybrid scoring on real AI turns, plain utility
  // scoring on chat load (no "current turn" to extract entity mentions from).
  const budget = settings.session_inject_budget ?? 400;
  const protectedSet = new Set(selectProtectedMemories(memories, ['development', 'scene']));

  let trimmed;
  if (updateTelemetry) {
    const context = getContext();
    const lastMessages = (context.chat ?? []).slice(-2);
    const turnMentions = extractTurnEntityMentions(lastMessages);
    trimmed = await hybridPrioritize(memories, {
      turnMentions,
      floorTypes: ['development', 'scene'],
      embedFn: getEmbeddingBatch,
      lastTurnText: lastMessages[lastMessages.length - 1]?.mes ?? '',
      w5: getHardwareProfile() === 'b' ? 0.6 : 0.2,
    });
  } else {
    trimmed = prioritizeMemories(memories);
  }
  while (trimmed.length > 1 && estimateTokens(formatSessionMemories(trimmed)) > budget) {
    let idx = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (!protectedSet.has(trimmed[i])) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) trimmed.splice(idx, 1);
    else break;
  }

  // Only update retrieval telemetry when called from a real AI response turn.
  if (updateTelemetry) {
    const recalled = new Set(trimmed.map((m) => `${m.type}|${m.content}`));
    const updated = memories.map((m) => {
      const key = `${m.type}|${m.content}`;
      if (!recalled.has(key)) return m;
      return {
        ...m,
        retrieval_count: (m.retrieval_count ?? 0) + 1,
        last_confirmed_ts: Date.now(),
      };
    });
    await saveSessionMemories(updated);
  }

  const template = settings.session_template ?? 'Details from this session:\n{{session}}';
  const sessionBlock = template.replace('{{session}}', formatSessionMemories(trimmed));
  const sceneStateBlock = buildCurrentSceneStateBlock(trimmed);
  const content = sceneStateBlock ? `${sceneStateBlock}\n${sessionBlock}` : sessionBlock;

  setExtensionPrompt(
    PROMPT_KEY_SESSION,
    content,
    settings.session_position ?? extension_prompt_types.IN_PROMPT,
    settings.session_depth ?? 3,
    false,
    settings.session_role ?? extension_prompt_roles.SYSTEM,
  );
}
