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
 * Main entry point: wires all modules together, manages event handlers,
 * and drives the per-message processing loop.
 *
 * Multi-tier memory and narrative context system:
 *   Short-term    Token-threshold structured summary (progressive compaction).
 *   Long-term     Per-character persistent facts across all sessions.
 *   Session       Detailed within-session facts (scene details, revelations).
 *   Scene history Mini-summaries of completed scenes for scene-transition context.
 *   Story arcs    Open plot threads - promises made, tensions, mysteries.
 *   Away recap    "Previously on..." summary when returning after a long break.
 *   Continuity    Manual check: does the last response contradict known facts?
 *   /sm-search    Slash command: semantic search across all tiers, shows results popup.
 *   Graph view    Force-directed canvas visualization of entities and memories.
 *   Activity      Sticky toastr notification shown during background extraction (startActivityLoader/stopActivityLoader).
 */

import {
  eventSource,
  event_types,
  getCurrentChatId,
  saveSettingsDebounced,
  setExtensionPrompt,
  extension_prompt_types,
} from '../../../../script.js';
import {
  getContext,
  extension_settings,
  renderExtensionTemplateAsync,
} from '../../../extensions.js';
import {
  MODULE_NAME,
  META_KEY,
  PROMPT_KEY_SHORT,
  PROMPT_KEY_LONG,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_REPAIR,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_CANON,
  PROMPT_KEY_TRIGGERED,
  PROMPT_KEY_RELATIONSHIPS,
  PROMPT_KEY_EPISTEMIC,
  PROMPT_KEY_STATE_LEDGER,
} from './constants.js';
import { memory_sources, abortCurrentMemoryGeneration } from './generate.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import {
  ARGUMENT_TYPE,
  SlashCommandArgument,
  SlashCommandNamedArgument,
} from '../../../slash-commands/SlashCommandArgument.js';

import { shouldCompact, runCompaction, injectSummary, loadAndInjectSummary } from './compaction.js';
import {
  extractAndStoreMemories,
  consolidateMemories,
  injectMemories,
  loadCharacterMemories,
  isFreshStart,
  injectRelationshipHistory,
  prunePersistentMemoriesAfterRollback,
} from './longterm.js';
import { updateLastActive, getAwayHours, generateRecap, displayRecap } from './recap.js';
import {
  extractSessionMemories,
  consolidateSessionMemories,
  injectSessionMemories,
  loadSessionMemories,
} from './session.js';
import { processSceneBreak, injectSceneHistory, linkMemoriesToLastScene } from './scenes.js';
import {
  extractArcs,
  injectArcs,
  loadArcs,
  loadArcSummaries,
  mergePersistentArcs,
  mergeGroupPersistentArcs,
  loadGroupPersistentArcs,
  saveGroupPersistentArcs,
  pruneOrphanedGroupArcs,
} from './arcs.js';
import {
  checkContinuity,
  handleContinuityResult,
  applyPendingRepair,
  applyDurableRetconNote,
  clearRepair,
  loadAndInjectRepair,
  advanceDurableRetcons,
} from './continuity.js';
import {
  clearEmbeddingCache,
  getHardwareProfile,
  getEmbeddingBatch,
  cosineSimilarity,
  abortEmbeddingRequests,
} from './embeddings.js';
import { jaccardSimilarity } from './similarity.js';
import { generateCanon, injectCanon } from './canon.js';
import {
  ensureCharacterMigrated,
  ensureChatMigrated,
  loadCharacterEntityRegistry,
  saveCharacterEntityRegistry,
  seedCharacterEntity,
} from './graph-migration.js';
import { generateProfiles, injectProfiles, loadProfiles } from './profiles.js';
import {
  classifyTurn,
  adaptiveBudgets,
  correlateGenerationGate,
  isDuplicateChatLoad,
  recapCompletionOwnsSlot,
  resolveDeletedIndexFromRefs,
  isTrackableGeneration,
} from './memory-utils.js';
import { clearUnifiedSlot, maybeInjectUnified } from './unified-inject.js';
import { registerSmartMemoryMacros } from './macros.js';
import { smLog } from './logging.js';
import {
  isEpistemicEnabled,
  extractEpistemicKnowledge,
  extractAndPartitionGroupEpistemic,
  injectEpistemicKnowledge,
  loadAndInjectEpistemicKnowledge,
  resetEpistemicWarnFlag,
} from './epistemic.js';
import {
  runStateCardExtraction,
  injectStateLedger,
  loadAndInjectStateLedger,
  takeStateSnapshot,
  rollbackStateToSnapshot,
} from './state-ledger.js';
import {
  setStatusMessage,
  updateShortTermUI,
  updateLongTermUI,
  updateSessionUI,
  updateScenesUI,
  updateArcsUI,
  updateTokenDisplay,
  updateFreshStartUI,
  updateCanonUI,
  updateProfilesUI,
  updateRelationshipHistoryUI,
  updateEpistemicUI,
  updateEntityPanel,
  updateEmbeddingNotice,
  setContinuityBadge,
  showSearchResults,
  initTooltips,
  initTypePickers,
} from './ui.js';
import { defaultSettings, loadSettings, bindSettingsUI, autoTuneBudgets } from './settings.js';
import { clearTierTrimStats, resetTrimToastFlag, markChatLoadComplete } from './trim-stats.js';

// ---- Module-level state -------------------------------------------------

// Set to true by GENERATION_STARTED (type='normal' only) and cleared by MESSAGE_RECEIVED.
// Used instead of ST's is_send_press to guard onCharacterMessageRendered
// against intermediate streaming renders. is_send_press is still true when
// CHARACTER_MESSAGE_RENDERED fires in non-streaming mode, which would cause
// extraction to be silently skipped. MESSAGE_RECEIVED always fires before
// CHARACTER_MESSAGE_RENDERED in both streaming and non-streaming paths.
// Quiet generations (background calls from other extensions) are intentionally
// excluded - setting the flag for them causes extraction to be skipped when
// another extension fires a quiet generation between MESSAGE_RECEIVED and
// CHARACTER_MESSAGE_RENDERED.
let generationInProgress = false;

// Timestamp recorded when generationInProgress was last set to true. Used as a
// fail-safe in onCharacterMessageRendered: if a terminal generation event is
// somehow missed and the flag is left stuck, it is cleared once clearly stale
// so extraction can resume instead of being suppressed forever.
let generationStartTime = 0;

// Count of normal generations that have started but not yet been matched by a
// terminal event. SillyTavern's GENERATION_STOPPED/GENERATION_ENDED carry no
// generation id, so a delayed terminal for an older generation could otherwise
// clear a newer generation's gate. The pending count lets correlateGenerationGate
// pair starts and terminals FIFO and only clear the gate when the newest
// generation is the one terminating.
let generationPending = 0;

// Timestamp of the last processed terminal event. Back-to-back
// GENERATION_STOPPED + GENERATION_ENDED for the SAME generation are collapsed
// within GENERATION_TERMINAL_COALESCE_MS so a generation is dequeued once.
let lastGenerationTerminalAt = -Infinity;

// Which paired terminal complement is expected next for the current terminal
// slot: 'ended' after a GENERATION_STOPPED, or null when no pair is pending.
// stopGeneration() emits STOPPED then ENDED for one aborted generation; keying
// the pair on event kind (rather than elapsed time alone) ensures a newer
// generation's real terminal is never swallowed by a delayed older pair.
let generationAwaitingPair = null;

// Timer that force-clears generationInProgress when no terminal generation event
// arrives. The flag is normally cleared by MESSAGE_RECEIVED or by the terminal
// GENERATION_STOPPED/GENERATION_ENDED events, but a generation that is aborted or
// never emits one of those would otherwise leave the flag stuck true and suppress
// extraction forever. The passive timestamp check in onCharacterMessageRendered
// remains as a secondary guard.
let generationWatchdogId = null;

// Monotonic token identifying the generation that currently owns the
// generationInProgress gate. Incremented every time a new generation starts so
// the watchdog callback can detect that a newer generation has taken ownership
// and leave its gate alone. Terminal events are imperfectly correlated with the
// generation they belong to, so this keeps a stale watchdog fire from clearing a
// newer generation's flag.
let activeGenerationToken = 0;

/**
 * Cancels the generation watchdog timer, if one is running. The stored timer id
 * is cleared regardless of which generation owns the gate; the timer callback
 * itself guards by token so a newer generation is never cleared by a stale fire.
 */
function clearGenerationWatchdog() {
  if (generationWatchdogId) {
    clearTimeout(generationWatchdogId);
    generationWatchdogId = null;
  }
}

/**
 * Applies a generation lifecycle event to the module-level gate state via the
 * pure correlator in memory-utils.js. Keeps the correlation logic testable under
 * plain Node while the watchdog/timestamp side-effects stay here.
 * @param {'start'|'complete'|'stopped'|'ended'|'terminal'|'reset'} event
 * @param {number} [now] - Monotonic ms timestamp for terminal coalescing.
 * @returns {{pending: number, inProgress: boolean, awaitingPair: ('stopped'|'ended'|null), lastTerminalAt: number}}
 */
function applyGenerationGateEvent(event, now = Date.now()) {
  const next = correlateGenerationGate(
    {
      pending: generationPending,
      inProgress: generationInProgress,
      awaitingPair: generationAwaitingPair,
      lastTerminalAt: lastGenerationTerminalAt,
    },
    event,
    now,
  );
  generationPending = next.pending;
  generationInProgress = next.inProgress;
  generationAwaitingPair = next.awaitingPair;
  lastGenerationTerminalAt = next.lastTerminalAt;
  return next;
}

/**
 * Starts (or restarts) the watchdog that clears generationInProgress if no
 * terminal generation event arrives within 90 seconds. Increments the
 * generation token so this watchdog only clears the flag while its own
 * generation still owns the gate.
 */
function startGenerationWatchdog() {
  clearGenerationWatchdog();
  const myToken = ++activeGenerationToken;
  generationWatchdogId = setTimeout(() => {
    if (activeGenerationToken !== myToken) return; // a newer generation owns the gate
    applyGenerationGateEvent('reset');
    generationStartTime = 0;
    generationWatchdogId = null;
  }, 90000);
}

/**
 * Keeps watchdog lifetime aligned with the correlator's actual pending count.
 * A committed MESSAGE_RECEIVED may open the render gate while another generation
 * is still pending, so clearing solely because generationInProgress is false can
 * strand that retained slot forever. Only a fully idle gate clears the watchdog;
 * any remaining pending slot gets a fresh bounded-recovery timer.
 * @param {{pending: number, inProgress: boolean}} state
 */
function reconcileGenerationWatchdog(state) {
  if (!state.inProgress && state.pending === 0) {
    clearGenerationWatchdog();
  } else if (state.pending > 0) {
    startGenerationWatchdog();
  }
}

// Monotonic revision counter for the current chat branch. Incremented on every
export { bumpOperationRevision, getOperationRevision } from './memory-utils.js';
import { bumpOperationRevision, getOperationRevision } from './memory-utils.js';

// Guards prevent re-entrant model calls if ST fires events faster than
// the previous async job completes.
let messagesSinceLastExtraction = 0;
// Tracks messages since the last profile generation (extraction-pass or scheduled).
// Reset to 0 whenever profiles are regenerated so the two triggers don't stack.
let messagesSinceLastProfileRegen = 0;
let compactionRunning = false;
let extractionRunning = false;
let consolidationRunning = false;
// Guards the Profile B auto-continuity check so at most one runs at a time.
let continuityCheckRunning = false;
// Guards recap generation so a slow model call cannot produce a second toast
// if onChatChangedImpl fires again before updateLastActive() has run.
// Holds a reference to the chatMetadata object for the chat whose recap is
// currently in progress, null when idle. Using the metadata object reference
// as the identity key means:
//   - Same chat double-fire: both calls get the same object reference, so the
//     second call is blocked and the first recap can still display its result.
//   - Navigation away: getContext().chatMetadata returns a different object, so
//     the in-flight recap is correctly discarded at completion time.
// This variable must NOT be reset in the onChatChangedImpl reset block.
let recapRunningForChat = null;

// Set to true when MESSAGE_SENT fires while a recap is in progress. Prevents
// the popup from appearing after the recap finishes - the user already sent a
// message so showing "Previously on..." after the fact would be confusing.
// Reset at the start of each chat load and after each recap completes.
let recapSuppressed = false;

// Active activity loader handle for an in-progress recap, stored at module
// level so the reset block can clear a stuck toast if the chat changes before
// the recap promise settles (e.g. Ollama drops the request on an error).
let activeRecapHandle = null;

// Holds a reference to the chatMetadata object the currently-displayed recap
// overlay belongs to, null when no overlay is showing. Recap generation can
// take minutes, and SillyTavern can fire CHAT_CHANGED/CHAT_LOADED more than
// once for a single chat load (common across extensions). Without this check,
// onChatChangedImpl's unconditional overlay removal at the top of the function
// would wipe a just-displayed recap seconds after it appears whenever a second
// event fires for the SAME chat, not just on an actual chat switch.
let recapOverlayChatMeta = null;

// Set to true by the Cancel button to abort an in-progress catch-up loop.
let catchUpCancelled = false;

// Tracks which character names have responded in the current group chat round.
// Populated by onCharacterMessageRendered when context.groupId is set, cleared
// by onGroupWrapperStarted at the top of each new round.
let respondedThisRound = new Set();

// True once applyPendingRepair() has run for the first character in a group
// round. Prevents the one-shot repair note from being re-injected for every
// subsequent character in the same round.
let repairInjectedThisRound = false;

// Last observed chat length, used to distinguish new messages from swipes.
// CHARACTER_MESSAGE_RENDERED fires on both; swipes do not grow the chat array.
let lastKnownChatLength = 0;

// ---- Activity indicator helpers -----------------------------------------

/**
 * Shows a sticky toastr notification if the activity indicator setting is enabled.
 * Returns the toast element so it can be cleared when the operation finishes.
 * Returns null if the setting is off.
 * @param {object} settings - The Smart Memory settings object.
 * @param {string} [message] - Status text to display.
 * @returns {JQuery|null}
 */
