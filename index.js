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
  PROMPT_KEY_RECAP,
} from './constants.js';
import { memory_sources } from './generate.js';
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
import { updateLastActive, getAwayHours, generateRecap, injectRecap, clearRecap } from './recap.js';
import {
  extractSessionMemories,
  injectSessionMemories,
  loadSessionMemories,
  clearSessionMemories,
} from './session.js';
import {
  processSceneBreak,
  summarizeScene,
  injectSceneHistory,
  loadSceneHistory,
  saveSceneHistory,
  clearSceneHistory,
} from './scenes.js';
import { extractArcs, injectArcs, loadArcs, clearArcs, deleteArc } from './arcs.js';
import { checkContinuity } from './continuity.js';

// ---- Default settings ---------------------------------------------------

const defaultSettings = {
  enabled: true,

  // LLM source for all memory operations (extraction, summarization, recap)
  source: memory_sources.main,

  // Short-term (compaction)
  compaction_enabled: true,
  compaction_threshold: 80,
  compaction_keep_recent: 10,
  compaction_response_length: 1500,
  compaction_position: extension_prompt_types.IN_PROMPT,
  compaction_depth: 0,
  compaction_role: extension_prompt_roles.SYSTEM,
  compaction_template: '[Story so far:\n{{summary}}]',

  // Long-term
  longterm_enabled: true,
  longterm_carry_over: true,
  longterm_consolidate: true,
  longterm_extract_every: 3,
  longterm_max_memories: 25,
  longterm_response_length: 600,
  longterm_inject_budget: 500,
  longterm_position: extension_prompt_types.IN_PROMPT,
  longterm_depth: 2,
  longterm_role: extension_prompt_roles.SYSTEM,
  longterm_template: '[Memories from previous conversations:\n{{memories}}]',

  // Session memory
  session_enabled: true,
  session_extract_every: 3,
  session_max_memories: 30,
  session_response_length: 500,
  session_inject_budget: 400,
  session_position: extension_prompt_types.IN_CHAT,
  session_depth: 3,
  session_role: extension_prompt_roles.SYSTEM,
  session_template: '[Details from this session:\n{{session}}]',

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
  arcs_inject_budget: 200,
  arcs_position: extension_prompt_types.IN_CHAT,
  arcs_depth: 2,
  arcs_role: extension_prompt_roles.SYSTEM,

  // Away recap
  recap_enabled: true,
  recap_threshold_hours: 4,
  recap_response_length: 300,
  recap_position: extension_prompt_types.IN_CHAT,
  recap_depth: 0,
  recap_role: extension_prompt_roles.SYSTEM,

  // Continuity
  continuity_response_length: 300,

  // Per-character memory storage (populated at runtime by longterm.js)
  characters: {},
};

// ---- Module-level state -------------------------------------------------

// Guards prevent re-entrant model calls if ST fires events faster than
// the previous async job completes.
let messagesSinceLastExtraction = 0;
let compactionRunning = false;
let extractionRunning = false;

// Set to true by the Cancel button to abort an in-progress catch-up loop.
let catchUpCancelled = false;

// True while a recap is injected; cleared after the first AI response.
let recapActive = false;

// Accumulates messages since the last detected scene break. Reset to []
// when a break is detected so the next scene starts from a clean buffer.
let sceneMessageBuffer = [];

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

// ---- Event handlers -----------------------------------------------------

/**
 * Fires after each AI message is rendered (registered with makeLast so Smart
 * Memory runs after all other extensions have processed the message).
 *
 * Orchestration order:
 *   1. Clear recap if one was active (it served its purpose after one response).
 *   2. Check for compaction threshold and run if needed (async, non-blocking).
 *   3. Check for scene break in the latest message (async, non-blocking).
 *   4. Every N messages: batch extraction for session + long-term + arcs.
 *   5. Update lastActive timestamp for the away recap system.
 */
