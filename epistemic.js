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
 * Perspectives & Secrets: per-character knowledge map extracted at scene breaks.
 *
 * Extraction runs once per scene break (not every message) and produces a
 * five-tag knowledge map: what each character knows, suspects, believes (falsely),
 * is unaware of, and is actively concealing from a specific target.
 *
 * Existing entries are passed into each extraction prompt so the model can flag
 * superseded entries via [retire] tags in the same response. This prevents stale
 * entries (e.g. [suspects] after confirmation, [unaware] after the character
 * learns the fact) from accumulating alongside newer, contradicting entries.
 *
 * Entries are stored chat-scoped in chatMetadata so different chats and AU
 * branches with the same character never cross-contaminate secrets. They are
 * injected as a private knowledge block for the responding character only.
 *
 * isEpistemicEnabled               - returns true when the feature is active for the current profile
 * loadEpistemicKnowledge           - loads entries for the current chat (migrating a legacy global store once)
 * saveEpistemicKnowledge           - persists entries to the current chat's metadata
 * clearEpistemicKnowledge          - removes all entries for the current chat
 * extractEpistemicKnowledge        - runs the extraction pass for the current scene
 * extractAndPartitionGroupEpistemic - runs one extraction pass and partitions entries by subject for group members
 * injectEpistemicKnowledge         - pushes the knowledge block into the prompt; warn=true prompts budget growth
 * loadAndInjectEpistemicKnowledge  - restores and re-injects on chat load
 * resetEpistemicWarnFlag           - resets the per-load overflow warning flag; call on chat change
 * shrinkEpistemicBudgetIfPossible  - pulls the per-chat budget back down after entries are deleted
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
  saveSettingsDebounced,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  MODULE_NAME,
  META_KEY,
  PROMPT_KEY_EPISTEMIC,
  estimateTokens,
  generateMemoryId,
} from './constants.js';
import { buildEpistemicExtractionPrompt } from './prompts.js';
import {
  parseEpistemicResponse,
  parseEpistemicRetireIndices,
  MAX_EPISTEMIC_RETIREMENTS,
} from './parsers.js';
import { getSceneParticipants } from './scenes.js';
import { generateMemoryExtract } from './generate.js';
import { getEmbeddingBatch, cosineSimilarity } from './embeddings.js';
import { smLog } from './logging.js';
import { invalidateUnifiedCache } from './unified-inject.js';
import { MACRO_NAMES, setMacroContent, isMacroActive } from './macros.js';
import { reportTierTrimStats } from './trim-stats.js';
import {
  partitionEpistemicEntriesBySubject,
  matchSubjectToMember,
  normalizeEpistemicSubject,
  setSmartMemoryLogger,
} from './memory-utils.js';
import { resolveChatEpistemic } from './epistemic-utils.js';
import { takeStateSnapshot } from './state-ledger.js';

// memory-utils is intentionally free of the SillyTavern runtime so it can be
// unit-tested under plain Node. Wire the real logger so its ambiguity warnings
// respect the verbose_logging setting in production.
setSmartMemoryLogger(smLog);

// ---- Per-chat budget override -----------------------------------------------

// Prevents the overflow warning from firing repeatedly within the same
// extraction batch or on passive re-injections. Reset on chat change via
// resetEpistemicWarnFlag().
let _epistemicWarnedThisLoad = false;

/**
 * Resets the overflow warning flag. Call on CHAT_CHANGED / CHAT_LOADED so
 * the warning can fire again when the user enters a new chat.
 */
export function resetEpistemicWarnFlag() {
  _epistemicWarnedThisLoad = false;
}

/**
 * Returns the effective token budget for the current chat.
 * A per-chat override stored in chatMetadata takes precedence over the
 * settings slider value so the user does not need to adjust the slider
 * for each individual roleplay.
 *
 * @param {Object} settings - extension_settings[MODULE_NAME]
 * @returns {number}
 */