function startActivityLoader(settings, message = 'Processing...') {
  if (!(settings.show_activity_indicator ?? true)) return null;
  return toastr.info(message, 'Smart Memory', {
    timeOut: 0,
    extendedTimeOut: 0,
    tapToDismiss: false,
  });
}

/**
 * Clears the toast returned by startActivityLoader.
 * Safe to call with null (when the setting was off).
 * @param {JQuery|null} handle
 */
function stopActivityLoader(handle) {
  // Use direct DOM removal rather than toastr.clear() - toastr's clear()
  // resolves by queue position rather than by element identity, which causes
  // it to dismiss the wrong toast when multiple toasts exist concurrently
  // (e.g. a continuity check toast still lingering when extraction starts).
  if (handle) handle.remove();
}

/**
 * Re-injects the chat-scoped state blocks and refreshes the UI after a state
 * rollback, so the prompt and panels immediately reflect the restored snapshot
 * instead of the discarded branch.
 */
function refreshAfterStateRollback() {
  captureChatRefs();
  try {
    const context = getContext();
    const characterName = context.groupId ? selectedGroupCharacter : getCurrentCharacterName();

    injectStateLedger();
    injectArcs();
    if (characterName) {
      injectEpistemicKnowledge(characterName, characterName);
      updateEpistemicUI(characterName);
    }
    updateArcsUI();
    updateTokenDisplay();
    maybeInjectUnified();
  } catch (err) {
    console.error('[SmartMemory] Failed to refresh state after rollback:', err);
  }
}

/**
 * Returns a stable extraction window that excludes the currently swipable
 * assistant reply (the trailing non-user message in 1:1 chats). This prevents
 * storing memories from temporary swipe candidates the user may discard.
 *
 * The latest assistant reply is naturally included on the next turn after the
 * user responds, so accepted content is still captured with a one-turn delay.
 *
 * @param {Array} chat - Full chat array from SillyTavern context.
 * @param {number} windowSize - Max number of messages to return.
 * @returns {Array} Stable message slice safe for extraction.
 */
function getStableExtractionWindow(chat, windowSize) {
  if (!Array.isArray(chat) || chat.length === 0) return [];

  const last = chat[chat.length - 1];
  const cutoff = last && !last.is_user && !last.is_system ? chat.length - 1 : chat.length;
  if (cutoff <= 0) return [];

  const start = Math.max(0, cutoff - windowSize);
  return chat.slice(start, cutoff);
}

/**
 * Smart extraction window for memory tiers.
 *
 * On first extraction (lastCutoff null) falls back to maxWindow. On subsequent
 * passes, starts from just after the last processed message but always includes
 * at least extractEvery * 2 messages so the model has enough context to make
 * meaningful distinctions. Capped at maxWindow to avoid unbounded growth when
 * the chat has advanced a long way since the last pass.
 *
 * @param {Array} chat - Full chat array from SillyTavern context.
 * @param {number|null} lastCutoff - Exclusive end index used in the previous pass, or null.
 * @param {number} extractEvery - Current extraction interval setting.
 * @param {number} maxWindow - Hard cap on window size.
 * @returns {Array} Stable message slice.
 */
function getSmartExtractionWindow(chat, lastCutoff, extractEvery, maxWindow) {
  if (!Array.isArray(chat) || chat.length === 0) return [];

  const last = chat[chat.length - 1];
  const cutoff = last && !last.is_user && !last.is_system ? chat.length - 1 : chat.length;
  if (cutoff <= 0) return [];

  let start;
  if (lastCutoff === null || lastCutoff === undefined) {
    start = Math.max(0, cutoff - maxWindow);
  } else {
    // Start from just after the last processed message, but ensure at least
    // extractEvery * 2 messages of context. Cap at maxWindow so a very old
    // lastCutoff does not produce a huge window.
    const newStart = lastCutoff;
    const minContextStart = cutoff - extractEvery * 2;
    start = Math.max(Math.min(newStart, minContextStart), cutoff - maxWindow, 0);
  }
  return chat.slice(start, cutoff);
}

/**
 * Stable extraction window with fallback for small/new chats.
 *
 * @param {Array} chat - Full chat array from SillyTavern context.
 * @param {number} windowSize - Max number of messages to return.
 * @returns {Array} Stable message slice, or plain tail slice if none exist yet.
 */
function getStableExtractionWindowWithFallback(chat, windowSize) {
  const stable = getStableExtractionWindow(chat, windowSize);
  if (stable.length > 0) return stable;

  if (!Array.isArray(chat) || chat.length === 0) return [];
  const start = Math.max(0, chat.length - windowSize);
  return chat.slice(start);
}

// Accumulates messages since the last detected scene break. Reset to []
// when a break is detected so the next scene starts from a clean buffer.
let sceneMessageBuffer = [];
// Index of the last chat message already pushed into sceneMessageBuffer.
// Prevents duplicate pushes when CHARACTER_MESSAGE_RENDERED fires more than
// once for the same message (e.g. during swipes or re-renders).
let sceneBufferLastIndex = -1;

// Snapshot of the chat message object references captured after each known-good
// chat state. SillyTavern emits MESSAGE_DELETED with the NEW chat length, never
// the deleted index, so the deleted turn is recovered by diffing object identity
// against this snapshot (surviving messages keep their references across a
// splice).
let lastChatRefs = null;

// ---- Helpers ------------------------------------------------------------

/** Returns the settings object for this extension. */
function getSettings() {
  return extension_settings[MODULE_NAME];
}

/**
 * Captures the current chat's message object references for delete diffing.
 * Call after every known-good chat state (load, message sent/received, and
 * after a swipe/edit/delete rollback) so a later MESSAGE_DELETED can locate the
 * removed turn by identity.
 */
function captureChatRefs() {
  const chat = getContext().chat;
  lastChatRefs = Array.isArray(chat) ? [...chat] : null;
}

/**
 * Derives the index of the message SillyTavern just deleted.
 *
 * SillyTavern always emits MESSAGE_DELETED with the NEW chat length (see
 * `deleteMessage`/`deleteLastMessage` in the host), not the deleted index. The
 * deleted turn is therefore recovered by finding the first index where the
 * surviving chat diverges from the last captured reference snapshot. This is
 * correct for both single mid-chat deletes and "delete from here" range deletes.
 *
 * @param {number} emittedLength - the value ST passed (the new chat length).
 * @returns {number} index of the deleted message in the pre-delete chat.
 */
function resolveDeletedIndex(emittedLength) {
  return resolveDeletedIndexFromRefs(lastChatRefs, getContext().chat ?? [], emittedLength);
}

/** Returns the active character name, or null if no character is loaded. */
function getCurrentCharacterName() {
  const context = getContext();
  return context.name2 || context.characterName || null;
}

// Tracks which group member the settings panel is currently showing.
// Only meaningful when context.groupId is set. Null means "no selection yet"
// which falls back to context.name2 in getSelectedCharacterName.
let selectedGroupCharacter = null;

/**
 * Returns the character name the settings panel should operate on.
 * In group chats this is the explicitly-selected group member; in 1:1 chats
 * it falls through to the standard active-character lookup.
 *
 * @returns {string|null}
 */
function getSelectedCharacterName() {
  if (getContext().groupId) {
    // selectedGroupCharacter is briefly null during chat transitions (reset at
    // the start of onChatChangedImpl, set again after updateGroupCharSelector).
    // Fall back to the DOM selector value so buttons still work during that window.
    return selectedGroupCharacter || $('#sm_group_char_select').val() || null;
  }
  return getCurrentCharacterName();
}

/**
 * Clears all active injection slots. Called when the master toggle is turned
 * off so that no Smart Memory content lingers in the current prompt.
 * This only removes the live prompt injections - stored memories and metadata
 * are not touched. Re-enabling the extension restores them from storage.
 */
function clearAllInjections() {
  const none = extension_prompt_types.NONE;
  setExtensionPrompt(PROMPT_KEY_SHORT, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_LONG, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_SESSION, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_SCENES, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_ARCS, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_REPAIR, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_PROFILES, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_CANON, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_TRIGGERED, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_RELATIONSHIPS, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_EPISTEMIC, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_STATE_LEDGER, '', none, 0);
  clearUnifiedSlot();
  updateTokenDisplay();
}

// ---- Event handlers -----------------------------------------------------

/**
 * Fires after each AI message is rendered (registered with makeLast so Smart
 * Memory runs after all other extensions have processed the message).
 *
 * Swipe detection: CHARACTER_MESSAGE_RENDERED fires on swipes (alternative
 * generations) as well as on new messages. ST passes a `type` parameter -
 * 'swipe', 'impersonate', and 'quiet' should not trigger extraction. The type
 * check is the primary guard; the length comparison is kept as a belt-and-
 * suspenders fallback for any ST version that omits the parameter.
 *
 * Orchestration order (new messages only):
 *   1. Check for compaction threshold and run if needed (async, non-blocking).
 *   2. Check for scene break in the latest message (async, non-blocking).
 *   3. Every N messages: batch extraction for session + long-term + arcs.
 *   4. Update lastActive timestamp for the away recap system.
 *
 * The entire async pipeline (steps 1-7) is deferred via setTimeout(fn, 0) so
 * the handler returns before any model call begins. This prevents the non-
 * streaming path from holding ST's CHARACTER_MESSAGE_RENDERED emit open for the
 * full extraction duration (several seconds on Ollama), which blocks ST's
 * saveChatConditional. All cross-chat races are still guarded by chatLoadId.
 *
 * Compaction and extraction both pass a responseLength to ST's generateRaw /
 * generateQuietPrompt, which temporarily modifies the global amount_gen via
 * ST's TempResponseLength singleton. Running them concurrently corrupts that
 * singleton and leaves amount_gen at the extraction value. They therefore run
 * sequentially: compaction first, extraction only after compaction completes.
 * Compaction is also gated on !extractionRunning so a re-entrant handler call
 * (possible after the deferral) cannot start compaction while a previous turn's
 * extraction is still running. Compaction fires infrequently (only at the
 * context threshold) so the latency cost is negligible in practice.
 */
