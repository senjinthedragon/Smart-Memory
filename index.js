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
 * owns the settings UI lifecycle, and drives the per-message processing loop.
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
 */

import {
  eventSource,
  event_types,
  extension_prompts,
  saveSettingsDebounced,
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
  is_send_press,
  getMaxContextSize,
} from '../../../../script.js';
import {
  getContext,
  extension_settings,
  renderExtensionTemplateAsync,
} from '../../../extensions.js';
import {
  estimateTokens,
  MODULE_NAME,
  META_KEY,
  PROMPT_KEY_SHORT,
  PROMPT_KEY_LONG,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_REPAIR,
  PROMPT_KEY_PROFILES,
  MEMORY_TYPES,
  SESSION_TYPES,
} from './constants.js';
import { memory_sources, fetchOllamaModels, abortCurrentMemoryGeneration } from './generate.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import {
  ARGUMENT_TYPE,
  SlashCommandArgument,
} from '../../../slash-commands/SlashCommandArgument.js';

import { shouldCompact, runCompaction, injectSummary, loadAndInjectSummary } from './compaction.js';
import { hideChatMessageRange } from '../../../chats.js';
import {
  extractAndStoreMemories,
  consolidateMemories,
  injectMemories,
  loadCharacterMemories,
  saveCharacterMemories,
  clearCharacterMemories,
  isFreshStart,
  setFreshStart,
} from './longterm.js';
import { updateLastActive, getAwayHours, generateRecap, displayRecap } from './recap.js';
import {
  extractSessionMemories,
  consolidateSessionMemories,
  injectSessionMemories,
  loadSessionMemories,
  saveSessionMemories,
  clearSessionMemories,
} from './session.js';
import {
  processSceneBreak,
  summarizeScene,
  injectSceneHistory,
  loadSceneHistory,
  saveSceneHistory,
  clearSceneHistory,
  detectSceneBreakHeuristic,
  linkMemoriesToLastScene,
} from './scenes.js';
import {
  extractArcs,
  injectArcs,
  loadArcs,
  saveArcs,
  clearArcs,
  deleteArc,
  clearArcSummaries,
  loadArcSummaries,
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
import { clearCanon, generateCanon, injectCanon } from './canon.js';
import {
  ensureCharacterMigrated,
  ensureChatMigrated,
  loadCharacterEntityRegistry,
  saveCharacterEntityRegistry,
  loadSessionEntityRegistry,
  saveSessionEntityRegistry,
  clearSessionEntityRegistry,
  setEntityType,
  deleteEntityById,
  mergeEntitiesByName,
  seedCharacterEntity,
} from './graph-migration.js';
import {
  generateProfiles,
  injectProfiles,
  clearProfiles,
  loadProfiles,
  areProfilesStale,
} from './profiles.js';
import { classifyTurn, adaptiveBudgets } from './memory-utils.js';
import { smLog } from './logging.js';

// ---- Default settings ---------------------------------------------------

const defaultSettings = {
  enabled: true,

  // LLM source for all memory operations (extraction, summarization, recap)
  source: memory_sources.main,

  // Ollama direct source settings
  ollama_url: 'http://localhost:11434',
  ollama_model: '',

  // OpenAI Compatible source settings
  openai_compat_url: '',
  openai_compat_key: '',
  openai_compat_model: '',

  // Short-term (compaction)
  compaction_enabled: true,
  compaction_threshold: 80,
  compaction_keep_recent: 10,
  compaction_response_length: 2000,
  compaction_position: extension_prompt_types.IN_PROMPT,
  compaction_depth: 0,
  compaction_role: extension_prompt_roles.SYSTEM,
  compaction_template: 'Story so far:\n{{summary}}',

  // Long-term
  longterm_enabled: true,
  longterm_consolidate: true,
  longterm_consolidation_threshold_fact: 4,
  longterm_consolidation_threshold_relationship: 3,
  longterm_consolidation_threshold_preference: 3,
  longterm_consolidation_threshold_event: 4,
  longterm_extract_every: 3,
  longterm_max_memories: 25,
  longterm_response_length: 600,
  longterm_inject_budget: 500,
  longterm_position: extension_prompt_types.IN_PROMPT,
  longterm_depth: 2,
  longterm_role: extension_prompt_roles.SYSTEM,
  longterm_template: 'Memories from previous conversations:\n{{memories}}',

  // Session memory
  session_enabled: true,
  session_consolidation_threshold: 3,
  session_extract_every: 3,
  session_max_memories: 30,
  session_response_length: 500,
  session_inject_budget: 400,
  session_position: extension_prompt_types.IN_CHAT,
  session_depth: 3,
  session_role: extension_prompt_roles.SYSTEM,
  session_template: 'Details from this session:\n{{session}}',

  // Scene detection
  scene_enabled: true,
  scene_ai_detect: false,
  scene_max_history: 5,
  scene_summary_length: 200,
  scene_inject_budget: 300,
  scene_position: extension_prompt_types.IN_CHAT,
  scene_depth: 6,
  scene_role: extension_prompt_roles.SYSTEM,

  // Story arcs
  arcs_enabled: true,
  arcs_max: 10,
  arcs_response_length: 400,
  arcs_inject_budget: 700,
  arcs_position: extension_prompt_types.IN_CHAT,
  arcs_depth: 2,
  arcs_role: extension_prompt_roles.SYSTEM,
  arc_summary_response_length: 300,
  canon_response_length: 600,

  // Away recap
  recap_enabled: true,
  recap_threshold_hours: 4,
  recap_response_length: 300,

  // Short-term / compaction
  compaction_hide_summarized: false,

  // Continuity
  continuity_response_length: 300,
  continuity_auto_check: true,
  continuity_auto_repair: false,

  // Semantic embedding deduplication
  embedding_enabled: true,
  embedding_url: '',
  embedding_model: 'nomic-embed-text',
  embedding_keep: false,

  // Character/world profiles
  profiles_enabled: true,
  profiles_stale_threshold_minutes: 30,
  // 0 = regenerate only on extraction passes; positive = also regenerate every N
  // messages even if extraction did not run (Profile B only - too expensive on local).
  profiles_regen_every: 0,
  profiles_response_length: 600,
  profiles_inject_budget: 400,
  profiles_position: extension_prompt_types.IN_PROMPT,
  profiles_depth: 1,
  profiles_role: extension_prompt_roles.SYSTEM,
  profiles_template: '{{profiles}}',

  // Hardware profile - 'auto' | 'a' | 'b'
  // 'auto': detect from memory source (ollama/webllm -> A, main/openai_compat -> B)
  // 'a': force Profile A (local/low-VRAM behaviour)
  // 'b': force Profile B (hosted/high-performance behaviour)
  hardware_profile: 'auto',

  // Verbose logging - when false, operational extraction/migration logs are
  // suppressed. Errors (console.error) are always shown regardless of this flag.
  verbose_logging: false,

  // Per-character memory storage (populated at runtime by longterm.js)
  characters: {},
};

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

// Last observed chat length, used to distinguish new messages from swipes.
// CHARACTER_MESSAGE_RENDERED fires on both; swipes do not grow the chat array.
let lastKnownChatLength = 0;

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
  if (getContext().groupId && selectedGroupCharacter) return selectedGroupCharacter;
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
    updateLastActive();
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
    updateLastActive();
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
  if (settings.compaction_enabled && !compactionRunning) {
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
          // Canon overwrites the slot when active.
          injectCanon(characterName);
          updateShortTermUI(summary);
          updateTokenDisplay();
          setStatusMessage('Summary updated.');
          if (settings.compaction_hide_summarized) {
            await applySummarizedHiding(true);
          }
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
  const sceneCheckText = [lastUserMsgText, lastMsgText].filter(Boolean).join('\n');
  if (settings.scene_enabled && sceneCheckText) {
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

        if (settings.session_enabled && sessionWindow.length > 0) {
          // Snapshot existing memory ids before extraction so we can identify
          // which memories are new and link them to the current scene.
          const priorSessionIds = new Set(
            loadSessionMemories()
              .map((m) => m.id)
              .filter(Boolean),
          );

          const count = await extractSessionMemories(sessionWindow).catch((err) => {
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

        if (settings.longterm_enabled && characterName && longtermWindow.length > 0) {
          const count = await extractAndStoreMemories(characterName, longtermWindow).catch(
            (err) => {
              console.error('[SmartMemory] Long-term extraction error:', err);
              return 0;
            },
          );
          // Run consolidation after extraction if new memories were added.
          if (count > 0 && settings.longterm_consolidate && !consolidationRunning) {
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
          await injectMemories(characterName, isFreshStart(), true);
          updateLongTermUI(characterName);
          total += count;
        }

        if (settings.arcs_enabled) {
          // Arc extraction uses a wider window than other tiers so it can catch
          // arcs opened earlier in the session, but is capped to avoid overflowing
          // the model's context on long chats. Existing arcs are passed to the
          // prompt so resolution still works even outside this window.
          const arcWindow = getStableExtractionWindow(context.chat, 100);
          const count = await extractArcs(arcWindow).catch((err) => {
            console.error('[SmartMemory] Arc extraction error:', err);
            return 0;
          });
          injectArcs();
          updateArcsUI();
          total += count;
        }

        // Regenerate profiles after each extraction pass so they reflect the
        // latest memories. Sequential - same constraint as the other tiers.
        if (settings.profiles_enabled && characterName) {
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

        // Profile B only: auto-regenerate canon after arc extraction when
        // enough resolved arc summaries are available. On Profile A this is
        // too expensive for local models, so it stays manual-only there.
        if (
          settings.arcs_enabled &&
          characterName &&
          getHardwareProfile() === 'b' &&
          loadArcSummaries().length >= 2
        ) {
          await generateCanon(characterName)
            .then(() => injectCanon(characterName))
            .catch((err) => console.error('[SmartMemory] Auto-canon error:', err));
        }

        // Refresh entity panel after extraction since new entities may have been linked.
        updateEntityPanel(characterName);
        updateTokenDisplay();
        setStatusMessage(total > 0 ? `${total} item${total === 1 ? '' : 's'} stored.` : '');
      } catch (err) {
        console.error('[SmartMemory] Extraction error:', err);
        setStatusMessage('');
      } finally {
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
  updateLastActive();
}

// Debounce timer for onChatChanged. ST fires both CHAT_LOADED and CHAT_CHANGED
// on a fresh load, sometimes before context.groupId is set. Collapsing them
// into one deferred run ensures the context is stable before we act on it.
let chatChangedTimer = null;

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
    await injectMemories(selectedGroupCharacter, isFreshStart());
    await injectSessionMemories();
    injectCanon(selectedGroupCharacter);
    injectProfiles(selectedGroupCharacter);
    updateLongTermUI(selectedGroupCharacter);
    updateSessionUI();
    updateFreshStartUI(isFreshStart());
    updateProfilesUI(loadProfiles(selectedGroupCharacter));
    updateEntityPanel(selectedGroupCharacter);

    updateTokenDisplay();

    if (settings.recap_enabled) {
      const hoursAway = getAwayHours();
      if (hoursAway > 0) {
        setStatusMessage('Generating recap...');
        generateRecap()
          .then((recap) => {
            if (recap) displayRecap(recap, hoursAway);
            setStatusMessage('');
          })
          .catch((err) => {
            console.error('[SmartMemory] Auto-recap failed:', err);
            setStatusMessage('');
          });
      }
    }

    updateLastActive();
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
  // loadAndInjectSummary() writes the compaction summary to the short-term slot
  // and returns the text for the UI. Canon then overwrites the slot when active
  // (canon wins once enough arc summaries exist).
  const summary = loadAndInjectSummary();
  injectCanon(characterName);
  updateShortTermUI(summary);

  await injectMemories(characterName, freshStart);

  await injectSessionMemories();
  injectSceneHistory();
  injectArcs();
  injectProfiles(characterName);
  loadAndInjectRepair();

  updateLongTermUI(characterName);
  updateFreshStartUI(freshStart);
  updateSessionUI();
  updateScenesUI();
  updateArcsUI();
  updateProfilesUI(loadProfiles(characterName));
  updateTokenDisplay();

  // Regenerate profiles in the background if they are stale. Non-blocking -
  // the existing stored profiles (if any) were already injected above, so the
  // user sees coherent context immediately and the refresh is invisible.
  if (settings.profiles_enabled && characterName && !freshStart) {
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

  updateLastActive();
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
  if (!group) return;

  const members = (group.members ?? [])
    .map((avatarId) => context.characters.find((c) => c.avatar === avatarId)?.name)
    .filter(Boolean);

  if (members.length === 0) return;

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

  const freshStart = isFreshStart();

  // Restore all injected context for this character. The short-term summary
  // is chat-wide and was injected at load, but canon overwrites the slot when
  // active, so we re-apply it here per character.
  const summary = loadAndInjectSummary();
  injectCanon(characterName);
  updateShortTermUI(summary);

  await injectMemories(characterName, freshStart);
  await injectSessionMemories();
  injectSceneHistory();
  injectArcs();
  injectProfiles(characterName);
  loadAndInjectRepair();

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
  if (settings.compaction_enabled && !compactionRunning) {
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
          updateTokenDisplay();
          setStatusMessage('Summary updated.');
          if (settings.compaction_hide_summarized) {
            await applySummarizedHiding(true);
          }
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
  const sceneCheckText = [lastUserMsgText, lastMsgText].filter(Boolean).join('\n');
  if (settings.scene_enabled && sceneCheckText) {
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
      const longtermRawSize = 20 * Math.max(1, respondedThisRound.size);
      const longtermWindow = getStableExtractionWindow(context.chat, longtermRawSize);

      if (longtermWindow.length === 0 && sessionWindow.length === 0) {
        extractionRunning = false;
      } else {
        messagesSinceLastExtraction = 0;
        setStatusMessage('Extracting memories...');

        const originalBudgets = {
          longterm_inject_budget: settings.longterm_inject_budget,
          session_inject_budget: settings.session_inject_budget,
          scene_inject_budget: settings.scene_inject_budget,
          arcs_inject_budget: settings.arcs_inject_budget,
          profiles_inject_budget: settings.profiles_inject_budget,
        };

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

          // Session extraction is chat-wide - all characters share one session store.
          if (settings.session_enabled && sessionWindow.length > 0) {
            const priorSessionIds = new Set(
              loadSessionMemories()
                .map((m) => m.id)
                .filter(Boolean),
            );

            const count = await extractSessionMemories(sessionWindow).catch((err) => {
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

          // Long-term extraction and profiles run per character since each
          // character has their own store. Sequential per CLAUDE.md constraint.
          for (const characterName of respondedThisRound) {
            // Filter to this character's messages plus user messages so the
            // model only sees context directly relevant to the character being
            // extracted. User messages are included because they address all
            // characters and provide shared narrative context.
            const characterLongtermWindow = longtermWindow.filter(
              (m) => m.is_user || m.name === characterName,
            );

            if (settings.longterm_enabled && characterLongtermWindow.length > 0) {
              const count = await extractAndStoreMemories(
                characterName,
                characterLongtermWindow,
              ).catch((err) => {
                console.error('[SmartMemory] Long-term extraction error:', err);
                return 0;
              });
              if (count > 0 && settings.longterm_consolidate && !consolidationRunning) {
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

            if (settings.profiles_enabled && characterName) {
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

            // Profile B only: auto-regenerate canon after arc extraction when
            // enough resolved arc summaries are available.
            if (
              settings.arcs_enabled &&
              getHardwareProfile() === 'b' &&
              loadArcSummaries().length >= 2
            ) {
              await generateCanon(characterName).catch((err) =>
                console.error('[SmartMemory] Auto-canon error:', err),
              );
            }
          }

          // Arc extraction is chat-wide - once per round after all characters.
          if (settings.arcs_enabled) {
            const arcWindow = getStableExtractionWindow(context.chat, 100);
            const count = await extractArcs(arcWindow).catch((err) => {
              console.error('[SmartMemory] Arc extraction error:', err);
              return 0;
            });
            injectArcs();
            updateArcsUI();
            total += count;
          }

          // Refresh entity panel with the last character who responded.
          const lastResponder = [...respondedThisRound].at(-1);
          if (lastResponder) updateEntityPanel(lastResponder);

          // Refresh the settings panel for whichever character the selector
          // is showing so new memories appear without the user having to
          // manually switch selection.
          updateLongTermUI(selectedGroupCharacter);
          updateSessionUI();

          setStatusMessage(total > 0 ? `${total} item${total === 1 ? '' : 's'} stored.` : '');
        } catch (err) {
          console.error('[SmartMemory] Extraction error:', err);
          setStatusMessage('');
        } finally {
          Object.assign(settings, originalBudgets);
          saveSettingsDebounced();
          extractionRunning = false;
        }
      }
    }
  }

  // Step 4 (Profile B only): scheduled profile regen between extraction passes.
  // Run for each character who responded this round.
  if (
    settings.profiles_enabled &&
    (settings.profiles_regen_every ?? 0) > 0 &&
    getHardwareProfile() === 'b' &&
    messagesSinceLastProfileRegen >= settings.profiles_regen_every
  ) {
    messagesSinceLastProfileRegen = 0;
    for (const characterName of respondedThisRound) {
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
  const lastResponder = [...respondedThisRound].at(-1);
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
    await injectMemories(selectedGroupCharacter, isFreshStart());
    injectCanon(selectedGroupCharacter);
    injectProfiles(selectedGroupCharacter);
    updateTokenDisplay();
  }

  // Step 8: update lastActive.
  updateLastActive();
}

// ---- UI helpers ---------------------------------------------------------

/**
 * Metadata for each injection tier used by the token usage display.
 * Order determines the visual stacking order in the bar chart.
 */
const TOKEN_TIERS = [
  { key: PROMPT_KEY_LONG, label: 'Long-term', color: '#4a6fa5' },
  { key: PROMPT_KEY_SESSION, label: 'Session', color: '#8e5a8e' },
  { key: PROMPT_KEY_SHORT, label: 'Short-term', color: '#5a8e5a' },
  { key: PROMPT_KEY_SCENES, label: 'Scenes', color: '#a07840' },
  { key: PROMPT_KEY_ARCS, label: 'Arcs', color: '#7a6ea5' },
  { key: PROMPT_KEY_PROFILES, label: 'Profiles', color: '#5a9ea0' },
];

/**
 * Reads the currently injected content for each tier from extension_prompts
 * and updates the token usage bar chart and breakdown legend.
 *
 * Called after any injection or chat change so the display stays current.
 * Uses the estimateTokens heuristic (~4 chars/token) - fast, synchronous,
 * accurate enough for budget tuning.
 */
function updateTokenDisplay() {
  const bar = document.getElementById('sm_token_bar');
  const legend = document.getElementById('sm_token_legend');
  const usedEl = document.getElementById('sm_token_used');
  const maxEl = document.getElementById('sm_token_max');
  const pctEl = document.getElementById('sm_token_pct');

  // Panel may not be rendered yet on first call.
  if (!bar || !legend) return;

  // Measure each tier from what is actually injected right now.
  const tiers = TOKEN_TIERS.map((t) => ({
    ...t,
    tokens: estimateTokens(extension_prompts[t.key]?.value ?? ''),
  })).filter((t) => t.tokens > 0);

  const total = tiers.reduce((sum, t) => sum + t.tokens, 0);
  const maxContext = getContext().maxContext || 0;

  // Rebuild bar segments - each segment's width is its share of total SM tokens.
  bar.innerHTML = '';
  for (const tier of tiers) {
    const widthPct = total > 0 ? ((tier.tokens / total) * 100).toFixed(1) : 0;
    const seg = document.createElement('div');
    seg.className = 'sm-token-segment';
    seg.style.width = `${widthPct}%`;
    seg.style.background = tier.color;
    seg.title = `${tier.label}: ~${tier.tokens.toLocaleString()} tokens`;
    bar.appendChild(seg);
  }

  // Rebuild legend rows.
  legend.innerHTML = '';
  for (const tier of tiers) {
    const sharePct = total > 0 ? ((tier.tokens / total) * 100).toFixed(0) : 0;
    const row = document.createElement('div');
    row.className = 'sm-token-legend-row';
    row.innerHTML =
      `<span class="sm-token-dot" style="background:${tier.color}"></span>` +
      `<span class="sm-token-tier-name">${tier.label}</span>` +
      `<span class="sm-token-count">~${tier.tokens.toLocaleString()}</span>` +
      `<span class="sm-token-pct-col">${sharePct}%</span>`;
    legend.appendChild(row);
  }

  // Update totals line.
  const contextPct = maxContext && total ? ((total / maxContext) * 100).toFixed(1) : '0';
  if (usedEl) usedEl.textContent = `~${total.toLocaleString()}`;
  if (maxEl) maxEl.textContent = maxContext ? maxContext.toLocaleString() : '?';
  if (pctEl) pctEl.textContent = contextPct;
}

/** Updates the status bar text shown at the top of the settings panel. */
function setStatusMessage(msg) {
  $('#sm_status').text(msg);
}

/**
 * Updates the continuity badge shown in the settings panel header.
 * Called after the Profile B auto-check completes each AI turn.
 * @param {number|null} count - Contradiction count from checkContinuity, or null to clear.
 */
function setContinuityBadge(count) {
  const $badge = $('#sm_continuity_badge');
  $badge.removeClass('sm_continuity_badge_clean sm_continuity_badge_warn');
  if (count === null) {
    $badge.hide();
    return;
  }
  if (count === 0) {
    $badge.addClass('sm_continuity_badge_clean').text('clean').show();
    // Positive state is transient - hide after 4 s so it doesn't linger.
    setTimeout(() => $badge.hide(), 4000);
  } else {
    $badge
      .addClass('sm_continuity_badge_warn')
      .text(`${count} conflict${count === 1 ? '' : 's'}`)
      .show();
  }
}

/**
 * Displays memory search results in a dismissible modal overlay.
 * Called by the /sm-search slash command.
 * @param {string} query - The original search query.
 * @param {Array<{mem: Object, score: number}>} results - Top-K scored memories, sorted descending.
 */
function showSearchResults(query, results) {
  $('#sm_search_overlay').remove();

  const overlay = $('<div id="sm_search_overlay">');

  const card = $('<div class="sm_search_card">');
  card.append($('<h3>Memory Search Results</h3>'));
  card.append(
    $('<p class="sm_search_query_label">').text(
      `Query: "${query}" - ${results.length} result${results.length === 1 ? '' : 's'}`,
    ),
  );

  if (results.length === 0) {
    card.append($('<p>').text('No matching memories found.'));
  } else {
    const $list = $('<ul class="sm_search_list">');
    for (const { mem, score } of results) {
      const $item = $('<li class="sm_search_item">');
      $item.append(
        $('<span class="sm_search_badge sm_search_badge_tier">').text(mem._tier),
        $('<span>').addClass(`sm_search_badge sm_type_${mem.type}`).text(mem.type),
        $('<span class="sm_search_content">').text(String(mem.content || '')),
        $('<span class="sm_search_score">').text(`${Math.round(score * 100)}%`),
      );
      $list.append($item);
    }
    card.append($list);
  }

  const $footer = $('<div class="sm_search_footer">');
  const $dismiss = $('<button>Dismiss</button>').addClass('menu_button');
  $dismiss.on('click', () => overlay.remove());
  overlay.on('click', (e) => {
    if (e.target === overlay[0]) overlay.remove();
  });
  $footer.append($dismiss);
  card.append($footer);
  overlay.append(card);
  $('body').append(overlay);
}

/**
 * Injects a single #sm-tooltip div into <body> and wires up hover/focus
 * events on all .sm-info elements inside the settings panel.
 *
 * Using position:fixed on the tooltip div means it escapes ST's
 * overflow:hidden extensions panel and is never clipped at the edge.
 */
function initTooltips() {
  // Remove any previous tooltip element before creating a new one.
  // Guards against the settings panel being re-rendered (e.g. on extension
  // reload) which would otherwise append a second tooltip div to the body.
  document.getElementById('sm-tooltip')?.remove();
  const tooltip = document.createElement('div');
  tooltip.id = 'sm-tooltip';
  document.body.appendChild(tooltip);

  const panel = document.getElementById('smart_memory_settings');
  if (!panel) return;

  panel.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.sm-info');
    if (!target?.dataset.tooltip) return;
    tooltip.textContent = target.dataset.tooltip;
    const rect = target.getBoundingClientRect();
    // Prefer showing below the icon; flip above if too close to the bottom.
    const spaceBelow = window.innerHeight - rect.bottom;
    // Use the tooltip's actual rendered width to clamp the left position,
    // falling back to 260 before the first render when offsetWidth is 0.
    const tooltipWidth = tooltip.offsetWidth || 260;
    tooltip.style.left = `${Math.min(rect.left, window.innerWidth - tooltipWidth - 8)}px`;
    tooltip.style.top =
      spaceBelow > 80 ? `${rect.bottom + 6}px` : `${rect.top - tooltip.offsetHeight - 6}px`;
    tooltip.classList.add('sm-tooltip-visible');
  });

  panel.addEventListener('mouseout', (e) => {
    if (!e.target.closest('.sm-info')) return;
    tooltip.classList.remove('sm-tooltip-visible');
  });
}

/** Syncs the short-term summary textarea with the current summary text. */
function updateShortTermUI(summary) {
  $('#sm_current_summary').val(summary || '');
}

/**
 * Hides or restores all messages covered by the current compaction summary.
 * Uses ST's hideChatMessageRange which sets is_system on each message - hiding
 * them from the visible chat AND excluding them from the LLM context window.
 * The injected summary already covers their content, so excluding them is correct.
 * @param {boolean} hide - true to hide summarized messages, false to restore them
 */
async function applySummarizedHiding(hide) {
  const context = getContext();
  const summaryEnd = context.chatMetadata?.[META_KEY]?.summaryEnd ?? 0;
  if (summaryEnd <= 0) return;
  // hideChatMessageRange third param is `unhide`, so invert our hide flag.
  await hideChatMessageRange(0, summaryEnd - 1, !hide);
}

/** Re-renders the long-term memories list and entity panel for the given character. */
function updateLongTermUI(characterName) {
  const memories = characterName ? loadCharacterMemories(characterName) : [];
  renderMemoriesList(memories, characterName);
  updateEntityPanel(characterName);
}

/**
 * Builds a custom type-picker widget to replace the native <select>.
 * Native selects don't allow reliable per-option background styling in
 * Chromium/Electron because the select's own background bleeds into the
 * open dropdown, overriding option colors inconsistently.
 *
 * The returned element exposes its current value via $(el).data('value').
 * Clicking outside any open picker collapses it - register the document
 * handler once at init via initTypePickers().
 *
 * @param {string[]} types - ordered list of type values
 * @returns {jQuery} div.sm-type-picker
 */
function buildTypePicker(types) {
  const initial = types[0];
  const $picker = $('<div class="sm-type-picker">').attr('data-value', initial);
  const $current = $('<div class="sm-type-picker-current">')
    .attr('data-value', initial)
    .text(initial);
  const $list = $('<div class="sm-type-picker-list">');

  types.forEach((t) => {
    $list.append($('<div class="sm-type-option">').attr('data-value', t).text(t));
  });

  $picker.append($current, $list);

  $current.on('click', (e) => {
    e.stopPropagation();
    // Close any other open pickers first.
    $('.sm-type-picker').not($picker).removeClass('open');
    $picker.toggleClass('open');
  });

  $list.on('click', '.sm-type-option', function () {
    const val = $(this).data('value');
    $picker.attr('data-value', val).removeClass('open');
    $current.attr('data-value', val).text(val);
  });

  return $picker;
}

/**
 * Registers a single document-level click handler that closes all open
 * type pickers when the user clicks outside them. Called once at init.
 */
function initTypePickers() {
  $(document).on('click.smTypePicker', (e) => {
    if (!$(e.target).closest('.sm-type-picker').length) {
      $('.sm-type-picker').removeClass('open');
    }
  });
}

/** Syncs the Fresh Start checkbox state. */
function updateFreshStartUI(freshStart) {
  $('#sm_fresh_start').prop('checked', !!freshStart);
}

/**
 * Re-renders the session memory list with per-entry edit and delete buttons.
 * Shows a placeholder when no session memories exist yet.
 */
function updateSessionUI() {
  const memories = loadSessionMemories();
  const $list = $('#sm_session_list');
  $list.empty();

  if (memories.length === 0) {
    $list.append('<div class="sm_no_char">No session memories yet.</div>');
    return;
  }

  const hasRetiredSession = memories.some((m) => m.superseded_by);

  if (hasRetiredSession) {
    const $toggle = $(
      '<button class="sm_toggle_retired menu_button" style="margin-bottom:6px;font-size:0.8em;">' +
        '<i class="fa-solid fa-eye-slash"></i> Show retired memories</button>',
    );
    $list.append($toggle);
    $toggle.on('click', function () {
      const showing = $list.find('.sm_memory_item.sm_memory_retired').first().is(':visible');
      $list.find('.sm_memory_item.sm_memory_retired').toggle(!showing);
      $(this).html(
        `<i class="fa-solid ${showing ? 'fa-eye-slash' : 'fa-eye'}"></i> ${showing ? 'Show' : 'Hide'} retired memories`,
      );
    });
  }

  memories.forEach((mem, idx) => {
    const isRetired = Boolean(mem.superseded_by);
    const hasConflict = Array.isArray(mem.contradicts) && mem.contradicts.length > 0;
    const retiredClass = isRetired ? ' sm_memory_retired' : '';
    const retiredBadge = isRetired
      ? '<span class="sm_memory_retired_badge" title="This memory was superseded by a newer fact">retired</span>'
      : '';
    const supersededByLink = isRetired
      ? `<button class="sm_superseded_by_link menu_button" data-superseded-by="${mem.superseded_by}" title="Jump to the memory that replaced this one">→ superseded by</button>`
      : '';
    const conflictBadge = hasConflict
      ? `<span class="sm_memory_conflict_badge" title="This memory conflicts with ${mem.contradicts.length} other ${mem.contradicts.length === 1 ? 'memory' : 'memories'} - run the continuity checker to review"><i class="fa-solid fa-triangle-exclamation"></i></span>`
      : '';

    const $item = $(`
            <div class="sm_memory_item${retiredClass}" data-index="${idx}" data-memory-id="${mem.id || ''}" ${isRetired ? 'style="display:none"' : ''}>
                <span class="sm_memory_type sm_type_${mem.type}">${mem.type}</span>
                ${retiredBadge}${supersededByLink}${conflictBadge}
                <span class="sm_memory_text">${$('<div>').text(mem.content).html()}</span>
                <button class="sm_edit_session_memory menu_button" data-index="${idx}" title="Edit this memory" ${isRetired ? 'style="display:none"' : ''}>
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="sm_delete_session_memory menu_button" data-index="${idx}" title="Delete this memory">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `);
    $list.append($item);
  });

  // Jump-to-replacement handler for "→ superseded by" links.
  $list.find('.sm_superseded_by_link').on('click', function () {
    const targetId = $(this).data('superseded-by');
    if (!targetId) return;
    const $target = $list.find(`.sm_memory_item[data-memory-id="${targetId}"]`);
    if (!$target.length) return;
    // Ensure the target is visible - if it is also retired, make sure retired items are shown.
    if (!$target.is(':visible')) {
      $list.find('.sm_memory_item.sm_memory_retired').show();
      $list
        .find('.sm_toggle_retired')
        .html('<i class="fa-solid fa-eye"></i> Hide retired memories');
    }
    $target[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    $target.addClass('sm_memory_highlight');
    setTimeout(() => $target.removeClass('sm_memory_highlight'), 1500);
  });

  $list.find('.sm_edit_session_memory').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const $item = $(this).closest('.sm_memory_item');
    const $textSpan = $item.find('.sm_memory_text');
    const current = loadSessionMemories();
    if (!current[idx]) return;

    // Replace text span with an inline textarea for editing.
    const $textarea = $('<textarea class="sm_memory_edit_input">').val(current[idx].content);
    $textSpan.replaceWith($textarea);
    $textarea.trigger('focus');

    // Swap edit/delete buttons with save/cancel.
    $(this).hide();
    $item.find('.sm_delete_session_memory').hide();
    const $save = $(
      '<button class="sm_save_session_memory menu_button" title="Save">Save</button>',
    );
    const $cancel = $(
      '<button class="sm_cancel_session_memory menu_button" title="Cancel">Cancel</button>',
    );
    $item.append($save, $cancel);

    $save.on('click', async () => {
      const newContent = $textarea.val().trim();
      if (!newContent) return;
      const memories = loadSessionMemories();
      if (!memories[idx]) return;
      memories[idx].content = newContent;
      await saveSessionMemories(memories);
      await injectSessionMemories();
      updateSessionUI();
    });

    $cancel.on('click', () => updateSessionUI());
  });

  $list.find('.sm_delete_session_memory').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const context = getContext();
    const meta = context.chatMetadata?.[META_KEY];
    if (!meta?.sessionMemories) return;
    meta.sessionMemories.splice(idx, 1);
    await context.saveMetadata();
    injectSessionMemories();
    updateSessionUI();
  });

  // Add memory form at the bottom of the list.
  $list.next('.sm_add_memory_form').remove();
  const $addForm = $(`
    <div class="sm_add_memory_form">
      <input type="text" class="sm_add_memory_input" placeholder="New session memory...">
      <button class="sm_add_memory_btn menu_button" title="Add memory">Add</button>
    </div>
  `);
  $addForm.prepend(buildTypePicker(SESSION_TYPES));
  $list.after($addForm);

  $addForm.find('.sm_add_memory_btn').on('click', async () => {
    const type = $addForm.find('.sm-type-picker').data('value');
    const content = $addForm.find('.sm_add_memory_input').val().trim();
    if (!content) return;
    const memories = loadSessionMemories();
    memories.push({
      type,
      content,
      importance: 2,
      expiration: 'session',
      ts: Date.now(),
      consolidated: true,
      confidence: 1.0,
      persona_relevance: 1,
      intimacy_relevance: 1,
      retrieval_count: 0,
      last_confirmed_ts: Date.now(),
    });
    await saveSessionMemories(memories);
    await injectSessionMemories();
    updateSessionUI();
  });
}

/** Re-renders the scene history list. */
function updateScenesUI() {
  const history = loadSceneHistory();
  const $list = $('#sm_scenes_list');
  $list.empty();

  if (history.length === 0) {
    $list.append('<div class="sm_no_char">No scenes recorded yet.</div>');
    return;
  }

  history.forEach((s, i) => {
    $list.append(
      `<div class="sm_scene_item"><b>Scene ${i + 1}:</b> ${$('<div>').text(s.summary).html()}</div>`,
    );
  });
}

/** Re-renders the story arcs list with per-arc edit, resolve, and add buttons. */
function updateArcsUI() {
  const arcs = loadArcs();
  const $list = $('#sm_arcs_list');
  $list.empty();

  if (arcs.length === 0) {
    $list.append('<div class="sm_no_char">No open story threads.</div>');
  }

  arcs.forEach((arc, idx) => {
    const $item = $(`
            <div class="sm_arc_item" data-index="${idx}">
                <span class="sm_arc_text">${$('<div>').text(arc.content).html()}</span>
                <button class="sm_edit_arc menu_button" data-index="${idx}" title="Edit this arc">
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="sm_delete_arc menu_button" data-index="${idx}" title="Resolve / remove this arc">
                    <i class="fa-solid fa-check"></i>
                </button>
            </div>
        `);
    $list.append($item);
  });

  $list.find('.sm_edit_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const $item = $(this).closest('.sm_arc_item');
    const $textSpan = $item.find('.sm_arc_text');
    const current = loadArcs();
    if (!current[idx]) return;

    const $textarea = $('<textarea class="sm_memory_edit_input">').val(current[idx].content);
    $textSpan.replaceWith($textarea);
    $textarea.trigger('focus');

    $(this).hide();
    $item.find('.sm_delete_arc').hide();
    const $save = $('<button class="sm_save_arc menu_button" title="Save">Save</button>');
    const $cancel = $('<button class="sm_cancel_arc menu_button" title="Cancel">Cancel</button>');
    $item.append($save, $cancel);

    $save.on('click', async () => {
      const newContent = $textarea.val().trim();
      if (!newContent) return;
      const arcs = loadArcs();
      if (!arcs[idx]) return;
      arcs[idx].content = newContent;
      await saveArcs(arcs);
      injectArcs();
      updateArcsUI();
    });

    $cancel.on('click', () => updateArcsUI());
  });

  $list.find('.sm_delete_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    await deleteArc(idx);
    injectArcs();
    updateArcsUI();
  });

  // Add arc form at the bottom of the list.
  $list.next('.sm_add_memory_form').remove();
  const $addForm = $(`
    <div class="sm_add_memory_form">
      <input type="text" class="sm_add_memory_input" placeholder="New story thread...">
      <button class="sm_add_memory_btn menu_button" title="Add arc">Add</button>
    </div>
  `);
  $list.after($addForm);

  $addForm.find('.sm_add_memory_btn').on('click', async () => {
    const content = $addForm.find('.sm_add_memory_input').val().trim();
    if (!content) return;
    const arcs = loadArcs();
    arcs.push({ content, ts: Date.now() });
    await saveArcs(arcs);
    injectArcs();
    updateArcsUI();
  });
}

/**
 * Updates the profiles display panel with the current stored profiles.
 * Shows a placeholder when no profiles exist yet.
 * @param {{character_state: string, world_state: string, relationship_matrix: string}|null} profiles
 */
function updateProfilesUI(profiles) {
  const $display = $('#sm_profiles_display');
  $display.empty();

  if (!profiles) {
    $display.append('<span class="sm-muted">No profiles generated yet.</span>');
    return;
  }

  const sections = [
    { key: 'character_state', label: 'Character state' },
    { key: 'world_state', label: 'World state' },
    { key: 'relationship_matrix', label: 'Relationships' },
  ];

  let hasContent = false;
  for (const { key, label } of sections) {
    const text = profiles[key];
    if (!text) continue;
    $display.append($('<span class="sm_profiles_section-label">').text(label + ':'));
    $display.append($('<div>').text(text));
    hasContent = true;
  }

  if (!hasContent) {
    $display.append('<span class="sm-muted">No profiles generated yet.</span>');
  }
}

/**
 * Renders the entity registry panel, combining long-term (extension_settings)
 * and session-scoped (chatMetadata) entities. Each entity row shows its type
 * badge, canonical name, memory count, and last-seen message index. Clicking
 * an entity row opens its timeline view.
 *
 * @param {string|null} characterName - Current character name for long-term registry lookup.
 */
function updateEntityPanel(characterName) {
  const $panel = $('#sm_entity_panel');
  $panel.empty();

  const ltEntities = characterName ? loadCharacterEntityRegistry(characterName) : [];
  const sessionEntities = loadSessionEntityRegistry();

  // Merge by canonical name + type (case-insensitive) rather than by UUID.
  // The lt and session registries are independent stores with separate UUIDs,
  // so the same named entity (e.g. "Senjin") will have different ids in each.
  // Keying by name|type avoids collisions when two distinct entities share a
  // name but differ by type (e.g. a place "Hollow" vs. a character "Hollow").
  const byName = new Map();
  for (const e of ltEntities) {
    const key = `${e.name.toLowerCase().trim()}|${e.type ?? 'unknown'}`;
    byName.set(key, { ...e, memory_ids: [...(e.memory_ids ?? [])] });
  }
  for (const e of sessionEntities) {
    const key = `${e.name.toLowerCase().trim()}|${e.type ?? 'unknown'}`;
    if (byName.has(key)) {
      // Merge memory_ids and update last_seen.
      const merged = byName.get(key);
      for (const id of e.memory_ids ?? []) {
        if (!merged.memory_ids.includes(id)) merged.memory_ids.push(id);
      }
      merged.last_seen = Math.max(merged.last_seen ?? 0, e.last_seen ?? 0);
    } else {
      byName.set(key, { ...e, memory_ids: [...(e.memory_ids ?? [])] });
    }
  }

  const entities = [...byName.values()].sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));

  if (entities.length === 0) {
    $panel.append('<span class="sm-muted">No entities extracted yet.</span>');
    return;
  }

  const TYPE_ICONS = {
    character: 'fa-user',
    place: 'fa-location-dot',
    object: 'fa-cube',
    faction: 'fa-users',
    concept: 'fa-lightbulb',
    unknown: 'fa-question',
  };

  const ENTITY_TYPES = ['character', 'place', 'object', 'faction', 'concept', 'unknown'];

  // Helper: persist type or merge changes across both registries, then re-render.
  const persistAndRefresh = async () => {
    if (characterName) {
      const lt = loadCharacterEntityRegistry(characterName);
      saveCharacterEntityRegistry(characterName, lt);
      saveSettingsDebounced();
    }
    const session = loadSessionEntityRegistry();
    await saveSessionEntityRegistry(session);
    updateEntityPanel(characterName);
  };

  for (const entity of entities) {
    const icon = TYPE_ICONS[entity.type] ?? 'fa-tag';
    const memCount = Array.isArray(entity.memory_ids) ? entity.memory_ids.length : 0;
    const lastSeen = entity.last_seen != null ? `msg #${entity.last_seen}` : 'unknown';
    const safeName = $('<div>').text(entity.name).html();

    const $row = $(`
      <div class="sm_entity_row" data-entity-id="${entity.id}" style="position:relative;">
        <span class="sm_entity_type_badge sm_entity_type_${entity.type}" data-clickable title="Click to change type">
          <i class="fa-solid ${icon}"></i> ${entity.type}
        </span>
        <span class="sm_entity_name">${safeName}</span>
        <span class="sm_entity_meta">${memCount} ${memCount === 1 ? 'memory' : 'memories'} &middot; last seen ${lastSeen}</span>
        <button class="sm_entity_merge_btn menu_button" title="Merge into another entity">
          <i class="fa-solid fa-code-merge"></i>
        </button>
        <button class="sm_entity_timeline_btn menu_button" title="View timeline for this entity">
          <i class="fa-solid fa-timeline"></i>
        </button>
        <button class="sm_entity_delete_btn menu_button" title="Delete this entity">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `);

    // Type-picker: clicking the badge opens an inline dropdown to change the type.
    $row.find('.sm_entity_type_badge').on('click', (e) => {
      e.stopPropagation();
      $panel.find('.sm_entity_type_picker').remove();

      const $picker = $('<div class="sm_entity_type_picker">');
      for (const t of ENTITY_TYPES) {
        const tIcon = TYPE_ICONS[t] ?? 'fa-tag';
        const $opt = $(
          `<div class="sm_entity_type_option sm_entity_type_${t}"><i class="fa-solid ${tIcon}"></i> ${t}</div>`,
        );
        $opt.on('click', async (ev) => {
          ev.stopPropagation();
          $picker.remove();
          const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
          const sessReg = loadSessionEntityRegistry();
          setEntityType(entity.id, t, ltReg);
          setEntityType(entity.id, t, sessReg);
          await persistAndRefresh();
        });
        $picker.append($opt);
      }

      // Position below the badge and close on outside click.
      $row.append($picker);
      const closeOnOutside = (ev) => {
        if (!$picker[0].contains(ev.target)) {
          $picker.remove();
          $(document).off('click', closeOnOutside);
        }
      };
      setTimeout(() => $(document).on('click', closeOnOutside), 0);
    });

    // Merge button: shows a select of all other entity names.
    $row.find('.sm_entity_merge_btn').on('click', (e) => {
      e.stopPropagation();
      $panel.find('.sm_entity_type_picker').remove();

      const otherNames = entities.filter((en) => en.id !== entity.id).map((en) => en.name);
      if (otherNames.length === 0) return;

      const $picker = $('<div class="sm_entity_type_picker">');
      $picker.append(
        $('<div style="font-size:0.75em;opacity:0.6;padding:2px 8px 4px;">Merge into:</div>'),
      );
      for (const targetName of otherNames) {
        const safeTarget = $('<div>').text(targetName).html();
        const $opt = $(`<div class="sm_entity_type_option">${safeTarget}</div>`);
        $opt.on('click', async (ev) => {
          ev.stopPropagation();
          $picker.remove();
          const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
          const ltMems = characterName ? loadCharacterMemories(characterName) : [];
          const sessReg = loadSessionEntityRegistry();
          const sessMems = loadSessionMemories();
          mergeEntitiesByName(entity.name, targetName, ltReg, ltMems, sessReg, sessMems);
          if (characterName) saveCharacterMemories(characterName, ltMems);
          await persistAndRefresh();
        });
        $picker.append($opt);
      }

      $row.append($picker);
      const closeOnOutside = (ev) => {
        if (!$picker[0].contains(ev.target)) {
          $picker.remove();
          $(document).off('click', closeOnOutside);
        }
      };
      setTimeout(() => $(document).on('click', closeOnOutside), 0);
    });

    $row.find('.sm_entity_timeline_btn').on('click', (e) => {
      e.stopPropagation();
      showEntityTimeline(entity, characterName);
    });

    $row.find('.sm_entity_delete_btn').on('click', async (e) => {
      e.stopPropagation();
      $panel.find('.sm_entity_type_picker').remove();
      const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
      const ltMems = characterName ? loadCharacterMemories(characterName) : [];
      const sessReg = loadSessionEntityRegistry();
      const sessMems = loadSessionMemories();
      deleteEntityById(entity.id, ltReg, ltMems);
      deleteEntityById(entity.id, sessReg, sessMems);
      if (characterName) saveCharacterMemories(characterName, ltMems);
      await persistAndRefresh();
    });

    $panel.append($row);
  }
}

/**
 * Shows a CSS-only vertical timeline of memories involving a specific entity.
 * Memories are ordered by valid_from (falling back to ts), with retired entries
 * shown in muted style. Renders inline below the entity row.
 *
 * @param {Object} entity - The entity object from the registry.
 * @param {string|null} characterName - Current character name.
 */
function showEntityTimeline(entity, characterName) {
  const $panel = $('#sm_entity_panel');

  // Remove any existing timeline (toggle if same entity).
  const existingEntityId = $panel.find('.sm_entity_timeline').data('entity-id');
  $panel.find('.sm_entity_timeline').remove();
  if (existingEntityId === entity.id) return;

  const ltMemories = characterName ? loadCharacterMemories(characterName) : [];
  const sessionMems = loadSessionMemories();
  const allMemories = [...ltMemories, ...sessionMems];

  const memIds = new Set(Array.isArray(entity.memory_ids) ? entity.memory_ids : []);
  const linked = allMemories
    .filter((m) => m.id && memIds.has(m.id))
    .sort((a, b) => (a.valid_from ?? a.ts ?? 0) - (b.valid_from ?? b.ts ?? 0));

  const $timeline = $('<div class="sm_entity_timeline">').attr('data-entity-id', entity.id);
  $timeline.append(
    $(`<div class="sm_entity_timeline_header">`).text(
      `Timeline: ${entity.name} (${linked.length} ${linked.length === 1 ? 'memory' : 'memories'})`,
    ),
  );

  if (linked.length === 0) {
    $timeline.append('<div class="sm_timeline_empty sm-muted">No linked memories found.</div>');
  } else {
    const $list = $('<div class="sm_timeline_list">');
    for (const mem of linked) {
      const isRetired = Boolean(mem.superseded_by);
      const when = mem.valid_from != null ? `msg #${mem.valid_from}` : 'unknown';
      const $entry = $(`
        <div class="sm_timeline_entry${isRetired ? ' sm_timeline_entry_retired' : ''}">
          <div class="sm_timeline_dot"></div>
          <div class="sm_timeline_body">
            <span class="sm_timeline_when">${when}</span>
            <span class="sm_memory_type sm_type_${mem.type}">${mem.type}</span>
            ${isRetired ? '<span class="sm_memory_retired_badge">retired</span>' : ''}
            <span class="sm_timeline_text">${$('<div>').text(mem.content).html()}</span>
          </div>
        </div>
      `);
      $list.append($entry);
    }
    $timeline.append($list);
  }

  // Insert the timeline after the entity row for this entity.
  const $entityRow = $panel.find(`.sm_entity_row[data-entity-id="${entity.id}"]`);
  if ($entityRow.length) {
    $entityRow.after($timeline);
  } else {
    $panel.append($timeline);
  }
}

/**
 * Renders the long-term memories list with per-memory edit and delete buttons.
 * Shows a placeholder message when no character is selected or no memories exist.
 */
function renderMemoriesList(memories, characterName) {
  const $list = $('#sm_memories_list');
  $list.empty();

  if (!characterName) {
    $list.append('<div class="sm_no_char">No character selected.</div>');
    return;
  }

  if (memories.length === 0) {
    $list.append('<div class="sm_no_char">No memories stored yet for this character.</div>');
    return;
  }

  const hasRetired = memories.some((m) => m.superseded_by);

  // "Show retired" toggle - only rendered when retired memories exist.
  if (hasRetired) {
    const $toggle = $(
      '<button class="sm_toggle_retired menu_button" style="margin-bottom:6px;font-size:0.8em;">' +
        '<i class="fa-solid fa-eye-slash"></i> Show retired memories</button>',
    );
    $list.append($toggle);
    $toggle.on('click', function () {
      const showing = $list.find('.sm_memory_item.sm_memory_retired').first().is(':visible');
      $list.find('.sm_memory_item.sm_memory_retired').toggle(!showing);
      $(this).find('i').toggleClass('fa-eye-slash', !showing).toggleClass('fa-eye', !showing);
      $(this).find('i').toggleClass('fa-eye-slash fa-eye');
      $(this).html(
        `<i class="fa-solid ${showing ? 'fa-eye-slash' : 'fa-eye'}"></i> ${showing ? 'Show' : 'Hide'} retired memories`,
      );
    });
  }

  memories.forEach((mem, idx) => {
    const isRetired = Boolean(mem.superseded_by);
    const hasConflict = Array.isArray(mem.contradicts) && mem.contradicts.length > 0;
    const retiredClass = isRetired ? ' sm_memory_retired' : '';
    const retiredBadge = isRetired
      ? '<span class="sm_memory_retired_badge" title="This memory was superseded by a newer fact">retired</span>'
      : '';
    const supersededByLink = isRetired
      ? `<button class="sm_superseded_by_link menu_button" data-superseded-by="${mem.superseded_by}" title="Jump to the memory that replaced this one">→ superseded by</button>`
      : '';
    const conflictBadge = hasConflict
      ? `<span class="sm_memory_conflict_badge" title="This memory conflicts with ${mem.contradicts.length} other ${mem.contradicts.length === 1 ? 'memory' : 'memories'} - run the continuity checker to review"><i class="fa-solid fa-triangle-exclamation"></i></span>`
      : '';

    const $item = $(`
            <div class="sm_memory_item${retiredClass}" data-index="${idx}" data-memory-id="${mem.id || ''}" ${isRetired ? 'style="display:none"' : ''}>
                <span class="sm_memory_type sm_type_${mem.type}">${mem.type}</span>
                ${retiredBadge}${supersededByLink}${conflictBadge}
                <span class="sm_memory_text">${$('<div>').text(mem.content).html()}</span>
                <button class="sm_edit_memory menu_button" data-index="${idx}" title="Edit this memory" ${isRetired ? 'style="display:none"' : ''}>
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="sm_delete_memory menu_button" data-index="${idx}" title="Delete this memory">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `);
    $list.append($item);
  });

  // Jump-to-replacement handler for "→ superseded by" links.
  $list.find('.sm_superseded_by_link').on('click', function () {
    const targetId = $(this).data('superseded-by');
    if (!targetId) return;
    const $target = $list.find(`.sm_memory_item[data-memory-id="${targetId}"]`);
    if (!$target.length) return;
    // Target is an active (non-retired) memory, so it should already be visible.
    // If it happens to be retired too, show retired entries first.
    if (!$target.is(':visible')) {
      $list.find('.sm_memory_item.sm_memory_retired').show();
      $list
        .find('.sm_toggle_retired')
        .html('<i class="fa-solid fa-eye"></i> Hide retired memories');
    }
    $target[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    $target.addClass('sm_memory_highlight');
    setTimeout(() => $target.removeClass('sm_memory_highlight'), 1500);
  });

  $list.find('.sm_edit_memory').on('click', function () {
    const idx = parseInt($(this).data('index'), 10);
    const $item = $(this).closest('.sm_memory_item');
    const $textSpan = $item.find('.sm_memory_text');
    const current = loadCharacterMemories(characterName);
    if (!current[idx]) return;

    // Replace text span with an inline textarea for editing.
    const $textarea = $('<textarea class="sm_memory_edit_input">').val(current[idx].content);
    $textSpan.replaceWith($textarea);
    $textarea.trigger('focus');

    // Swap edit/delete buttons with save/cancel.
    $(this).hide();
    $item.find('.sm_delete_memory').hide();
    const $save = $('<button class="sm_save_memory menu_button" title="Save">Save</button>');
    const $cancel = $(
      '<button class="sm_cancel_memory menu_button" title="Cancel">Cancel</button>',
    );
    $item.append($save, $cancel);

    $save.on('click', () => {
      const newContent = $textarea.val().trim();
      if (!newContent) return;
      const memories = loadCharacterMemories(characterName);
      if (!memories[idx]) return;
      memories[idx].content = newContent;
      saveCharacterMemories(characterName, memories);
      saveSettingsDebounced();
      injectMemories(characterName, isFreshStart()).catch(console.error);
      renderMemoriesList(loadCharacterMemories(characterName), characterName);
    });

    $cancel.on('click', () =>
      renderMemoriesList(loadCharacterMemories(characterName), characterName),
    );
  });

  $list.find('.sm_delete_memory').on('click', function () {
    const idx = parseInt($(this).data('index'), 10);
    const current = loadCharacterMemories(characterName);
    current.splice(idx, 1);
    saveCharacterMemories(characterName, current);
    saveSettingsDebounced();
    renderMemoriesList(current, characterName);
  });

  // Add memory form at the bottom of the list.
  $list.next('.sm_add_memory_form').remove();
  const $addForm = $(`
    <div class="sm_add_memory_form">
      <input type="text" class="sm_add_memory_input" placeholder="New memory...">
      <button class="sm_add_memory_btn menu_button" title="Add memory">Add</button>
    </div>
  `);
  $addForm.prepend(buildTypePicker(MEMORY_TYPES));
  $list.after($addForm);

  $addForm.find('.sm_add_memory_btn').on('click', () => {
    const type = $addForm.find('.sm-type-picker').data('value');
    const content = $addForm.find('.sm_add_memory_input').val().trim();
    if (!content) return;
    const memories = loadCharacterMemories(characterName);
    memories.push({
      type,
      content,
      importance: 2,
      expiration: 'permanent',
      ts: Date.now(),
      consolidated: true,
      confidence: 1.0,
      persona_relevance: type === 'relationship' ? 3 : 1,
      intimacy_relevance: type === 'preference' ? 3 : 1,
      retrieval_count: 0,
      last_confirmed_ts: Date.now(),
    });
    saveCharacterMemories(characterName, memories);
    saveSettingsDebounced();
    injectMemories(characterName, isFreshStart()).catch(console.error);
    renderMemoriesList(loadCharacterMemories(characterName), characterName);
  });
}

// ---- Settings management ------------------------------------------------

/**
 * Merges defaultSettings into extension_settings for any missing keys.
 * Preserves existing values so user configuration is not overwritten on update.
 */
function loadSettings() {
  if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = {};
  }
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (extension_settings[MODULE_NAME][key] === undefined) {
      extension_settings[MODULE_NAME][key] = value;
    }
  }

  // Migration: replace old bracket-wrapped template defaults with plain-text equivalents.
  // Only affects users who never customized these fields (exact match on the old default).
  // Bracket notation in injections bleeds into RP output - the model mimics it.
  const TEMPLATE_MIGRATIONS = {
    compaction_template: {
      from: '[Story so far:\n{{summary}}]',
      to: 'Story so far:\n{{summary}}',
    },
    longterm_template: {
      from: '[Memories from previous conversations:\n{{memories}}]',
      to: 'Memories from previous conversations:\n{{memories}}',
    },
    session_template: {
      from: '[Details from this session:\n{{session}}]',
      to: 'Details from this session:\n{{session}}',
    },
  };
  for (const [key, migration] of Object.entries(TEMPLATE_MIGRATIONS)) {
    if (extension_settings[MODULE_NAME][key] === migration.from) {
      extension_settings[MODULE_NAME][key] = migration.to;
    }
  }

  // Migration: raise compaction response length from 1500 to 2000.
  // 1500 tokens was too tight for a 9-section summary, causing truncated output.
  if (extension_settings[MODULE_NAME].compaction_response_length === 1500) {
    extension_settings[MODULE_NAME].compaction_response_length = 2000;
  }

  // Migration: raise arc injection budget to 700.
  // 400 was too tight once the adaptive budget applies a 0.8x multiplier during intimate
  // scenes, dropping the oldest arc from injection. 200 is the pre-1.3.0 default.
  if (
    extension_settings[MODULE_NAME].arcs_inject_budget === 200 ||
    extension_settings[MODULE_NAME].arcs_inject_budget === 400
  ) {
    extension_settings[MODULE_NAME].arcs_inject_budget = 700;
  }
}

/**
 * Shows a toastr error notification for a failed Smart Memory operation.
 * Used by all manual button handlers so failures are visible to the user.
 * @param {string} operation - Short label for what failed (e.g. "Summary generation").
 * @param {Error} err - The caught error.
 */
function showError(operation, err) {
  console.error(`[SmartMemory] ${operation} failed:`, err);
  toastr.error(`${operation} failed. Check the browser console for details.`, 'Smart Memory', {
    timeOut: 6000,
    positionClass: 'toast-bottom-right',
  });
}

/**
 * Returns true and shows a warning toast if a catch-up or compaction is
 * currently running. Use this to block manual extract/clear buttons that
 * would conflict with an in-progress background job.
 * @returns {boolean}
 */
function isCatchUpRunning() {
  if (extractionRunning || compactionRunning) {
    toastr.warning(
      'Cannot do this while Memorize Chat is running. Cancel it first.',
      'Smart Memory',
      {
        timeOut: 4000,
        positionClass: 'toast-bottom-right',
      },
    );
    return true;
  }
  return false;
}

/**
 * Binds all settings panel controls to their corresponding settings values.
 * Each control reads from getSettings() on mount and writes back on change,
 * calling saveSettingsDebounced() to persist.
 */
function bindSettingsUI() {
  const s = getSettings();

  // Prevent section-header enable checkboxes from toggling the <details> open/closed
  // when clicked. Without this, clicking the checkbox both changes the setting and
  // collapses the section, which is never what the user intends.
  $(document).on('click', '.sm-section-toggle', (e) => e.stopPropagation());

  // ---- Master toggle --------------------------------------------------
  $('#sm_enabled')
    .prop('checked', s.enabled)
    .on('change', function () {
      getSettings().enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!getSettings().enabled) {
        // Remove all injections immediately so nothing lingers in the prompt.
        clearAllInjections();
      } else {
        // Restore injections from stored data so the user picks up where they left off.
        onChatChanged();
      }
    });

  // ---- Group chat character selector ----------------------------------
  $('#sm_group_char_select').on('change', async function () {
    selectedGroupCharacter = $(this).val() || null;
    updateLongTermUI(selectedGroupCharacter);
    updateSessionUI();
    updateFreshStartUI(isFreshStart());
    updateProfilesUI(loadProfiles(selectedGroupCharacter));
    // Re-inject the character-specific slots so updateTokenDisplay reads
    // the selected character's content rather than whoever responded last.
    // onGroupMemberDrafted will overwrite these again before the next Generate().
    await injectMemories(selectedGroupCharacter, isFreshStart());
    await injectSessionMemories();
    injectCanon(selectedGroupCharacter);
    injectProfiles(selectedGroupCharacter);
    updateTokenDisplay();
  });

  // ---- LLM source -----------------------------------------------------

  /**
   * Shows or hides the per-source settings sections based on the current source.
   * @param {string} source
   */
  function updateSourceSections(source) {
    $('#sm_ollama_settings').toggle(source === memory_sources.ollama);
    $('#sm_openai_compat_settings').toggle(source === memory_sources.openai_compatible);
  }

  /**
   * Fetches installed Ollama models and populates the model dropdown.
   * Preserves the previously selected model if it is still available.
   */
  async function refreshOllamaModels() {
    const $select = $('#sm_ollama_model');
    const $btn = $('#sm_ollama_refresh');
    const prevModel = getSettings().ollama_model;
    $btn.prop('disabled', true);
    try {
      const models = await fetchOllamaModels();
      $select.empty();
      if (models.length === 0) {
        $select.append('<option value="">No models found</option>');
      } else {
        models.forEach((name) => {
          $select.append(`<option value="${name}">${name}</option>`);
        });
        const best = models.includes(prevModel) ? prevModel : models[0];
        $select.val(best);
        getSettings().ollama_model = best;
        saveSettingsDebounced();
      }
    } catch (err) {
      toastr.error(
        `Could not reach Ollama at ${getSettings().ollama_url || 'http://localhost:11434'}. Is it running?`,
        'Smart Memory',
      );
      console.error('[SmartMemory] Ollama model fetch failed:', err);
    } finally {
      $btn.prop('disabled', false);
    }
  }

  const currentSource = s.source ?? memory_sources.main;
  $('#sm_source')
    .val(currentSource)
    .on('change', function () {
      const source = $(this).val();
      getSettings().source = source;
      saveSettingsDebounced();
      updateSourceSections(source);
      if (source === memory_sources.ollama && !getSettings().ollama_model) {
        refreshOllamaModels();
      }
      // Re-evaluate auto-detected hardware profile label when source changes.
      updateProfileLabel();
    });

  updateSourceSections(currentSource);

  // Ollama URL field
  $('#sm_ollama_url')
    .val(s.ollama_url ?? 'http://localhost:11434')
    .on('change', function () {
      getSettings().ollama_url = $(this).val().trim();
      saveSettingsDebounced();
      // Refresh models when the URL changes so the list reflects the new instance.
      refreshOllamaModels();
    });

  // Ollama model dropdown
  $('#sm_ollama_model').on('change', function () {
    getSettings().ollama_model = $(this).val();
    saveSettingsDebounced();
  });

  // Populate Ollama model list on load if Ollama is already selected.
  if (currentSource === memory_sources.ollama) {
    refreshOllamaModels();
  }

  // Ollama refresh button
  $('#sm_ollama_refresh').on('click', () => refreshOllamaModels());

  // OpenAI Compatible fields
  $('#sm_openai_compat_url')
    .val(s.openai_compat_url ?? '')
    .on('change', function () {
      getSettings().openai_compat_url = $(this).val().trim();
      saveSettingsDebounced();
    });

  $('#sm_openai_compat_key')
    .val(s.openai_compat_key ?? '')
    .on('change', function () {
      getSettings().openai_compat_key = $(this).val();
      saveSettingsDebounced();
    });

  $('#sm_openai_compat_model')
    .val(s.openai_compat_model ?? '')
    .on('input', function () {
      getSettings().openai_compat_model = $(this).val().trim();
      saveSettingsDebounced();
    });

  // Hardware profile override
  const PROFILE_LABELS = {
    a: 'Profile A: local / low-VRAM - minimal model calls, heuristic-only signals.',
    b: 'Profile B: hosted / high-performance - richer extraction, all retrieval signals active.',
  };

  /** Updates the descriptive label below the hardware profile select. */
  function updateProfileLabel() {
    const active = getHardwareProfile();
    $('#sm_hardware_profile_label').text(PROFILE_LABELS[active] ?? '');
  }

  /**
   * Dims and disables settings that only apply to Profile B when Profile A is
   * active, so users are not confused by controls that silently do nothing.
   */
  function syncProfileGating() {
    const isB = getHardwareProfile() === 'b';
    $('#smart_memory_settings .sm-profile-b-only').each(function () {
      $(this).toggleClass('sm-gated', !isB);
      $(this).find('input, select, button').prop('disabled', !isB);
    });
  }

  $('#sm_hardware_profile')
    .val(s.hardware_profile ?? 'auto')
    .on('change', function () {
      getSettings().hardware_profile = $(this).val();
      saveSettingsDebounced();
      updateProfileLabel();
      syncProfileGating();
    });

  updateProfileLabel();
  syncProfileGating();

  // ---- Short-term (compaction) ----------------------------------------
  $('#sm_compaction_enabled')
    .prop('checked', s.compaction_enabled)
    .on('change', function () {
      getSettings().compaction_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_compaction_threshold')
    .val(s.compaction_threshold)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().compaction_threshold = val;
      $('#sm_compaction_threshold_value').text(val + '%');
      saveSettingsDebounced();
    });
  $('#sm_compaction_threshold_value').text(s.compaction_threshold + '%');

  $('#sm_compaction_response_length')
    .val(s.compaction_response_length)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().compaction_response_length = val;
      $('#sm_compaction_response_length_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_compaction_response_length_value').text(s.compaction_response_length);

  $('#sm_hide_summarized')
    .prop('checked', s.compaction_hide_summarized)
    .on('change', async function () {
      const hide = $(this).prop('checked');
      getSettings().compaction_hide_summarized = hide;
      saveSettingsDebounced();
      await applySummarizedHiding(hide);
    });

  $('#sm_compaction_template')
    .val(s.compaction_template)
    .on('input', function () {
      getSettings().compaction_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sm_compaction_position"][value="${s.compaction_position}"]`).prop('checked', true);
  $('input[name="sm_compaction_position"]').on('change', function () {
    getSettings().compaction_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_compaction_depth')
    .val(s.compaction_depth)
    .on('input', function () {
      getSettings().compaction_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_compaction_role')
    .val(s.compaction_role)
    .on('change', function () {
      getSettings().compaction_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_summarize_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (compactionRunning) return;
    compactionRunning = true;
    setStatusMessage('Generating summary...');
    $(this).prop('disabled', true);
    try {
      const summary = await runCompaction();
      if (summary) {
        injectSummary(summary);
        updateShortTermUI(summary);
        updateTokenDisplay();
        setStatusMessage('Summary updated.');
      }
    } catch (err) {
      showError('Summary generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
      compactionRunning = false;
    }
  });

  $('#sm_generate_canon').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = getSelectedCharacterName();
    if (!characterName) {
      toastr.warning('No character loaded.', 'Smart Memory');
      return;
    }
    if (loadArcSummaries().length < 2) {
      toastr.warning(
        'Canon requires at least 2 resolved arc summaries. Resolve more story arcs first.',
        'Smart Memory',
      );
      return;
    }
    $(this).prop('disabled', true);
    setStatusMessage('Generating canon summary...');
    try {
      const text = await generateCanon(characterName);
      if (text) {
        injectCanon(characterName);
        updateShortTermUI(text);
        $('#sm_canon_status').text(
          `Canon updated: ${estimateTokens(text)} tokens, sourced from ${loadArcSummaries().length} arc summaries.`,
        );
        updateTokenDisplay();
        setStatusMessage('Canon summary updated.');
      } else {
        setStatusMessage('');
        toastr.warning('Canon generation returned no output.', 'Smart Memory');
      }
    } catch (err) {
      showError('Canon generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  // Allow manual edits to the summary textarea to take effect immediately.
  $('#sm_current_summary').on('input', function () {
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    const val = $(this).val();
    context.chatMetadata[META_KEY].summary = val;
    context.saveMetadata();
    injectSummary(val);
  });

  // ---- Long-term memory -----------------------------------------------
  $('#sm_longterm_enabled')
    .prop('checked', s.longterm_enabled)
    .on('change', function () {
      getSettings().longterm_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectMemories(getSelectedCharacterName(), isFreshStart()).catch(console.error);
    });

  $('#sm_longterm_consolidate')
    .prop('checked', s.longterm_consolidate ?? true)
    .on('change', function () {
      getSettings().longterm_consolidate = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_longterm_threshold_fact')
    .val(s.longterm_consolidation_threshold_fact ?? 4)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().longterm_consolidation_threshold_fact = val;
      $('#sm_longterm_threshold_fact_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_longterm_threshold_fact_value').text(s.longterm_consolidation_threshold_fact ?? 4);

  $('#sm_longterm_threshold_relationship')
    .val(s.longterm_consolidation_threshold_relationship ?? 3)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().longterm_consolidation_threshold_relationship = val;
      $('#sm_longterm_threshold_relationship_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_longterm_threshold_relationship_value').text(
    s.longterm_consolidation_threshold_relationship ?? 3,
  );

  $('#sm_longterm_threshold_preference')
    .val(s.longterm_consolidation_threshold_preference ?? 3)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().longterm_consolidation_threshold_preference = val;
      $('#sm_longterm_threshold_preference_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_longterm_threshold_preference_value').text(
    s.longterm_consolidation_threshold_preference ?? 3,
  );

  $('#sm_longterm_threshold_event')
    .val(s.longterm_consolidation_threshold_event ?? 4)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().longterm_consolidation_threshold_event = val;
      $('#sm_longterm_threshold_event_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_longterm_threshold_event_value').text(s.longterm_consolidation_threshold_event ?? 4);

  $('#sm_longterm_extract_every')
    .val(s.longterm_extract_every)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().longterm_extract_every = val;
      $('#sm_longterm_extract_every_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_longterm_extract_every_value').text(s.longterm_extract_every);

  $('#sm_longterm_max_memories')
    .val(s.longterm_max_memories)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().longterm_max_memories = val;
      $('#sm_longterm_max_memories_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_longterm_max_memories_value').text(s.longterm_max_memories);

  $('#sm_longterm_template')
    .val(s.longterm_template)
    .on('input', function () {
      getSettings().longterm_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sm_longterm_position"][value="${s.longterm_position}"]`).prop('checked', true);
  $('input[name="sm_longterm_position"]').on('change', function () {
    getSettings().longterm_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_longterm_depth')
    .val(s.longterm_depth)
    .on('input', function () {
      getSettings().longterm_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_longterm_role')
    .val(s.longterm_role)
    .on('change', function () {
      getSettings().longterm_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_longterm_inject_budget_value').text(s.longterm_inject_budget ?? 500);
  $('#sm_longterm_inject_budget')
    .val(s.longterm_inject_budget ?? 500)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      getSettings().longterm_inject_budget = v;
      $('#sm_longterm_inject_budget_value').text(v);
      saveSettingsDebounced();
    });

  $('#sm_fresh_start').on('change', async function () {
    const val = $(this).prop('checked');
    await setFreshStart(val);
    await injectMemories(getSelectedCharacterName(), val);
  });

  $('#sm_extract_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (extractionRunning || consolidationRunning) return;
    const characterName = getSelectedCharacterName();
    if (!characterName) return;
    extractionRunning = true;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting memories...');
    try {
      const context = getContext();
      const recentMessages = getStableExtractionWindowWithFallback(context.chat, 20);
      const count = await extractAndStoreMemories(characterName, recentMessages);
      saveSettingsDebounced();
      updateLongTermUI(characterName);
      setStatusMessage(
        count > 0
          ? `${count} new memor${count === 1 ? 'y' : 'ies'} saved.`
          : 'No new memories found.',
      );
    } catch (err) {
      showError('Memory extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
      extractionRunning = false;
    }
  });

  $('#sm_clear_memories').on('click', function () {
    if (isCatchUpRunning()) return;
    const characterName = getSelectedCharacterName();
    if (!characterName) return;
    if (!confirm(`Clear all memories for "${characterName}"?`)) return;
    clearCharacterMemories(characterName);
    clearCanon(characterName);
    saveSettingsDebounced();
    updateLongTermUI(characterName);
    injectMemories(null, true).catch(console.error);
    setStatusMessage('Memories cleared.');
  });

  // ---- Session memory -------------------------------------------------
  $('#sm_session_enabled')
    .prop('checked', s.session_enabled)
    .on('change', function () {
      getSettings().session_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectSessionMemories();
    });

  $('#sm_session_consolidation_threshold')
    .val(s.session_consolidation_threshold ?? 3)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().session_consolidation_threshold = val;
      $('#sm_session_consolidation_threshold_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_session_consolidation_threshold_value').text(s.session_consolidation_threshold ?? 3);

  $('#sm_session_extract_every')
    .val(s.session_extract_every)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().session_extract_every = val;
      $('#sm_session_extract_every_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_session_extract_every_value').text(s.session_extract_every);

  $('#sm_session_max_memories')
    .val(s.session_max_memories)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().session_max_memories = val;
      $('#sm_session_max_memories_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_session_max_memories_value').text(s.session_max_memories);

  $('#sm_session_template')
    .val(s.session_template)
    .on('input', function () {
      getSettings().session_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sm_session_position"][value="${s.session_position}"]`).prop('checked', true);
  $('input[name="sm_session_position"]').on('change', function () {
    getSettings().session_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_session_depth')
    .val(s.session_depth)
    .on('input', function () {
      getSettings().session_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_session_role')
    .val(s.session_role)
    .on('change', function () {
      getSettings().session_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_session_inject_budget_value').text(s.session_inject_budget ?? 400);
  $('#sm_session_inject_budget')
    .val(s.session_inject_budget ?? 400)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      getSettings().session_inject_budget = v;
      $('#sm_session_inject_budget_value').text(v);
      saveSettingsDebounced();
    });

  $('#sm_extract_session_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting session memories...');
    try {
      const context = getContext();
      const recentMessages = getStableExtractionWindowWithFallback(context.chat, 40);
      const count = await extractSessionMemories(recentMessages);
      await injectSessionMemories();
      updateSessionUI();
      updateTokenDisplay();
      setStatusMessage(
        count > 0
          ? `${count} session item${count === 1 ? '' : 's'} saved.`
          : 'No new session items found.',
      );
    } catch (err) {
      showError('Session extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sm_clear_session').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (!confirm('Clear all session memories for this chat?')) return;
    await clearSessionMemories();
    await clearSessionEntityRegistry();
    injectSessionMemories();
    updateSessionUI();
    setStatusMessage('Session memories cleared.');
  });

  // ---- Scene detection ------------------------------------------------
  $('#sm_scene_enabled')
    .prop('checked', s.scene_enabled)
    .on('change', function () {
      getSettings().scene_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectSceneHistory();
    });

  $('#sm_scene_ai_detect')
    .prop('checked', s.scene_ai_detect)
    .on('change', function () {
      getSettings().scene_ai_detect = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_scene_max_history')
    .val(s.scene_max_history)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().scene_max_history = val;
      $('#sm_scene_max_history_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_scene_max_history_value').text(s.scene_max_history);

  $(`input[name="sm_scene_position"][value="${s.scene_position}"]`).prop('checked', true);
  $('input[name="sm_scene_position"]').on('change', function () {
    getSettings().scene_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_scene_depth')
    .val(s.scene_depth)
    .on('input', function () {
      getSettings().scene_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_scene_role')
    .val(s.scene_role)
    .on('change', function () {
      getSettings().scene_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_scene_inject_budget_value').text(s.scene_inject_budget ?? 300);
  $('#sm_scene_inject_budget')
    .val(s.scene_inject_budget ?? 300)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      getSettings().scene_inject_budget = v;
      $('#sm_scene_inject_budget_value').text(v);
      saveSettingsDebounced();
    });

  $('#sm_extract_scenes_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Summarizing current scene...');
    try {
      const context = getContext();
      // Use buffered messages since last break if available, else fall back to
      // the last 40 messages - capped to avoid overflowing the model context.
      const messages = sceneMessageBuffer.length > 0 ? sceneMessageBuffer : context.chat.slice(-40);
      const summary = await summarizeScene(messages);
      if (summary) {
        const history = loadSceneHistory();
        const max = getSettings().scene_max_history ?? 5;
        history.push({ summary, ts: Date.now() });
        if (history.length > max) history.splice(0, history.length - max);
        await saveSceneHistory(history);
        // Reset the buffer - we just archived what was in it.
        sceneMessageBuffer = [];
        sceneBufferLastIndex = -1;
        injectSceneHistory();
        updateScenesUI();
        updateTokenDisplay();
        setStatusMessage('Scene added to history.');
      } else {
        setStatusMessage('Scene summary failed.');
      }
    } catch (err) {
      showError('Scene extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sm_clear_scenes').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (!confirm('Clear all scene history for this chat?')) return;
    await clearSceneHistory();
    injectSceneHistory();
    updateScenesUI();
    setStatusMessage('Scene history cleared.');
  });

  // ---- Story arcs -----------------------------------------------------
  $('#sm_arcs_enabled')
    .prop('checked', s.arcs_enabled)
    .on('change', function () {
      getSettings().arcs_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectArcs();
    });

  $('#sm_arcs_max')
    .val(s.arcs_max)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().arcs_max = val;
      $('#sm_arcs_max_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_arcs_max_value').text(s.arcs_max);

  $(`input[name="sm_arcs_position"][value="${s.arcs_position}"]`).prop('checked', true);
  $('input[name="sm_arcs_position"]').on('change', function () {
    getSettings().arcs_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_arcs_depth')
    .val(s.arcs_depth)
    .on('input', function () {
      getSettings().arcs_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_arcs_role')
    .val(s.arcs_role)
    .on('change', function () {
      getSettings().arcs_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_arcs_inject_budget_value').text(s.arcs_inject_budget ?? 200);
  $('#sm_arcs_inject_budget')
    .val(s.arcs_inject_budget ?? 200)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      getSettings().arcs_inject_budget = v;
      $('#sm_arcs_inject_budget_value').text(v);
      saveSettingsDebounced();
    });

  $('#sm_extract_arcs_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting story arcs...');
    try {
      const context = getContext();
      const recentMessages = getStableExtractionWindowWithFallback(context.chat, 100);
      const count = await extractArcs(recentMessages);
      injectArcs();
      updateArcsUI();
      setStatusMessage(
        count > 0 ? `${count} arc${count === 1 ? '' : 's'} found.` : 'No new arcs found.',
      );
    } catch (err) {
      showError('Arc extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sm_clear_arcs').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (!confirm('Clear all story arcs for this chat?')) return;
    await clearArcs();
    injectArcs();
    updateArcsUI();
    setStatusMessage('Arcs cleared.');
  });

  // ---- Away recap -----------------------------------------------------
  $('#sm_recap_enabled')
    .prop('checked', s.recap_enabled)
    .on('change', function () {
      getSettings().recap_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_recap_threshold')
    .val(s.recap_threshold_hours)
    .on('input', function () {
      const val = parseFloat($(this).val());
      getSettings().recap_threshold_hours = val;
      $('#sm_recap_threshold_value').text(val + 'h');
      saveSettingsDebounced();
    });
  $('#sm_recap_threshold_value').text(s.recap_threshold_hours + 'h');

  $('#sm_recap_now').on('click', async function () {
    $(this).prop('disabled', true);
    setStatusMessage('Generating recap...');
    try {
      const recap = await generateRecap();
      if (recap) {
        displayRecap(recap);
        setStatusMessage('Recap displayed.');
      } else {
        setStatusMessage('Recap failed.');
      }
    } catch (err) {
      showError('Recap generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  // ---- Catch Up -------------------------------------------------------

  // Maximum messages per catch-up chunk. Acts as a hard cap even when messages
  // are very short, so the model always has some turn-by-turn structure to work with.
  const CATCH_UP_CHUNK_SIZE = 20;

  // Token budget for chat content per catch-up chunk is computed dynamically
  // from the configured context size at the time catch-up runs - see below.

  $('#sm_catch_up').on('click', async function () {
    if (extractionRunning || compactionRunning) {
      toastr.warning('An extraction is already running.', 'Smart Memory', { timeOut: 3000 });
      return;
    }
    const characterName = getSelectedCharacterName();
    if (!characterName) {
      toastr.warning('No character is active.', 'Smart Memory', { timeOut: 3000 });
      return;
    }

    // In group chats, build the full list of active member names so long-term
    // extraction runs for every character, not just the one in the selector.
    // Solo chats collapse to a single-element array using the active character.
    const catchUpContext = getContext();
    const catchUpCharacterNames = (() => {
      if (!catchUpContext.groupId) return [characterName];
      const group = catchUpContext.groups?.find((g) => g.id === catchUpContext.groupId);
      if (!group) return [characterName];
      return group.members
        .filter((avatar) => !(group.disabled_members ?? []).includes(avatar))
        .map((avatar) => catchUpContext.characters.find((c) => c.avatar === avatar)?.name)
        .filter(Boolean);
    })();

    // Warn if memories already exist for any character in the list.
    const existingMemories = catchUpCharacterNames.some(
      (name) => loadCharacterMemories(name).length > 0,
    );
    if (existingMemories) {
      if (
        !confirm(
          'Memories already exist for one or more characters. Running Memorize Chat again may add near-duplicate entries on top of existing ones.\n\nContinue?',
        )
      )
        return;
    }

    // The catch-up loop holds extractionRunning=true for its entire duration.
    // This blocks the background extraction path in onCharacterMessageRendered
    // from running concurrently, so consolidationRunning does not need a
    // separate check here - no other path can interleave with catch-up while
    // extractionRunning is set.
    extractionRunning = true;
    compactionRunning = true;
    catchUpCancelled = false;
    $('#sm_catch_up').hide();
    $('#sm_cancel_catch_up').show().prop('disabled', false);

    try {
      const context = getContext();
      const settings = getSettings();

      // Use the stable window first so an in-progress trailing swipe candidate
      // is not ingested during catch-up.
      const stableChat = getStableExtractionWindowWithFallback(context.chat, context.chat.length);

      // Filter to real messages only so system/hidden entries don't inflate
      // the chunk count or confuse the model.
      const allMessages = stableChat.filter((m) => m.mes && !m.is_system);
      const total = allMessages.length;

      // Process the chat in token-limited chunks sequentially. Each extraction
      // function loads its existing results and passes them as context to the
      // model, so each chunk naturally builds on what the previous one found.
      // Budget = 35% of the configured context size, leaving the remainder for
      // prompt overhead (instructions, existing memories) and the model response.
      const catchUpTokenBudget = Math.max(500, Math.floor(getMaxContextSize(0) * 0.35));
      let i = 0;
      while (i < total) {
        if (catchUpCancelled) break;

        // Yield to the browser event loop at the start of each chunk so the
        // UI remains responsive and the cancel button stays clickable even
        // when individual model calls complete quickly (e.g. cached responses).
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Build the chunk by accumulating messages until the token budget or
        // the message cap is reached. Always include at least one message so
        // a single very long message does not stall the loop forever.
        const chunk = [];
        let chunkTokens = 0;
        for (let j = i; j < total && chunk.length < CATCH_UP_CHUNK_SIZE; j++) {
          const msg = allMessages[j];
          const msgTokens = estimateTokens(`${msg.name}: ${msg.mes}`);
          if (chunk.length > 0 && chunkTokens + msgTokens > catchUpTokenBudget) break;
          chunk.push(msg);
          chunkTokens += msgTokens;
        }
        const processed = Math.min(i + chunk.length, total);
        const pct = Math.round((processed / total) * 100);
        setStatusMessage(
          `Catching up... (${i}/${total} messages, ${Math.round((i / total) * 100)}%)`,
        );

        if (settings.longterm_enabled) {
          for (const name of catchUpCharacterNames) {
            // Filter chunk to this character's messages + user messages, matching
            // the Phase 2 per-character window filtering used in automatic extraction.
            const nameChunk = catchUpContext.groupId
              ? chunk.filter((m) => m.is_user || m.name === name)
              : chunk;
            if (nameChunk.length === 0) continue;
            setStatusMessage(
              `Catching up... (${i}/${total} messages - extracting long-term for ${name})`,
            );
            await extractAndStoreMemories(name, nameChunk).catch((err) => {
              console.error('[SmartMemory] Catch-up long-term extraction error (chunk):', err);
            });
            // Consolidate after each chunk so near-duplicates are collapsed before
            // the next chunk can add more similar entries.
            if (settings.longterm_consolidate) {
              setStatusMessage(`Catching up... (${i}/${total} messages - consolidating ${name})`);
              await consolidateMemories(name).catch((err) => {
                console.error('[SmartMemory] Catch-up long-term consolidation error (chunk):', err);
              });
            }
          }
        }
        if (settings.session_enabled) {
          setStatusMessage(`Catching up... (${i}/${total} messages - extracting session)`);
          await extractSessionMemories(chunk).catch((err) => {
            console.error('[SmartMemory] Catch-up session extraction error (chunk):', err);
          });
          setStatusMessage(`Catching up... (${i}/${total} messages - consolidating session)`);
          await consolidateSessionMemories().catch((err) => {
            console.error('[SmartMemory] Catch-up session consolidation error (chunk):', err);
          });
        }
        if (settings.arcs_enabled) {
          setStatusMessage(`Catching up... (${i}/${total} messages - extracting arcs)`);
          await extractArcs(chunk).catch((err) => {
            console.error('[SmartMemory] Catch-up arc extraction error (chunk):', err);
          });
        }

        // Re-inject after each chunk so the token display reflects what is
        // actually stored, not just what was injected before catch-up started.
        if (settings.longterm_enabled && characterName) {
          await injectMemories(characterName, isFreshStart());
        }
        if (settings.session_enabled) {
          await injectSessionMemories();
        }
        if (settings.arcs_enabled) {
          injectArcs();
        }

        // Update progress and token display after each chunk so the user can
        // see memories accumulating in real time rather than only at the end.
        setStatusMessage(`Catching up... (${processed}/${total} messages, ${pct}%)`);
        updateTokenDisplay();

        i += chunk.length;
      }

      if (!catchUpCancelled) {
        // Scene: walk through the full chat using heuristic break detection,
        // summarizing each detected scene. AI detection is skipped here - it
        // would cost one model call per message across potentially hundreds of
        // messages. The heuristic is free and good enough for bulk processing.
        if (settings.scene_enabled) {
          setStatusMessage('Detecting and summarizing scenes...');
          const sceneHistory = loadSceneHistory();
          const max = settings.scene_max_history ?? 5;
          let sceneBuffer = [];

          for (const msg of allMessages) {
            if (catchUpCancelled) break;
            sceneBuffer.push(msg);

            const msgText = msg.mes ?? '';
            if (detectSceneBreakHeuristic(msgText) && sceneBuffer.length > 1) {
              const sceneSummary = await summarizeScene(sceneBuffer).catch((err) => {
                console.error('[SmartMemory] Catch-up scene summary failed:', err);
                return null;
              });
              if (sceneSummary) {
                sceneHistory.push({ summary: sceneSummary, ts: Date.now() });
                if (sceneHistory.length > max) sceneHistory.splice(0, sceneHistory.length - max);
              }
              sceneBuffer = [];
            }
          }

          // Summarize any remaining messages after the last break as the current scene.
          if (!catchUpCancelled && sceneBuffer.length > 1) {
            const sceneSummary = await summarizeScene(sceneBuffer).catch((err) => {
              console.error('[SmartMemory] Catch-up final scene summary failed:', err);
              return null;
            });
            if (sceneSummary) {
              sceneHistory.push({ summary: sceneSummary, ts: Date.now() });
              if (sceneHistory.length > max) sceneHistory.splice(0, sceneHistory.length - max);
            }
          }

          await saveSceneHistory(sceneHistory).catch((err) => {
            console.error('[SmartMemory] Catch-up scene history save failed:', err);
          });
          sceneMessageBuffer = [];
          sceneBufferLastIndex = -1;
          updateTokenDisplay();
        }

        // Final consolidation pass for any entries that didn't accumulate enough
        // to hit the per-chunk threshold (e.g. a type that only got 1-2 new entries
        // across the whole chat). Forces consolidation regardless of threshold.
        if (settings.longterm_enabled && settings.longterm_consolidate) {
          for (const name of catchUpCharacterNames) {
            setStatusMessage(`Consolidating long-term memories for ${name}...`);
            await consolidateMemories(name, true).catch((err) => {
              console.error('[SmartMemory] Catch-up final consolidation failed:', err);
            });
          }
          updateTokenDisplay();
        }
        if (settings.session_enabled) {
          setStatusMessage('Consolidating session memories...');
          await consolidateSessionMemories(true).catch((err) => {
            console.error('[SmartMemory] Catch-up final session consolidation failed:', err);
          });
          updateTokenDisplay();
        }

        // Short-term compaction runs once at the end - it uses the real token
        // count to decide what to include, so chunking doesn't apply.
        if (settings.compaction_enabled) {
          setStatusMessage('Generating summary...');
          await runCompaction()
            .then((summary) => {
              if (summary) {
                injectSummary(summary);
                updateShortTermUI(summary);
              }
            })
            .catch((err) => {
              console.error('[SmartMemory] Catch-up compaction failed:', err);
            });
          updateTokenDisplay();
        }
      }

      // Generate character & world profiles once at the end of a completed run.
      // Skipped on cancel - partial data may produce low-quality profiles.
      if (!catchUpCancelled && settings.profiles_enabled) {
        for (const name of catchUpCharacterNames) {
          setStatusMessage(`Generating character & world profiles for ${name}...`);
          const profiles = await generateProfiles(name).catch((err) => {
            console.error('[SmartMemory] Catch-up profile generation failed:', err);
            return null;
          });
          // Update UI with the selected character's profiles - other characters'
          // profiles are stored but only the active character is displayed.
          if (profiles && name === characterName) {
            injectProfiles(name);
            updateProfilesUI(profiles);
          }
        }
        // If the selected character wasn't in the group (edge case), inject
        // whatever profiles exist for them anyway.
        if (!catchUpCharacterNames.includes(characterName)) {
          injectProfiles(characterName);
        }
      }

      // Re-inject and refresh UI for everything processed so far, whether the
      // run completed or was cancelled partway through.
      await injectMemories(characterName, isFreshStart());
      injectSessionMemories();
      injectSceneHistory();
      injectArcs();
      injectProfiles(characterName);
      updateLongTermUI(characterName);
      updateSessionUI();
      updateScenesUI();
      updateArcsUI();
      updateProfilesUI(loadProfiles(characterName));
      updateEntityPanel(characterName);
      updateTokenDisplay();
      saveSettingsDebounced();

      if (catchUpCancelled) {
        setStatusMessage('Catch-up cancelled.');
        toastr.warning('Catch-up cancelled. Partial results have been saved.', 'Smart Memory', {
          timeOut: 5000,
          positionClass: 'toast-bottom-right',
        });
      } else {
        setStatusMessage('Catch-up complete.');
        toastr.success('Full catch-up extraction finished.', 'Smart Memory', {
          timeOut: 4000,
          positionClass: 'toast-bottom-right',
        });
      }
    } catch (err) {
      showError('Catch-up', err);
      setStatusMessage('Catch-up failed.');
    } finally {
      $('#sm_cancel_catch_up').hide();
      $('#sm_catch_up').show();
      extractionRunning = false;
      compactionRunning = false;
      catchUpCancelled = false;
    }
  });

  $('#sm_cancel_catch_up').on('click', function () {
    catchUpCancelled = true;
    $(this).prop('disabled', true);
    setStatusMessage('Cancelling...');
  });

  // ---- Clear Chat Context ---------------------------------------------
  $('#sm_clear_chat_context').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (
      !confirm(
        'Clear all Smart Memory context for this chat?\n\nThis will erase the summary, session memories, scene history, and story arcs. Long-term memories are not affected.',
      )
    )
      return;

    const characterName = getSelectedCharacterName();
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    // Wipe short-term summary state.
    delete context.chatMetadata[META_KEY].summary;
    delete context.chatMetadata[META_KEY].summaryEnd;
    delete context.chatMetadata[META_KEY].summaryUpdated;

    // Clear the other chat-scoped tiers.
    await clearSessionMemories();
    await clearSessionEntityRegistry();
    await clearSceneHistory();
    await clearArcs();
    await clearArcSummaries();
    await clearProfiles();
    await context.saveMetadata();

    // Clearing chatMetadata means loadAndInjectSummary will clear the slot.
    loadAndInjectSummary();
    injectSessionMemories();
    injectSceneHistory();
    injectArcs();
    injectProfiles(characterName);

    updateShortTermUI(null);
    updateSessionUI();
    updateScenesUI();
    updateArcsUI();
    updateProfilesUI(null);
    updateEntityPanel(characterName);
    updateTokenDisplay();
    sceneMessageBuffer = [];
    sceneBufferLastIndex = -1;
    setStatusMessage('Chat context cleared.');
  });

  // ---- Fresh Start ----------------------------------------------------
  $('#sm_fresh_start_button').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = getSelectedCharacterName();
    const nameLabel = characterName ? `"${characterName}"` : 'this character';
    if (
      !confirm(
        `Fresh Start - this will permanently delete all long-term memories for ${nameLabel} and clear all Smart Memory context for this chat.\n\nThis cannot be undone. Continue?`,
      )
    )
      return;

    // Clear long-term memories and canon for the character.
    if (characterName) {
      clearCharacterMemories(characterName);
      clearCanon(characterName);
      saveSettingsDebounced();
    }

    // Clear all chat-scoped tiers.
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    delete context.chatMetadata[META_KEY].summary;
    delete context.chatMetadata[META_KEY].summaryEnd;
    delete context.chatMetadata[META_KEY].summaryUpdated;

    await clearSessionMemories();
    await clearSessionEntityRegistry();
    await clearSceneHistory();
    await clearArcs();
    await clearArcSummaries();
    await clearProfiles(characterName);
    // Dismiss any open recap modal.
    $('#sm_recap_overlay').remove();

    await context.saveMetadata();

    // Clear all injection slots.
    loadAndInjectSummary();
    await injectMemories(characterName, isFreshStart());
    injectSessionMemories();
    injectSceneHistory();
    injectArcs();
    injectProfiles(characterName);

    updateShortTermUI(null);
    updateLongTermUI(characterName);
    updateFreshStartUI(isFreshStart());
    updateSessionUI();
    updateScenesUI();
    updateArcsUI();
    updateProfilesUI(null);
    updateTokenDisplay();
    sceneMessageBuffer = [];
    sceneBufferLastIndex = -1;
    setStatusMessage('Fresh start complete.');
    toastr.success(`All memories cleared for ${nameLabel}.`, 'Smart Memory', {
      timeOut: 4000,
      positionClass: 'toast-bottom-right',
    });
  });

  // ---- Embedding deduplication ----------------------------------------
  $('#sm_embedding_enabled')
    .prop('checked', s.embedding_enabled)
    .on('change', function () {
      getSettings().embedding_enabled = $(this).prop('checked');
      $('#sm_embedding_config').toggle(getSettings().embedding_enabled);
      saveSettingsDebounced();
    });
  $('#sm_embedding_config').toggle(s.embedding_enabled);

  $('#sm_embedding_url')
    .val(s.embedding_url ?? '')
    .on('input', function () {
      getSettings().embedding_url = $(this).val().trim();
      saveSettingsDebounced();
    });

  $('#sm_embedding_model')
    .val(s.embedding_model ?? 'nomic-embed-text')
    .on('input', function () {
      getSettings().embedding_model = $(this).val().trim();
      saveSettingsDebounced();
    });

  $('#sm_embedding_keep')
    .prop('checked', s.embedding_keep)
    .on('change', function () {
      getSettings().embedding_keep = $(this).prop('checked');
      saveSettingsDebounced();
    });

  // ---- Profiles -------------------------------------------------------
  $('#sm_profiles_enabled')
    .prop('checked', s.profiles_enabled)
    .on('change', function () {
      getSettings().profiles_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!getSettings().profiles_enabled) {
        setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
        updateTokenDisplay();
      } else {
        injectProfiles(getSelectedCharacterName());
      }
    });

  const $profilesThresholdVal = $('#sm_profiles_stale_threshold_value');
  const formatProfilesThreshold = (v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`);
  $profilesThresholdVal.text(formatProfilesThreshold(s.profiles_stale_threshold_minutes ?? 30));
  $('#sm_profiles_stale_threshold')
    .val(s.profiles_stale_threshold_minutes ?? 30)
    .on('input', function () {
      const v = Number($(this).val());
      $profilesThresholdVal.text(formatProfilesThreshold(v));
      getSettings().profiles_stale_threshold_minutes = v;
      saveSettingsDebounced();
    });

  const $regenEveryVal = $('#sm_profiles_regen_every_value');
  const formatRegenEvery = (v) => (v === 0 ? 'extraction only' : `${v} msg${v === 1 ? '' : 's'}`);
  $regenEveryVal.text(formatRegenEvery(s.profiles_regen_every ?? 0));
  $('#sm_profiles_regen_every')
    .val(s.profiles_regen_every ?? 0)
    .on('input', function () {
      const v = Number($(this).val());
      $regenEveryVal.text(formatRegenEvery(v));
      getSettings().profiles_regen_every = v;
      saveSettingsDebounced();
    });

  $('#sm_profiles_regenerate').on('click', async function () {
    const characterName = getSelectedCharacterName();
    if (!characterName) {
      toastr.warning('No active character - profiles need a character.', 'Smart Memory', {
        timeOut: 3000,
        positionClass: 'toast-bottom-right',
      });
      return;
    }
    $(this).prop('disabled', true);
    setStatusMessage('Generating profiles...');
    try {
      const profiles = await generateProfiles(characterName);
      if (profiles) {
        injectProfiles(characterName);
        updateProfilesUI(profiles);
        setStatusMessage('Profiles updated.');
      } else {
        setStatusMessage('Profile generation returned no output.');
      }
    } catch (err) {
      showError('Profile generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  const $profilesBudgetVal = $('#sm_profiles_inject_budget_value');
  $('#sm_profiles_inject_budget')
    .val(s.profiles_inject_budget ?? 400)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      getSettings().profiles_inject_budget = val;
      $profilesBudgetVal.text(val + ' tokens');
      saveSettingsDebounced();
      injectProfiles(getSelectedCharacterName());
    });
  $profilesBudgetVal.text((s.profiles_inject_budget ?? 400) + ' tokens');

  const currentProfilesPosition = s.profiles_position ?? extension_prompt_types.IN_PROMPT;
  $(`input[name="sm_profiles_position"][value="${currentProfilesPosition}"]`).prop('checked', true);
  $('input[name="sm_profiles_position"]').on('change', function () {
    getSettings().profiles_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
    injectProfiles(getSelectedCharacterName());
  });

  $('#sm_profiles_depth')
    .val(s.profiles_depth ?? 1)
    .on('input', function () {
      getSettings().profiles_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
      injectProfiles(getSelectedCharacterName());
    });

  $('#sm_profiles_role')
    .val(s.profiles_role ?? extension_prompt_roles.SYSTEM)
    .on('change', function () {
      getSettings().profiles_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
      injectProfiles(getSelectedCharacterName());
    });

  updateProfilesUI(loadProfiles(getSelectedCharacterName()));

  // ---- Continuity checker ---------------------------------------------
  $('#sm_auto_check')
    .prop('checked', s.continuity_auto_check)
    .on('change', function () {
      getSettings().continuity_auto_check = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_auto_repair')
    .prop('checked', s.continuity_auto_repair)
    .on('change', function () {
      getSettings().continuity_auto_repair = $(this).prop('checked');
      saveSettingsDebounced();
    });

  // ---- Developer / debug ----------------------------------------------
  $('#sm_verbose_logging')
    .prop('checked', s.verbose_logging)
    .on('change', function () {
      getSettings().verbose_logging = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_check_continuity').on('click', async function () {
    const characterName = getSelectedCharacterName();
    $(this).prop('disabled', true);
    setStatusMessage('Checking continuity...');
    $('#sm_continuity_result').hide().empty();
    try {
      const contradictions = await checkContinuity(characterName);
      if (contradictions.length === 0) {
        $('#sm_continuity_result')
          .addClass('sm_continuity_clean')
          .removeClass('sm_continuity_warn')
          .text('No contradictions found.')
          .show();
        setStatusMessage('Continuity OK.');
      } else {
        const $result = $('#sm_continuity_result')
          .addClass('sm_continuity_warn')
          .removeClass('sm_continuity_clean');
        $result.empty();
        $result.append('<b>Contradictions found:</b>');
        const $ul = $('<ul>');
        contradictions.forEach((c) => $ul.append($('<li>').text(c)));
        $result.append($ul).show();
        setStatusMessage(
          `${contradictions.length} contradiction${contradictions.length === 1 ? '' : 's'} found.`,
        );

        // If auto-repair is on, generate a corrective note and inject it for
        // the next AI turn. The note is cleared automatically once that response
        // is rendered by onCharacterMessageRendered.
        if (getSettings().continuity_auto_repair) {
          setStatusMessage('Generating repair...');
          try {
            const note = await generateRepair(contradictions, characterName);
            injectRepair(note);
            $result.append(
              $('<p class="sm_repair_queued">').text('Correction queued for next response.'),
            );
            setStatusMessage('Correction queued.');
          } catch (repairErr) {
            console.error('[SmartMemory] Repair generation failed:', repairErr);
            setStatusMessage('Repair failed - see console.');
          }
        }
      }
    } catch (err) {
      showError('Continuity check', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });
}

// ---- Init ---------------------------------------------------------------

jQuery(async function () {
  loadSettings();

  const html = await renderExtensionTemplateAsync('third-party/Smart-Memory', 'settings', {
    defaultSettings,
  });
  $('#extensions_settings').append(html);

  bindSettingsUI();
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
          await extractAndStoreMemories(characterName, recentLongTerm);
          await extractSessionMemories(recentSession);
          await extractArcs(recentArcs);
          await injectMemories(characterName, isFreshStart());
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
      unnamedArgumentList: [new SlashCommandArgument('search query', [ARGUMENT_TYPE.STRING], true)],
      helpString:
        'Searches long-term and session memories by semantic similarity. Displays top matching memories with type and tier labels. Optional: k sets result count (default 10, max 50); min sets the minimum similarity threshold to filter weak matches (default 0.5, range 0-1).',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  smLog('[SmartMemory] Loaded.');
});