function getEffectiveEpistemicBudget(settings) {
  const context = getContext();
  const override = context.chatMetadata?.[META_KEY]?.epistemicBudgetOverride;
  return typeof override === 'number' ? override : (settings.epistemic_inject_budget ?? 200);
}

/**
 * Returns the highest message index reflected in the chat's extracted state,
 * used for the "as of turn #N" header on injected blocks.
 *
 * @returns {number|null}
 */
function getLastSeenMsg() {
  const context = getContext();
  const cutoff = context.chatMetadata?.[META_KEY]?.lastExtractCutoff;
  return Number.isInteger(cutoff) ? cutoff : null;
}

/**
 * Persists a new per-chat budget override to chatMetadata (fire-and-forget).
 *
 * @param {number} newBudget
 */
function saveEpistemicBudgetOverride(newBudget) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].epistemicBudgetOverride = newBudget;
  context
    .saveMetadata()
    .catch((err) => console.error('[SmartMemory] Failed to save epistemic budget override:', err));
}

/**
 * Shrinks the per-chat budget override after entries are deleted.
 * If the current override exceeds what the remaining entries need by more than
 * 100 tokens, the override is pulled back to needed + 100. Never goes below
 * the base settings value so the slider still acts as a floor.
 *
 * Call this after any manual entry deletion so the budget reflects the list.
 *
 * @param {string} characterName
 * @param {string} respondingCharName
 */
export function shrinkEpistemicBudgetIfPossible(characterName, respondingCharName) {
  const settings = extension_settings[MODULE_NAME];
  const context = getContext();
  const override = context.chatMetadata?.[META_KEY]?.epistemicBudgetOverride;
  if (typeof override !== 'number') return; // no override set, nothing to shrink

  const entries = loadEpistemicKnowledge(characterName);
  const block = buildEpistemicBlock(entries, respondingCharName, settings, getLastSeenMsg());
  const needed = block ? estimateTokens(block) : 0;
  const floor = settings.epistemic_inject_budget ?? 200;
  const ideal = Math.max(floor, needed + 100);

  if (ideal < override) {
    saveEpistemicBudgetOverride(ideal);
  }
}

// ---- Feature gate -----------------------------------------------------------

/**
 * Returns true when the Perspectives & Secrets feature is active.
 *
 * @returns {boolean}
 */
export function isEpistemicEnabled() {
  const s = extension_settings[MODULE_NAME];
  if (!s) return false;
  return !!s.epistemic_enabled;
}

// ---- Storage ----------------------------------------------------------------

/**
 * Loads the chat-scoped epistemic knowledge entries for the current chat.
 *
 * Entries are stored in `chatMetadata[META_KEY].epistemic_knowledge` so that
 * different chats and AU branches with the same character can never
 * cross-contaminate secrets. The `characterName` argument is retained for
 * signature compatibility and to migrate a legacy per-character global store.
 *
 * Entry shape:
 *   { id, type, subject, target, content, ts, source_messages }
 *
 * @param {string} characterName - Card character name (used only for legacy migration).
 * @returns {Array<Object>}
 */
export function loadEpistemicKnowledge(characterName) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  const meta = context.chatMetadata[META_KEY];

  // One-time migration source: a pre-existing chat (or pre-upgrade settings)
  // may hold this character's knowledge in the global extension_settings store.
  const legacy = characterName
    ? extension_settings[MODULE_NAME]?.characters?.[characterName]?.epistemic_knowledge
    : null;

  const { entries, migrated } = resolveChatEpistemic(meta, legacy);

  if (migrated) {
    // Clear the global copy so it can never leak into a different chat or AU
    // branch with the same character.
    const s = extension_settings[MODULE_NAME];
    if (s?.characters?.[characterName]) {
      s.characters[characterName].epistemic_knowledge = [];
      saveSettingsDebounced();
    }
    context.saveMetadata()?.catch?.(console.error);
  }

  return entries;
}