async function onCharacterMessageRendered(messageId, type) {
  captureChatRefs();
  // Fail-safe: if a terminal generation event was missed, the flag can stick
  // true and block extraction indefinitely. Clear it once it is clearly stale.
  if (generationInProgress && Date.now() - generationStartTime > 60000) {
    applyGenerationGateEvent('reset');
    generationStartTime = 0;
    clearGenerationWatchdog();
  }

  // Skip intermediate streaming renders - MESSAGE_RECEIVED clears this flag
  // before the final CHARACTER_MESSAGE_RENDERED fires in both streaming and
  // non-streaming paths, so extraction only runs once per completed message.
  if (generationInProgress) return;

  const settings = getSettings();
  if (!settings.enabled) return;

  const context = getContext();
  if (!context.chat || context.chat.length === 0) return;

  // ST passes a type string for non-committed generations. Skip these - the user
  // has not settled on a final message so nothing should be extracted or stored.
  // 'continue' extends the current message in place and may be swiped away;
  // its content will be captured on the next real extraction pass.
  if (type === 'swipe' || type === 'continue' || type === 'impersonate' || type === 'quiet') {
    updateLastActive().catch(console.error);
    return;
  }

  // Belt-and-suspenders fallback: if type is absent (older ST version) fall back
  // to the length comparison. A swipe replaces the last message in-place without
  // growing the chat array, so a non-growing length means skip.
  const currentLength = context.chat.length;
  const isSwipe = currentLength <= lastKnownChatLength;
  lastKnownChatLength = currentLength;
  if (isSwipe) {
    updateLastActive().catch(console.error);
    return;
  }

  // In group chats, all round-level work (extraction, compaction, scene detection,
  // continuity) runs in onGroupWrapperFinished. Here we just track participation
  // and feed new messages into the scene buffer so WRAPPER_FINISHED has the full
  // round's context. Injection is handled by onGroupMemberDrafted before each
  // character generates, so there is nothing further to do here.
  if (context.groupId) {
    const name = getCurrentCharacterName();
    if (name) respondedThisRound.add(name);

    // Accumulate messages so scene break detection in WRAPPER_FINISHED sees
    // everything that happened this round.
    const newGroupMessages = context.chat.slice(sceneBufferLastIndex + 1);
    if (newGroupMessages.length > 0) {
      sceneMessageBuffer.push(...newGroupMessages);
      sceneBufferLastIndex = context.chat.length - 1;
    }

    updateLastActive().catch(console.error);
    return;
  }

  // The continuity note (if any) was consumed by the generation that produced
  // this committed message. Clear it synchronously, before the deferred
  // extraction pipeline, so it can never leak into a later turn.
  clearRepair();

  // Advance durable retcon lifetimes one AI turn. Retcons that reach the end of
  // their lifespan are auto-resolved as canon and stop being injected. Expired
  // retcons are resolved into state so the old baseline fact is superseded.
  const characterName = getCurrentCharacterName();
  advanceDurableRetcons(characterName);

  // Capture the current chat generation and operation revision so we can abort
  // before any write if the user switches chats or rewrites the branch (swipe,
  // edit, delete) while a model call is in progress.
  const capturedGen = chatLoadId;
  const capturedRev = getOperationRevision();
  const chatChanged = () => chatLoadId !== capturedGen;
  const branchChanged = () => chatChanged() || getOperationRevision() !== capturedRev;

  const lastMsg = context.chat
    .slice()
    .reverse()
    .find((m) => !m.is_user && !m.is_system && m.mes);
  const lastMsgText = lastMsg?.mes ?? '';

  // Also grab the last user message so scene break detection catches
  // transitions the user wrote (e.g. "a year passed") that the AI may
  // not have echoed back in its own response.
  const lastUserMsg = context.chat
    .slice()
    .reverse()
    .find((m) => m.is_user && !m.is_system && m.mes);
  const lastUserMsgText = lastUserMsg?.mes ?? '';

  // Previous AI message - passed to scene break detection as context so the
  // model can distinguish a continuation from a genuine transition.
  const aiMessages = context.chat.filter((m) => !m.is_user && !m.is_system && m.mes);
  const prevAiMsgText = aiMessages.length >= 2 ? aiMessages[aiMessages.length - 2].mes : '';

  // Push only messages not yet in the buffer. Using the chat index as a
  // cursor prevents duplicate pushes when the event fires more than once
  // for the same message (swipes, re-renders).
  const newMessages = context.chat.slice(sceneBufferLastIndex + 1);
  if (newMessages.length > 0) {
    sceneMessageBuffer.push(...newMessages);
    sceneBufferLastIndex = context.chat.length - 1;
  }

  // Defer the async pipeline so this handler returns immediately. ST awaits all
  // CHARACTER_MESSAGE_RENDERED listeners before continuing to saveChatConditional;
  // returning here lets that proceed while extraction runs in the background.
  setTimeout(() => {
    (async () => {
      // Guard: if the user switched chats in the gap between the event handler
      // returning and this timeout firing, bail immediately. Without this check,
      // compaction evaluates the new chat and injectCanon briefly injects the
      // previous character's canon into the wrong chat.
      if (branchChanged()) return;

      // Tracks whether a scene-break epistemic pass already ran this turn so the
      // periodic extraction batch below does not duplicate the model call.
      let epistemicThisPass = false;

      // Step 1: compaction - awaited before extraction to prevent concurrent use
      // of ST's TempResponseLength singleton, which would corrupt amount_gen.
      // Also gated on !extractionRunning: after the deferral a re-entrant handler
      // call (new message during extraction) must not start compaction concurrently.
      // Gated by !isFreshStart() so read-only sessions never advance summaryEnd
      // past the ghosted window; the discard path then has nothing to roll back.
      if (
        settings.compaction_enabled &&
        !compactionRunning &&
        !extractionRunning &&
        !isFreshStart()
      ) {
        compactionRunning = true;
        try {
          const needed = await shouldCompact();
          if (needed) {
            setStatusMessage('Updating story summary...');
            // Only show the activity indicator for external sources - with the main
            // API, ST's own pipeline blocks swipes with its own message so a second
            // toast would be redundant.
            const source = extension_settings[MODULE_NAME]?.source ?? memory_sources.main;
            const compactionHandle =
              source !== memory_sources.main
                ? startActivityLoader(settings, 'Updating story summary...')
                : null;
            const summary = await runCompaction({ abortCheck: branchChanged });
            stopActivityLoader(compactionHandle);
            if (summary) {
              injectSummary(summary);
              injectCanon(characterName);
              updateShortTermUI(summary);
              updateTokenDisplay();
              setStatusMessage('Summary updated.');
            } else {
              setStatusMessage('');
            }
          }
        } catch (err) {
          console.error('[SmartMemory] Compaction error:', err);
        } finally {
          compactionRunning = false;
        }
      }

      // Step 2: scene break detection - awaited before extraction for the same
      // reason as compaction: the AI detection path uses responseLength: 5 which
      // would corrupt amount_gen if it raced with extraction.
      // Also gated on !extractionRunning for the same re-entry reason as step 1.
      // Check both the AI response and the preceding user message - transitions
      // are often written by the user and not echoed by the AI.
      // Gated by !isFreshStart() so no scene summaries are written during read-only.
      const sceneCheckText = [lastUserMsgText, lastMsgText].filter(Boolean).join('\n');
      if (settings.scene_enabled && sceneCheckText && !isFreshStart() && !extractionRunning) {
        try {
          const wasBreak = await processSceneBreak(
            sceneCheckText,
            sceneMessageBuffer,
            prevAiMsgText,
            branchChanged,
          );
          if (wasBreak) {
            injectSceneHistory();
            updateScenesUI();
            updateTokenDisplay();
            if (isEpistemicEnabled()) {
              await extractEpistemicKnowledge(sceneMessageBuffer, characterName, '', branchChanged);
              injectEpistemicKnowledge(characterName, characterName, true, true);
              epistemicThisPass = true;
            }
            sceneMessageBuffer = [];
            // Point the cursor at the current end of chat, not -1. Setting -1
            // would make the next render slice from index 0 and re-ingest the
            // entire history into the fresh scene buffer.
            sceneBufferLastIndex = context.chat.length - 1;
            setStatusMessage('Scene break detected.');
          }
        } catch (err) {
          console.error('[SmartMemory] Scene detection error:', err);
        }
      }

      // Step 3: batched extraction every N messages.
      // extractEvery uses the smaller of the two intervals so neither tier
      // falls behind if one is configured more frequently than the other.
      if (!extractionRunning) {
        messagesSinceLastExtraction++;
        messagesSinceLastProfileRegen++;
        const extractEvery = Math.min(
          settings.session_extract_every ?? 3,
          settings.longterm_extract_every ?? 3,
        );

        smLog(
          `[SmartMemory] Solo counter: ${messagesSinceLastExtraction}/${extractEvery} (extractionRunning=${extractionRunning})`,
        );

        if (messagesSinceLastExtraction >= extractEvery) {
          extractionRunning = true;
          smLog(`[SmartMemory] Solo extraction starting at ${new Date().toISOString()}`);

          // Use separate windows per tier. Both memory tiers use a smart window
          // that starts from just after the last processed message so already-seen
          // messages are not re-fed on every pass. A minimum of extractEvery * 2
          // messages is always included so the model has enough context to make
          // meaningful distinctions. Arc extraction uses a fixed wide window to
          // catch threads that were introduced earlier in the session.
          const lastExtractCutoff = context.chatMetadata?.[META_KEY]?.lastExtractCutoff ?? null;
          const sessionWindow = getSmartExtractionWindow(
            context.chat,
            lastExtractCutoff,
            extractEvery,
            40,
          );
          const longtermWindow = getSmartExtractionWindow(
            context.chat,
            lastExtractCutoff,
            extractEvery,
            20,
          );

          // Determine whether to refresh injection slots this pass. When the
          // refresh period is > 1, long-term and session slots stay stable between
          // refreshes so cloud API prompt caches remain valid. Recent events are
          // covered by chat history during the gap.
          const injRefreshPeriod = settings.injection_refresh_period ?? 1;
          // Clamp the stored index to the current chat tip so message deletions
          // reset the delta to 0 rather than stalling refreshes until the chat
          // regrows past the stale index.
          const injLastRefresh = Math.min(
            context.chatMetadata?.[META_KEY]?.lastInjectionRefresh ?? 0,
            Math.max(0, context.chat.length - 1),
          );
          const shouldRefreshInjections =
            injRefreshPeriod <= 1 || context.chat.length - 1 - injLastRefresh >= injRefreshPeriod;

          // Snapshot the cutoff index now, before any awaits, so messages that
          // arrive during extraction are not silently swallowed by advancing the
          // window boundary after the model calls complete.
          const snapshotLast = context.chat[context.chat.length - 1];
          const snapshotCutoff =
            context.chat.length > 0 &&
            snapshotLast &&
            !snapshotLast.is_user &&
            !snapshotLast.is_system
              ? context.chat.length - 1
              : context.chat.length;

          // If only a fresh assistant reply exists beyond the stable boundary,
          // postpone extraction until the next turn so swipes settle first.
          // Do NOT reset the counter here - no extraction happened, so the next
          // message should retry immediately rather than waiting another extractEvery
          // cycle.
          if (longtermWindow.length === 0 && sessionWindow.length === 0) {
            extractionRunning = false;
            return;
          }

          // Only reset the counter once we know extraction will actually proceed.
          messagesSinceLastExtraction = 0;

          // Baseline snapshot: capture the pre-write state at the previous turn
          // so a swipe/delete of this turn can roll back to it cleanly.
          takeStateSnapshot(Math.max(0, snapshotCutoff - 1));

          setStatusMessage(`Extracting memories for ${characterName}...`);

          // Run extraction tiers sequentially rather than in parallel.
          // Parallel model calls overwhelm local hardware (RTX 2080 / 8GB VRAM)
          // and gain nothing on Ollama which serializes requests anyway.
          // Awaiting here also prevents compaction/scene detection on the next
          // message from racing against an ongoing extraction and corrupting
          // ST's TempResponseLength singleton (the same hazard fixed in 1.0.1).
          const activityHandle = startActivityLoader(settings, 'Extracting memories...');
          try {
            let total = 0;

            // Classify the current turn and compute adaptive per-tier token
            // budgets. These are passed directly to the injectors for this
            // turn only - never written into settings - so a debounced save
            // during a long model call cannot persist temporary values over
            // the user's manually configured budgets.
            const lastAiMessage = context.chat?.at(-1)?.mes ?? '';
            const turnType = classifyTurn(lastAiMessage);
            const budgets = adaptiveBudgets(settings, turnType);

            if (branchChanged()) throw CHAT_SWITCHED;
            if (settings.session_enabled && sessionWindow.length > 0 && !isFreshStart()) {
              // Snapshot existing memory ids before extraction so we can identify
              // which memories are new and link them to the current scene.
              const priorSessionIds = new Set(
                loadSessionMemories()
                  .map((m) => m.id)
                  .filter(Boolean),
              );

              const count = await extractSessionMemories(sessionWindow, branchChanged).catch(
                (err) => {
                  console.error('[SmartMemory] Session extraction error:', err);
                  return 0;
                },
              );
              // Run session consolidation after extraction - fires per-type when threshold is reached.
              if (!consolidationRunning) {
                consolidationRunning = true;
                await consolidateSessionMemories(false, branchChanged).catch((err) => {
                  console.error('[SmartMemory] Session consolidation error:', err);
                });
                consolidationRunning = false;
              }
              if (shouldRefreshInjections) await injectSessionMemories(true, budgets.session);
              updateSessionUI();
              total += count;

              // Link newly-added session memory ids to the most recent scene entry
              // (layer 1 -> layer 2 backlink for three-layer summarization).
              if (settings.scene_enabled && count > 0) {
                const newIds = loadSessionMemories()
                  .map((m) => m.id)
                  .filter((id) => id && !priorSessionIds.has(id));
                if (newIds.length > 0) {
                  await linkMemoriesToLastScene(newIds).catch((err) =>
                    console.error('[SmartMemory] Scene memory linking failed:', err),
                  );
                }
              }
            }

            if (branchChanged()) throw CHAT_SWITCHED;
            if (
              settings.longterm_enabled &&
              characterName &&
              longtermWindow.length > 0 &&
              !isFreshStart()
            ) {
              const count = await extractAndStoreMemories(
                characterName,
                longtermWindow,
                setStatusMessage,
                branchChanged,
              ).catch((err) => {
                console.error('[SmartMemory] Long-term extraction error:', err);
                return 0;
              });
              // Run consolidation after extraction if new memories were added.
              if (count > 0 && settings.consolidation_enabled && !consolidationRunning) {
                consolidationRunning = true;
                const removed = await consolidateMemories(
                  characterName,
                  false,
                  branchChanged,
                ).catch((err) => {
                  console.error('[SmartMemory] Consolidation error:', err);
                  return 0;
                });
                consolidationRunning = false;
                if (removed > 0) {
                  setStatusMessage(
                    `Consolidated ${removed} redundant memories for ${characterName}.`,
                  );
                  toastr.info(
                    `Merged ${removed} redundant ${removed === 1 ? 'memory' : 'memories'}.`,
                    'Smart Memory',
                    { timeOut: 3000 },
                  );
                }
              }
              // Inject once after extraction (and any consolidation). Gated by the
              // refresh period so the slot stays stable between refreshes for
              // cloud API prompt cache hits.
              if (shouldRefreshInjections) {
                await injectMemories(characterName, true, budgets.longterm);
                injectRelationshipHistory(characterName);
              }
              updateLongTermUI(characterName);
              updateRelationshipHistoryUI(characterName);
              updateEpistemicUI(characterName);
              total += count;
            }

            // Periodic epistemic refresh: scene breaks can be dozens of messages
            // apart, leaving character knowledge stale when a secret is revealed
            // mid-scene. Run a lightweight pass on each extraction batch unless a
            // scene-break pass already covered this turn's buffer.
            if (branchChanged()) throw CHAT_SWITCHED;
            if (isEpistemicEnabled() && characterName && !isFreshStart() && !epistemicThisPass) {
              const epistemicWindow = longtermWindow.length > 0 ? longtermWindow : sessionWindow;
              if (epistemicWindow.length > 0) {
                await extractEpistemicKnowledge(
                  epistemicWindow,
                  characterName,
                  '',
                  branchChanged,
                ).catch((err) => {
                  console.error('[SmartMemory] Periodic epistemic extraction error:', err);
                });
                if (shouldRefreshInjections) {
                  injectEpistemicKnowledge(characterName, characterName);
                }
                updateEpistemicUI(characterName);
              }
            }

            // Snapshot arc summary count before extraction so we can detect a new
            // resolution in this pass (the count only grows when an arc closes).
            const arcSummaryCountBefore = settings.arcs_enabled ? loadArcSummaries().length : 0;

            if (branchChanged()) throw CHAT_SWITCHED;
            if (settings.arcs_enabled && !isFreshStart()) {
              // Arc extraction uses a wider window than other tiers so it can catch
              // arcs opened earlier in the session, but is capped to avoid overflowing
              // the model's context on long chats. Existing arcs are passed to the
              // prompt so resolution still works even outside this window.
              const arcWindow = getStableExtractionWindow(context.chat, 100);
              const count = await extractArcs(arcWindow, characterName, branchChanged).catch(
                (err) => {
                  console.error('[SmartMemory] Arc extraction error:', err);
                  return 0;
                },
              );
              injectArcs(budgets.arcs);
              updateArcsUI();
              total += count;
            }

            if (branchChanged()) throw CHAT_SWITCHED;
            if (!isFreshStart()) {
              await runStateCardExtraction(characterName, longtermWindow, branchChanged).catch(
                (err) => {
                  console.error('[SmartMemory] State ledger extraction error:', err);
                },
              );
              injectStateLedger(true);
            }

            // Regenerate profiles after each extraction pass so they reflect the
            // latest memories. Sequential - same constraint as the other tiers.
            // Skipped in freshStart chats - no new memories were written so
            // regeneration would waste a model call producing the same output.
            if (branchChanged()) throw CHAT_SWITCHED;
            if (settings.profiles_enabled && characterName && !isFreshStart()) {
              await generateProfiles(characterName, branchChanged)
                .then((profiles) => {
                  if (branchChanged()) return;
                  if (profiles) {
                    injectProfiles(characterName, budgets.profiles);
                    updateProfilesUI(profiles);
                  }
                })
                .catch((err) => console.error('[SmartMemory] Profile generation error:', err));
              // Reset the scheduled-regen counter since we just regenerated.
              messagesSinceLastProfileRegen = 0;
            }

            // Profile B only: auto-regenerate canon when a new arc resolved this
            // pass. Gating on an increase (not just count >= 2) avoids a model call
            // on every extraction batch once the chat has two summaries.
            if (branchChanged()) throw CHAT_SWITCHED;
            if (
              settings.canon_enabled &&
              settings.arcs_enabled &&
              characterName &&
              !isFreshStart() &&
              getHardwareProfile() === 'b' &&
              loadArcSummaries().length > arcSummaryCountBefore
            ) {
              await generateCanon(characterName, branchChanged)
                .then(() => injectCanon(characterName))
                .catch((err) => console.error('[SmartMemory] Auto-canon error:', err));
            }

            // The branch can be rewritten during the final model calls. If it
            // was, abort now rather than writing memories/state/UI for a branch
            // the user has discarded.
            if (branchChanged()) return;

            // Refresh entity panel after extraction since new entities may have been linked.
            updateEntityPanel(characterName);
            if (shouldRefreshInjections) maybeInjectUnified();
            updateTokenDisplay();
            autoTuneBudgets(characterName);
            setStatusMessage(
              total > 0
                ? `${total} item${total === 1 ? '' : 's'} stored for ${characterName}.`
                : '',
            );

            // Persist the cutoff so the next extraction pass knows where this one ended.
            // Use the index snapshotted before the model calls so messages that arrived
            // during extraction are not skipped on the next pass.
            const metaAfter = context.chatMetadata?.[META_KEY];
            if (metaAfter) {
              metaAfter.lastExtractCutoff = snapshotCutoff;
              if (shouldRefreshInjections) metaAfter.lastInjectionRefresh = snapshotCutoff;
              context.saveMetadata();
            }

            // Record a message-anchored snapshot of the state after this pass so
            // a later swipe/delete of this turn rolls back cleanly.
            takeStateSnapshot(snapshotCutoff);
          } catch (err) {
            if (err === CHAT_SWITCHED) {
              smLog('[SmartMemory] Extraction aborted: chat switched mid-extraction.');
            } else {
              console.error('[SmartMemory] Extraction error:', err);
            }
            setStatusMessage('');
          } finally {
            smLog(`[SmartMemory] Solo extraction finished at ${new Date().toISOString()}`);
            stopActivityLoader(activityHandle);
            extractionRunning = false;
          }
        }
      }

      // Step 4 (Profile B only): scheduled profile regeneration between extraction passes.
      // Fires when profiles_regen_every > 0 and enough messages have elapsed since the
      // last generation (extraction-pass or a previous scheduled regen). Fire-and-forget
      // so it does not block the handler. Profile A skips this - profiles regenerate on
      // extraction passes there and extra calls are too expensive on local hardware.
      if (
        settings.profiles_enabled &&
        (settings.profiles_regen_every ?? 0) > 0 &&
        getHardwareProfile() === 'b' &&
        characterName &&
        !isFreshStart() &&
        messagesSinceLastProfileRegen >= settings.profiles_regen_every
      ) {
        messagesSinceLastProfileRegen = 0;
        const schedProfileHandle = startActivityLoader(settings, 'Updating profiles...');
        generateProfiles(characterName, branchChanged)
          .then((profiles) => {
            stopActivityLoader(schedProfileHandle);
            if (branchChanged()) return;
            if (profiles) {
              injectProfiles(characterName);
              updateProfilesUI(profiles);
            }
          })
          .catch((err) => {
            stopActivityLoader(schedProfileHandle);
            console.error('[SmartMemory] Scheduled profile regeneration error:', err);
          });
      }

      // Step 5: the continuity note injected before this generation has been
      // consumed by the response that just rendered. Clear it so repair is
      // strictly one-shot and can never leak into a later turn.
      clearRepair();

      // Step 6 (Profile B only): silent continuity check after each AI turn.
      // Fire-and-forget so it does not block the event handler while the model
      // responds. handleContinuityResult applies the user's continuity_mode:
      // warn (default) only reports, repair queues a forward-only anchored note.
      // On Profile A (local hardware) this stays manual-only - too expensive for
      // every turn on an RTX 2080.
      if (
        getHardwareProfile() === 'b' &&
        settings.continuity_auto_check &&
        !continuityCheckRunning
      ) {
        continuityCheckRunning = true;
        // Capture the branch state so a result from a discarded branch can never
        // render, toast, or queue a note against the replacement branch.
        const isCurrentChat = () => !branchChanged();
        const continuityHandle = startActivityLoader(settings, 'Checking continuity...');
        checkContinuity(characterName, isCurrentChat)
          .then((result) => {
            if (!isCurrentChat()) return;
            handleContinuityResult(result, characterName, isCurrentChat);
            // Snapshot any durable retcon into its anchor turn so swiping a
            // later turn does not discard a correction the story still needs.
            if (result && Number.isInteger(result.anchorIdx)) takeStateSnapshot(result.anchorIdx);
          })
          .catch((err) => {
            if (!isCurrentChat()) return;
            console.error('[SmartMemory] Auto-continuity check failed:', err);
          })
          .finally(() => {
            stopActivityLoader(continuityHandle);
            if (isCurrentChat()) continuityCheckRunning = false;
          });
      }

      // Step 7: update lastActive so the away recap threshold stays accurate.
      updateLastActive().catch(console.error);
    })().catch(console.error);
  }, 0);
}

