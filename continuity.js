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
 * Continuity checker: transcript-grounded contradiction detection and anchored,
 * forward-only repair.
 *
 * The checker compares the latest AI response against established facts, but it
 * is given the recent transcript as ground truth so it does not mistake normal
 * story progression (moving, using an item, learning something, time passing)
 * for a contradiction. Baseline notes are explicitly treated as lagging.
 *
 * Any contradiction the model returns is verified before use:
 * - category must be a permanent category
 * - why_not_progression must be substantive
 * - response_quote must appear verbatim in the latest response
 * - fact must appear verbatim in the baseline notes
 *
 * Repair is forward-only and anchored. The note never asks the model to revoke
 * or re-narrate a past event. It is stored against the index and text hash of
 * the message the check ran on, so a swipe, edit, or deletion invalidates it
 * instead of applying a correction to a rewritten turn.
 *
 * Confirmed contradictions also create durable retcons that are re-injected for
 * several turns and auto-resolve as canon once the story moves past them. Both
 * the anchored note and the durable retcons are chat-scoped and survive only
 * while the turns that produced them survive; a state-snapshot rollback on
 * swipe/delete restores the previous retcon state.
 *
 * checkContinuity        - runs a verified contradiction check against the last AI message
 * handleContinuityResult - respects continuity_mode (off/warn/repair) and queues a note
 * addDurableRetcons      - records durable retcons for confirmed contradictions
 * advanceDurableRetcons  - decrements retcon lifetimes once per AI turn
 * applyPendingRepair     - validates the anchor and injects the active continuity notes
 * clearRepair            - removes pending repair state, storage, and prompt slot
 * buildForwardRepairNote - builds the forward-only note (pure helper, re-exported)
 * gatherEstablishedFacts - collects character card, summary, and memories
 * loadAndInjectRepair    - restores a stored anchored note on chat load
 */

import { generateMemoryExtract } from './generate.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { power_user } from '../../../../scripts/power-user.js';
import { MODULE_NAME, META_KEY, PROMPT_KEY_REPAIR, generateMemoryId } from './constants.js';
import { buildContinuityPrompt } from './prompts.js';
import { loadCharacterMemories, applyRetconToLongterm } from './longterm.js';
import { loadSessionMemories } from './session.js';
import { applyRetconToStateLedger } from './state-ledger.js';
import { setContinuityBadge } from './ui.js';
import { smLog } from './logging.js';
import {
  buildRecentTranscript,
  hashText,
  validateIssue,
  buildForwardRepairNote,
  parseContinuityJson,
  isPendingRepairAnchorValid,
  buildDurableRetconNote,
  advanceRetconLifetimes,
  invalidateAcceptedRetcons,
  getResolvedRetconFact,
  inferRetconStateUpdate,
  RETCON_TURNS,
} from './continuity-utils.js';

// Re-export the pure helpers so the pipeline API lives in one place.
export {
  buildRecentTranscript,
  hashText,
  validateIssue,
  buildForwardRepairNote,
  parseContinuityJson,
  isPendingRepairAnchorValid,
  buildDurableRetconNote,
  advanceRetconLifetimes,
  invalidateAcceptedRetcons,
  getResolvedRetconFact,
  inferRetconStateUpdate,
  RETCON_TURNS,
};

// chatMetadata key under META_KEY where the pending repair note is stored.
const REPAIR_KEY = 'pendingRepair';

// chatMetadata key under META_KEY where durable retcons are stored.
const RETCONS_KEY = 'durable_retcons';

// In-memory mirror of the anchored repair note. Kept alongside chatMetadata so
// the hot path (apply before generation) does not need a storage round-trip.
let pendingRepair = null;

const CONTINUITY_MODES = new Set(['off', 'warn', 'repair']);

/**
 * Resolves the active continuity mode, honouring the legacy
 * continuity_auto_repair flag for settings saved before continuity_mode existed.
 * @returns {'off'|'warn'|'repair'}
 */
function getContinuityMode() {
  const settings = extension_settings[MODULE_NAME] ?? {};
  if (CONTINUITY_MODES.has(settings.continuity_mode)) return settings.continuity_mode;
  return settings.continuity_auto_repair ? 'repair' : 'warn';
}

// ---- Durable retcon storage -------------------------------------------------

/**
 * Returns the chat's durable continuity retcons.
 *
 * Retcon shape:
 *   { id, fact, quote, category, as_of_msg, created_at, turns_remaining }
 *
 * @returns {Array<Object>}
 */
