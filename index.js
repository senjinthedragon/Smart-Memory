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
 *   Activity      Non-blocking loader shown during background extraction (startActivityLoader/stopActivityLoader).
 */

import {
  eventSource,
  event_types,
  saveSettingsDebounced,
  setExtensionPrompt,
  extension_prompt_types,
  is_send_press,
} from '../../../../script.js';
import { loader, ActionLoaderToastMode } from '../../../scripts/action-loader.js';
import {
  getContext,
  extension_settings,
  renderExtensionTemplateAsync,
} from '../../../extensions.js';
import {
  MODULE_NAME,
  PROMPT_KEY_SHORT,
  PROMPT_KEY_LONG,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_REPAIR,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_CANON,
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
  loadPersistentArcs,
  savePersistentArcs,
} from './arcs.js';
import {
  checkContinuity,
  generateRepair,
  injectRepair,
  clearRepair,
  loadAndInjectRepair,
} from './continuity.js';
import {
  clearEmbeddingCache,
  getHardwareProfile,
  getEmbeddingBatch,
  cosineSimilarity,
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
import { generateProfiles, injectProfiles, loadProfiles, areProfilesStale } from './profiles.js';
import { classifyTurn, adaptiveBudgets } from './memory-utils.js';
import { clearUnifiedSlot, maybeInjectUnified } from './unified-inject.js';
import { smLog } from './logging.js';
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
  updateEntityPanel,
  updateEmbeddingNotice,
  setContinuityBadge,
  showSearchResults,
  initTooltips,
  initTypePickers,
} from './ui.js';
import { defaultSettings, loadSettings, bindSettingsUI } from './settings.js';

// ---- Module-level state -------------------------------------------------

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

// Set to true by the Cancel button to abort an in-progress catch-up loop.
let catchUpCancelled = false;

// Tracks which character names have responded in the current group chat round.
// Populated by onCharacterMessageRendered when context.groupId is set, cleared
// by onGroupWrapperStarted at the top of each new round.
let respondedThisRound = new Set();

// True once loadAndInjectRepair() has been called for the first character in a
// group round. Prevents the one-shot repair note from being re-injected for
// every subsequent character in the same round.
let repairInjectedThisRound = false;

// Last observed chat length, used to distinguish new messages from swipes.
// CHARACTER_MESSAGE_RENDERED fires on both; swipes do not grow the chat array.
let lastKnownChatLength = 0;

// ---- Activity indicator helpers -----------------------------------------

/**
 * Shows a non-blocking activity loader if the setting is enabled.
 * Returns a handle that must be passed to stopActivityLoader when done.
 * Returns null if the setting is off.
 * @param {object} settings - The Smart Memory settings object.
 * @returns {import('../../../scripts/action-loader.js').ActionLoaderHandle|null}
 */
function startActivityLoader(settings) {
  if (!(settings.show_activity_indicator ?? true)) return null;
  return loader.show({
    blocking: false,
    toastMode: ActionLoaderToastMode.STATIC,
    title: 'Smart Memory',
    message: 'Extracting memories...',
  });
}

/**
 * Hides the activity loader returned by startActivityLoader.
 * Safe to call with null (when the setting was off).
 * @param {import('../../../scripts/action-loader.js').ActionLoaderHandle|null} handle
 */