// Debounce timer for onChatChanged. ST fires both CHAT_LOADED and CHAT_CHANGED
// on a fresh load, sometimes before context.groupId is set. Collapsing them
// into one deferred run ensures the context is stable before we act on it.
let chatChangedTimer = null;

// Incremented synchronously by onChatChanged at event receipt. Async callbacks
// (recap, extraction) capture this value and bail out if it has changed by the
// time they resolve - prevents a slow operation from a previous chat writing
// into a different chat's metadata. Bumping synchronously (rather than after the
// debounce in onChatChangedImpl) ensures work from the old chat is invalidated
// immediately instead of during the context-stabilization window.
let chatLoadId = 0;

// Identity of the chat whose load last triggered a synchronous invalidation,
// plus the timestamp of that invalidation. SillyTavern fires both CHAT_CHANGED
// and CHAT_LOADED for a single chat load (and other extensions can trigger
// further duplicates), which would otherwise bump chatLoadId/operationRevision
// twice for one logical change. Duplicate events for the SAME chat within a
// short window are coalesced into a single bump. A genuine switch to a
// different chat id never coalesces and always bumps.
//
// Identity has two parts: the normalized chat id (numeric/string-equivalent) and
// the chatMetadata object reference. The id is authoritative when available; the
// metadata reference is a per-load lifecycle token used when getCurrentChatId()
// is temporarily null during a load, so duplicate events are still coalesced
// instead of bumping the revision twice.
let lastChatLoadIdentity = { id: null, meta: null };
let lastChatInvalidatedAt = 0;

// Sentinel thrown inside the extraction try/finally when a chat switch is detected
// mid-extraction. Caught separately from real errors so it is not logged as a failure.
const CHAT_SWITCHED = Symbol('chat-switched');

function onChatChanged() {
  // Invalidate all in-flight work SYNCHRONOUSLY at event receipt, before the
  // debounced onChatChangedImpl() runs. The debounce exists only so the host can
  // settle context (groupId, chatMetadata) before the heavier UI/load
  // restoration; it must not delay invalidation, or tasks from the old chat
  // would still observe the "current" revision/load-id during the 100ms window
  // and could write or inject stale content.
  //
  // ST fires CHAT_CHANGED and CHAT_LOADED for one load, so a duplicate event for
  // the SAME chat id within a short window is coalesced: chatLoadId and
  // operationRevision must only advance once per logical chat change.
  const now = Date.now();
  const chatId = getCurrentChatId();
  // `chatMetadata` is a fresh object per loaded chat, so its reference doubles
  // as a per-load lifecycle token when the chat id is not yet available.
  const chatMeta = getContext().chatMetadata ?? null;
  const nextIdentity = { id: chatId == null ? null : String(chatId), meta: chatMeta };
  const coalesce = isDuplicateChatLoad(
    lastChatLoadIdentity,
    nextIdentity,
    now - lastChatInvalidatedAt,
  );

  if (!coalesce) {
    ++chatLoadId;
    bumpOperationRevision();
    lastChatLoadIdentity = nextIdentity;
    lastChatInvalidatedAt = now;

    // A chat switch ends any generation in this context. Clear the gate
    // immediately so a stuck value cannot suppress extraction in the new chat.
    applyGenerationGateEvent('reset');
    generationStartTime = 0;
    clearGenerationWatchdog();
  }

  // A coalesced duplicate is still a fresh load signal for the same chat, so
  // abort any in-flight model/embedding work. Both calls are cheap and
  // idempotent, and this guarantees stale work cannot survive even when the
  // load-id bump was skipped.
  abortCurrentMemoryGeneration();
  abortEmbeddingRequests();

  // Always clear and reschedule the debounced restoration so it runs after the
  // last event in a burst, once the host has settled context.
  clearTimeout(chatChangedTimer);
  chatChangedTimer = setTimeout(() => onChatChangedImpl().catch(console.error), 100);
}

/**
 * Fires when a chat is loaded or switched (debounced via onChatChanged).
 * Resets all module-level state, restores stored injections, and generates
 * an away recap if the user has been gone longer than the configured threshold.
 */
