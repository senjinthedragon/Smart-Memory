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
 * Entries are stored per-character in extension_settings and injected as a
 * private knowledge block for the responding character only.
 *
 * isEpistemicEnabled               - returns true when the feature is active for the current profile
 * loadEpistemicKnowledge           - loads entries for a character from extension_settings
 * saveEpistemicKnowledge           - persists entries for a character
 * clearEpistemicKnowledge          - removes all entries for a character
 * extractEpistemicKnowledge        - runs the extraction pass for the current scene
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
import { parseEpistemicResponse, parseEpistemicRetireIndices } from './parsers.js';
import { getSceneParticipants } from './scenes.js';
import { generateMemoryExtract } from './generate.js';
import { getEmbeddingBatch, cosineSimilarity } from './embeddings.js';
import { smLog } from './logging.js';
import { invalidateUnifiedCache } from './unified-inject.js';
import { getCharacterContainer } from './scope.js';
import { MACRO_NAMES, setMacroContent, isMacroActive } from './macros.js';
import { reportTierTrimStats } from './trim-stats.js';

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
  const block = buildEpistemicBlock(entries, respondingCharName, settings);
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
 * Loads the epistemic knowledge entries for a character from extension_settings.
 *
 * Entry shape:
 *   { id, type, subject, target, content, ts, source_messages }
 *
 * @param {string} characterName
 * @returns {Array<Object>}
 */
export function loadEpistemicKnowledge(characterName) {
  if (!characterName) return [];
  return getCharacterContainer(characterName)?.epistemic_knowledge ?? [];
}

/**
 * Persists the epistemic knowledge entries for a character to extension_settings.
 * Merges with the existing character object so no other fields are overwritten.
 *
 * @param {string} characterName
 * @param {Array<Object>} entries
 */
export function saveEpistemicKnowledge(characterName, entries) {
  if (!characterName || !Array.isArray(entries)) return;
  getCharacterContainer(characterName).epistemic_knowledge = entries;
  saveSettingsDebounced();
}

/**
 * Removes all epistemic knowledge entries for a character.
 * Should be called alongside clearCharacterMemories and clearRelationshipHistory.
 *
 * @param {string} characterName
 */
export function clearEpistemicKnowledge(characterName) {
  if (!characterName) return;
  const s = extension_settings[MODULE_NAME];
  if (!s.characters?.[characterName]) return;
  getCharacterContainer(characterName).epistemic_knowledge = [];
  saveSettingsDebounced();
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
    const chatExcerpt = sceneMessages
      .filter((m) => m.mes && !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join('\n\n');

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
    const retireIndices = parseEpistemicRetireIndices(response);
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

    // Assign ids and source range.
    const context = getContext();
    const chatLen = context.chat?.length ?? 1;
    const windowEnd = Math.max(0, chatLen - 2);
    const windowStart = Math.max(0, windowEnd - sceneMessages.length + 1);
    for (const entry of parsed) {
      entry.id = generateMemoryId();
      entry.ts = Date.now();
      entry.source_messages = [windowStart, windowEnd];
    }

    // Fetch embeddings for all content strings in one batch when possible.
    let embeddings = null;
    try {
      const texts = [...survivingExisting.map((e) => e.content), ...parsed.map((e) => e.content)];
      if (texts.length > 0) {
        embeddings = await getEmbeddingBatch(texts);
      }
    } catch {
      // Embedding fetch failed - fall back to Jaccard inside isEpistemicDuplicate.
    }

    const newEntries = [];
    for (let pi = 0; pi < parsed.length; pi++) {
      const incoming = parsed[pi];
      const incomingVec = embeddings?.get(incoming.content.trim()) ?? null;
      const isDup = survivingExisting.some((ex) => {
        const existingVec = embeddings?.get(ex.content.trim()) ?? null;
        const vectors = incomingVec && existingVec ? [existingVec, incomingVec] : null;
        return isEpistemicDuplicate(ex, incoming, vectors);
      });
      if (!isDup) newEntries.push(incoming);
    }

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
 * @returns {string} Formatted injection block, or empty string if nothing to inject.
 */
function buildEpistemicBlock(entries, respondingChar, settings) {
  // Filter to entries where this character is the subject.
  const relevant = entries.filter((e) => e.subject.toLowerCase() === respondingChar.toLowerCase());
  if (relevant.length === 0) return '';

  const byType = {
    knows: relevant.filter((e) => e.type === 'knows'),
    suspects: relevant.filter((e) => e.type === 'suspects'),
    unaware: relevant.filter((e) => e.type === 'unaware'),
    believes: relevant.filter((e) => e.type === 'believes'),
    hiding: relevant.filter((e) => e.type === 'hiding'),
  };

  const lines = [`What ${respondingChar} knows and believes:`];

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

  const block = buildEpistemicBlock(entries, respondingCharName, settings);
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
      settings.epistemic_depth ?? 1,
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