/**
 * Records a message-anchored state snapshot after a manual epistemic edit.
 * Without this, the next swipe/delete rollback would restore an older snapshot
 * and silently discard the user's edit.
 */
function snapshotCurrentState() {
  const context = getContext();
  const length = context.chat?.length ?? 0;
  if (length === 0) return;
  takeStateSnapshot(Math.max(0, length - 1));
}

/**
 * Persists the chat-scoped epistemic knowledge entries for the current chat.
 *
 * Writes to chatMetadata only - never to the global settings store - so
 * chat-specific secrets stay with their chat.
 *
 * @param {string} characterName - Retained for signature compatibility.
 * @param {Array<Object>} entries
 */
export function saveEpistemicKnowledge(characterName, entries) {
  if (!Array.isArray(entries)) return;
  void characterName;
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  // Cap stored entries to the 100 most recent. Without this, repeated scene
  // extractions accumulate stale perspectives indefinitely and the chat-scoped
  // store grows without bound.
  if (entries.length > 100) entries = entries.slice(-100);
  context.chatMetadata[META_KEY].epistemic_knowledge = entries;
  context.saveMetadata()?.catch?.(console.error);
  snapshotCurrentState();
}

/**
 * Removes all chat-scoped epistemic knowledge entries for the current chat.
 * Also clears any legacy global copy for the character so migrated data does
 * not reappear in a later chat.
 *
 * @param {string} characterName
 */
export function clearEpistemicKnowledge(characterName) {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    context.chatMetadata[META_KEY].epistemic_knowledge = [];
    context.saveMetadata()?.catch?.(console.error);
  }

  const s = extension_settings[MODULE_NAME];
  if (characterName && s?.characters?.[characterName]) {
    s.characters[characterName].epistemic_knowledge = [];
    saveSettingsDebounced();
  }
  snapshotCurrentState();
}

// ---- Deduplication ----------------------------------------------------------

/**
 * Returns true when two epistemic entries are near-duplicates.
 * Uses cosine similarity on embeddings when available; falls back to Jaccard.
 *
 * Entries must share the same type and subject to be considered for dedup.
 * For hiding entries, targets must also match.
 *
 * @param {Object} a - Existing entry.
 * @param {Object} b - Incoming entry.
 * @param {number[][]} [vectors] - Pre-fetched embedding vectors [vecA, vecB], if available.
 * @returns {boolean}
 */