async function onChatChangedImpl() {
  captureChatRefs();
  // Capture the load id and operation revision at entry. After every await and
  // before each mutating UI/state write below, bail out if either changed: a
  // newer chat event (implGen) or a branch rewrite (implRev - swipe/edit/delete)
  // means this restoration is now stale and must not keep loading the previous
  // chat's context over the new state. For a normal single event these values
  // are the ones set by the synchronous bump in onChatChanged(), so stale() is
  // false and the load completes.
  const implGen = chatLoadId;
  const implRev = getOperationRevision();
  const stale = () => chatLoadId !== implGen || getOperationRevision() !== implRev;

  // NOTE: chatLoadId/operationRevision were already bumped and any in-flight
  // generation/embedding aborts issued synchronously in onChatChanged(), at
  // event receipt. Do not invalidate again here: doing so would double-count
  // the revision for a single chat change and would delay invalidation until
  // after the debounce.

  // Reset per-load flags so warnings and trim indicators start fresh for the new chat.
  resetEpistemicWarnFlag();
  clearTierTrimStats();
  resetTrimToastFlag();

  // Dismiss any recap overlay from the previous chat immediately - it is modal
  // and blocks input, so leaving it up over the new chat is confusing. Only
  // remove it on an actual chat switch - SillyTavern can fire CHAT_CHANGED/
  // CHAT_LOADED more than once for the same chat load, and a duplicate event
  // here must not wipe a recap that was just displayed for this same chat.
  if (recapOverlayChatMeta !== getContext().chatMetadata) {
    $('#sm_recap_overlay').remove();
    recapOverlayChatMeta = null;
  }

  messagesSinceLastExtraction = 0;
  messagesSinceLastProfileRegen = 0;
  compactionRunning = false;
  extractionRunning = false;
  continuityCheckRunning = false;
  recapSuppressed = false;
  catchUpCancelled = true;
  // Aborts for any in-flight Ollama/OpenAI memory generation and embedding
  // requests from the previous chat were already issued synchronously in
  // onChatChanged(), so the old chat's memory call cannot compete with the new
  // chat's generation for the same model instance.
  stopActivityLoader(activeRecapHandle);
  activeRecapHandle = null;
  sceneMessageBuffer = [];
  // Point the cursor at the end of the loaded chat so historical messages are
  // not ingested into the active scene buffer when the next character responds.
  sceneBufferLastIndex = (getContext().chat?.length ?? 0) - 1;
  respondedThisRound = new Set();
  selectedGroupCharacter = null;
  setContinuityBadge(null);
  // A queued continuity note is anchored to message indices in the previous
  // chat, which are meaningless here. Clear the live slot/in-memory state, but
  // keep this chat's own stored note so loadAndInjectRepair() can re-arm it
  // after re-validating the anchor against the newly loaded chat.
  clearRepair({ keepStored: true });
  setStatusMessage('');
  // Initialise to the current chat length so the first CHARACTER_MESSAGE_RENDERED
  // after a chat load is not mistaken for a new message when the user swipes
  // immediately without generating anything first. A swipe does not grow the
  // chat array, so currentLength <= lastKnownChatLength correctly identifies it.
  lastKnownChatLength = getContext().chat?.length ?? 0;
  clearEmbeddingCache();
  clearUnifiedSlot();

  // Migrate chat data first - no character name needed, operates on chatMetadata.
  // Fast no-op when the container is already at the current schema version.
  await ensureChatMigrated();
  if (stale()) return;

  // Remove group arc stores for groups that no longer exist. Runs once per
  // chat load; cheap enough that it does not need further throttling.
  pruneOrphanedGroupArcs();

  const settings = getSettings();
  if (!settings.enabled) return;

  // Group chats: clear stale slots first (they may hold content from the
  // previous session's last responder), then inject fresh. onGroupMemberDrafted
  // will overwrite the character-specific slots before each Generate().
  if (getContext().groupId) {
    clearAllInjections();
    const summary = loadAndInjectSummary();
    updateShortTermUI(summary);
    injectSceneHistory();
    // Merge group-level persistent arcs into this chat before injecting.
    await mergeGroupPersistentArcs(getContext().groupId);
    if (stale()) return;
    injectArcs();
    updateScenesUI();
    updateArcsUI();

    // Show the group character selector and pre-populate panels and token
    // display for whichever member is selected (first member by default).
    updateGroupCharSelector();
    // Migrate the selected character's data container before any reads so that
    // confidence/decay fields and other v2+ additions are present. Other members
    // are migrated lazily on their first onGroupMemberDrafted.
    if (selectedGroupCharacter) ensureCharacterMigrated(selectedGroupCharacter);
    await injectMemories(selectedGroupCharacter);
    if (stale()) return;
    injectRelationshipHistory(selectedGroupCharacter);
    loadAndInjectEpistemicKnowledge(selectedGroupCharacter, selectedGroupCharacter);
    loadAndInjectStateLedger();
    await injectSessionMemories();
    if (stale()) return;
    injectCanon(selectedGroupCharacter);
    injectProfiles(selectedGroupCharacter);
    loadAndInjectRepair();
    updateLongTermUI(selectedGroupCharacter);
    updateRelationshipHistoryUI(selectedGroupCharacter);
    updateEpistemicUI(selectedGroupCharacter);
    updateSessionUI();
    updateFreshStartUI(isFreshStart());
    updateCanonUI(selectedGroupCharacter);
    updateProfilesUI(loadProfiles(selectedGroupCharacter));
    updateEntityPanel(selectedGroupCharacter);

    maybeInjectUnified();
    updateTokenDisplay();
    autoTuneBudgets(selectedGroupCharacter);
    // Mark load complete so the trim toast can fire on the next injection cycle,
    // not immediately on load before the user has done anything.
    markChatLoadComplete();

    const groupChatMeta = getContext().chatMetadata;
    if (settings.recap_enabled) {
      const hoursAway = getAwayHours();
      if (hoursAway > 0) {
        if (recapRunningForChat === groupChatMeta) {
          // Same chat fired again before the recap finished - already handled.
        } else {
          recapRunningForChat = groupChatMeta;
          setStatusMessage('Generating recap...');
          activeRecapHandle = startActivityLoader(settings, 'Generating recap...');
          const groupRecapHandle = activeRecapHandle;
          // Load identity captured when this recap started. It is passed to the
          // detached completion so ownership can be proven by the load id even
          // when chatMetadata is null (a null/null metadata comparison is not
          // proof of ownership).
          const recapLoadId = implGen;
          generateRecap()
            .then((recap) => {
              // The recap promise is detached from onChatChangedImpl, so it can
              // resolve after the user has switched chats and a different recap
              // has claimed the active slot. If we no longer own the slot, return
              // BEFORE touching the loader, status text, or suppression flag -
              // those now belong to the new chat, and clearing them here would
              // erase its recap UI.
              if (
                !recapCompletionOwnsSlot({
                  capturedMeta: groupChatMeta,
                  currentMeta: getContext().chatMetadata,
                  capturedHandle: groupRecapHandle,
                  activeHandle: activeRecapHandle,
                  capturedLoadId: recapLoadId,
                  currentLoadId: chatLoadId,
                })
              ) {
                return;
              }
              stopActivityLoader(groupRecapHandle);
              activeRecapHandle = null;
              if (recapRunningForChat === groupChatMeta) recapRunningForChat = null;
              const suppressed = recapSuppressed;
              recapSuppressed = false;
              setStatusMessage('');
              if (suppressed) return;
              if (recap) {
                recapOverlayChatMeta = groupChatMeta;
                displayRecap(recap, hoursAway);
              }
            })
            .catch((err) => {
              if (
                !recapCompletionOwnsSlot({
                  capturedMeta: groupChatMeta,
                  currentMeta: getContext().chatMetadata,
                  capturedHandle: groupRecapHandle,
                  activeHandle: activeRecapHandle,
                  capturedLoadId: recapLoadId,
                  currentLoadId: chatLoadId,
                })
              ) {
                return;
              }
              stopActivityLoader(groupRecapHandle);
              activeRecapHandle = null;
              if (recapRunningForChat === groupChatMeta) recapRunningForChat = null;
              recapSuppressed = false;
              console.error('[SmartMemory] Auto-recap failed:', err);
              setStatusMessage('');
            });
        }
      }
    }

    if (stale()) return;
    await updateLastActive();
    return;
  }

  const characterName = getCurrentCharacterName();

  // Migrate character data now that we know which character is active.
  // Fast no-op when already at the current schema version.
  ensureCharacterMigrated(characterName);

  // Seed the active character's canonical name into the long-term entity registry
  // if not already present, so the main character appears in the entity panel and
  // benefits from entity overlap scoring from the first message.
  if (characterName) {
    const ltReg = loadCharacterEntityRegistry(characterName);
    const before = ltReg.length;
    seedCharacterEntity(characterName, ltReg);
    if (ltReg.length > before) {
      saveCharacterEntityRegistry(characterName, ltReg);
      saveSettingsDebounced();
    }
  }

  const freshStart = isFreshStart();

  // Restore all injected context from the previous session.
  const summary = loadAndInjectSummary();
  injectCanon(characterName);
  updateShortTermUI(summary);

  await injectMemories(characterName);
  if (stale()) return;
  injectRelationshipHistory(characterName);
  loadAndInjectEpistemicKnowledge(characterName, characterName);
  loadAndInjectStateLedger();

  await injectSessionMemories();
  if (stale()) return;
  injectSceneHistory();
  // Merge character-level persistent arcs into this chat before injecting.
  await mergePersistentArcs(characterName);
  if (stale()) return;
  injectArcs();
  injectProfiles(characterName);
  loadAndInjectRepair();

  updateLongTermUI(characterName);
  updateRelationshipHistoryUI(characterName);
  updateEpistemicUI(characterName);
  updateFreshStartUI(freshStart);
  updateSessionUI();
  updateScenesUI();
  updateArcsUI();
  updateCanonUI(characterName);
  updateProfilesUI(loadProfiles(characterName));
  maybeInjectUnified();
  updateTokenDisplay();
  autoTuneBudgets(characterName);
  updateEmbeddingNotice();
  // Mark load complete so the budget trim warning toast can fire on the next
  // injection cycle for 1:1 chats too (previously only the group path did this).
  markChatLoadComplete();

  // Show a recap popup if the user has been away long enough.
  const soloChatMeta = getContext().chatMetadata;
  if (settings.recap_enabled) {
    const hoursAway = getAwayHours();
    if (hoursAway > 0) {
      if (recapRunningForChat === soloChatMeta) {
        // Same chat fired again before the recap finished - already handled.
      } else {
        recapRunningForChat = soloChatMeta;
        setStatusMessage('Generating recap...');
        activeRecapHandle = startActivityLoader(settings, 'Generating recap...');
        const soloRecapHandle = activeRecapHandle;
        // Load identity captured when this recap started. It is passed to the
        // detached completion so ownership can be proven by the load id even
        // when chatMetadata is null (a null/null metadata comparison is not
        // proof of ownership).
        const recapLoadId = implGen;
        generateRecap()
          .then((recap) => {
            // The recap promise is detached from onChatChangedImpl, so it can
            // resolve after the user has switched chats and a different recap
            // has claimed the active slot. If we no longer own the slot, return
            // BEFORE touching the loader, status text, or suppression flag -
            // those now belong to the new chat, and clearing them here would
            // erase its recap UI.
            if (
              !recapCompletionOwnsSlot({
                capturedMeta: soloChatMeta,
                currentMeta: getContext().chatMetadata,
                capturedHandle: soloRecapHandle,
                activeHandle: activeRecapHandle,
                capturedLoadId: recapLoadId,
                currentLoadId: chatLoadId,
              })
            ) {
              return;
            }
            stopActivityLoader(soloRecapHandle);
            activeRecapHandle = null;
            if (recapRunningForChat === soloChatMeta) recapRunningForChat = null;
            const suppressed = recapSuppressed;
            recapSuppressed = false;
            setStatusMessage('');
            if (suppressed) return;
            if (recap) {
              // Pass hoursAway explicitly - updateLastActive() runs after this
              // async block starts, so getAwayHours() inside displayRecap would
              // return 0 and always show "short break" regardless of actual gap.
              recapOverlayChatMeta = soloChatMeta;
              displayRecap(recap, hoursAway);
            }
          })
          .catch((err) => {
            if (
              !recapCompletionOwnsSlot({
                capturedMeta: soloChatMeta,
                currentMeta: getContext().chatMetadata,
                capturedHandle: soloRecapHandle,
                activeHandle: activeRecapHandle,
                capturedLoadId: recapLoadId,
                currentLoadId: chatLoadId,
              })
            ) {
              return;
            }
            stopActivityLoader(soloRecapHandle);
            activeRecapHandle = null;
            if (recapRunningForChat === soloChatMeta) recapRunningForChat = null;
            recapSuppressed = false;
            console.error('[SmartMemory] Auto-recap failed:', err);
            setStatusMessage('');
          });
      }
    }
  }

  if (stale()) return;
  await updateLastActive();
}

// ---- Group chat helpers -------------------------------------------------

/**
 * Resolves the active group's member names from their avatar ids.
 * Returns an empty array outside a group or when no member can be resolved.
 * Used by group extraction to gather state-ledger entities and partition
 * epistemic entries across every member rather than only the selected one.
 *
 * @returns {string[]}
 */
function getGroupMemberNames() {
  const context = getContext();
  const group = context.groups?.find((g) => String(g.id) === String(context.groupId));
  if (!group) return [];
  return [
    ...new Set(
      (group.members ?? [])
        .map((avatarId) => context.characters.find((c) => c.avatar === avatarId)?.name)
        .filter(Boolean),
    ),
  ];
}

/**
 * Populates the group character selector dropdown with the current group's
 * members, shows the selector row, and sets selectedGroupCharacter to
 * whichever member is currently selected (or the first member if none is).
 * Should be called from onChatChanged when context.groupId is set.
 */
function updateGroupCharSelector() {
  const context = getContext();
  const group = context.groups?.find((g) => String(g.id) === String(context.groupId));
  if (!group) {
    smLog('[SmartMemory] updateGroupCharSelector: group not found for groupId', context.groupId);
    return;
  }

  const members = (group.members ?? [])
    .map((avatarId) => context.characters.find((c) => c.avatar === avatarId)?.name)
    .filter(Boolean);

  if (members.length === 0) {
    smLog('[SmartMemory] updateGroupCharSelector: no resolvable members in group', group.id);
    return;
  }

  const $select = $('#sm_group_char_select');
  $select.empty();
  for (const name of members) {
    $select.append($('<option>', { value: name, text: name }));
  }

  // Preserve the current selection if the character is still in the group;
  // otherwise default to the first member.
  if (selectedGroupCharacter && members.includes(selectedGroupCharacter)) {
    $select.val(selectedGroupCharacter);
  } else {
    selectedGroupCharacter = members[0];
    $select.val(selectedGroupCharacter);
  }
}

// ---- Group chat handlers ------------------------------------------------

/**
 * Fires at the start of each group chat round (GROUP_WRAPPER_STARTED).
 * Clears the per-round participation set so the new round starts clean.
 *
 * @param {{ type?: string }} [event] - ST event payload; type='quiet' for background generates.
 */
function onGroupWrapperStarted({ type } = {}) {
  // Quiet generates (e.g. the Expressions extension classifying emotion after each round)
  // are not real user turns. Clearing the set here would erase the responders from the
  // preceding real round before onGroupWrapperFinished can loop over them.
  if (type === 'quiet') return;
  respondedThisRound = new Set();
  repairInjectedThisRound = false;
}

/**
 * Fires before each group member generates their response (GROUP_MEMBER_DRAFTED).
 * Swaps all injection slots to the character about to respond so Generate()
 * sees the correct context rather than the previous character's memories.
 *
 * @param {number} chId - ST character array index of the character being drafted.
 */
async function onGroupMemberDrafted(chId) {
  const settings = getSettings();
  if (!settings.enabled) return;

  const context = getContext();
  if (!context.chat) return;

  const characterName = context.characters[chId]?.name;
  if (!characterName) return;

  // Capture the operation revision so a branch change (swipe/edit/delete)
  // during the awaits below does not leave this character's slots half-swapped
  // with stale branch data.
  const capturedRev = getOperationRevision();
  const branchChanged = () => getOperationRevision() !== capturedRev;

  // Migrate per-character data on first access in this session. Fast no-op
  // once already at the current schema version.
  ensureCharacterMigrated(characterName);

  // Seed the character entity so it appears in the entity panel and benefits
  // from overlap scoring from the first message.
  const ltReg = loadCharacterEntityRegistry(characterName);
  const before = ltReg.length;
  seedCharacterEntity(characterName, ltReg);
  if (ltReg.length > before) {
    saveCharacterEntityRegistry(characterName, ltReg);
    saveSettingsDebounced();
  }

  // Restore all injected context for this character.
  const summary = loadAndInjectSummary();
  injectCanon(characterName);
  updateShortTermUI(summary);

  await injectMemories(characterName);
  if (branchChanged()) return;
  injectRelationshipHistory(characterName);
  injectEpistemicKnowledge(characterName, characterName);
  await injectSessionMemories();
  if (branchChanged()) return;
  injectSceneHistory();
  injectArcs();
  injectProfiles(characterName);
  // Repair is one-shot - only the first character in a round gets the anchored
  // note. The standing durable-retcon note, however, applies to the whole
  // round, so every subsequent member re-injects it. applyPendingRepair()
  // validates the anchor before injecting the one-shot note.
  if (!repairInjectedThisRound) {
    applyPendingRepair();
    repairInjectedThisRound = true;
  } else {
    applyDurableRetconNote();
  }

  // The token display is NOT updated here. Injecting this character's slots
  // is correct for the model, but updating the display here would overwrite
  // the selected character's token bars with the generating character's data.
  // onGroupWrapperFinished restores the selected character's slots and
  // updates the display once the entire round is done.
}

