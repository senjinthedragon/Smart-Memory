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
  MEMORY_TYPES,
  SESSION_TYPES,
} from './constants.js';
import { memory_sources, fetchOllamaModels, abortCurrentMemoryGeneration } from './generate.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE } from '../../../slash-commands/SlashCommandArgument.js';

import { shouldCompact, runCompaction, injectSummary, loadAndInjectSummary } from './compaction.js';
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
} from './scenes.js';
import { extractArcs, injectArcs, loadArcs, saveArcs, clearArcs, deleteArc } from './arcs.js';
import { checkContinuity } from './continuity.js';
import { clearEmbeddingCache } from './embeddings.js';

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
  arcs_inject_budget: 400,
  arcs_position: extension_prompt_types.IN_CHAT,
  arcs_depth: 2,
  arcs_role: extension_prompt_roles.SYSTEM,

  // Away recap
  recap_enabled: true,
  recap_threshold_hours: 4,
  recap_response_length: 300,

  // Continuity
  continuity_response_length: 300,

  // Semantic embedding deduplication
  embedding_enabled: true,
  embedding_url: '',
  embedding_model: 'nomic-embed-text',
  embedding_keep: false,

  // Per-character memory storage (populated at runtime by longterm.js)
  characters: {},
};

// ---- Module-level state -------------------------------------------------

// Guards prevent re-entrant model calls if ST fires events faster than
// the previous async job completes.
let messagesSinceLastExtraction = 0;
let compactionRunning = false;
let extractionRunning = false;
let consolidationRunning = false;

// Set to true by the Cancel button to abort an in-progress catch-up loop.
let catchUpCancelled = false;

// Tracks the last group ID for which the group chat warning was shown.
// Stored as the actual groupId rather than a plain boolean so switching
// between two different group chats shows the toast once per group, while
// switching back to a group that was already warned stays silent.
let lastWarnedGroupId = null;

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

  // Group chats are not yet supported - character name resolution is unreliable
  // in that context and memories could be attributed to the wrong character.
  if (context.groupId) {
    if (lastWarnedGroupId !== context.groupId) {
      lastWarnedGroupId = context.groupId;
      toastr.warning(
        'Smart Memory is not active in group chats. 1:1 chats only for now.',
        'Smart Memory',
        { timeOut: 6000, positionClass: 'toast-bottom-right' },
      );
    }
    return;
  }

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
  const sceneCheckText = [lastUserMsgText, lastMsgText].filter(Boolean).join('\n');
  if (settings.scene_enabled && sceneCheckText) {
    try {
      const wasBreak = await processSceneBreak(sceneCheckText, sceneMessageBuffer);
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
      try {
        let total = 0;

        if (settings.session_enabled && sessionWindow.length > 0) {
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
          injectMemories(characterName, isFreshStart(), true);
          updateLongTermUI(characterName);
          saveSettingsDebounced();
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

        updateTokenDisplay();
        setStatusMessage(total > 0 ? `${total} item${total === 1 ? '' : 's'} stored.` : '');
      } catch (err) {
        console.error('[SmartMemory] Extraction error:', err);
        setStatusMessage('');
      } finally {
        extractionRunning = false;
      }
    }
  }

  // Step 4: update lastActive so the away recap threshold stays accurate.
  updateLastActive();
}

/**
 * Fires when a chat is loaded or switched.
 * Resets all module-level state, restores stored injections, and generates
 * an away recap if the user has been gone longer than the configured threshold.
 */