function stopActivityLoader(handle) {
  if (handle) handle.hide();
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

// ---- Helpers ------------------------------------------------------------

/** Returns the settings object for this extension. */
function getSettings() {
  return extension_settings[MODULE_NAME];
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
  clearUnifiedSlot();
  updateTokenDisplay();
}

// ---- Event handlers -----------------------------------------------------

/**
 * Fires after each AI message is rendered (registered with makeLast so Smart
 * Memory runs after all other extensions have processed the message).
 *
 * Swipe detection: CHARACTER_MESSAGE_RENDERED fires on swipes (alternative
 * generations) as well as on new messages. A swipe replaces the last message
 * in-place without growing the chat array, so we compare the current chat
 * length against lastKnownChatLength to detect and skip swipes entirely.
 * Only new messages (chat grew) trigger compaction, scene detection, and
 * extraction. lastActive is updated on swipes so the recap threshold stays
 * accurate during long swipe sessions.
 *
 * Orchestration order (new messages only):
 *   1. Check for compaction threshold and run if needed (async, non-blocking).
 *   2. Check for scene break in the latest message (async, non-blocking).
 *   3. Every N messages: batch extraction for session + long-term + arcs.
 *   4. Update lastActive timestamp for the away recap system.
 *
 * Compaction and extraction both pass a responseLength to ST's generateRaw /
 * generateQuietPrompt, which temporarily modifies the global amount_gen via
 * ST's TempResponseLength singleton. Running them concurrently corrupts that
 * singleton and leaves amount_gen at the extraction value. They therefore run
 * sequentially: compaction first, extraction only after compaction completes.
 * Compaction fires infrequently (only at the context threshold) so the latency
 * cost is negligible in practice.
 */
async function onCharacterMessageRendered() {
  // is_send_press is true while ST is still streaming - skip to avoid
  // running on intermediate renders.
  if (is_send_press) return;

  const settings = getSettings();
  if (!settings.enabled) return;

  const context = getContext();
  if (!context.chat || context.chat.length === 0) return;

  // Swipe detection: CHARACTER_MESSAGE_RENDERED fires on swipes too, but a swipe
  // replaces the last message in-place - the chat array does not grow. Only
  // process when the chat actually advanced (new message added by a real turn).
  const currentLength = context.chat.length;
  const isSwipe = currentLength <= lastKnownChatLength;
  lastKnownChatLength = currentLength;
  if (isSwipe) {
    // Still update lastActive so the recap threshold stays accurate during
    // a long swipe session where the user is clearly present.
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

    $('#sm_recap_overlay').remove();
    updateLastActive().catch(console.error);
    return;
  }

  // A new AI message has arrived - dismiss any open recap modal so it doesn't
  // linger while the user reads the response. Recap was only meant as a
  // pre-response reminder; once the story is moving again it should be gone.
  $('#sm_recap_overlay').remove();

  const characterName = getCurrentCharacterName();

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

  // Step 1: compaction - awaited before extraction to prevent concurrent use
  // of ST's TempResponseLength singleton, which would corrupt amount_gen.
  // Gated by !isFreshStart() so read-only sessions never advance summaryEnd
  // past the ghosted window; the discard path then has nothing to roll back.
  if (settings.compaction_enabled && !compactionRunning && !isFreshStart()) {
    compactionRunning = true;
    try {
      const needed = await shouldCompact();
      if (needed) {
        setStatusMessage('Updating story summary...');
        // Only toast for external sources - with the main API, ST's own pipeline
        // blocks swipes with its own message so a second toast would be redundant.
        const source = extension_settings[MODULE_NAME]?.source ?? memory_sources.main;
        let compactionToast = null;
        if (source !== memory_sources.main) {
          compactionToast = toastr.info('Updating story summary...', 'Smart Memory', {
            timeOut: 0,
            extendedTimeOut: 0,
            positionClass: 'toast-bottom-right',
          });
        }
        const summary = await runCompaction();
        if (compactionToast) toastr.clear(compactionToast);
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
  // Check both the AI response and the preceding user message - transitions
  // are often written by the user and not echoed by the AI.
  // Gated by !isFreshStart() so no scene summaries are written during read-only.
  const sceneCheckText = [lastUserMsgText, lastMsgText].filter(Boolean).join('\n');
  if (settings.scene_enabled && sceneCheckText && !isFreshStart()) {
    try {
      const wasBreak = await processSceneBreak(sceneCheckText, sceneMessageBuffer, prevAiMsgText);
      if (wasBreak) {
        injectSceneHistory();
        updateScenesUI();
        updateTokenDisplay();
        sceneMessageBuffer = [];
        sceneBufferLastIndex = -1;
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

    if (messagesSinceLastExtraction >= extractEvery) {
      extractionRunning = true;

      // Capture the current chat generation so we can abort before any write if
      // the user switches chats while a model call is in progress.
      const capturedGen = chatLoadId;
      const chatChanged = () => chatLoadId !== capturedGen;

      // Use separate windows per tier. Session benefits from more context than
      // long-term (scene/detail extraction needs the surrounding messages);
      // long-term extraction targets distilled facts that are visible in a
      // narrower window. Arc extraction uses a wide window to catch threads
      // that were introduced earlier in the session.
      const sessionWindow = getStableExtractionWindow(context.chat, 40);
      const longtermWindow = getStableExtractionWindow(context.chat, 20);

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

      setStatusMessage('Extracting memories...');

      // Run extraction tiers sequentially rather than in parallel.
      // Parallel model calls overwhelm local hardware (RTX 2080 / 8GB VRAM)
      // and gain nothing on Ollama which serializes requests anyway.
      // Awaiting here also prevents compaction/scene detection on the next
      // message from racing against an ongoing extraction and corrupting
      // ST's TempResponseLength singleton (the same hazard fixed in 1.0.1).
      // Capture original budgets before entering try/finally so the finally
      // block can restore them regardless of where the error occurred.
      const originalBudgets = {
        longterm_inject_budget: settings.longterm_inject_budget,
        session_inject_budget: settings.session_inject_budget,
        scene_inject_budget: settings.scene_inject_budget,
        arcs_inject_budget: settings.arcs_inject_budget,
        profiles_inject_budget: settings.profiles_inject_budget,
      };
      const activityHandle = startActivityLoader(settings);
      try {
        let total = 0;

        // Classify the current turn and apply adaptive per-tier token budgets.
        // The last AI message drives the classifier; budgets are patched directly
        // into settings so injection calls pick them up without signature changes.
        const lastAiMessage = context.chat?.at(-1)?.mes ?? '';
        const turnType = classifyTurn(lastAiMessage);
        const budgets = adaptiveBudgets(settings, turnType);
        settings.longterm_inject_budget = budgets.longterm;
        settings.session_inject_budget = budgets.session;
        settings.scene_inject_budget = budgets.scenes;
        settings.arcs_inject_budget = budgets.arcs;
        settings.profiles_inject_budget = budgets.profiles;

        if (chatChanged()) throw CHAT_SWITCHED;
        if (settings.session_enabled && sessionWindow.length > 0 && !isFreshStart()) {
          // Snapshot existing memory ids before extraction so we can identify
          // which memories are new and link them to the current scene.
          const priorSessionIds = new Set(
            loadSessionMemories()
              .map((m) => m.id)
              .filter(Boolean),
          );

          const count = await extractSessionMemories(sessionWindow, chatChanged).catch((err) => {
            console.error('[SmartMemory] Session extraction error:', err);
            return 0;
          });
          // Run session consolidation after extraction - fires per-type when threshold is reached.
          if (!consolidationRunning) {
            consolidationRunning = true;
            await consolidateSessionMemories().catch((err) => {
              console.error('[SmartMemory] Session consolidation error:', err);
            });
            consolidationRunning = false;
          }
          await injectSessionMemories(true);
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

        if (chatChanged()) throw CHAT_SWITCHED;
        if (
          settings.longterm_enabled &&
          characterName &&
          longtermWindow.length > 0 &&
          !isFreshStart()
        ) {
          const count = await extractAndStoreMemories(characterName, longtermWindow).catch(
            (err) => {
              console.error('[SmartMemory] Long-term extraction error:', err);
              return 0;
            },
          );
          // Run consolidation after extraction if new memories were added.
          if (count > 0 && settings.consolidation_enabled && !consolidationRunning) {
            consolidationRunning = true;
            const removed = await consolidateMemories(characterName).catch((err) => {
              console.error('[SmartMemory] Consolidation error:', err);
              return 0;
            });
            consolidationRunning = false;
            if (removed > 0) {
              setStatusMessage(`Consolidated ${removed} redundant memories.`);
              toastr.info(
                `Merged ${removed} redundant ${removed === 1 ? 'memory' : 'memories'}.`,
                'Smart Memory',
                { timeOut: 3000, positionClass: 'toast-bottom-right' },
              );
            }
          }
          // Inject once after extraction (and any consolidation) - this is the
          // one call per AI response turn where telemetry should be updated.
          await injectMemories(characterName, true);
          updateLongTermUI(characterName);
          total += count;
        }

        // Snapshot arc summary count before extraction so we can detect a new
        // resolution in this pass (the count only grows when an arc closes).
        const arcSummaryCountBefore = settings.arcs_enabled ? loadArcSummaries().length : 0;

        if (chatChanged()) throw CHAT_SWITCHED;
        if (settings.arcs_enabled && !isFreshStart()) {
          // Arc extraction uses a wider window than other tiers so it can catch
          // arcs opened earlier in the session, but is capped to avoid overflowing
          // the model's context on long chats. Existing arcs are passed to the
          // prompt so resolution still works even outside this window.
          const arcWindow = getStableExtractionWindow(context.chat, 100);
          const count = await extractArcs(arcWindow, characterName, chatChanged).catch((err) => {
            console.error('[SmartMemory] Arc extraction error:', err);
            return 0;
          });
          injectArcs();
          updateArcsUI();
          total += count;
        }

        // Regenerate profiles after each extraction pass so they reflect the
        // latest memories. Sequential - same constraint as the other tiers.
        // Skipped in freshStart chats - no new memories were written so
        // regeneration would waste a model call producing the same output.
        if (chatChanged()) throw CHAT_SWITCHED;
        if (settings.profiles_enabled && characterName && !isFreshStart()) {
          await generateProfiles(characterName)
            .then((profiles) => {
              if (profiles) {
                injectProfiles(characterName);
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
        if (chatChanged()) throw CHAT_SWITCHED;
        if (
          settings.canon_enabled &&
          settings.arcs_enabled &&
          characterName &&
          !isFreshStart() &&
          getHardwareProfile() === 'b' &&
          loadArcSummaries().length > arcSummaryCountBefore
        ) {
          await generateCanon(characterName)
            .then(() => injectCanon(characterName))
            .catch((err) => console.error('[SmartMemory] Auto-canon error:', err));
        }

        // Refresh entity panel after extraction since new entities may have been linked.
        updateEntityPanel(characterName);
        maybeInjectUnified();
        updateTokenDisplay();
        setStatusMessage(total > 0 ? `${total} item${total === 1 ? '' : 's'} stored.` : '');
      } catch (err) {
        if (err === CHAT_SWITCHED) {
          smLog('[SmartMemory] Extraction aborted: chat switched mid-extraction.');
        } else {
          console.error('[SmartMemory] Extraction error:', err);
        }
        setStatusMessage('');
      } finally {
        stopActivityLoader(activityHandle);
        // Restore original budget settings so chat-load / settings-change injection
        // paths use the user's configured values, not this turn's adapted values.
        // saveSettingsDebounced is called here rather than inside the try block to
        // ensure the debounce never fires while adapted budgets are still patched in.
        // On Ollama, LLM calls take several seconds - long enough for a 1000ms debounce
        // to fire with wrong values and persist them to disk.
        Object.assign(settings, originalBudgets);
        saveSettingsDebounced();
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
    generateProfiles(characterName)
      .then((profiles) => {
        if (profiles) {
          injectProfiles(characterName);
          updateProfilesUI(profiles);
        }
      })
      .catch((err) => console.error('[SmartMemory] Scheduled profile regeneration error:', err));
  }

  // Step 5: clear any pending continuity repair - it was injected for this
  // response turn and should not carry over to the next message.
  clearRepair();

  // Step 6 (Profile B only): silent continuity check after each AI turn.
  // Fire-and-forget so it does not block the event handler while the model
  // responds. The badge in the settings header updates when the check finishes.
  // On Profile A (local hardware) this stays manual-only - too expensive for
  // every turn on an RTX 2080.
  if (getHardwareProfile() === 'b' && settings.continuity_auto_check && !continuityCheckRunning) {
    continuityCheckRunning = true;
    checkContinuity(characterName)
      .then(async (contradictions) => {
        setContinuityBadge(contradictions.length);
        if (contradictions.length > 0 && getSettings().continuity_auto_repair) {
          const note = await generateRepair(contradictions, characterName);
          injectRepair(note);
        }
      })
      .catch((err) => {
        console.error('[SmartMemory] Auto-continuity check failed:', err);
      })
      .finally(() => {
        continuityCheckRunning = false;
      });
  }

  // Step 7: update lastActive so the away recap threshold stays accurate.
  updateLastActive().catch(console.error);
}

// Debounce timer for onChatChanged. ST fires both CHAT_LOADED and CHAT_CHANGED
// on a fresh load, sometimes before context.groupId is set. Collapsing them
// into one deferred run ensures the context is stable before we act on it.
let chatChangedTimer = null;

// Incremented each time onChatChangedImpl starts. Async callbacks (recap, extraction)
// capture this value and bail out if it has changed by the time they resolve - prevents
// a slow operation from a previous chat writing into a different chat's metadata.
let chatLoadId = 0;

// Sentinel thrown inside the extraction try/finally when a chat switch is detected
// mid-extraction. Caught separately from real errors so it is not logged as a failure.
const CHAT_SWITCHED = Symbol('chat-switched');

function onChatChanged() {
  clearTimeout(chatChangedTimer);
  chatChangedTimer = setTimeout(() => onChatChangedImpl().catch(console.error), 100);
}

/**
 * Fires when a chat is loaded or switched (debounced via onChatChanged).
 * Resets all module-level state, restores stored injections, and generates
 * an away recap if the user has been gone longer than the configured threshold.
 */
async function onChatChangedImpl() {
  const thisLoadId = ++chatLoadId;

  // Dismiss any recap overlay from the previous chat immediately - it is modal
  // and blocks input, so leaving it up over the new chat is confusing.
  $('#sm_recap_overlay').remove();

  messagesSinceLastExtraction = 0;
  messagesSinceLastProfileRegen = 0;
  compactionRunning = false;
  extractionRunning = false;
  continuityCheckRunning = false;
  sceneMessageBuffer = [];
  sceneBufferLastIndex = -1;
  respondedThisRound = new Set();
  selectedGroupCharacter = null;
  setContinuityBadge(null);
  lastKnownChatLength = 0;
  clearEmbeddingCache();
  clearUnifiedSlot();

  // Migrate chat data first - no character name needed, operates on chatMetadata.
  // Fast no-op when the container is already at the current schema version.
  await ensureChatMigrated();

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
    await injectSessionMemories();
    injectCanon(selectedGroupCharacter);
    injectProfiles(selectedGroupCharacter);
    loadAndInjectRepair();
    updateLongTermUI(selectedGroupCharacter);
    updateSessionUI();
    updateFreshStartUI(isFreshStart());
    updateCanonUI(selectedGroupCharacter);
    updateProfilesUI(loadProfiles(selectedGroupCharacter));
    updateEntityPanel(selectedGroupCharacter);

    maybeInjectUnified();
    updateTokenDisplay();

    if (settings.recap_enabled) {
      const hoursAway = getAwayHours();
      if (hoursAway > 0) {
        setStatusMessage('Generating recap...');
        generateRecap()
          .then((recap) => {
            if (thisLoadId !== chatLoadId) return;
            if (recap) displayRecap(recap, hoursAway);
            setStatusMessage('');
          })
          .catch((err) => {
            console.error('[SmartMemory] Auto-recap failed:', err);
            setStatusMessage('');
          });
      }
    }

    await updateLastActive();
    return;
  }

  // 1:1 chat - hide the group selector so it doesn't bleed between chat types.
  $('#sm_group_char_row').hide();

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

  await injectSessionMemories();
  injectSceneHistory();
  // Merge character-level persistent arcs into this chat before injecting.
  await mergePersistentArcs(characterName);
  injectArcs();
  injectProfiles(characterName);
  loadAndInjectRepair();

  updateLongTermUI(characterName);
  updateFreshStartUI(freshStart);
  updateSessionUI();
  updateScenesUI();
  updateArcsUI();
  updateCanonUI(characterName);
  updateProfilesUI(loadProfiles(characterName));
  maybeInjectUnified();
  updateTokenDisplay();
  updateEmbeddingNotice();

  // Regenerate profiles in the background if they are stale. Non-blocking -
  // the existing stored profiles (if any) were already injected above, so the
  // user sees coherent context immediately and the refresh is invisible.
  if (settings.profiles_enabled && characterName && !isFreshStart()) {
    const thresholdMs = (settings.profiles_stale_threshold_minutes ?? 30) * 60 * 1000;
    if (areProfilesStale(thresholdMs, characterName)) {
      generateProfiles(characterName)
        .then((profiles) => {
          if (profiles) {
            injectProfiles(characterName);
            updateProfilesUI(profiles);
          }
        })
        .catch((err) =>
          console.error('[SmartMemory] Background profile regeneration failed:', err),
        );
    }
  }

  // Show a recap popup if the user has been away long enough.
  if (settings.recap_enabled) {
    const hoursAway = getAwayHours();
    if (hoursAway > 0) {
      setStatusMessage('Generating recap...');
      generateRecap()
        .then((recap) => {
          if (thisLoadId !== chatLoadId) return;
          if (recap) {
            // Pass hoursAway explicitly - updateLastActive() runs after this
            // async block starts, so getAwayHours() inside displayRecap would
            // return 0 and always show "short break" regardless of actual gap.
            displayRecap(recap, hoursAway);
          }
          setStatusMessage('');
        })
        .catch((err) => {
          console.error('[SmartMemory] Auto-recap failed:', err);
          setStatusMessage('');
        });
    }
  }

  await updateLastActive();
}

// ---- Group chat helpers -------------------------------------------------

/**
 * Populates the group character selector dropdown with the current group's
 * members, shows the selector row, and sets selectedGroupCharacter to
 * whichever member is currently selected (or the first member if none is).
 * Should be called from onChatChanged when context.groupId is set.
 */
function updateGroupCharSelector() {
  const context = getContext();
  const group = context.groups?.find((g) => g.id === context.groupId);
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

  $('#sm_group_char_row').show();
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
  await injectSessionMemories();
  injectSceneHistory();
  injectArcs();
  injectProfiles(characterName);
  // Repair is one-shot - only the first character in a round gets it.
  // Subsequent characters call clearRepair() so the slot doesn't carry over.
  if (!repairInjectedThisRound) {
    loadAndInjectRepair();
    repairInjectedThisRound = true;
  } else {
    clearRepair();
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
  if (is_send_press) return;
  const settings = getSettings();
  if (!settings.enabled) return;
  const context = getContext();
  if (!context.chat || context.chat.length === 0) return;

  // Snapshot before any await - onGroupWrapperStarted resets respondedThisRound
  // for the next round and can fire while this function is mid-await if the user
  // sends a new message quickly. Everything below uses the snapshot.
  const roundResponders = new Set(respondedThisRound);

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

  // Step 1: compaction - once per round rather than per character response.
  // Gated by !isFreshStart() matching the solo path.
  if (settings.compaction_enabled && !compactionRunning && !isFreshStart()) {
    compactionRunning = true;
    try {
      const needed = await shouldCompact();
      if (needed) {
        setStatusMessage('Updating story summary...');
        const source = extension_settings[MODULE_NAME]?.source ?? memory_sources.main;
        let compactionToast = null;
        if (source !== memory_sources.main) {
          compactionToast = toastr.info('Updating story summary...', 'Smart Memory', {
            timeOut: 0,
            extendedTimeOut: 0,
            positionClass: 'toast-bottom-right',
          });
        }
        const summary = await runCompaction();
        if (compactionToast) toastr.clear(compactionToast);
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
  // Gated by !isFreshStart() matching the solo path.
  const sceneCheckText = [lastUserMsgText, lastMsgText].filter(Boolean).join('\n');
  if (settings.scene_enabled && sceneCheckText && !isFreshStart()) {
    try {
      const wasBreak = await processSceneBreak(sceneCheckText, sceneMessageBuffer, prevAiMsgText);
      if (wasBreak) {
        injectSceneHistory();
        updateScenesUI();
        maybeInjectUnified();
        updateTokenDisplay();
        sceneMessageBuffer = [];
        sceneBufferLastIndex = -1;
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

    if (messagesSinceLastExtraction >= extractEvery) {
      extractionRunning = true;

      const sessionWindow = getStableExtractionWindow(context.chat, 40);
      // Scale the raw window by character count so that after per-character
      // filtering each character still gets roughly 20 messages of context.
      const longtermRawSize = 20 * Math.max(1, roundResponders.size);
      const longtermWindow = getStableExtractionWindow(context.chat, longtermRawSize);

      if (longtermWindow.length === 0 && sessionWindow.length === 0) {
        extractionRunning = false;
      } else {
        messagesSinceLastExtraction = 0;
        setStatusMessage('Extracting memories...');

        const capturedGen = chatLoadId;
        const chatChanged = () => chatLoadId !== capturedGen;

        const originalBudgets = {
          longterm_inject_budget: settings.longterm_inject_budget,
          session_inject_budget: settings.session_inject_budget,
          scene_inject_budget: settings.scene_inject_budget,
          arcs_inject_budget: settings.arcs_inject_budget,
          profiles_inject_budget: settings.profiles_inject_budget,
        };
        const activityHandle = startActivityLoader(settings);

        try {
          let total = 0;

          const lastAiMessage = context.chat?.at(-1)?.mes ?? '';
          const turnType = classifyTurn(lastAiMessage);
          const budgets = adaptiveBudgets(settings, turnType);
          settings.longterm_inject_budget = budgets.longterm;
          settings.session_inject_budget = budgets.session;
          settings.scene_inject_budget = budgets.scenes;
          settings.arcs_inject_budget = budgets.arcs;
          settings.profiles_inject_budget = budgets.profiles;

          if (chatChanged()) throw CHAT_SWITCHED;
          // Session extraction is chat-wide - all characters share one session store.
          if (settings.session_enabled && sessionWindow.length > 0 && !isFreshStart()) {
            const priorSessionIds = new Set(
              loadSessionMemories()
                .map((m) => m.id)
                .filter(Boolean),
            );

            const count = await extractSessionMemories(sessionWindow, chatChanged).catch((err) => {
              console.error('[SmartMemory] Session extraction error:', err);
              return 0;
            });
            if (!consolidationRunning) {
              consolidationRunning = true;
              await consolidateSessionMemories().catch((err) => {
                console.error('[SmartMemory] Session consolidation error:', err);
              });
              consolidationRunning = false;
            }
            await injectSessionMemories(true);
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

          if (chatChanged()) throw CHAT_SWITCHED;
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
              ).catch((err) => {
                console.error('[SmartMemory] Long-term extraction error:', err);
                return 0;
              });
              if (count > 0 && settings.consolidation_enabled && !consolidationRunning) {
                consolidationRunning = true;
                const removed = await consolidateMemories(characterName).catch((err) => {
                  console.error('[SmartMemory] Consolidation error:', err);
                  return 0;
                });
                consolidationRunning = false;
                if (removed > 0) {
                  setStatusMessage(`Consolidated ${removed} redundant memories.`);
                  toastr.info(
                    `Merged ${removed} redundant ${removed === 1 ? 'memory' : 'memories'}.`,
                    'Smart Memory',
                    { timeOut: 3000, positionClass: 'toast-bottom-right' },
                  );
                }
              }
              total += count;
            }

            if (settings.profiles_enabled && characterName && !isFreshStart()) {
              await generateProfiles(characterName)
                .then((profiles) => {
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

          if (chatChanged()) throw CHAT_SWITCHED;
          // Arc extraction is chat-wide - once per round after all characters.
          // Snapshot summary count first so the canon check below can detect a
          // new resolution without re-running extraction.
          const arcSummaryCountBefore = settings.arcs_enabled ? loadArcSummaries().length : 0;

          if (settings.arcs_enabled && !isFreshStart()) {
            const arcWindow = getStableExtractionWindow(context.chat, 100);
            const count = await extractArcs(arcWindow, null, chatChanged).catch((err) => {
              console.error('[SmartMemory] Arc extraction error:', err);
              return 0;
            });
            injectArcs();
            updateArcsUI();
            total += count;

            // Clean persistent arcs for all responding characters. The solo path
            // does this inside extractArcs via characterName, but group arc
            // extraction is chat-wide with no single characterName. Any persistent
            // arc whose content is no longer in the current arc list was resolved.
            const currentArcContents = new Set(loadArcs().map((a) => a.content));
            for (const charName of roundResponders) {
              const persistent = loadPersistentArcs(charName);
              if (persistent.length === 0) continue;
              const cleaned = persistent.filter((a) => currentArcContents.has(a.content));
              if (cleaned.length < persistent.length) savePersistentArcs(charName, cleaned);
            }
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
              await generateCanon(characterName)
                .then(() => injectCanon(characterName))
                .catch((err) => console.error('[SmartMemory] Auto-canon error:', err));
            }
          }

          // Refresh entity panel with the last character who responded.
          const lastResponder = [...roundResponders].at(-1);
          if (lastResponder) updateEntityPanel(lastResponder);

          // Refresh the settings panel for whichever character the selector
          // is showing so new memories appear without the user having to
          // manually switch selection.
          updateLongTermUI(selectedGroupCharacter);
          updateSessionUI();

          setStatusMessage(total > 0 ? `${total} item${total === 1 ? '' : 's'} stored.` : '');
        } catch (err) {
          if (err === CHAT_SWITCHED) {
            smLog('[SmartMemory] Group extraction aborted: chat switched mid-extraction.');
          } else {
            console.error('[SmartMemory] Extraction error:', err);
          }
          setStatusMessage('');
        } finally {
          stopActivityLoader(activityHandle);
          Object.assign(settings, originalBudgets);
          saveSettingsDebounced();
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
      generateProfiles(characterName)
        .then((profiles) => {
          if (profiles) {
            injectProfiles(characterName);
            if (characterName === selectedGroupCharacter) updateProfilesUI(profiles);
          }
        })
        .catch((err) => console.error('[SmartMemory] Scheduled profile regeneration error:', err));
    }
  }

  // Step 5: clear any pending continuity repair carried over from last round.
  clearRepair();

  // Step 6 (Profile B only): silent continuity check - once per round using
  // the last character who responded. Running per-character would multiply
  // model calls by character count for the same round of messages.
  const lastResponder = [...roundResponders].at(-1);
  if (
    getHardwareProfile() === 'b' &&
    settings.continuity_auto_check &&
    lastResponder &&
    !continuityCheckRunning
  ) {
    continuityCheckRunning = true;
    checkContinuity(lastResponder)
      .then(async (contradictions) => {
        setContinuityBadge(contradictions.length);
        if (contradictions.length > 0 && getSettings().continuity_auto_repair) {
          const note = await generateRepair(contradictions, lastResponder);
          injectRepair(note);
        }
      })
      .catch((err) => {
        console.error('[SmartMemory] Auto-continuity check failed:', err);
      })
      .finally(() => {
        continuityCheckRunning = false;
      });
  }

  // Step 7: restore injection slots to the selected character. onGroupMemberDrafted
  // swaps slots to each generating character in turn; after the round ends the
  // last responder's data is still in the slots. Re-inject for the selector choice
  // so the token display reflects what the panel is showing, not who generated last.
  if (selectedGroupCharacter) {
    await injectMemories(selectedGroupCharacter);
    injectCanon(selectedGroupCharacter);
    injectProfiles(selectedGroupCharacter);
    maybeInjectUnified();
    updateTokenDisplay();
  }

  // Step 8: update lastActive.
  await updateLastActive();
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
  eventSource.on(event_types.MESSAGE_SWIPED, () => {
    abortCurrentMemoryGeneration();
  });

  // When a message is deleted, trim the scene buffer to only messages that
  // still exist in the chat. Without this, a deleted message would remain in
  // the buffer and be included in the next scene summary.
  eventSource.on(event_types.MESSAGE_DELETED, () => {
    const context = getContext();
    const chatSet = new Set(context.chat);
    sceneMessageBuffer = sceneMessageBuffer.filter((m) => chatSet.has(m));
    sceneBufferLastIndex = Math.min(sceneBufferLastIndex, context.chat.length - 1);
  });

  onChatChanged();

  // ---- Slash commands -----------------------------------------------------

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-check',
      callback: async () => {
        const characterName = getCurrentCharacterName();
        if (!characterName) return 'No character active.';
        const contradictions = await checkContinuity(characterName);
        if (contradictions.length === 0) {
          toastr.info('No contradictions found.', 'Smart Memory', {
            timeOut: 4000,
            positionClass: 'toast-bottom-right',
          });
          return 'No contradictions found.';
        }
        const message = contradictions.map((c, i) => `${i + 1}. ${c}`).join('\n');
        toastr.warning(
          `${contradictions.length} contradiction${contradictions.length === 1 ? '' : 's'} found. Check the Smart Memory panel for details.`,
          'Smart Memory',
          { timeOut: 8000, positionClass: 'toast-bottom-right' },
        );
        return message;
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
        setStatusMessage('Generating summary...');
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
        setStatusMessage('Extracting memories...');
        try {
          const context = getContext();
          const recentLongTerm = getStableExtractionWindowWithFallback(context.chat, 20);
          const recentSession = getStableExtractionWindowWithFallback(context.chat, 40);
          const recentArcs = getStableExtractionWindowWithFallback(context.chat, 100);
          if (!isFreshStart()) {
            await extractAndStoreMemories(characterName, recentLongTerm);
            await extractArcs(recentArcs, characterName);
            await extractSessionMemories(recentSession);
          }
          await injectMemories(characterName);
          await injectSessionMemories();
          injectArcs();
          updateLongTermUI(characterName);
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