/**
 * Fires after all characters in a group round have responded
 * (GROUP_WRAPPER_FINISHED). Runs compaction, scene break detection, and
 * batched extraction once per round rather than once per character response.
 * Profile B continuity also fires once here instead of per-character.
 *
 * @param {{ type?: string }} [event] - ST event payload; type='quiet' for background generates.
 */
async function onGroupWrapperFinished({ type } = {}) {
  // Quiet generates (e.g. the Expressions extension) are not real user turns.
  // Skipping them keeps the extraction counter and respondedThisRound in sync with
  // actual story progress rather than firing on every post-round expression classify.
  if (type === 'quiet') return;
  // Swipes and continues are not committed user turns. GROUP_WRAPPER_FINISHED
  // fires with type='swipe' or type='continue' for these, so without this guard
  // every swipe or /continue increments the extraction counter. The content will
  // be captured correctly once the user sends a real message and extraction fires.
  if (type === 'swipe' || type === 'continue') return;
  if (generationInProgress) return;
  const settings = getSettings();
  if (!settings.enabled) return;
  const context = getContext();
  if (!context.chat || context.chat.length === 0) return;

  // Capture the current chat generation and operation revision so we can abort
  // before any write if the user switches chats or rewrites the branch (swipe,
  // edit, delete) while a model call is in progress.
  const capturedGen = chatLoadId;
  const capturedRev = getOperationRevision();
  const chatChanged = () => chatLoadId !== capturedGen;
  const branchChanged = () => chatChanged() || getOperationRevision() !== capturedRev;

  // Snapshot before any await - onGroupWrapperStarted resets respondedThisRound
  // for the next round and can fire while this function is mid-await if the user
  // sends a new message quickly. Everything below uses the snapshot.
  const roundResponders = new Set(respondedThisRound);

  // All active group members - used for group epistemic partitioning and
  // cross-member state-ledger entity gathering. Fall back to this round's
  // responders if the roster cannot be resolved.
  const groupMemberNames = getGroupMemberNames();
  const activeGroupMembers = groupMemberNames.length > 0 ? groupMemberNames : [...roundResponders];

  // Build scene check text from the end of the completed round.
  const lastMsg = context.chat
    .slice()
    .reverse()
    .find((m) => !m.is_user && !m.is_system && m.mes);
  const lastMsgText = lastMsg?.mes ?? '';
  const lastUserMsg = context.chat
    .slice()
    .reverse()
    .find((m) => m.is_user && !m.is_system && m.mes);
  const lastUserMsgText = lastUserMsg?.mes ?? '';
  const aiMessages = context.chat.filter((m) => !m.is_user && !m.is_system && m.mes);
  const prevAiMsgText = aiMessages.length >= 2 ? aiMessages[aiMessages.length - 2].mes : '';

  // Defer the async pipeline - same reason as the solo handler.
  setTimeout(() => {
    (async () => {
      // Guard: bail if the user switched chats during the deferral window.
      if (branchChanged()) return;

      // Tracks whether a scene-break epistemic pass already ran this round so
      // the periodic extraction below does not duplicate the model call.
      let epistemicThisPass = false;

      // Step 1: compaction - once per round rather than per character response.
      // Gated by !isFreshStart() and !extractionRunning matching the solo path.
      if (
        settings.compaction_enabled &&
        !compactionRunning &&
        !extractionRunning &&
        !isFreshStart()
      ) {
        compactionRunning = true;
        try {
          const needed = await shouldCompact();
          if (needed) {
            setStatusMessage('Updating story summary...');
            const source = extension_settings[MODULE_NAME]?.source ?? memory_sources.main;
            const compactionHandle =
              source !== memory_sources.main
                ? startActivityLoader(settings, 'Updating story summary...')
                : null;
            const summary = await runCompaction({ abortCheck: branchChanged });
            stopActivityLoader(compactionHandle);
            if (summary) {
              injectSummary(summary);
              updateShortTermUI(summary);
              maybeInjectUnified();
              updateTokenDisplay();
              setStatusMessage('Summary updated.');
            } else {
              setStatusMessage('');
            }
          }
        } catch (err) {
          console.error('[SmartMemory] Compaction error:', err);
        } finally {
          compactionRunning = false;
        }
      }

      // Step 2: scene break detection - once for the round using accumulated buffer.
      // Gated by !isFreshStart() and !extractionRunning matching the solo path.
      const sceneCheckText = [lastUserMsgText, lastMsgText].filter(Boolean).join('\n');
      if (settings.scene_enabled && sceneCheckText && !isFreshStart() && !extractionRunning) {
        try {
          const wasBreak = await processSceneBreak(
            sceneCheckText,
            sceneMessageBuffer,
            prevAiMsgText,
            branchChanged,
          );
          if (wasBreak) {
            injectSceneHistory();
            updateScenesUI();
            maybeInjectUnified();
            updateTokenDisplay();
            if (isEpistemicEnabled() && activeGroupMembers.length > 0) {
              // One extraction pass, then partition the subjects into each
              // member's own epistemic store so every group member keeps the
              // knowledge they gained during the scene.
              await extractAndPartitionGroupEpistemic(
                sceneMessageBuffer,
                activeGroupMembers,
                branchChanged,
              );
              const epistemicChar = selectedGroupCharacter || activeGroupMembers[0] || null;
              if (epistemicChar) {
                injectEpistemicKnowledge(epistemicChar, epistemicChar, true, true);
                updateEpistemicUI(epistemicChar);
              }
              epistemicThisPass = true;
            }
            sceneMessageBuffer = [];
            // Point the cursor at the current end of chat, not -1. Setting -1
            // would make the next render slice from index 0 and re-ingest the
            // entire history into the fresh scene buffer.
            sceneBufferLastIndex = context.chat.length - 1;
            setStatusMessage('Scene break detected.');
          }
        } catch (err) {
          console.error('[SmartMemory] Scene detection error:', err);
        }
      }

      // Step 3: batched extraction - counter increments once per round, not per
      // character response, so extractEvery=3 means every 3 user turns as intended.
      if (!extractionRunning) {
        messagesSinceLastExtraction++;
        messagesSinceLastProfileRegen++;

        const extractEvery = Math.min(
          settings.session_extract_every ?? 3,
          settings.longterm_extract_every ?? 3,
        );

        smLog(
          `[SmartMemory] Group counter: ${messagesSinceLastExtraction}/${extractEvery} (extractionRunning=${extractionRunning})`,
        );

        if (messagesSinceLastExtraction >= extractEvery) {
          extractionRunning = true;
          smLog(`[SmartMemory] Group extraction starting at ${new Date().toISOString()}`);

          const lastExtractCutoff = context.chatMetadata?.[META_KEY]?.lastExtractCutoff ?? null;
          const sessionWindow = getSmartExtractionWindow(
            context.chat,
            lastExtractCutoff,
            extractEvery,
            40,
          );
          // Scale the raw window by character count so that after per-character
          // filtering each character still gets roughly 20 messages of context.
          const longtermRawSize = 20 * Math.max(1, roundResponders.size);
          const longtermWindow = getSmartExtractionWindow(
            context.chat,
            lastExtractCutoff,
            extractEvery,
            longtermRawSize,
          );

          // Injection refresh period check - same logic as solo path.
          const injRefreshPeriodGroup = settings.injection_refresh_period ?? 1;
          const injLastRefreshGroup = Math.min(
            context.chatMetadata?.[META_KEY]?.lastInjectionRefresh ?? 0,
            Math.max(0, context.chat.length - 1),
          );
          const shouldRefreshInjectionsGroup =
            injRefreshPeriodGroup <= 1 ||
            context.chat.length - 1 - injLastRefreshGroup >= injRefreshPeriodGroup;

          // Snapshot before any awaits - same reason as solo path.
          const snapshotLastGroup = context.chat[context.chat.length - 1];
          const snapshotCutoffGroup =
            context.chat.length > 0 &&
            snapshotLastGroup &&
            !snapshotLastGroup.is_user &&
            !snapshotLastGroup.is_system
              ? context.chat.length - 1
              : context.chat.length;

          if (longtermWindow.length === 0 && sessionWindow.length === 0) {
            extractionRunning = false;
          } else {
            messagesSinceLastExtraction = 0;

            // Baseline snapshot before this round's writes (same as solo path).
            takeStateSnapshot(Math.max(0, snapshotCutoffGroup - 1));

            setStatusMessage('Extracting memories...');

            const activityHandle = startActivityLoader(settings, 'Extracting memories...');

            try {
              let total = 0;

              // Adaptive budgets are per-turn values passed to injectors below;
              // they are never written into settings, so a save during the model
              // call cannot persist them over the user's configured values.
              const lastAiMessage = context.chat?.at(-1)?.mes ?? '';
              const turnType = classifyTurn(lastAiMessage);
              const budgets = adaptiveBudgets(settings, turnType);

              if (branchChanged()) throw CHAT_SWITCHED;
              // Session extraction is chat-wide - all characters share one session store.
              if (settings.session_enabled && sessionWindow.length > 0 && !isFreshStart()) {
                const priorSessionIds = new Set(
                  loadSessionMemories()
                    .map((m) => m.id)
                    .filter(Boolean),
                );

                const count = await extractSessionMemories(sessionWindow, branchChanged).catch(
                  (err) => {
                    console.error('[SmartMemory] Session extraction error:', err);
                    return 0;
                  },
                );
                if (!consolidationRunning) {
                  consolidationRunning = true;
                  await consolidateSessionMemories(false, branchChanged).catch((err) => {
                    console.error('[SmartMemory] Session consolidation error:', err);
                  });
                  consolidationRunning = false;
                }
                if (shouldRefreshInjectionsGroup)
                  await injectSessionMemories(true, budgets.session);
                updateSessionUI();
                total += count;

                if (settings.scene_enabled && count > 0) {
                  const newIds = loadSessionMemories()
                    .map((m) => m.id)
                    .filter((id) => id && !priorSessionIds.has(id));
                  if (newIds.length > 0) {
                    await linkMemoriesToLastScene(newIds).catch((err) =>
                      console.error('[SmartMemory] Scene memory linking failed:', err),
                    );
                  }
                }
              }

              if (branchChanged()) throw CHAT_SWITCHED;
              // Long-term extraction and profiles run per character since each
              // character has their own store. Sequential per CLAUDE.md constraint.
              for (const characterName of roundResponders) {
                // Filter to this character's messages plus user messages so the
                // model only sees context directly relevant to the character being
                // extracted. User messages are included because they address all
                // characters and provide shared narrative context.
                const characterLongtermWindow = longtermWindow.filter(
                  (m) => m.is_user || m.name === characterName,
                );

                if (
                  settings.longterm_enabled &&
                  characterLongtermWindow.length > 0 &&
                  !isFreshStart()
                ) {
                  const count = await extractAndStoreMemories(
                    characterName,
                    characterLongtermWindow,
                    setStatusMessage,
                    branchChanged,
                  ).catch((err) => {
                    console.error('[SmartMemory] Long-term extraction error:', err);
                    return 0;
                  });
                  if (count > 0 && settings.consolidation_enabled && !consolidationRunning) {
                    consolidationRunning = true;
                    const removed = await consolidateMemories(
                      characterName,
                      false,
                      branchChanged,
                    ).catch((err) => {
                      console.error('[SmartMemory] Consolidation error:', err);
                      return 0;
                    });
                    consolidationRunning = false;
                    if (removed > 0) {
                      setStatusMessage(
                        `Consolidated ${removed} redundant memories for ${characterName}.`,
                      );
                      toastr.info(
                        `Merged ${removed} redundant ${removed === 1 ? 'memory' : 'memories'}.`,
                        'Smart Memory',
                        { timeOut: 3000 },
                      );
                    }
                  }
                  total += count;
                }

                if (settings.profiles_enabled && characterName && !isFreshStart()) {
                  await generateProfiles(characterName, branchChanged)
                    .then((profiles) => {
                      if (branchChanged()) return;
                      if (profiles) {
                        // Only update the UI panel if this is the character currently
                        // shown in the selector - other characters' profiles are stored
                        // but the display follows the selector.
                        if (characterName === selectedGroupCharacter) updateProfilesUI(profiles);
                      }
                    })
                    .catch((err) => console.error('[SmartMemory] Profile generation error:', err));
                  messagesSinceLastProfileRegen = 0;
                }
              }

              // Periodic group epistemic refresh so knowledge revealed between scene
              // breaks is captured. One pass partitions entries across every member.
              if (branchChanged()) throw CHAT_SWITCHED;
              if (
                isEpistemicEnabled() &&
                !isFreshStart() &&
                !epistemicThisPass &&
                activeGroupMembers.length > 0
              ) {
                const epistemicWindow = longtermWindow.length > 0 ? longtermWindow : sessionWindow;
                if (epistemicWindow.length > 0) {
                  await extractAndPartitionGroupEpistemic(
                    epistemicWindow,
                    activeGroupMembers,
                    branchChanged,
                  ).catch((err) => {
                    console.error('[SmartMemory] Group periodic epistemic error:', err);
                  });
                  if (selectedGroupCharacter) {
                    injectEpistemicKnowledge(selectedGroupCharacter, selectedGroupCharacter);
                    updateEpistemicUI(selectedGroupCharacter);
                  }
                  epistemicThisPass = true;
                }
              }

              if (branchChanged()) throw CHAT_SWITCHED;
              // Arc extraction is chat-wide - once per round after all characters.
              // Snapshot summary count first so the canon check below can detect a
              // new resolution without re-running extraction.
              const arcSummaryCountBefore = settings.arcs_enabled ? loadArcSummaries().length : 0;

              if (settings.arcs_enabled && !isFreshStart()) {
                const arcWindow = getStableExtractionWindow(context.chat, 100);
                const count = await extractArcs(arcWindow, null, branchChanged).catch((err) => {
                  console.error('[SmartMemory] Arc extraction error:', err);
                  return 0;
                });
                injectArcs(budgets.arcs);
                updateArcsUI();
                total += count;

                // Sync resolved flags into the group persistent store. The solo path
                // handles this inside extractArcs via characterName, but group arc
                // extraction is chat-wide with no single characterName. Any arc now
                // marked resolved in chatMetadata should also be marked resolved in
                // the group store so the state carries into future chats.
                const groupId = context.groupId;
                if (groupId) {
                  const currentArcs = loadArcs();
                  const resolvedContents = new Set(
                    currentArcs.filter((a) => a.resolved).map((a) => a.content),
                  );
                  if (resolvedContents.size > 0) {
                    const groupPersistent = loadGroupPersistentArcs(groupId);
                    let changed = false;
                    for (const p of groupPersistent) {
                      if (resolvedContents.has(p.content) && !p.resolved) {
                        p.resolved = true;
                        changed = true;
                      }
                    }
                    if (changed) saveGroupPersistentArcs(groupId, groupPersistent);
                  }
                }
              }

              if (branchChanged()) throw CHAT_SWITCHED;
              if (!isFreshStart()) {
                // Pass every active member so entities from the whole group's
                // registries are available, not just the selected character's.
                await runStateCardExtraction(
                  activeGroupMembers,
                  longtermWindow,
                  branchChanged,
                ).catch((err) => {
                  console.error('[SmartMemory] State ledger extraction error:', err);
                });
                injectStateLedger(true);
              }

              // Profile B only: auto-regenerate canon per responding character when
              // a new arc resolved this pass. Runs after arc extraction so it can
              // react to arcs closed in this round.
              if (
                settings.canon_enabled &&
                settings.arcs_enabled &&
                !isFreshStart() &&
                getHardwareProfile() === 'b' &&
                loadArcSummaries().length > arcSummaryCountBefore
              ) {
                for (const characterName of roundResponders) {
                  await generateCanon(characterName, branchChanged)
                    .then(() => injectCanon(characterName))
                    .catch((err) => console.error('[SmartMemory] Auto-canon error:', err));
                }
              }

              // The branch can be rewritten during the final model calls. If it
              // was, abort now rather than writing memories/state/UI for a branch
              // the user has discarded.
              if (branchChanged()) return;

              // Refresh entity panel with the last character who responded.
              const lastResponder = [...roundResponders].at(-1);
              if (lastResponder) updateEntityPanel(lastResponder);

              // Refresh the settings panel for whichever character the selector
              // is showing so new memories appear without the user having to
              // manually switch selection.
              updateLongTermUI(selectedGroupCharacter);
              updateRelationshipHistoryUI(selectedGroupCharacter);
              updateSessionUI();

              setStatusMessage(total > 0 ? `${total} item${total === 1 ? '' : 's'} stored.` : '');
              autoTuneBudgets(selectedGroupCharacter);

              const metaAfterGroup = context.chatMetadata?.[META_KEY];
              if (metaAfterGroup) {
                metaAfterGroup.lastExtractCutoff = snapshotCutoffGroup;
                if (shouldRefreshInjectionsGroup)
                  metaAfterGroup.lastInjectionRefresh = snapshotCutoffGroup;
                context.saveMetadata();
              }

              // Record a message-anchored snapshot after this round's pass.
              takeStateSnapshot(snapshotCutoffGroup);
            } catch (err) {
              if (err === CHAT_SWITCHED) {
                smLog('[SmartMemory] Group extraction aborted: chat switched mid-extraction.');
              } else {
                console.error('[SmartMemory] Extraction error:', err);
              }
              setStatusMessage('');
            } finally {
              smLog(`[SmartMemory] Group extraction finished at ${new Date().toISOString()}`);
              stopActivityLoader(activityHandle);
              extractionRunning = false;
            }
          }
        }
      }

      // Step 4 (Profile B only): scheduled profile regen between extraction passes.
      // Run for each character who responded this round.
      // Note: step 3 resets messagesSinceLastProfileRegen to 0 whenever profiles
      // are regenerated during extraction, so this block only fires on rounds
      // where extraction did not run (i.e. between extraction-frequency intervals).
      if (
        settings.profiles_enabled &&
        (settings.profiles_regen_every ?? 0) > 0 &&
        getHardwareProfile() === 'b' &&
        !isFreshStart() &&
        messagesSinceLastProfileRegen >= settings.profiles_regen_every
      ) {
        messagesSinceLastProfileRegen = 0;
        for (const characterName of roundResponders) {
          const schedProfileHandle = startActivityLoader(settings, 'Updating profiles...');
          generateProfiles(characterName, branchChanged)
            .then((profiles) => {
              stopActivityLoader(schedProfileHandle);
              if (branchChanged()) return;
              if (profiles) {
                injectProfiles(characterName);
                if (characterName === selectedGroupCharacter) updateProfilesUI(profiles);
              }
            })
            .catch((err) => {
              stopActivityLoader(schedProfileHandle);
              console.error('[SmartMemory] Scheduled profile regeneration error:', err);
            });
        }
      }

      // Step 5: the note injected before this round's generation has been
      // consumed. Clear it so repair remains strictly one-shot.
      clearRepair();

      // Advance durable retcon lifetimes once per group round - never per member.
      // Expired retcons are resolved into the group members' state.
      advanceDurableRetcons(activeGroupMembers);

      // Step 6 (Profile B only): silent continuity check - once per round using
      // the last character who responded. Running per-character would multiply
      // model calls by character count for the same round of messages.
      // handleContinuityResult applies continuity_mode (warn/repair/off).
      const lastResponder = [...roundResponders].at(-1);
      if (
        getHardwareProfile() === 'b' &&
        settings.continuity_auto_check &&
        lastResponder &&
        !continuityCheckRunning
      ) {
        continuityCheckRunning = true;
        // Capture the branch state so a result from a discarded branch can never
        // render, toast, or queue a note against the replacement branch.
        const isCurrentChat = () => !branchChanged();
        const continuityHandle = startActivityLoader(settings, 'Checking continuity...');
        checkContinuity(lastResponder, isCurrentChat)
          .then((result) => {
            if (!isCurrentChat()) return;
            handleContinuityResult(result, lastResponder, isCurrentChat);
            // Snapshot any durable retcon into its anchor turn so swiping a
            // later turn does not discard a correction the story still needs.
            if (result && Number.isInteger(result.anchorIdx)) takeStateSnapshot(result.anchorIdx);
          })
          .catch((err) => {
            if (!isCurrentChat()) return;
            console.error('[SmartMemory] Auto-continuity check failed:', err);
          })
          .finally(() => {
            stopActivityLoader(continuityHandle);
            if (isCurrentChat()) continuityCheckRunning = false;
          });
      }

      // Step 7: restore injection slots to the selected character. onGroupMemberDrafted
      // swaps slots to each generating character in turn; after the round ends the
      // last responder's data is still in the slots. Re-inject for the selector choice
      // so the token display reflects what the panel is showing, not who generated last.
      if (selectedGroupCharacter) {
        // Capture the revision before the awaits below. If the branch changes
        // while a slot is being re-injected, stop restoring rather than leave
        // stale branch data in the prompt.
        const reinjectionRev = getOperationRevision();
        await injectMemories(selectedGroupCharacter);
        if (getOperationRevision() !== reinjectionRev) return;
        injectRelationshipHistory(selectedGroupCharacter);
        injectEpistemicKnowledge(selectedGroupCharacter, selectedGroupCharacter);
        injectCanon(selectedGroupCharacter);
        injectProfiles(selectedGroupCharacter);
        maybeInjectUnified();
        updateTokenDisplay();
      }

      // Step 8: update lastActive.
      await updateLastActive();
    })().catch(console.error);
  }, 0);
}