export function loadDurableRetcons() {
  const context = getContext();
  const retcons = context.chatMetadata?.[META_KEY]?.[RETCONS_KEY];
  return Array.isArray(retcons) ? retcons : [];
}

/**
 * Persists the chat's durable continuity retcons to chatMetadata.
 *
 * @param {Array<Object>} retcons
 */
function saveDurableRetcons(retcons) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY][RETCONS_KEY] = retcons;
  context.saveMetadata()?.catch?.(console.error);
}

/**
 * Returns the names of the active chat's characters, used to route a resolved
 * retcon's new baseline fact into the correct long-term memory store(s).
 *
 * @returns {string[]}
 */
function getActiveCharacterNames() {
  const context = getContext();
  if (context.groupId) {
    const group = (context.groups ?? []).find(
      (candidate) => String(candidate?.id) === String(context.groupId),
    );
    if (group) {
      const disabled = new Set(group.disabled_members ?? []);
      return (group.members ?? [])
        .filter((avatar) => !disabled.has(avatar))
        .map((avatar) => (context.characters ?? []).find((char) => char?.avatar === avatar)?.name)
        .filter(Boolean);
    }
  }
  const active = context.characters?.[context.characterId];
  return active?.name ? [active.name] : [];
}

/**
 * Picks the character store(s) a retcon applies to. A fact that names a group
 * member only touches that member's memories; a solo chat falls back to the
 * only available character.
 *
 * @param {string[]} names
 * @param {string} fact
 * @returns {string[]}
 */
function selectRetconTargets(names, fact) {
  const list = [...new Set((names ?? []).filter(Boolean))];
  if (list.length === 0) return [];

  const factText = String(fact ?? '').toLowerCase();
  const matching = list.filter((name) =>
    String(name)
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length >= 2)
      .some((token) => factText.includes(token)),
  );
  if (matching.length > 0) return matching;
  return list.length === 1 ? list : [];
}

/**
 * Applies a resolved or user-accepted retcon to chat state so the old baseline
 * stops asserting the superseded fact. This is what keeps a repetition loop
 * from re-flagging the same contradiction after the retcon's lifetime ends.
 *
 * - Long-term memories: the memory matching `retcon.fact` is retired via
 *   `superseded_by`, and the resolved fact becomes the new active baseline.
 * - State ledger: when the retcon describes a state-card attribute, the
 *   entity's card field is updated.
 *
 * @param {Object} retcon
 * @param {string|string[]|null} [characterName=null] - Explicit character(s), or
 *   null to resolve against the active chat's characters.
 */
function resolveRetconIntoState(retcon, characterName = null) {
  if (!retcon || typeof retcon !== 'object') return;

  const oldFact = String(retcon.fact ?? '').trim();
  const resolvedFact = getResolvedRetconFact(retcon);
  // A retcon without a distinct changed state has nothing to install - leaving
  // the baseline alone avoids creating a duplicate of the old fact.
  if (!oldFact || !resolvedFact) return;
  if (oldFact.toLowerCase() === resolvedFact.toLowerCase()) return;

  const names =
    characterName == null
      ? getActiveCharacterNames()
      : Array.isArray(characterName)
        ? characterName.filter(Boolean)
        : [characterName];

  for (const name of selectRetconTargets(names, oldFact)) {
    try {
      applyRetconToLongterm(name, retcon);
    } catch (err) {
      console.error('[SmartMemory] Failed to apply resolved retcon to long-term memory:', err);
    }
  }

  try {
    applyRetconToStateLedger(retcon);
  } catch (err) {
    console.error('[SmartMemory] Failed to apply resolved retcon to state ledger:', err);
  }
}

/**
 * Adds durable retcon entries for confirmed contradictions. Each entry lives
 * for RETCON_TURNS AI turns (or until the user accepts the change) so the
 * continuity note is no longer a fragile one-shot.
 *
 * @param {Array<Object>} issues - Validated contradiction issues.
 * @param {number} asOfMsg - Message index the contradictions were found on.
 * @returns {number} Number of retcons added.
 */