function isEpistemicDuplicate(a, b, vectors) {
  // Only compare entries of the same type, subject, and (for hiding) target.
  if (a.type !== b.type) return false;
  if (a.subject.toLowerCase() !== b.subject.toLowerCase()) return false;
  if (a.type === 'hiding' && a.target?.toLowerCase() !== b.target?.toLowerCase()) return false;

  const DEDUP_THRESHOLD = 0.7;

  if (vectors) {
    const [vecA, vecB] = vectors;
    if (vecA && vecB && vecA.length > 0 && vecB.length > 0) {
      return cosineSimilarity(vecA, vecB) >= DEDUP_THRESHOLD;
    }
  }

  // Jaccard fallback when embeddings are unavailable.
  const wordsA = new Set(a.content.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.content.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const jaccard = intersection / (wordsA.size + wordsB.size - intersection);
  return jaccard >= DEDUP_THRESHOLD;
}

// ---- Extraction -------------------------------------------------------------

/**
 * Formats the scene messages into the plain-text excerpt used by the model.
 *
 * @param {Object[]} sceneMessages
 * @returns {string}
 */
function buildEpistemicSceneExcerpt(sceneMessages) {
  return (sceneMessages ?? [])
    .filter((m) => m.mes && !m.is_system)
    .map((m) => `${m.name}: ${m.mes}`)
    .join('\n\n');
}

/**
 * Assigns id, timestamp, and source range to freshly parsed entries.
 *
 * @param {Object[]} entries
 * @param {Object[]} sceneMessages
 */
function stampEpistemicEntries(entries, sceneMessages) {
  const context = getContext();
  const chatLen = context.chat?.length ?? 1;
  const windowEnd = Math.max(0, chatLen - 2);
  const windowStart = Math.max(0, windowEnd - (sceneMessages?.length ?? 0) + 1);
  for (const entry of entries) {
    entry.id = generateMemoryId();
    entry.ts = Date.now();
    entry.source_messages = [windowStart, windowEnd];
  }
}

/**
 * Fetches embeddings for the existing + incoming content strings in one batch.
 * Returns null when embeddings are unavailable so callers fall back to Jaccard.
 *
 * @param {Object[]} existing
 * @param {Object[]} parsed
 * @returns {Promise<Map<string, number[]>|null>}
 */
async function fetchEpistemicEmbeddings(existing, parsed) {
  try {
    const texts = [...existing.map((e) => e.content), ...parsed.map((e) => e.content)];
    if (texts.length === 0) return null;
    return await getEmbeddingBatch(texts);
  } catch {
    return null;
  }
}

/**
 * Removes incoming entries that duplicate an existing entry.
 *
 * @param {Object[]} parsed - Incoming entries.
 * @param {Object[]} existing - Entries that survived retirement.
 * @param {Map<string, number[]>|null} embeddings
 * @returns {Object[]}
 */
function filterDuplicateEpistemicEntries(parsed, existing, embeddings) {
  const newEntries = [];
  for (const incoming of parsed) {
    const incomingVec = embeddings?.get(incoming.content.trim()) ?? null;
    const isDup = existing.some((ex) => {
      const existingVec = embeddings?.get(ex.content.trim()) ?? null;
      const vectors = incomingVec && existingVec ? [existingVec, incomingVec] : null;
      return isEpistemicDuplicate(ex, incoming, vectors);
    });
    if (!isDup) newEntries.push(incoming);
  }
  return newEntries;
}

/**
 * Canonicalises parsed entry subjects to the card character name for solo chats.
 *
 * Weak models rarely echo the full card name in the subject field - a card named
 * "Elara Voss" often produces entries with subject "Elara". Injection filters
 * entries by subject, so an unmatched short form would be silently dropped.
 * Rewriting the subject to the card name keeps those entries retrievable.
 *
 * Only subjects that resolve to `characterName` via matchSubjectToMember are
 * touched; unrelated subjects are left as-is so a multi-character scene does not
 * misattribute entries to the card character.
 *
 * @param {Object[]} entries - Freshly parsed entries (mutated in place).
 * @param {string} characterName - Card character name (storage key).
 */
function normalizeParsedSubjects(entries, characterName) {
  if (!characterName) return;
  for (const entry of entries ?? []) {
    if (entry && typeof entry.subject === 'string') {
      entry.subject = normalizeEpistemicSubject(entry.subject, characterName);
    }
  }
}

/**
 * Guards against a model retiring the entire existing entry list in one pass.
 *
 * A response that flags every entry for retirement is almost always a model
 * failure (e.g. it echoed the whole list with [retire] tags) rather than a
 * genuine scene-level reset, and applying it would wipe the character's
 * knowledge map. When the flagged count covers all existing entries and there
 * are more than two, log a warning and keep only the first
 * MAX_EPISTEMIC_RETIREMENTS retirements.
 *
 * The incoming set is also validated here: only positive integers are kept, and
 * at most MAX_EPISTEMIC_RETIREMENTS indices are honored per pass.
 *
 * @param {Set<number>} retireIndices - 1-based indices flagged by the model.
 * @param {Object[]} existing - Existing entries the indices refer to.
 * @returns {Set<number>} Possibly-trimmed retire index set.
 */
function guardMassRetirement(retireIndices, existing) {
  // Drop anything that is not a valid 1-based positive integer.
  const valid = new Set();
  for (const n of retireIndices) {
    if (Number.isInteger(n) && n > 0) valid.add(n);
    if (valid.size >= MAX_EPISTEMIC_RETIREMENTS) break;
  }
  retireIndices = valid;

  if (existing.length > 2 && retireIndices.size >= existing.length) {
    console.warn(
      `[SmartMemory] Epistemic mass-retirement guard: model flagged ${retireIndices.size} of ${existing.length} entries for retirement. Retiring only the first ${MAX_EPISTEMIC_RETIREMENTS} to protect the knowledge map.`,
    );
    retireIndices = new Set(
      [...retireIndices].sort((a, b) => a - b).slice(0, MAX_EPISTEMIC_RETIREMENTS),
    );
  }
  return retireIndices;
}

/**
 * Runs the epistemic extraction pass for a completed scene.
 *
 * Called at scene breaks only - not every extraction cycle. Epistemic facts are
 * established at specific moments and stay stable; running every message adds noise.
 *
 * Entries are stored under the card character's key but cover ALL named characters
 * in the scene. On injection only entries for the responding character are used.
 *
 * @param {Object[]} sceneMessages - Messages from the completed scene.
 * @param {string} characterName - Card character name (storage key).
 * @param {string} [_characterCardExcerpt] - Reserved for future use (card context for the prompt).
 * @returns {Promise<number>} Number of new entries added.
 */
export async function extractEpistemicKnowledge(
  sceneMessages,
  characterName,
  _characterCardExcerpt = '',
) {
  if (!isEpistemicEnabled() || !characterName) return 0;

  const settings = extension_settings[MODULE_NAME];

  try {
    const chatExcerpt = buildEpistemicSceneExcerpt(sceneMessages);
    if (!chatExcerpt.trim()) return 0;

    const participants = getSceneParticipants(sceneMessages);

    // Load existing entries before building the prompt so they can be passed
    // in for supersession checking. The model outputs [retire] <n> lines for
    // any existing entry it determines the scene has resolved or contradicted.
    const existing = loadEpistemicKnowledge(characterName);

    const prompt = buildEpistemicExtractionPrompt(chatExcerpt, participants, existing);

    const response = await generateMemoryExtract(prompt, {
      responseLength: settings.epistemic_response_length ?? 400,
    });

    smLog('[SmartMemory] Epistemic raw response:', response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    // Parse retire indices first so the caller can filter before dedup.
    const retireIndices = guardMassRetirement(parseEpistemicRetireIndices(response), existing);
    const retiredCount = retireIndices.size;

    // Filter existing entries - remove any the model flagged as superseded.
    // 1-based indices; out-of-range values are silently ignored.
    const survivingExisting = existing.filter((_, i) => !retireIndices.has(i + 1));

    if (retiredCount > 0) {
      smLog(
        `[SmartMemory] Epistemic: retired ${retiredCount} superseded entries for "${characterName}".`,
      );
    }

    const parsed = parseEpistemicResponse(response);
    if (parsed.length === 0 && retiredCount === 0) {
      smLog('[SmartMemory] Epistemic extraction produced no parseable lines.');
      return 0;
    }

    // Normalize short-form subjects ("Elara" -> "Elara Voss") to the card name
    // so per-character injection still finds them in a solo chat.
    normalizeParsedSubjects(parsed, characterName);

    // Assign ids and source range.
    stampEpistemicEntries(parsed, sceneMessages);

    // Fetch embeddings for all content strings in one batch when possible.
    const embeddings = await fetchEpistemicEmbeddings(survivingExisting, parsed);
    const newEntries = filterDuplicateEpistemicEntries(parsed, survivingExisting, embeddings);

    if (newEntries.length === 0 && retiredCount === 0) {
      smLog('[SmartMemory] All epistemic candidates were duplicates of existing entries.');
      return 0;
    }

    saveEpistemicKnowledge(characterName, [...survivingExisting, ...newEntries]);
    smLog(
      `[SmartMemory] Epistemic: added ${newEntries.length} new entries, retired ${retiredCount} for "${characterName}".`,
    );
    return newEntries.length;
  } catch (err) {
    smLog('[SmartMemory] Epistemic extraction failed:', err.message);
    return 0;
  }
}

/**
 * Runs one epistemic extraction pass for a group scene and partitions the
 * resulting entries by subject.
 *
 * Group scenes contain several named characters in a single model response.
 * All members' entries are stored in the chat-scoped
 * `chatMetadata[META_KEY].epistemic_knowledge` array (entries carry a subject
 * field), so the whole group's perspectives stay with this chat and can never
 * cross-contaminate another chat or AU branch with the same characters.
 *
 * `[retire] <n>` indices refer to the combined chat-scoped entry list and are
 * applied back to that single list.
 *
 * @param {Object[]} sceneMessages - Messages from the completed scene.
 * @param {string[]} groupMemberNames - Active group members (subject keys).
 * @returns {Promise<number>} Number of new entries added across all members.
 */
export async function extractAndPartitionGroupEpistemic(sceneMessages, groupMemberNames) {
  if (!isEpistemicEnabled()) return 0;

  const memberNames = [...new Set((groupMemberNames ?? []).filter(Boolean))];
  if (memberNames.length === 0) return 0;

  const settings = extension_settings[MODULE_NAME];

  try {
    const chatExcerpt = buildEpistemicSceneExcerpt(sceneMessages);
    if (!chatExcerpt.trim()) return 0;

    const sceneParticipants = getSceneParticipants(sceneMessages);
    const participants = [...new Set([...sceneParticipants, ...memberNames])];

    // Chat-scoped: every member's entries live in one array for this chat.
    // loadEpistemicKnowledge returns the chat array regardless of which member
    // key is passed, so reading once is enough.
    const existing = [...loadEpistemicKnowledge(memberNames[0])];

    const prompt = buildEpistemicExtractionPrompt(chatExcerpt, participants, existing);

    const response = await generateMemoryExtract(prompt, {
      responseLength: settings.epistemic_response_length ?? 400,
    });

    smLog('[SmartMemory] Group epistemic raw response:', response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    const retireIndices = guardMassRetirement(parseEpistemicRetireIndices(response), existing);
    const retiredCount = retireIndices.size;

    // Retire indices refer to the combined chat-scoped list.
    const survivingExisting = existing.filter((_, i) => !retireIndices.has(i + 1));

    const parsed = parseEpistemicResponse(response);
    if (parsed.length === 0 && retiredCount === 0) {
      smLog('[SmartMemory] Group epistemic extraction produced no parseable lines.');
      return 0;
    }

    stampEpistemicEntries(parsed, sceneMessages);

    const embeddings = await fetchEpistemicEmbeddings(survivingExisting, parsed);

    const { grouped, skipped } = partitionEpistemicEntriesBySubject(parsed, memberNames);
    if (skipped.length > 0) {
      smLog(
        `[SmartMemory] Group epistemic: skipped ${skipped.length} entries for non-member subjects.`,
      );
    }

    const incoming = [...grouped.values()].flat();
    const newEntries = filterDuplicateEpistemicEntries(incoming, survivingExisting, embeddings);

    if (newEntries.length === 0 && retiredCount === 0) {
      smLog('[SmartMemory] Group epistemic: all candidates were duplicates.');
      return 0;
    }

    saveEpistemicKnowledge(memberNames[0], [...survivingExisting, ...newEntries]);
    smLog(
      `[SmartMemory] Group epistemic: added ${newEntries.length} new entries, retired ${retiredCount} across ${memberNames.length} members.`,
    );
    return newEntries.length;
  } catch (err) {
    smLog('[SmartMemory] Group epistemic extraction failed:', err.message);
    return 0;
  }
}

// ---- Injection --------------------------------------------------------------

/**
 * Builds the injection text block for a responding character from their
 * perspective-scoped knowledge entries.
 *
 * Groups entries by type into labelled sections. The [hiding] entries are
 * included here (the UI places them behind a spoiler; the prompt injection
 * intentionally includes them so the AI can maintain the deception correctly).
 * The [unaware] block is opt-in via epistemic_inject_unaware (default true).
 *
 * @param {Object[]} entries - All epistemic entries for this character.
 * @param {string} respondingChar - Name of the character being injected for.
 * @param {Object} settings - extension_settings[MODULE_NAME].
 * @param {number|null} [lastSeenMsg] - Highest message index reflected in the entries.
 * @returns {string} Formatted injection block, or empty string if nothing to inject.
 */
function buildEpistemicBlock(entries, respondingChar, settings, lastSeenMsg = null) {
  // Filter to entries where this character is the subject. Uses the shared
  // matcher rather than a strict string compare so a card named "Elara Voss"
  // still picks up entries the model emitted with the short form "Elara".
  const relevant = entries.filter(
    (e) => matchSubjectToMember(e.subject, [respondingChar]) !== null,
  );
  if (relevant.length === 0) return '';

  const byType = {
    knows: relevant.filter((e) => e.type === 'knows'),
    suspects: relevant.filter((e) => e.type === 'suspects'),
    unaware: relevant.filter((e) => e.type === 'unaware'),
    believes: relevant.filter((e) => e.type === 'believes'),
    hiding: relevant.filter((e) => e.type === 'hiding'),
  };

  const lines = [
    `[Perspectives & Secrets as of turn #${lastSeenMsg ?? 'current'}]:`,
    `What ${respondingChar} knows and believes:`,
  ];

  if (byType.knows.length > 0) {
    lines.push(`Knows:`);
    for (const e of byType.knows) lines.push(`- ${e.content}`);
  }

  if (byType.suspects.length > 0) {
    lines.push(`Suspects (unconfirmed):`);
    for (const e of byType.suspects) lines.push(`- ${e.content}`);
  }

  if (settings.epistemic_inject_unaware !== false && byType.unaware.length > 0) {
    lines.push(`Does not know:`);
    for (const e of byType.unaware) lines.push(`- ${e.content}`);
  }

  if (byType.believes.length > 0) {
    lines.push(`Believes (but is false):`);
    for (const e of byType.believes) lines.push(`- ${e.content}`);
  }

  if (byType.hiding.length > 0) {
    lines.push(`Concealing:`);
    for (const e of byType.hiding) lines.push(`- from ${e.target}: ${e.content}`);
  }

  return lines.join('\n');
}

/**
 * Injects the perspective-scoped knowledge block for the responding character.
 * Clears the slot when the feature is disabled or no relevant entries exist.
 *
 * When warn is true and the block exceeds the effective budget, the user is
 * offered a chance to grow the per-chat budget. In normal roleplay the budget
 * grows by 100 tokens per confirmation. When exactFit is also true (catch-up
 * mode) the budget jumps directly to the size needed so the user is only asked
 * once. The override is stored in chatMetadata and does not affect the settings
 * slider.
 *
 * @param {string} characterName - Card character name (storage key for entries).
 * @param {string} respondingCharName - The character currently responding.
 * @param {boolean} [updateTelemetry=false] - Whether to update the token usage bar.
 * @param {boolean} [warn=false] - Whether to prompt the user when the budget is exceeded.
 * @param {boolean} [exactFit=false] - When true, grow to exact needed size rather than +100.
 */
export function injectEpistemicKnowledge(
  characterName,
  respondingCharName,
  updateTelemetry = false,
  warn = false,
  exactFit = false,
) {
  const settings = extension_settings[MODULE_NAME];

  const clear = () => {
    setMacroContent(MACRO_NAMES.epistemic, '');
    setExtensionPrompt(PROMPT_KEY_EPISTEMIC, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_EPISTEMIC);
    if (updateTelemetry) updateEpistemicTelemetry(0);
  };

  if (!isEpistemicEnabled() || !characterName || !respondingCharName) {
    clear();
    return;
  }

  const entries = loadEpistemicKnowledge(characterName);
  if (entries.length === 0) {
    clear();
    return;
  }

  const block = buildEpistemicBlock(entries, respondingCharName, settings, getLastSeenMsg());
  if (!block) {
    clear();
    return;
  }

  // Apply token budget cap, using the per-chat override when set.
  let budget = getEffectiveEpistemicBudget(settings);
  let content = block;
  const fullTokens = estimateTokens(content);

  if (estimateTokens(content) > budget) {
    if (warn && !_epistemicWarnedThisLoad) {
      const needed = estimateTokens(content);
      const increment = exactFit ? needed - budget + 100 : 100;
      const newBudget = budget + increment;
      const grew = confirm(
        exactFit
          ? `Your Perspectives & Secrets list needs ${needed} tokens but the current budget for this chat is ${budget}.\n\nIncrease the budget to ${newBudget} for this roleplay? This will consume more VRAM and prompt size.\n\nThis does not change your settings.`
          : `Your Perspectives & Secrets list needs ${needed} tokens but the current budget for this chat is ${budget}.\n\nIncrease the budget by 100 tokens for this roleplay? This will consume more VRAM and prompt size.\n\nThis does not change your settings.`,
      );
      if (grew) {
        budget = newBudget;
        saveEpistemicBudgetOverride(budget);
        // Leave _epistemicWarnedThisLoad false so the user can keep growing
        // in +100 increments if the list still does not fit after this step.
      } else {
        _epistemicWarnedThisLoad = true;
      }
    }
    // Trim to the (possibly just-grown) budget by dropping lines from the end.
    const blockLines = content.split('\n');
    while (blockLines.length > 1 && estimateTokens(blockLines.join('\n')) > budget) {
      blockLines.pop();
    }
    content = blockLines.join('\n');
  }

  reportTierTrimStats(PROMPT_KEY_EPISTEMIC, estimateTokens(content), fullTokens);

  setMacroContent(MACRO_NAMES.epistemic, content);
  if (isMacroActive(MACRO_NAMES.epistemic)) {
    setExtensionPrompt(PROMPT_KEY_EPISTEMIC, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_EPISTEMIC);
  } else {
    setExtensionPrompt(
      PROMPT_KEY_EPISTEMIC,
      content,
      settings.epistemic_position ?? extension_prompt_types.IN_CHAT,
      settings.epistemic_depth ?? 2,
      false,
      settings.epistemic_role ?? extension_prompt_roles.SYSTEM,
    );
  }

  if (updateTelemetry) updateEpistemicTelemetry(estimateTokens(content));
}

/**
 * Restores and re-injects epistemic knowledge on chat load or character change.
 * No extraction is run - only previously stored entries are re-injected.
 *
 * @param {string} characterName - Card character name (storage key).
 * @param {string} respondingCharName - The character currently responding.
 */
export function loadAndInjectEpistemicKnowledge(characterName, respondingCharName) {
  injectEpistemicKnowledge(characterName, respondingCharName, false);
}

// ---- Telemetry (token usage bar) --------------------------------------------

/**
 * Updates the epistemic slice of the token usage bar.
 * No-op when the bar element is not present in the DOM.
 *
 * @param {number} tokens - Estimated token count of the injected block.
 */
function updateEpistemicTelemetry(tokens) {
  const el = document.querySelector('.sm-token-bar-epistemic');
  if (!el) return;
  el.style.setProperty('--sm-tokens', tokens);
  el.setAttribute('data-tokens', tokens);
}