// ---- Group membership changes -------------------------------------------

/**
 * Fires when the group roster changes (GROUP_UPDATED) - a member was added
 * or removed while a chat is open. Rebuilds the group character selector so
 * the new member appears immediately, and refreshes the token display to
 * include or drop their memory footprint row.
 *
 * Injection context for a newly added member is handled automatically:
 * onGroupMemberDrafted fires before their first generation and sets up all
 * slots at that point, so no pre-injection is needed here.
 */
function onGroupUpdated() {
  const context = getContext();
  if (!context.groupId) return;
  updateGroupCharSelector();
  updateTokenDisplay();
}

// ---- Init ---------------------------------------------------------------

jQuery(async function () {
  loadSettings();
  registerSmartMemoryMacros();

  const html = await renderExtensionTemplateAsync('third-party/Smart-Memory', 'settings', {
    defaultSettings,
  });
  $('#extensions_settings').append(html);

  bindSettingsUI({
    get extractionRunning() {
      return extractionRunning;
    },
    set extractionRunning(v) {
      extractionRunning = v;
    },
    get compactionRunning() {
      return compactionRunning;
    },
    set compactionRunning(v) {
      compactionRunning = v;
    },
    get consolidationRunning() {
      return consolidationRunning;
    },
    set consolidationRunning(v) {
      consolidationRunning = v;
    },
    get catchUpCancelled() {
      return catchUpCancelled;
    },
    set catchUpCancelled(v) {
      catchUpCancelled = v;
    },
    get sceneMessageBuffer() {
      return sceneMessageBuffer;
    },
    set sceneMessageBuffer(v) {
      sceneMessageBuffer = v;
    },
    get sceneBufferLastIndex() {
      return sceneBufferLastIndex;
    },
    set sceneBufferLastIndex(v) {
      sceneBufferLastIndex = v;
    },
    get selectedGroupCharacter() {
      return selectedGroupCharacter;
    },
    set selectedGroupCharacter(v) {
      selectedGroupCharacter = v;
    },
    clearAllInjections,
    onChatChanged,
    getSelectedCharacterName,
    getStableExtractionWindowWithFallback,
  });
  initTooltips();
  initTypePickers();
  updateTokenDisplay();

  // makeLast ensures Smart Memory processes the message after all other
  // extensions have had their turn with it.
  eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
  eventSource.on(event_types.CHAT_LOADED, onChatChanged);
  // Dismiss the recap overlay when a message is sent or when generation starts.
  // MESSAGE_SENT handles the case where the overlay is already visible when the
  // message arrives. GENERATION_STARTED covers the race condition where the
  // message arrives while the recap model call is still running (overlay not yet
  // created), then the overlay appears after MESSAGE_SENT fired. Restricted to
  // 'normal' type only - 'quiet' is Smart Memory's own background extraction,
  // and other types (e.g. expression classification) are extension background
  // calls that should not dismiss the overlay.
  eventSource.on(event_types.MESSAGE_SENT, () => {
    captureChatRefs();
    $('#sm_recap_overlay').remove();
    recapOverlayChatMeta = null;
    // If a recap is still generating when the message is sent, suppress the
    // popup - showing it after the response arrives would be confusing.
    if (recapRunningForChat !== null) recapSuppressed = true;
  });
  eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
    // Only track real normal generations. ST's PromptManager performs a
    // post-message DRY-RUN (Generate('normal', {}, true)) to compute token
    // composition; a dry-run returns before emitting MESSAGE_RECEIVED or
    // GENERATION_ENDED, so counting it would lock the gate and silently skip
    // extraction on every turn. Quiet generations are other extensions'
    // background calls and produce no CHARACTER_MESSAGE_RENDERED.
    if (isTrackableGeneration(type, dryRun)) {
      applyGenerationGateEvent('start');
      generationStartTime = Date.now();
      startGenerationWatchdog();
      $('#sm_recap_overlay').remove();
      recapOverlayChatMeta = null;
      // Inject a queued continuity note before the model sees the prompt.
      // The anchor check discards it if the turn it was based on was edited,
      // swiped, or deleted.
      applyPendingRepair();
    }
  });
  eventSource.on(event_types.MESSAGE_RECEIVED, () => {
    if (generationInProgress) {
      // MESSAGE_RECEIVED is authoritative evidence that a generation produced a
      // committed message. The correlator consumes its slot; if another slot is
      // genuinely pending, keep a bounded-recovery watchdog instead of stranding
      // that slot after opening the render gate.
      const next = applyGenerationGateEvent('complete');
      reconcileGenerationWatchdog(next);
    }
  });
  // Terminal generation paths. A cancelled or stopped generation produces no
  // MESSAGE_RECEIVED and no CHARACTER_MESSAGE_RENDERED, which would otherwise
  // leave the gate stuck true and suppress extraction for every subsequent
  // message.
  //
  // SillyTavern's terminal events carry no generation id, and stopGeneration()
  // emits GENERATION_STOPPED immediately followed by GENERATION_ENDED via
  // hideStopButton(). correlateGenerationGate pairs starts and terminals FIFO
  // and collapses the back-to-back STOPPED/ENDED pair for one generation by
  // event kind (so a delayed older pair can never swallow a newer generation's
  // real terminal), so a delayed terminal from an older generation advances the
  // queue WITHOUT clearing a newer generation's gate. A genuine immediate cancel
  // has a single pending generation and still clears at once. The residual
  // constraint - a STOPPED that never receives its ENDED relies on the watchdog -
  // is documented on correlateGenerationGate.
  const onGenerationTerminal = (kind) => {
    const next = applyGenerationGateEvent(kind);
    reconcileGenerationWatchdog(next);
  };
  eventSource.on(event_types.GENERATION_STOPPED, () => onGenerationTerminal('stopped'));
  eventSource.on(event_types.GENERATION_ENDED, () => onGenerationTerminal('ended'));
  // Allow external extensions to dismiss the recap overlay programmatically
  // (e.g. Discord Connector can dispatch this when the user sends a command
  // remotely and the blocking modal is preventing it from responding).
  $(document).on('smart_memory:dismiss_recap', () => {
    $('#sm_recap_overlay').remove();
    recapOverlayChatMeta = null;
  });
  // Profile B: auto-regenerate canon when the user manually resolves an arc
  // and a summary was successfully generated for it.
  $(document).on('smart_memory:arc_resolved_with_summary', async (e, characterName, groupId) => {
    const settings = getSettings();
    const charName = groupId ? selectedGroupCharacter : characterName;
    if (
      settings.canon_enabled &&
      settings.arcs_enabled &&
      charName &&
      !isFreshStart() &&
      getHardwareProfile() === 'b'
    ) {
      // Capture the revision so a manual resolve that lands after a branch change
      // cannot regenerate canon for a branch the user has already discarded.
      const capturedRev = getOperationRevision();
      const branchChanged = () => getOperationRevision() !== capturedRev;
      await generateCanon(charName, branchChanged)
        .then(() => injectCanon(charName))
        .catch((err) => console.error('[SmartMemory] Auto-canon after manual resolve error:', err));
    }
  });
  eventSource.on(event_types.GROUP_WRAPPER_STARTED, onGroupWrapperStarted);
  eventSource.on(event_types.GROUP_MEMBER_DRAFTED, onGroupMemberDrafted);
  eventSource.on(event_types.GROUP_WRAPPER_FINISHED, onGroupWrapperFinished);
  eventSource.on(event_types.GROUP_UPDATED, onGroupUpdated);

  // Warn when the user creates a checkpoint or branch without read-only mode
  // active. Long-term memories will continue forming in the current chat and
  // will not roll back if they later switch to the checkpoint/branch.
  $(document).on('click', '.mes_create_bookmark, .mes_create_branch', () => {
    if (!isFreshStart()) {
      toastr.warning(
        'Smart Memory is still active. Enable read-only mode first to keep this session consequence-free.',
        'Smart Memory',
        { timeOut: 7000, positionClass: 'toast-bottom-right' },
      );
    }
  });

  // When the user swipes, immediately abort any in-flight Ollama or
  // OpenAI-compat memory generation. Without this, the swipe generation request
  // queues behind the memory model on the same Ollama instance and ST aborts it
  // before the memory model finishes, reverting the swipe counter. The aborted
  // memory operation returns an empty response and is skipped cleanly - it will
  // retry on the next accepted message.
  eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
    // A swipe discards the previous branch. Bump the revision so any in-flight
    // background task is invalidated, clear the generation flag, and abort any
    // external memory generation immediately.
    bumpOperationRevision();
    applyGenerationGateEvent('reset');
    generationStartTime = 0;
    clearGenerationWatchdog();
    abortCurrentMemoryGeneration();
    abortEmbeddingRequests();
    // A swipe rewrites the message the continuity check was anchored to, so
    // any queued note is no longer valid for this branch of the story.
    clearRepair();

    const context = getContext();
    const chat = context.chat ?? [];
    if (chat.length === 0) return;

    const targetIndex = Number.isInteger(messageId) ? messageId : chat.length - 1;
    const swiped = chat[targetIndex] ?? chat[chat.length - 1];
    // Swipes only replace assistant messages. User/system messages never enter
    // the scene buffer, so there is nothing to rewind for them.
    if (!swiped || swiped.is_user || swiped.is_system) return;

    // Roll the chat-scoped state back to the turn before the swiped message so
    // facts, state cards, arcs, secrets, and durable retcons from the discarded
    // reply can never survive the rewrite.
    rollbackStateToSnapshot(targetIndex - 1);
    prunePersistentMemoriesAfterRollback(
      targetIndex - 1,
      [getCurrentCharacterName(), ...getGroupMemberNames()].filter(Boolean),
    );
    refreshAfterStateRollback();

    // Drop the buffered copy of the swiped message when it is the buffer tail.
    // This prevents the old variant from being included in the next scene
    // summary alongside the regenerated text. The index check covers ST
    // versions that replace the message object instead of mutating it in place.
    const buffered = sceneMessageBuffer[sceneMessageBuffer.length - 1];
    const bufferedSwipedMessage =
      buffered &&
      (buffered === swiped ||
        (buffered.mes === swiped.mes && buffered.name === swiped.name) ||
        sceneBufferLastIndex >= targetIndex);
    if (bufferedSwipedMessage) {
      sceneMessageBuffer.pop();
    }

    // Rewind the cursor so the regenerated message is captured once by the
    // next real character render instead of being skipped as already-seen.
    sceneBufferLastIndex = Math.min(sceneBufferLastIndex, chat.length - 2);
  });

  // When an already-extracted message is edited, everything extracted from it
  // and from later turns is now based on text the user replaced. Roll the
  // chat-scoped state back to the turn before the edit, rewind the extraction
  // cursor, and rewind the scene buffer so the rewritten text is processed
  // again instead of being skipped as already-seen.
  eventSource.on(event_types.MESSAGE_EDITED, (messageId) => {
    // An edit rewrites the branch. Bump the revision so any in-flight
    // background task is invalidated, clear the generation flag, and abort any
    // external memory generation before touching state.
    bumpOperationRevision();
    applyGenerationGateEvent('reset');
    generationStartTime = 0;
    clearGenerationWatchdog();
    abortCurrentMemoryGeneration();
    abortEmbeddingRequests();
    if (!Number.isInteger(messageId)) return;

    const context = getContext();
    const meta = context.chatMetadata?.[META_KEY];
    const lastExtractCutoff = Number.isInteger(meta?.lastExtractCutoff)
      ? meta.lastExtractCutoff
      : -1;

    // Only messages that were already fed to extraction need a rollback.
    if (messageId > lastExtractCutoff) return;

    const rollbackTarget = messageId - 1;

    // Set the cursor before rollback so the same metadata save persists it.
    // The cursor itself is clamped at 0; the state rollback target is not, so
    // editing the very first turn resets state instead of preserving it.
    if (meta) meta.lastExtractCutoff = Math.max(0, rollbackTarget);
    rollbackStateToSnapshot(rollbackTarget);
    prunePersistentMemoriesAfterRollback(
      rollbackTarget,
      [getCurrentCharacterName(), ...getGroupMemberNames()].filter(Boolean),
    );

    // Drop the buffered copy of the edited message and every buffered turn after
    // it so the rewritten branch is captured cleanly by the next pass.
    sceneBufferLastIndex = Math.min(sceneBufferLastIndex, rollbackTarget);

    clearRepair();
    refreshAfterStateRollback();
  });

  // When a message is deleted, trim the scene buffer to only messages that
  // still exist in the chat. Without this, a deleted message would remain in
  // the buffer and be included in the next scene summary.
  eventSource.on(event_types.MESSAGE_DELETED, (messageId) => {
    // A delete rewrites the branch. Bump the revision so any in-flight
    // background task is invalidated, clear the generation flag, and abort any
    // external memory generation before touching state.
    bumpOperationRevision();
    applyGenerationGateEvent('reset');
    generationStartTime = 0;
    clearGenerationWatchdog();
    abortCurrentMemoryGeneration();
    abortEmbeddingRequests();
    const context = getContext();
    const chatSet = new Set(context.chat);
    sceneMessageBuffer = sceneMessageBuffer.filter((m) => chatSet.has(m));
    sceneBufferLastIndex = Math.min(sceneBufferLastIndex, context.chat.length - 1);
    // Deleting a message shifts every later index and may remove the anchor.
    // Discard any queued note rather than risk applying it to a different turn.
    clearRepair();
    // Roll the chat-scoped state back to the surviving turn before the deleted
    // one so its facts, state cards, arcs, secrets, and retcons are gone.
    // SillyTavern emits MESSAGE_DELETED with the NEW chat length, never the
    // deleted index, so derive the deleted turn by diffing object identity
    // against the last captured chat snapshot. This is correct for both a single
    // mid-chat delete and a "delete from here" range delete.
    const deletedIndex = resolveDeletedIndex(messageId);
    const targetIndex = Math.max(0, deletedIndex - 1);
    const meta = context.chatMetadata?.[META_KEY];
    // Rewind the extraction cursor so deleted/rewritten turns are re-extracted
    // rather than skipped by the next pass.
    if (meta) meta.lastExtractCutoff = Math.max(0, targetIndex);
    rollbackStateToSnapshot(targetIndex);
    prunePersistentMemoriesAfterRollback(
      targetIndex,
      [getCurrentCharacterName(), ...getGroupMemberNames()].filter(Boolean),
    );
    refreshAfterStateRollback();
  });

  onChatChanged();

  // ---- Slash commands -----------------------------------------------------

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-check',
      callback: async () => {
        const characterName = getCurrentCharacterName();
        if (!characterName) return 'No character active.';
        const result = await checkContinuity(characterName);
        const { issues } = handleContinuityResult(result, characterName);
        if (issues.length === 0) {
          toastr.info('No contradictions found.', 'Smart Memory', {
            timeOut: 4000,
            positionClass: 'toast-bottom-right',
          });
          return 'No contradictions found.';
        }
        return issues.map((issue, i) => `${i + 1}. ${issue.fact ?? issue}`).join('\n');
      },
      helpString:
        'Checks the last AI response for contradictions against established facts and memories.',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-summarize',
      callback: async () => {
        if (compactionRunning) return 'Compaction already running.';
        compactionRunning = true;
        setStatusMessage('Extracting short-term memories...');
        try {
          const summary = await runCompaction();
          if (summary) {
            injectSummary(summary);
            updateShortTermUI(summary);
            setStatusMessage('Summary updated.');
            toastr.success('Short-term summary updated.', 'Smart Memory', {
              timeOut: 4000,
              positionClass: 'toast-bottom-right',
            });
            return summary;
          }
          toastr.info('Nothing to summarize yet.', 'Smart Memory', {
            timeOut: 4000,
            positionClass: 'toast-bottom-right',
          });
          return 'Nothing to summarize yet.';
        } finally {
          compactionRunning = false;
        }
      },
      helpString: 'Forces Smart Memory to generate or update the short-term context summary now.',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-extract',
      callback: async () => {
        if (extractionRunning) return 'Extraction already running.';
        const characterName = getCurrentCharacterName();
        if (!characterName) return 'No character active.';
        extractionRunning = true;
        setStatusMessage(`Extracting memories for ${characterName}...`);
        try {
          const context = getContext();
          const recentLongTerm = getStableExtractionWindowWithFallback(context.chat, 20);
          const recentSession = getStableExtractionWindowWithFallback(context.chat, 40);
          const recentArcs = getStableExtractionWindowWithFallback(context.chat, 100);
          if (!isFreshStart()) {
            await extractAndStoreMemories(characterName, recentLongTerm, setStatusMessage);
            await extractArcs(recentArcs, characterName);
            await extractSessionMemories(recentSession);
          }
          await injectMemories(characterName);
          injectRelationshipHistory(characterName);
          await injectSessionMemories();
          injectArcs();
          updateLongTermUI(characterName);
          updateRelationshipHistoryUI(characterName);
          updateSessionUI();
          updateArcsUI();
          saveSettingsDebounced();
          setStatusMessage('Extraction complete.');
          toastr.success('Memory extraction complete.', 'Smart Memory', {
            timeOut: 4000,
            positionClass: 'toast-bottom-right',
          });
          return 'Memory extraction complete.';
        } finally {
          extractionRunning = false;
        }
      },
      helpString:
        'Forces Smart Memory to extract long-term memories, session details, and story arcs from the current chat now.',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-recap',
      callback: async () => {
        const recap = await generateRecap();
        if (!recap) {
          toastr.error('Recap generation failed.', 'Smart Memory', {
            timeOut: 4000,
            positionClass: 'toast-bottom-right',
          });
          return 'Recap generation failed.';
        }
        recapOverlayChatMeta = getContext().chatMetadata;
        displayRecap(recap);
        setStatusMessage('Recap displayed.');
        return recap;
      },
      helpString:
        'Generates a "Previously on..." recap of the current chat and displays it as a popup.',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-search',
      callback: async (args, query) => {
        const q = String(query || '').trim();
        if (!q) {
          toastr.warning('Usage: /sm-search <query>', 'Smart Memory', {
            timeOut: 3000,
            positionClass: 'toast-bottom-right',
          });
          return '';
        }

        const characterName = getCurrentCharacterName();
        const ltMemories = characterName
          ? loadCharacterMemories(characterName).filter((m) => !m.superseded_by)
          : [];
        const sessionMems = loadSessionMemories().filter((m) => !m.superseded_by);
        const allMems = [
          ...ltMemories.map((m) => ({ ...m, _tier: 'long-term' })),
          ...sessionMems.map((m) => ({ ...m, _tier: 'session' })),
        ];

        if (allMems.length === 0) {
          toastr.info('No memories to search.', 'Smart Memory', {
            timeOut: 3000,
            positionClass: 'toast-bottom-right',
          });
          return '';
        }

        const topK = Math.max(1, Math.min(50, Number(args?.k) || 10));
        const minScore = Math.max(0, Math.min(1, args?.min !== undefined ? Number(args.min) : 0.5));
        const qLower = q.toLowerCase();
        const memTexts = allMems.map((m) =>
          String(m.content || '')
            .toLowerCase()
            .trim(),
        );
        const vectorMap = await getEmbeddingBatch([qLower, ...memTexts]);
        const queryVec = vectorMap.get(qLower) ?? null;

        const scored = allMems
          .map((mem, i) => {
            const memText = memTexts[i];
            const memVec = vectorMap.get(memText) ?? null;
            const score =
              queryVec && memVec
                ? cosineSimilarity(queryVec, memVec)
                : jaccardSimilarity(qLower, memText);
            return { mem, score };
          })
          .filter(({ score }) => score >= minScore);

        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, topK);
        showSearchResults(q, top);
        return `Found ${top.length} result${top.length === 1 ? '' : 's'} for "${q}".`;
      },
      namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
          name: 'k',
          description: 'number of results to return (default 10, max 50)',
          typeList: [ARGUMENT_TYPE.NUMBER],
          isRequired: false,
          defaultValue: '10',
        }),
        SlashCommandNamedArgument.fromProps({
          name: 'min',
          description: 'minimum similarity score to include a result (default 0.5, range 0-1)',
          typeList: [ARGUMENT_TYPE.NUMBER],
          isRequired: false,
          defaultValue: '0.5',
        }),
      ],
      unnamedArgumentList: [new SlashCommandArgument('search query', [ARGUMENT_TYPE.STRING], true)],
      helpString:
        'Searches long-term and session memories by semantic similarity. Displays top matching memories with type and tier labels. Optional: k sets result count (default 10, max 50); min sets the minimum similarity threshold to filter weak matches (default 0.5, range 0-1).',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  smLog('[SmartMemory] Loaded.');
});