export function addDurableRetcons(issues, asOfMsg) {
  const list = Array.isArray(issues) ? issues : [];
  if (list.length === 0) return 0;

  const retcons = loadDurableRetcons();
  const existingFacts = new Set(
    retcons
      .map((retcon) =>
        String(retcon?.fact ?? '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );

  let added = 0;
  for (const issue of list) {
    const fact = String(issue?.fact ?? '').trim();
    if (!fact) continue;
    // Do not stack the same contradiction re-confirmed on later turns.
    if (existingFacts.has(fact.toLowerCase())) continue;

    retcons.push({
      id: generateMemoryId(),
      fact,
      quote: String(issue?.response_quote ?? '').trim(),
      category: String(issue?.category ?? '').trim(),
      as_of_msg: Number.isInteger(asOfMsg) ? asOfMsg : null,
      created_at: Date.now(),
      turns_remaining: RETCON_TURNS,
    });
    existingFacts.add(fact.toLowerCase());
    added++;
  }

  if (added > 0) saveDurableRetcons(retcons);
  return added;
}

/**
 * Advances every active retcon by one AI turn, dropping those that have
 * reached the end of their lifespan (auto-resolved as canon). Expired retcons
 * are written into state first so the old baseline fact is superseded by the
 * newly canonised state.
 *
 * Called once per committed AI turn (once per full group round).
 *
 * @param {string|string[]|null} [characterName=null] - Character(s) whose
 *   long-term store should receive the resolved fact. Null resolves against the
 *   active chat.
 * @returns {number} Number of active retcons remaining.
 */
export function advanceDurableRetcons(characterName = null) {
  const retcons = loadDurableRetcons();
  if (retcons.length === 0) return 0;
  const advanced = advanceRetconLifetimes(retcons);
  const survivingIds = new Set(advanced.map((retcon) => retcon?.id).filter(Boolean));
  const survivingFacts = new Set(
    advanced
      .map((retcon) =>
        String(retcon?.fact ?? '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  for (const retcon of retcons) {
    if (!retcon) continue;
    const factKey = String(retcon.fact ?? '')
      .trim()
      .toLowerCase();
    if ((retcon.id && survivingIds.has(retcon.id)) || (factKey && survivingFacts.has(factKey))) {
      continue;
    }
    resolveRetconIntoState(retcon, characterName);
  }
  saveDurableRetcons(advanced);
  return advanced.length;
}

/**
 * Drops retcons the user has implicitly accepted by echoing the flagged quote
 * in their reply. When the user writes the changed state themselves, the
 * repair is moot; the accepted state becomes the new baseline so it is never
 * re-flagged.
 *
 * @param {string} userText - Text of the user's most recent turn.
 * @param {string|string[]|null} [characterName=null] - Character(s) whose
 *   long-term store should receive the resolved fact.
 * @returns {number} Number of retcons removed.
 */
export function invalidateAcceptedDurableRetcons(userText, characterName = null) {
  const retcons = loadDurableRetcons();
  if (retcons.length === 0) return 0;
  const remaining = invalidateAcceptedRetcons(retcons, userText);
  if (remaining.length !== retcons.length) {
    // invalidateAcceptedRetcons filters the input, so surviving entries are the
    // same object references and identity comparison is exact even for legacy
    // retcons without an id.
    const remainingSet = new Set(remaining);
    const accepted = retcons.filter((retcon) => retcon && !remainingSet.has(retcon));
    for (const retcon of accepted) resolveRetconIntoState(retcon, characterName);
    saveDurableRetcons(remaining);
    return accepted.length;
  }
  return 0;
}

/**
 * Collects all established facts into a single labelled text block.
 * Pulls from the short-term summary, long-term memories, and session memories
 * so the model has the full picture of what is "known" for this chat.
 *
 * These are baseline notes, not ground truth: they frequently lag behind the
 * transcript. The continuity prompt says so explicitly.
 *
 * @param {string} characterName
 * @returns {string} Multi-section fact block, or empty string if nothing is stored.
 */
export function gatherEstablishedFacts(characterName) {
  const context = getContext();
  const meta = context.chatMetadata?.[META_KEY];
  const parts = [];

  // The character card is the canonical source of truth - check it first.
  // Characters may contradict their card (wrong gender, species, etc.) in ways
  // that no extracted memory would catch, especially in a fresh chat.
  // Look up by name so group chat checks use the responder's card, not the
  // ST-active character (context.characterId) which may be a different member.
  const char = context.characters?.find((c) => c.name === characterName);
  if (char) {
    const cardParts = [];
    if (char.description) cardParts.push(char.description);
    if (char.personality) cardParts.push('Personality: ' + char.personality);
    if (char.scenario) cardParts.push('Scenario: ' + char.scenario);
    if (cardParts.length > 0) {
      parts.push('-- CHARACTER CARD --\n' + cardParts.join('\n'));
    }
  }

  // Include the active user persona description so the checker does not flag
  // accurate descriptions of the user's character as contradictions.
  const personaDesc = power_user?.persona_description?.trim();
  if (personaDesc) {
    parts.push('-- USER PERSONA --\n' + personaDesc);
  }

  if (meta?.summary) {
    parts.push('-- STORY SUMMARY --\n' + meta.summary);
  }

  if (characterName) {
    const longterm = loadCharacterMemories(characterName).filter((m) => !m.superseded_by);
    if (longterm.length > 0) {
      const text = longterm.map((m) => `[${m.type}] ${m.content}`).join('\n');
      parts.push('-- LONG-TERM MEMORIES --\n' + text);
    }
  }

  const session = loadSessionMemories().filter((m) => !m.superseded_by);
  if (session.length > 0) {
    const text = session.map((m) => `[${m.type}] ${m.content}`).join('\n');
    parts.push('-- SESSION DETAILS --\n' + text);
  }

  return parts.join('\n\n');
}

/**
 * Runs a verified continuity check against the last AI message in the chat.
 *
 * Anchors on the last visible AI message and records its text hash. The model
 * is given the recent transcript (ground truth) plus the baseline notes, and
 * every returned contradiction is filtered through validateIssue before it is
 * returned. Unverifiable or non-permanent issues are dropped.
 *
 * @param {string} characterName - Used to load the correct long-term memories.
 * @param {(() => boolean)|null} [abortCheck=null] - Returns true when the chat
 *   changed mid-check; the check then bails without generating or applying a note.
 * @returns {Promise<{issues: Array<Object>, anchorIdx: number, anchorHash: string}|null>}
 *   Null when the check cannot run (chat too short, no AI anchor, no facts), or
 *   when it is aborted because the user switched chats.
 */
export async function checkContinuity(characterName, abortCheck = null) {
  const settings = extension_settings[MODULE_NAME] ?? {};

  try {
    const context = getContext();
    const chat = context.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;

    // A check needs at least one exchange plus a response to inspect.
    const nonSystem = chat.filter(
      (m) => m && !m.is_system && typeof m.mes === 'string' && m.mes.length > 0,
    );
    if (nonSystem.length < 2) return null;

    // Anchor on the last visible AI message (skip user/system turns).
    let anchorIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
      const message = chat[i];
      if (
        message &&
        !message.is_user &&
        !message.is_system &&
        typeof message.mes === 'string' &&
        message.mes.length > 0
      ) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx === -1) return null;

    const latestText = chat[anchorIdx].mes;
    const anchorHash = hashText(latestText);

    const facts = gatherEstablishedFacts(characterName);
    if (!facts.trim()) return null;

    const recentTranscript = buildRecentTranscript(chat, anchorIdx, 6);
    const prompt = buildContinuityPrompt(facts, recentTranscript, latestText);

    // Bail before the model call if the chat already changed.
    if (abortCheck?.()) return null;

    const response = await generateMemoryExtract(prompt, {
      responseLength: settings.continuity_response_length ?? 400,
    });

    // The generation is slow; the user may have switched chats while it ran.
    // Discard the result rather than applying it to the wrong chat.
    if (abortCheck?.()) return null;

    smLog('[SmartMemory] Continuity check response:', response);

    const issues = parseContinuityJson(response).filter((issue) =>
      validateIssue(issue, latestText, facts, recentTranscript),
    );

    return { issues, anchorIdx, anchorHash };
  } catch (err) {
    console.error('[SmartMemory] Continuity check failed:', err);
    throw err;
  }
}

/**
 * Renders the continuity issues in the settings result panel and updates the
 * header badge. Browser-only; silently no-ops when the panel is not mounted.
 * @param {Array<Object>} issues
 * @param {{queued?: boolean, note?: string}} [options]
 */
function renderContinuityResult(issues, { queued = false, note = '' } = {}) {
  setContinuityBadge(issues.length);

  if (typeof $ !== 'function') return;
  const $result = $('#sm_continuity_result');
  if (!$result.length) return;

  $result.empty().removeClass('sm_continuity_clean').addClass('sm_continuity_warn');
  $result.append('<b>Contradictions found:</b>');

  const $list = $('<ul>');
  issues.forEach((issue, index) => {
    const text = typeof issue === 'string' ? issue : issue.fact || `Contradiction ${index + 1}`;
    $list.append($('<li>').text(text));
  });
  $result.append($list);

  if (queued && note) {
    const $block = $('<div class="sm_repair_queued">');
    $block.append($('<p>').text('Continuity note queued for the next response:'));
    $block.append($('<p class="sm_repair_note">').text(note));
    const $cancel = $('<button class="menu_button sm_repair_cancel">Cancel note</button>');
    $cancel.on('click', () => {
      clearRepair();
      $block.remove();
    });
    $block.append($cancel);
    $result.append($block);
  }

  $result.show();
}

/**
 * Shows a toast for the outcome, if the host page provides toastr.
 * @param {Array<Object>} issues
 * @param {boolean} queued
 */
function notifyContinuityIssues(issues, queued) {
  if (typeof toastr === 'undefined') return;
  const count = issues.length;
  const plural = count === 1 ? '' : 's';
  if (queued) {
    toastr.info(
      `${count} permanent contradiction${plural} found - continuity note queued for the next response.`,
      'Smart Memory',
      { timeOut: 6000, positionClass: 'toast-bottom-right' },
    );
  } else {
    toastr.warning(`${count} permanent contradiction${plural} found.`, 'Smart Memory', {
      timeOut: 8000,
      positionClass: 'toast-bottom-right',
    });
  }
}

/**
 * Applies a continuity check result according to the configured mode.
 *
 * off    - silently discard the result and clear any queued note.
 * warn   - show the issues but never inject anything (the safe default).
 * repair - queue a forward-only, anchored note for the next response.
 *
 * @param {{issues: Array<Object>, anchorIdx: number, anchorHash: string}|null} result
 * @param {string} characterName
 * @param {(() => boolean)|null} [abortCheck=null] - Returns true when the chat
 *   changed since the check started; the result is then discarded untouched so
 *   it cannot render, toast, or queue against a different chat.
 * @returns {{mode: 'off'|'warn'|'repair', issues: Array<Object>}}
 */
export function handleContinuityResult(result, characterName, abortCheck = null) {
  const mode = getContinuityMode();

  if (abortCheck?.()) return { mode, issues: [] };

  const issues = Array.isArray(result?.issues) ? result.issues : [];

  if (!result || issues.length === 0) {
    clearRepair();
    return { mode, issues: [] };
  }

  if (mode === 'off') {
    // Off discards the result without changing the prompt or showing a toast.
    clearRepair();
    return { mode, issues };
  }

  if (mode === 'warn') {
    // Warn never injects, so any previously queued note is no longer relevant.
    clearRepair();
    renderContinuityResult(issues);
    notifyContinuityIssues(issues, false);
    return { mode, issues };
  }

  const note = buildForwardRepairNote(issues, characterName);
  if (!note) {
    clearRepair();
    return { mode, issues };
  }

  pendingRepair = {
    note,
    anchorIdx: result.anchorIdx,
    anchorHash: result.anchorHash,
    // Response quotes let isPendingRepairAnchorValid detect whether the user has
    // already acknowledged the changed state (making the note moot).
    quotes: issues.map((issue) => issue?.response_quote).filter(Boolean),
  };

  // In addition to the anchored one-shot note, record durable retcons so the
  // reminder survives several turns instead of vanishing after one response.
  // The retcon entry is removed by a swipe/delete rollback of its anchor.
  addDurableRetcons(issues, result.anchorIdx);

  const context = getContext();
  if (context.chatMetadata) {
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    context.chatMetadata[META_KEY][REPAIR_KEY] = pendingRepair;
    context.saveMetadata()?.catch(console.error);
  }

  renderContinuityResult(issues, { queued: true, note });
  notifyContinuityIssues(issues, true);
  return { mode, issues };
}

/**
 * Injects the pending repair note if it is still anchored to an unchanged turn.
 *
 * Called immediately before a generation. The note is injected into its own
 * IN_CHAT slot at the configured depth (default 1) as a system prompt. If the
 * anchored message was swiped, edited, or deleted, the note is discarded.
 *
 * @returns {boolean} True when a note was injected.
 */
export function applyPendingRepair() {
  const context = getContext();

  // Recover a note stored by a previous session so it survives chat reloads.
  if (!pendingRepair && context.chatMetadata?.[META_KEY]?.[REPAIR_KEY]) {
    pendingRepair = context.chatMetadata[META_KEY][REPAIR_KEY];
  }

  // If the user's latest turn already adopts the changed state, the retcon is
  // moot - drop it before building the injected note.
  const lastUserText =
    [...(context.chat ?? [])].reverse().find((m) => m?.is_user && typeof m.mes === 'string')?.mes ??
    '';
  if (lastUserText) invalidateAcceptedDurableRetcons(lastUserText);

  // Only repair mode injects anything. Warn and off never inject, so any
  // stored durable retcons stay dormant rather than leaking into the prompt.
  if (getContinuityMode() !== 'repair') {
    setExtensionPrompt(PROMPT_KEY_REPAIR, '', extension_prompt_types.NONE, 0);
    return false;
  }

  // Durable retcons take precedence: they persist across turns so the reminder
  // is not lost after the anchored one-shot note has been consumed.
  const durableNote = buildDurableRetconNote(loadDurableRetcons());

  let content = '';
  if (durableNote) {
    content = durableNote;
  } else if (pendingRepair && isPendingRepairAnchorValid(context.chat, pendingRepair)) {
    content = pendingRepair.note;
  } else {
    // No durable note and no valid anchor - drop any stale one-shot note.
    if (pendingRepair) clearRepair();
    setExtensionPrompt(PROMPT_KEY_REPAIR, '', extension_prompt_types.NONE, 0);
    return false;
  }

  const settings = extension_settings[MODULE_NAME] ?? {};
  const depth = Number.isFinite(settings.repair_depth) ? settings.repair_depth : 1;

  setExtensionPrompt(
    PROMPT_KEY_REPAIR,
    content,
    extension_prompt_types.IN_CHAT,
    depth,
    false,
    extension_prompt_roles.SYSTEM,
  );

  smLog('[SmartMemory] Continuity note injected for the next response.');
  return true;
}

/**
 * Re-injects only the standing durable-retcon note, without arming the
 * one-shot anchored note. Used for every group member after the first in a
 * round so the shared continuity reminder reaches all responders while the
 * one-shot repair stays single-use.
 *
 * @returns {boolean} True when a durable note was injected.
 */
export function applyDurableRetconNote() {
  if (getContinuityMode() !== 'repair') {
    setExtensionPrompt(PROMPT_KEY_REPAIR, '', extension_prompt_types.NONE, 0);
    return false;
  }

  const durableNote = buildDurableRetconNote(loadDurableRetcons());
  if (!durableNote) {
    setExtensionPrompt(PROMPT_KEY_REPAIR, '', extension_prompt_types.NONE, 0);
    return false;
  }

  const settings = extension_settings[MODULE_NAME] ?? {};
  const depth = Number.isFinite(settings.repair_depth) ? settings.repair_depth : 1;
  setExtensionPrompt(
    PROMPT_KEY_REPAIR,
    durableNote,
    extension_prompt_types.IN_CHAT,
    depth,
    false,
    extension_prompt_roles.SYSTEM,
  );
  return true;
}

/**
 * Removes the pending repair from memory, chatMetadata, and the prompt slot.
 * Called after the note is consumed and whenever the anchor is invalidated.
 *
 * @param {object} [options]
 * @param {boolean} [options.keepStored=false] - When true, the live in-memory
 *   state and prompt slot are cleared but the note stored in chatMetadata is
 *   kept. Used on chat change so loadAndInjectRepair() can re-arm this chat's
 *   own note after re-validating its anchor, without leaking another chat's note.
 */
export function clearRepair({ keepStored = false } = {}) {
  pendingRepair = null;

  const context = getContext();
  if (!keepStored && context.chatMetadata?.[META_KEY]) {
    delete context.chatMetadata[META_KEY][REPAIR_KEY];
    context.saveMetadata()?.catch(console.error);
  }

  setExtensionPrompt(PROMPT_KEY_REPAIR, '', extension_prompt_types.NONE, 0);
}

/**
 * Restores a stored anchored repair note on chat load.
 *
 * The stored note is re-armed in memory and re-validated against the chat's
 * current message at its anchor index. If the anchor no longer matches, the
 * note is cleared instead of injected.
 */
export function loadAndInjectRepair() {
  const context = getContext();
  const stored = context.chatMetadata?.[META_KEY]?.[REPAIR_KEY];

  // Re-arm this chat's stored one-shot note (if any) and re-inject any durable
  // retcons that are still active. applyPendingRepair validates the anchor
  // before using the one-shot note, and injects durable retcons regardless.
  pendingRepair = stored ?? null;
  applyPendingRepair();
}