async function onChatChanged() {
  messagesSinceLastExtraction = 0;
  compactionRunning = false;
  extractionRunning = false;
  sceneMessageBuffer = [];
  sceneBufferLastIndex = -1;
  lastWarnedGroupId = null;
  lastKnownChatLength = 0;
  clearEmbeddingCache();

  const settings = getSettings();
  if (!settings.enabled) return;

  // Clear any lingering injections and skip restore for group chats.
  if (getContext().groupId) {
    clearAllInjections();
    return;
  }

  const characterName = getCurrentCharacterName();
  const freshStart = isFreshStart();

  // Restore all injected context from the previous session.
  const summary = loadAndInjectSummary();
  updateShortTermUI(summary);

  injectMemories(characterName, freshStart);

  injectSessionMemories();
  injectSceneHistory();
  injectArcs();

  updateLongTermUI(characterName);
  updateFreshStartUI(freshStart);
  updateSessionUI();
  updateScenesUI();
  updateArcsUI();
  updateTokenDisplay();

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

// ---- UI helpers ---------------------------------------------------------

/**
 * Metadata for each injection tier used by the token usage display.
 * Order determines the visual stacking order in the bar chart.
 */
const TOKEN_TIERS = [
  { key: PROMPT_KEY_LONG, label: 'Long-term', color: '#4a6fa5' },
  { key: PROMPT_KEY_SESSION, label: 'Session', color: '#8e5a8e' },
  { key: PROMPT_KEY_SHORT, label: 'Short-term', color: '#5a8e5a' },
  { key: PROMPT_KEY_SCENES, label: 'Scenes', color: '#5a8e7a' },
  { key: PROMPT_KEY_ARCS, label: 'Arcs', color: '#7a6ea5' },
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

/** Re-renders the long-term memories list for the given character. */
function updateLongTermUI(characterName) {
  const memories = characterName ? loadCharacterMemories(characterName) : [];
  renderMemoriesList(memories, characterName);
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

  memories.forEach((mem, idx) => {
    const $item = $(`
            <div class="sm_memory_item" data-index="${idx}">
                <span class="sm_memory_type sm_type_${mem.type}">${mem.type}</span>
                <span class="sm_memory_text">${$('<div>').text(mem.content).html()}</span>
                <button class="sm_edit_session_memory menu_button" data-index="${idx}" title="Edit this memory">
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="sm_delete_session_memory menu_button" data-index="${idx}" title="Delete this memory">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `);
    $list.append($item);
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
  const typeOptions = SESSION_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('');
  const $addForm = $(`
    <div class="sm_add_memory_form">
      <select class="sm_add_memory_type">${typeOptions}</select>
      <input type="text" class="sm_add_memory_input" placeholder="New session memory...">
      <button class="sm_add_memory_btn menu_button" title="Add memory">Add</button>
    </div>
  `);
  $list.append($addForm);

  $addForm.find('.sm_add_memory_btn').on('click', async () => {
    const type = $addForm.find('.sm_add_memory_type').val();
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
  const $addForm = $(`
    <div class="sm_add_memory_form">
      <input type="text" class="sm_add_memory_input" placeholder="New story thread...">
      <button class="sm_add_memory_btn menu_button" title="Add arc">Add</button>
    </div>
  `);
  $list.append($addForm);

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

  memories.forEach((mem, idx) => {
    const $item = $(`
            <div class="sm_memory_item" data-index="${idx}">
                <span class="sm_memory_type sm_type_${mem.type}">${mem.type}</span>
                <span class="sm_memory_text">${$('<div>').text(mem.content).html()}</span>
                <button class="sm_edit_memory menu_button" data-index="${idx}" title="Edit this memory">
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="sm_delete_memory menu_button" data-index="${idx}" title="Delete this memory">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `);
    $list.append($item);
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
      injectMemories(characterName, isFreshStart());
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
  const typeOptions = MEMORY_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('');
  const $addForm = $(`
    <div class="sm_add_memory_form">
      <select class="sm_add_memory_type">${typeOptions}</select>
      <input type="text" class="sm_add_memory_input" placeholder="New memory...">
      <button class="sm_add_memory_btn menu_button" title="Add memory">Add</button>
    </div>
  `);
  $list.append($addForm);

  $addForm.find('.sm_add_memory_btn').on('click', () => {
    const type = $addForm.find('.sm_add_memory_type').val();
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
    injectMemories(characterName, isFreshStart());
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

  // Migration: raise arc injection budget from 200 to 400.
  // 200 tokens is too tight for 10 arcs, causing the last entry to be cut mid-sentence.
  if (extension_settings[MODULE_NAME].arcs_inject_budget === 200) {
    extension_settings[MODULE_NAME].arcs_inject_budget = 400;
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
      injectMemories(getCurrentCharacterName(), isFreshStart());
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
    injectMemories(getCurrentCharacterName(), val);
  });

  $('#sm_extract_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (extractionRunning || consolidationRunning) return;
    const characterName = getCurrentCharacterName();
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
    const characterName = getCurrentCharacterName();
    if (!characterName) return;
    if (!confirm(`Clear all memories for "${characterName}"?`)) return;
    clearCharacterMemories(characterName);
    saveSettingsDebounced();
    updateLongTermUI(characterName);
    injectMemories(null, true);
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
      injectSessionMemories();
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

  // Number of messages processed per extraction call. Large enough to give
  // the model meaningful context, small enough to stay within local model
  // context windows. Must match what users would expect for cost on paid APIs.
  const CATCH_UP_CHUNK_SIZE = 20;

  $('#sm_catch_up').on('click', async function () {
    if (extractionRunning || compactionRunning) {
      toastr.warning('An extraction is already running.', 'Smart Memory', { timeOut: 3000 });
      return;
    }
    const characterName = getCurrentCharacterName();
    if (!characterName) {
      toastr.warning('No character is active.', 'Smart Memory', { timeOut: 3000 });
      return;
    }

    // Warn if memories already exist - running catch-up again on the same chat
    // can introduce near-duplicate entries that displace lower-importance ones.
    const existingMemories = loadCharacterMemories(characterName);
    if (existingMemories.length > 0) {
      if (
        !confirm(
          'Memories already exist for this character. Running Memorize Chat again may add near-duplicate entries on top of existing ones.\n\nContinue?',
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

      // Process the chat in fixed-size chunks sequentially. Each extraction
      // function loads its existing results and passes them as context to the
      // model, so each chunk naturally builds on what the previous one found.
      for (let i = 0; i < total; i += CATCH_UP_CHUNK_SIZE) {
        if (catchUpCancelled) break;

        // Yield to the browser event loop at the start of each chunk so the
        // UI remains responsive and the cancel button stays clickable even
        // when individual model calls complete quickly (e.g. cached responses).
        await new Promise((resolve) => setTimeout(resolve, 0));

        const chunk = allMessages.slice(i, i + CATCH_UP_CHUNK_SIZE);
        const processed = Math.min(i + CATCH_UP_CHUNK_SIZE, total);
        const pct = Math.round((processed / total) * 100);
        setStatusMessage(
          `Catching up... (${i}/${total} messages, ${Math.round((i / total) * 100)}%)`,
        );

        if (settings.longterm_enabled && characterName) {
          setStatusMessage(`Catching up... (${i}/${total} messages - extracting long-term)`);
          await extractAndStoreMemories(characterName, chunk).catch((err) => {
            console.error('[SmartMemory] Catch-up long-term extraction error (chunk):', err);
          });
          // Consolidate after each chunk so near-duplicates are collapsed before
          // the next chunk can add more similar entries. Without this, a full chat
          // with many thematically similar exchanges floods the unprocessed queue
          // with variants that all slip under the per-entry Jaccard threshold.
          if (settings.longterm_consolidate) {
            setStatusMessage(`Catching up... (${i}/${total} messages - consolidating long-term)`);
            await consolidateMemories(characterName).catch((err) => {
              console.error('[SmartMemory] Catch-up long-term consolidation error (chunk):', err);
            });
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
          injectMemories(characterName, isFreshStart());
        }
        if (settings.session_enabled) {
          injectSessionMemories();
        }
        if (settings.arcs_enabled) {
          injectArcs();
        }

        // Update progress and token display after each chunk so the user can
        // see memories accumulating in real time rather than only at the end.
        setStatusMessage(`Catching up... (${processed}/${total} messages, ${pct}%)`);
        updateTokenDisplay();
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
        if (settings.longterm_enabled && settings.longterm_consolidate && characterName) {
          setStatusMessage('Consolidating long-term memories...');
          await consolidateMemories(characterName, true).catch((err) => {
            console.error('[SmartMemory] Catch-up final consolidation failed:', err);
          });
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

      // Re-inject and refresh UI for everything processed so far, whether the
      // run completed or was cancelled partway through.
      injectMemories(characterName, isFreshStart());
      injectSessionMemories();
      injectSceneHistory();
      injectArcs();
      updateLongTermUI(characterName);
      updateSessionUI();
      updateScenesUI();
      updateArcsUI();
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

    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    // Wipe short-term summary state.
    delete context.chatMetadata[META_KEY].summary;
    delete context.chatMetadata[META_KEY].summaryEnd;
    delete context.chatMetadata[META_KEY].summaryUpdated;

    // Clear the other chat-scoped tiers.
    await clearSessionMemories();
    await clearSceneHistory();
    await clearArcs();
    await context.saveMetadata();

    // Clearing chatMetadata means loadAndInjectSummary will clear the slot.
    loadAndInjectSummary();
    injectSessionMemories();
    injectSceneHistory();
    injectArcs();

    updateShortTermUI(null);
    updateSessionUI();
    updateScenesUI();
    updateArcsUI();
    updateTokenDisplay();
    sceneMessageBuffer = [];
    sceneBufferLastIndex = -1;
    setStatusMessage('Chat context cleared.');
  });

  // ---- Fresh Start ----------------------------------------------------
  $('#sm_fresh_start_button').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = getCurrentCharacterName();
    const nameLabel = characterName ? `"${characterName}"` : 'this character';
    if (
      !confirm(
        `Fresh Start - this will permanently delete all long-term memories for ${nameLabel} and clear all Smart Memory context for this chat.\n\nThis cannot be undone. Continue?`,
      )
    )
      return;

    // Clear long-term memories for the character.
    if (characterName) {
      clearCharacterMemories(characterName);
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
    await clearSceneHistory();
    await clearArcs();
    // Dismiss any open recap modal.
    $('#sm_recap_overlay').remove();

    await context.saveMetadata();

    // Clear all injection slots.
    loadAndInjectSummary();
    injectMemories(characterName, isFreshStart());
    injectSessionMemories();
    injectSceneHistory();
    injectArcs();

    updateShortTermUI(null);
    updateLongTermUI(characterName);
    updateFreshStartUI(isFreshStart());
    updateSessionUI();
    updateScenesUI();
    updateArcsUI();
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

  // ---- Continuity checker ---------------------------------------------
  $('#sm_check_continuity').on('click', async function () {
    const characterName = getCurrentCharacterName();
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
  updateTokenDisplay();

  // makeLast ensures Smart Memory processes the message after all other
  // extensions have had their turn with it.
  eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
  eventSource.on(event_types.CHAT_LOADED, onChatChanged);

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
          injectMemories(characterName, isFreshStart());
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

  console.log('[SmartMemory] Loaded.');
});