async function onCharacterMessageRendered() {
  // is_send_press is true while ST is still streaming - skip to avoid
  // running on intermediate renders.
  if (is_send_press) return;

  const settings = getSettings();
  if (!settings.enabled) return;

  const context = getContext();
  if (!context.chat || context.chat.length === 0) return;

  const characterName = getCurrentCharacterName();

  const lastMsg = context.chat
    .slice()
    .reverse()
    .find((m) => !m.is_user && !m.is_system && m.mes);
  const lastMsgText = lastMsg?.mes ?? '';

  sceneMessageBuffer.push(...context.chat.slice(-1));

  // Step 1: clear the recap after the first AI response.
  if (recapActive) {
    clearRecap();
    recapActive = false;
  }

  // Step 2: compaction (runs async - does not block extraction below).
  if (settings.compaction_enabled && !compactionRunning) {
    compactionRunning = true;
    shouldCompact()
      .then(async (needed) => {
        if (needed) {
          setStatusMessage('Updating story summary...');
          const summary = await runCompaction();
          if (summary) {
            injectSummary(summary);
            updateShortTermUI(summary);
            updateTokenDisplay();
            setStatusMessage('Summary updated.');
          } else {
            setStatusMessage('');
          }
        }
        compactionRunning = false;
      })
      .catch((err) => {
        console.error('[SmartMemory] Compaction error:', err);
        compactionRunning = false;
      });
  }

  // Step 3: scene break detection (runs async - does not block extraction).
  if (settings.scene_enabled && lastMsgText) {
    processSceneBreak(lastMsgText, sceneMessageBuffer)
      .then((wasBreak) => {
        if (wasBreak) {
          injectSceneHistory();
          updateScenesUI();
          updateTokenDisplay();
          sceneMessageBuffer = [];
          setStatusMessage('Scene break detected.');
        }
      })
      .catch(() => {});
  }

  // Step 4: batched extraction every N messages.
  // extractEvery uses the smaller of the two intervals so neither tier
  // falls behind if one is configured more frequently than the other.
  if (!extractionRunning) {
    messagesSinceLastExtraction++;
    const extractEvery = Math.min(
      settings.session_extract_every ?? 3,
      settings.longterm_extract_every ?? 3,
    );

    if (messagesSinceLastExtraction >= extractEvery) {
      messagesSinceLastExtraction = 0;
      extractionRunning = true;

      const recentCount = Math.min(extractEvery * 2, context.chat.length);
      const recentMessages = context.chat.slice(-recentCount);

      setStatusMessage('Extracting memories...');

      const jobs = [];

      if (settings.session_enabled) {
        jobs.push(
          extractSessionMemories(recentMessages)
            .then((count) => {
              injectSessionMemories();
              updateSessionUI();
              return count;
            })
            .catch((err) => {
              console.error('[SmartMemory] Background session extraction error:', err);
              return 0;
            }),
        );
      }

      if (settings.longterm_enabled && characterName) {
        jobs.push(
          extractAndStoreMemories(characterName, recentMessages)
            .then(async (count) => {
              // Run consolidation after extraction if new memories were added.
              if (count > 0 && settings.longterm_consolidate) {
                const removed = await consolidateMemories(characterName).catch((err) => {
                  console.error('[SmartMemory] Background consolidation error:', err);
                  return 0;
                });
                if (removed > 0) {
                  injectMemories(characterName, isFreshStart());
                  setStatusMessage(`Consolidated ${removed} redundant memories.`);
                  toastr.info(
                    `Merged ${removed} redundant ${removed === 1 ? 'memory' : 'memories'}.`,
                    'Smart Memory',
                    { timeOut: 3000, positionClass: 'toast-bottom-right' },
                  );
                }
              }
              updateLongTermUI(characterName);
              saveSettingsDebounced();
              return count;
            })
            .catch((err) => {
              console.error('[SmartMemory] Background long-term extraction error:', err);
              return 0;
            }),
        );
      }

      if (settings.arcs_enabled) {
        // Arc extraction uses the full chat rather than just recent messages
        // so it can resolve arcs that were opened many turns ago.
        jobs.push(
          extractArcs(context.chat)
            .then((count) => {
              injectArcs();
              updateArcsUI();
              return count;
            })
            .catch((err) => {
              console.error('[SmartMemory] Background arc extraction error:', err);
              return 0;
            }),
        );
      }

      Promise.all(jobs)
        .then((counts) => {
          const total = counts.reduce((a, b) => a + b, 0);
          updateTokenDisplay();
          setStatusMessage(total > 0 ? `${total} item${total === 1 ? '' : 's'} stored.` : '');
        })
        .catch((err) => {
          console.error('[SmartMemory] Extraction error:', err);
          setStatusMessage('');
        })
        .finally(() => {
          extractionRunning = false;
        });
    }
  }

  // Step 5: update lastActive so the away recap threshold stays accurate.
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
  recapActive = false;
  sceneMessageBuffer = [];

  const settings = getSettings();
  if (!settings.enabled) return;

  const characterName = getCurrentCharacterName();
  const freshStart = isFreshStart();

  // Restore all injected context from the previous session.
  const summary = loadAndInjectSummary();
  updateShortTermUI(summary);

  if (settings.longterm_carry_over) {
    injectMemories(characterName, freshStart);
  } else {
    injectMemories(null, true);
  }

  injectSessionMemories();
  injectSceneHistory();
  injectArcs();

  updateLongTermUI(characterName);
  updateFreshStartUI(freshStart);
  updateSessionUI();
  updateScenesUI();
  updateArcsUI();
  updateTokenDisplay();

  // Generate a recap if the user has been away long enough.
  if (settings.recap_enabled) {
    const hoursAway = getAwayHours();
    if (hoursAway > 0) {
      setStatusMessage('Generating recap...');
      generateRecap()
        .then((recap) => {
          if (recap) {
            injectRecap(recap);
            recapActive = true;
            updateTokenDisplay();
            toastr.info('A recap of your last session has been added to context.', 'Smart Memory', {
              timeOut: 5000,
              positionClass: 'toast-bottom-right',
            });
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
  { key: PROMPT_KEY_RECAP, label: 'Recap', color: '#8e6e3a' },
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
    tooltip.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
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
 * Re-renders the session memory list with per-entry delete buttons.
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
                <button class="sm_delete_session_memory menu_button" data-index="${idx}" title="Delete this memory">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `);
    $list.append($item);
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

/** Re-renders the story arcs list with per-arc resolve buttons. */
function updateArcsUI() {
  const arcs = loadArcs();
  const $list = $('#sm_arcs_list');
  $list.empty();

  if (arcs.length === 0) {
    $list.append('<div class="sm_no_char">No open story threads.</div>');
    return;
  }

  arcs.forEach((arc, idx) => {
    const $item = $(`
            <div class="sm_arc_item" data-index="${idx}">
                <span class="sm_arc_text">${$('<div>').text(arc.content).html()}</span>
                <button class="sm_delete_arc menu_button" data-index="${idx}" title="Resolve / remove this arc">
                    <i class="fa-solid fa-check"></i>
                </button>
            </div>
        `);
    $list.append($item);
  });

  $list.find('.sm_delete_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    await deleteArc(idx);
    injectArcs();
    updateArcsUI();
  });
}

/**
 * Renders the long-term memories list with per-memory delete buttons.
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
                <button class="sm_delete_memory menu_button" data-index="${idx}" title="Delete this memory">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `);
    $list.append($item);
  });

  $list.find('.sm_delete_memory').on('click', function () {
    const idx = parseInt($(this).data('index'), 10);
    const current = loadCharacterMemories(characterName);
    current.splice(idx, 1);
    saveCharacterMemories(characterName, current);
    saveSettingsDebounced();
    renderMemoriesList(current, characterName);
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
    });

  // ---- LLM source -----------------------------------------------------
  $('#sm_source')
    .val(s.source ?? memory_sources.main)
    .on('change', function () {
      getSettings().source = $(this).val();
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
    if (compactionRunning) return;
    compactionRunning = true;
    setStatusMessage('Generating summary...');
    $(this).prop('disabled', true);
    try {
      const summary = await runCompaction();
      if (summary) {
        injectSummary(summary);
        updateShortTermUI(summary);
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

  $('#sm_longterm_carry_over')
    .prop('checked', s.longterm_carry_over)
    .on('change', function () {
      getSettings().longterm_carry_over = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_longterm_consolidate')
    .prop('checked', s.longterm_consolidate ?? true)
    .on('change', function () {
      getSettings().longterm_consolidate = $(this).prop('checked');
      saveSettingsDebounced();
    });

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
    if (extractionRunning) return;
    const characterName = getCurrentCharacterName();
    if (!characterName) return;
    extractionRunning = true;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting memories...');
    try {
      const context = getContext();
      const recentMessages = context.chat.slice(-20);
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
    $(this).prop('disabled', true);
    setStatusMessage('Extracting session memories...');
    try {
      const context = getContext();
      const count = await extractSessionMemories(context.chat.slice(-40));
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
    $(this).prop('disabled', true);
    setStatusMessage('Extracting story arcs...');
    try {
      const context = getContext();
      const count = await extractArcs(context.chat.slice(-100));
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

  $(`input[name="sm_recap_position"][value="${s.recap_position}"]`).prop('checked', true);
  $('input[name="sm_recap_position"]').on('change', function () {
    getSettings().recap_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_recap_depth')
    .val(s.recap_depth)
    .on('input', function () {
      getSettings().recap_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_recap_role')
    .val(s.recap_role)
    .on('change', function () {
      getSettings().recap_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_recap_now').on('click', async function () {
    $(this).prop('disabled', true);
    setStatusMessage('Generating recap...');
    try {
      const recap = await generateRecap();
      if (recap) {
        injectRecap(recap);
        recapActive = true;
        setStatusMessage('Recap injected.');
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

    extractionRunning = true;
    compactionRunning = true;
    catchUpCancelled = false;
    $('#sm_catch_up').hide();
    $('#sm_cancel_catch_up').show().prop('disabled', false);

    try {
      const context = getContext();
      const settings = getSettings();

      // Filter to real messages only so system/hidden entries don't inflate
      // the chunk count or confuse the model.
      const allMessages = context.chat.filter((m) => m.mes && !m.is_system);
      const total = allMessages.length;

      // Process the chat in fixed-size chunks sequentially. Each extraction
      // function loads its existing results and passes them as context to the
      // model, so each chunk naturally builds on what the previous one found.
      for (let i = 0; i < total; i += CATCH_UP_CHUNK_SIZE) {
        if (catchUpCancelled) break;

        const chunk = allMessages.slice(i, i + CATCH_UP_CHUNK_SIZE);
        const processed = Math.min(i + CATCH_UP_CHUNK_SIZE, total);
        const pct = Math.round((processed / total) * 100);
        setStatusMessage(`Catching up... (${processed}/${total} messages, ${pct}%)`);

        if (settings.longterm_enabled && characterName) {
          await extractAndStoreMemories(characterName, chunk);
        }
        if (settings.session_enabled) {
          await extractSessionMemories(chunk);
        }
        if (settings.arcs_enabled) {
          await extractArcs(chunk);
        }
      }

      if (!catchUpCancelled) {
        // Scene: summarize the full chat as a single scene entry rather than
        // one entry per chunk, since scene history is a coarse narrative view.
        if (settings.scene_enabled) {
          setStatusMessage('Summarizing scene history...');
          const sceneSummary = await summarizeScene(context.chat);
          if (sceneSummary) {
            const history = loadSceneHistory();
            const max = settings.scene_max_history ?? 5;
            history.push({ summary: sceneSummary, ts: Date.now() });
            if (history.length > max) history.splice(0, history.length - max);
            await saveSceneHistory(history);
            sceneMessageBuffer = [];
          }
        }

        // Consolidate after all chunks so the model sees the full merged set.
        if (settings.longterm_enabled && settings.longterm_consolidate && characterName) {
          setStatusMessage('Consolidating memories...');
          await consolidateMemories(characterName);
        }

        // Short-term compaction runs once at the end - it uses the real token
        // count to decide what to include, so chunking doesn't apply.
        if (settings.compaction_enabled) {
          setStatusMessage('Generating summary...');
          const summary = await runCompaction();
          if (summary) {
            injectSummary(summary);
            updateShortTermUI(summary);
          }
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
    if (
      !confirm(
        'Clear all Smart Memory context for this chat?\n\nThis will erase the summary, session memories, scene history, and story arcs. Long-term memories are not affected.',
      )
    )
      return;

    const context = getContext();
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
    setStatusMessage('Chat context cleared.');
  });

  // ---- Fresh Start ----------------------------------------------------
  $('#sm_fresh_start_button').on('click', async function () {
    const characterName = getCurrentCharacterName();
    const nameLabel = characterName ? `"${characterName}"` : 'this character';
    if (
      !confirm(
        `Fresh Start - this will permanently delete all long-term memories for ${nameLabel} and clear all Smart Memory context for this chat.\n\nMemory injection will also be suppressed for this chat.\n\nThis cannot be undone. Continue?`,
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
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    delete context.chatMetadata[META_KEY].summary;
    delete context.chatMetadata[META_KEY].summaryEnd;
    delete context.chatMetadata[META_KEY].summaryUpdated;

    await clearSessionMemories();
    await clearSceneHistory();
    await clearArcs();

    // Enable the fresh-start flag so long-term injection stays suppressed.
    await setFreshStart(true);
    await context.saveMetadata();

    // Clear all injection slots.
    loadAndInjectSummary();
    injectMemories(characterName, true);
    injectSessionMemories();
    injectSceneHistory();
    injectArcs();

    updateShortTermUI(null);
    updateLongTermUI(characterName);
    updateFreshStartUI(true);
    updateSessionUI();
    updateScenesUI();
    updateArcsUI();
    updateTokenDisplay();
    sceneMessageBuffer = [];
    setStatusMessage('Fresh start complete.');
    toastr.success(`All memories cleared for ${nameLabel}.`, 'Smart Memory', {
      timeOut: 4000,
      positionClass: 'toast-bottom-right',
    });
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

  onChatChanged();

  // ---- Slash commands -----------------------------------------------------

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-check',
      callback: async () => {
        const characterName = getCurrentCharacterName();
        if (!characterName) return 'No character active.';
        const contradictions = await checkContinuity(characterName);
        if (contradictions.length === 0) return 'No contradictions found.';
        return contradictions.map((c, i) => `${i + 1}. ${c}`).join('\n');
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
            return summary;
          }
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
          await extractAndStoreMemories(characterName, context.chat);
          await extractSessionMemories(context.chat);
          await extractArcs(context.chat);
          injectMemories(characterName, isFreshStart());
          injectSessionMemories();
          injectArcs();
          updateLongTermUI(characterName);
          updateArcsUI();
          setStatusMessage('Extraction complete.');
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
        if (!recap) return 'Recap generation failed.';
        injectRecap(recap);
        recapActive = true;
        setStatusMessage('Recap injected.');
        return recap;
      },
      helpString:
        'Generates a "Previously on..." recap of the current chat and injects it into context.',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  console.log('[SmartMemory] Loaded.');
});
