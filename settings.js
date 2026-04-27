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
 * Settings management: default values, settings migration, and UI binding.
 *
 * defaultSettings  - canonical default values for all extension_settings keys
 * loadSettings     - merges defaults + runs field migrations on startup
 * bindSettingsUI   - wires all settings panel controls; takes a ctrl object
 *                    with getter/setter properties for index.js state variables
 *                    so this module never imports from index.js
 */

import {
  extension_prompt_types,
  extension_prompt_roles,
  setExtensionPrompt,
  saveSettingsDebounced,
  getMaxContextSize,
} from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../scripts/popup.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  estimateTokens,
  MODULE_NAME,
  META_KEY,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_CANON,
} from './constants.js';
import { memory_sources, fetchOllamaModels } from './generate.js';
import { runCompaction, injectSummary, loadAndInjectSummary } from './compaction.js';
import {
  extractAndStoreMemories,
  consolidateMemories,
  injectMemories,
  loadCharacterMemories,
  clearCharacterMemories,
  isFreshStart,
  setFreshStart,
  getReadOnlyStartIndex,
  setReadOnlyStartIndex,
  getReadOnlyStartTime,
} from './longterm.js';
import { hideChatMessageRange } from '../../../../scripts/chats.js';
import { generateRecap, displayRecap } from './recap.js';
import {
  extractSessionMemories,
  consolidateSessionMemories,
  injectSessionMemories,
  clearSessionMemories,
  purgeSessionMemoriesSince,
} from './session.js';
import {
  summarizeScene,
  sceneSimilarity,
  injectSceneHistory,
  loadSceneHistory,
  saveSceneHistory,
  clearSceneHistory,
  detectSceneBreakHeuristic,
} from './scenes.js';
import { extractArcs, injectArcs, clearArcs, clearArcSummaries, loadArcSummaries } from './arcs.js';
import { checkContinuity, generateRepair, injectRepair } from './continuity.js';
import { getHardwareProfile, getEmbeddingBatch, clearEmbeddingFailed } from './embeddings.js';
import { clearCanon, generateCanon, injectCanon, saveCanon } from './canon.js';
import { clearSessionEntityRegistry } from './graph-migration.js';
import { generateProfiles, injectProfiles, clearProfiles, loadProfiles } from './profiles.js';
import { clearUnifiedSlot, injectUnified, maybeInjectUnified } from './unified-inject.js';
import { showMemoryGraph } from './graph.js';
import {
  setStatusMessage,
  updateLongTermUI,
  updateSessionUI,
  updateScenesUI,
  updateArcsUI,
  updateShortTermUI,
  updateCanonUI,
  updateProfilesUI,
  updateFreshStartUI,
  updateEntityPanel,
  updateTokenDisplay,
  updateEmbeddingNotice,
} from './ui.js';

// ---- Default settings ---------------------------------------------------

export const defaultSettings = {
  enabled: true,
  settings_mode: 'simple',
  extraction_frequency: 'medium',

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

  // Consolidation (shared across tiers)
  consolidation_enabled: true,
  longterm_consolidation_threshold_fact: 4,
  longterm_consolidation_threshold_relationship: 3,
  longterm_consolidation_threshold_preference: 3,
  longterm_consolidation_threshold_event: 4,
  session_consolidation_threshold_scene: 3,
  session_consolidation_threshold_revelation: 3,
  session_consolidation_threshold_development: 3,
  session_consolidation_threshold_detail: 3,

  // Long-term
  longterm_enabled: true,
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
  scene_min_messages: 3,
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
  canon_enabled: true,
  canon_inject_budget: 800,
  canon_position: extension_prompt_types.IN_PROMPT,
  canon_depth: 0,
  canon_role: extension_prompt_roles.SYSTEM,
  canon_template: 'Character history:\n{{canon}}',

  // Away recap
  recap_enabled: true,
  recap_threshold_hours: 4,
  recap_response_length: 300,

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

  // Experimental: merge all tier content into a single IN_PROMPT block instead
  // of injecting each tier into its own named slot at different depths/positions.
  unified_injection: false,

  // Per-character memory storage (populated at runtime by longterm.js)
  characters: {},
};

// ---- Settings mode helpers -----------------------------------------------

// Extraction frequency presets for the simple-mode dropdown.
const EXTRACTION_FREQUENCY_MAP = { low: 5, medium: 3, high: 1 };

// Fixed proportions for the simplified total-budget slider. Each value is a
// fraction of the total that gets allocated to that tier. Must sum to 1.0.
const BUDGET_RATIOS = {
  longterm: 0.16,
  session: 0.13,
  scenes: 0.1,
  arcs: 0.22,
  canon: 0.26,
  profiles: 0.13,
};

/**
 * Returns the sum of all per-tier inject budgets from current settings.
 * Used to initialise the simplified slider from existing advanced values.
 * @param {Object} s - Settings object.
 * @returns {number}
 */
function totalBudgetFromSettings(s) {
  return (
    (s.longterm_inject_budget ?? 500) +
    (s.session_inject_budget ?? 400) +
    (s.scene_inject_budget ?? 300) +
    (s.arcs_inject_budget ?? 700) +
    (s.canon_inject_budget ?? 800) +
    (s.profiles_inject_budget ?? 400)
  );
}

/**
 * Distributes a total token budget across tiers using BUDGET_RATIOS and
 * writes the results directly into the settings object. Rounds to nearest 50
 * to match the step granularity of the individual sliders.
 * @param {number} total
 * @param {Object} s - Settings object (mutated in place).
 */
function applyTotalBudget(total, s) {
  const snap = (v) => Math.max(50, Math.round(v / 50) * 50);
  s.longterm_inject_budget = snap(total * BUDGET_RATIOS.longterm);
  s.session_inject_budget = snap(total * BUDGET_RATIOS.session);
  s.scene_inject_budget = snap(total * BUDGET_RATIOS.scenes);
  s.arcs_inject_budget = snap(total * BUDGET_RATIOS.arcs);
  s.canon_inject_budget = snap(total * BUDGET_RATIOS.canon);
  s.profiles_inject_budget = snap(total * BUDGET_RATIOS.profiles);
}

/**
 * Shows or hides advanced-only controls based on the current settings mode.
 * Also syncs the simplified budget slider value from the current per-tier totals.
 * @param {'simple'|'advanced'} mode
 */
function applySettingsMode(mode) {
  const isSimple = mode === 'simple';
  $('.sm-advanced-only').toggle(!isSimple);
  $('.sm-simple-only').toggle(isSimple);
  if (isSimple) {
    const total = totalBudgetFromSettings(extension_settings[MODULE_NAME]);
    $('#sm_total_budget').val(total);
    $('#sm_total_budget_value').text(total);
  }
}

// ---- Settings loading and migration -------------------------------------

/**
 * Merges defaultSettings into extension_settings for any missing keys.
 * Preserves existing values so user configuration is not overwritten on update.
 */
export function loadSettings() {
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

  // Migration: longterm_consolidate -> consolidation_enabled (now controls both tiers).
  // If a user had explicitly disabled long-term consolidation, carry that intent forward.
  if (
    Object.prototype.hasOwnProperty.call(extension_settings[MODULE_NAME], 'longterm_consolidate') &&
    !Object.prototype.hasOwnProperty.call(extension_settings[MODULE_NAME], 'consolidation_enabled')
  ) {
    extension_settings[MODULE_NAME].consolidation_enabled =
      extension_settings[MODULE_NAME].longterm_consolidate;
  }
}

// ---- Settings UI binding ------------------------------------------------

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
 * Each control reads from extension_settings[MODULE_NAME] on mount and writes
 * back on change, calling saveSettingsDebounced() to persist.
 *
 * @param {Object} ctrl - Getter/setter proxy for index.js module-level state:
 *   extractionRunning, compactionRunning, consolidationRunning, catchUpCancelled,
 *   sceneMessageBuffer, sceneBufferLastIndex, selectedGroupCharacter.
 *   Also carries callbacks: clearAllInjections, onChatChanged,
 *   getSelectedCharacterName, getStableExtractionWindowWithFallback.
 */
export function bindSettingsUI(ctrl) {
  const s = extension_settings[MODULE_NAME];

  /**
   * Returns true and shows a warning toast if a catch-up or compaction is
   * currently running. Use this to block manual extract/clear buttons that
   * would conflict with an in-progress background job.
   * @returns {boolean}
   */
  function isCatchUpRunning() {
    if (ctrl.extractionRunning || ctrl.compactionRunning) {
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
   * Runs extraction on messages generated during the read-only window, then
   * lifts the gate without purging or ghosting anything. Called when the user
   * chooses to commit a read-only session rather than discard it.
   *
   * Session memories are already present (extraction was gated, not deleted).
   * This function fills in the missing tiers: long-term, arcs, and profiles.
   *
   * @param {number} startIndex - Chat index where the read-only window began.
   * @returns {Promise<void>}
   */
  async function commitReadOnlyWindow(startIndex) {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];
    const windowMessages = (context.chat ?? [])
      .slice(startIndex)
      .filter((m) => m.mes && !m.is_system);

    if (windowMessages.length === 0) return;

    const characterName = ctrl.getSelectedCharacterName();
    const characterNames = (() => {
      if (!context.groupId) return characterName ? [characterName] : [];
      const group = context.groups?.find((g) => g.id === context.groupId);
      if (!group) return characterName ? [characterName] : [];
      return group.members
        .filter((avatar) => !(group.disabled_members ?? []).includes(avatar))
        .map((avatar) => context.characters.find((c) => c.avatar === avatar)?.name)
        .filter(Boolean);
    })();

    setStatusMessage('Committing read-only session...');

    for (const name of characterNames) {
      if (settings.longterm_enabled) {
        const nameWindow = context.groupId
          ? windowMessages.filter((m) => m.is_user || m.name === name)
          : windowMessages;
        if (nameWindow.length > 0) {
          await extractAndStoreMemories(name, nameWindow).catch((err) =>
            console.error('[SmartMemory] Commit long-term extraction error:', err),
          );
          if (settings.consolidation_enabled) {
            await consolidateMemories(name).catch((err) =>
              console.error('[SmartMemory] Commit consolidation error:', err),
            );
          }
        }
      }
      if (settings.profiles_enabled && name) {
        await generateProfiles(name)
          .then((profiles) => {
            if (profiles) {
              injectProfiles(name);
              updateProfilesUI(profiles);
            }
          })
          .catch((err) => console.error('[SmartMemory] Commit profile generation error:', err));
      }
    }

    if (settings.arcs_enabled) {
      await extractArcs(windowMessages).catch((err) =>
        console.error('[SmartMemory] Commit arc extraction error:', err),
      );
    }

    saveSettingsDebounced();
    setStatusMessage('Session committed.');
  }

  // Prevent section-header enable checkboxes from toggling the <details> open/closed
  // when clicked. Without this, clicking the checkbox both changes the setting and
  // collapses the section, which is never what the user intends.
  $(document).on('click', '.sm-section-toggle', (e) => e.stopPropagation());

  // ---- Master toggle --------------------------------------------------
  $('#sm_enabled')
    .prop('checked', s.enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!extension_settings[MODULE_NAME].enabled) {
        // Remove all injections immediately so nothing lingers in the prompt.
        ctrl.clearAllInjections();
      } else {
        // Restore injections from stored data so the user picks up where they left off.
        ctrl.onChatChanged();
      }
    });

  // ---- Settings mode toggle -------------------------------------------
  $('#sm_settings_mode_advanced')
    .prop('checked', s.settings_mode === 'advanced')
    .on('change', function () {
      const mode = $(this).prop('checked') ? 'advanced' : 'simple';
      extension_settings[MODULE_NAME].settings_mode = mode;
      saveSettingsDebounced();
      applySettingsMode(mode);
    });

  // ---- Simplified total budget slider ---------------------------------
  $('#sm_total_budget')
    .val(totalBudgetFromSettings(s))
    .on('input', function () {
      const total = parseInt($(this).val(), 10);
      $('#sm_total_budget_value').text(total);
      applyTotalBudget(total, extension_settings[MODULE_NAME]);
      saveSettingsDebounced();
    });

  // Apply initial mode on load.
  applySettingsMode(s.settings_mode ?? 'simple');

  // ---- Group chat character selector ----------------------------------
  $('#sm_group_char_select').on('change', async function () {
    const selection = $(this).val() || null;
    ctrl.selectedGroupCharacter = selection;
    updateLongTermUI(ctrl.selectedGroupCharacter);
    updateSessionUI();
    updateFreshStartUI(isFreshStart());
    updateCanonUI(ctrl.selectedGroupCharacter);
    updateProfilesUI(loadProfiles(ctrl.selectedGroupCharacter));
    // Re-inject the character-specific slots so updateTokenDisplay reads
    // the selected character's content rather than whoever responded last.
    // onGroupMemberDrafted will overwrite these again before the next Generate().
    await injectMemories(selection);
    if (ctrl.selectedGroupCharacter !== selection) return;
    await injectSessionMemories();
    injectCanon(selection);
    injectProfiles(selection);
    maybeInjectUnified();
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
    const prevModel = extension_settings[MODULE_NAME].ollama_model;
    $btn.prop('disabled', true);
    try {
      const models = await fetchOllamaModels();
      $select.empty();
      if (models.length === 0) {
        $select.append('<option value="">No models found</option>');
      } else {
        models.forEach((name) => {
          $select.append($('<option>', { value: name, text: name }));
        });
        const best = models.includes(prevModel) ? prevModel : models[0];
        $select.val(best);
        extension_settings[MODULE_NAME].ollama_model = best;
        saveSettingsDebounced();
      }
    } catch (err) {
      toastr.error(
        `Could not reach Ollama at ${extension_settings[MODULE_NAME].ollama_url || 'http://localhost:11434'}. Is it running?`,
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
      extension_settings[MODULE_NAME].source = source;
      saveSettingsDebounced();
      updateSourceSections(source);
      if (source === memory_sources.ollama && !extension_settings[MODULE_NAME].ollama_model) {
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
      extension_settings[MODULE_NAME].ollama_url = $(this).val().trim();
      saveSettingsDebounced();
      // Refresh models when the URL changes so the list reflects the new instance.
      refreshOllamaModels();
    });

  // Ollama model dropdown
  $('#sm_ollama_model').on('change', function () {
    extension_settings[MODULE_NAME].ollama_model = $(this).val();
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
      extension_settings[MODULE_NAME].openai_compat_url = $(this).val().trim();
      saveSettingsDebounced();
    });

  $('#sm_openai_compat_key')
    .val(s.openai_compat_key ?? '')
    .on('change', function () {
      extension_settings[MODULE_NAME].openai_compat_key = $(this).val();
      saveSettingsDebounced();
    });

  $('#sm_openai_compat_model')
    .val(s.openai_compat_model ?? '')
    .on('input', function () {
      extension_settings[MODULE_NAME].openai_compat_model = $(this).val().trim();
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
      extension_settings[MODULE_NAME].hardware_profile = $(this).val();
      saveSettingsDebounced();
      updateProfileLabel();
      syncProfileGating();
    });

  updateProfileLabel();
  syncProfileGating();

  $('#sm_extraction_frequency')
    .val(s.extraction_frequency ?? 'medium')
    .on('change', function () {
      const freq = $(this).val();
      const every = EXTRACTION_FREQUENCY_MAP[freq] ?? 3;
      const settings = extension_settings[MODULE_NAME];
      settings.extraction_frequency = freq;
      settings.longterm_extract_every = every;
      settings.session_extract_every = every;
      saveSettingsDebounced();
      // Keep the advanced sliders in sync so switching to advanced mode shows the right values.
      $('#sm_longterm_extract_every').val(every);
      $('#sm_longterm_extract_every_value').text(every);
      $('#sm_session_extract_every').val(every);
      $('#sm_session_extract_every_value').text(every);
    });

  // ---- Short-term (compaction) ----------------------------------------
  $('#sm_compaction_enabled')
    .prop('checked', s.compaction_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].compaction_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_compaction_threshold')
    .val(s.compaction_threshold)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].compaction_threshold = val;
      $('#sm_compaction_threshold_value').text(val + '%');
      saveSettingsDebounced();
    });
  $('#sm_compaction_threshold_value').text(s.compaction_threshold + '%');

  $('#sm_compaction_response_length')
    .val(s.compaction_response_length)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].compaction_response_length = val;
      $('#sm_compaction_response_length_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_compaction_response_length_value').text(s.compaction_response_length);

  $('#sm_compaction_template')
    .val(s.compaction_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].compaction_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sm_compaction_position"][value="${s.compaction_position}"]`).prop('checked', true);
  $('input[name="sm_compaction_position"]').on('change', function () {
    extension_settings[MODULE_NAME].compaction_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_compaction_depth')
    .val(s.compaction_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].compaction_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_compaction_role')
    .val(s.compaction_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].compaction_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // ---- Canon ----------------------------------------------------------

  $('#sm_canon_enabled')
    .prop('checked', s.canon_enabled ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].canon_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!extension_settings[MODULE_NAME].canon_enabled) {
        setExtensionPrompt(PROMPT_KEY_CANON, '', extension_prompt_types.NONE, 0);
        updateTokenDisplay();
      } else {
        injectCanon(ctrl.getSelectedCharacterName());
        updateTokenDisplay();
      }
    });

  $('#sm_canon_inject_budget')
    .val(s.canon_inject_budget)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].canon_inject_budget = val;
      $('#sm_canon_inject_budget_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_canon_inject_budget_value').text(s.canon_inject_budget);

  $('#sm_canon_template')
    .val(s.canon_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].canon_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sm_canon_position"][value="${s.canon_position}"]`).prop('checked', true);
  $('input[name="sm_canon_position"]').on('change', function () {
    extension_settings[MODULE_NAME].canon_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_canon_depth')
    .val(s.canon_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].canon_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_canon_role')
    .val(s.canon_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].canon_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // Allow manual edits to the canon textarea to take effect immediately.
  $('#sm_canon_display').on('input', function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    const val = $(this).val().trim();
    if (val) {
      saveCanon(characterName, val);
      injectCanon(characterName);
    } else {
      clearCanon(characterName);
    }
    updateTokenDisplay();
  });

  $('#sm_summarize_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (ctrl.compactionRunning) return;
    ctrl.compactionRunning = true;
    setStatusMessage('Generating summary...');
    $(this).prop('disabled', true);
    try {
      const summary = await runCompaction();
      if (summary) {
        injectSummary(summary);
        updateShortTermUI(summary);
        maybeInjectUnified();
        updateTokenDisplay();
        setStatusMessage('Summary updated.');
      }
    } catch (err) {
      showError('Summary generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
      ctrl.compactionRunning = false;
    }
  });

  $('#sm_generate_canon').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) {
      toastr.warning('No character loaded.', 'Smart Memory');
      return;
    }
    if (loadArcSummaries().length === 0) {
      toastr.warning(
        'Canon requires at least one resolved arc summary. Resolve a story arc first.',
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
        updateCanonUI(characterName);
        maybeInjectUnified();
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

  // ---- Consolidation --------------------------------------------------
  $('#sm_consolidate_enabled')
    .prop('checked', s.consolidation_enabled ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].consolidation_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  for (const [type, defVal] of [
    ['fact', 4],
    ['relationship', 3],
    ['preference', 3],
    ['event', 4],
  ]) {
    const key = `longterm_consolidation_threshold_${type}`;
    const spanId = `#sm_longterm_threshold_${type}_value`;
    $(`#sm_longterm_threshold_${type}`)
      .val(s[key] ?? defVal)
      .on('input', function () {
        const val = parseInt($(this).val(), 10);
        extension_settings[MODULE_NAME][key] = val;
        $(spanId).text(val);
        saveSettingsDebounced();
      });
    $(spanId).text(s[key] ?? defVal);
  }

  for (const [type, defVal] of [
    ['scene', 3],
    ['revelation', 3],
    ['development', 3],
    ['detail', 3],
  ]) {
    const key = `session_consolidation_threshold_${type}`;
    const spanId = `#sm_session_threshold_${type}_value`;
    $(`#sm_session_threshold_${type}`)
      .val(s[key] ?? defVal)
      .on('input', function () {
        const val = parseInt($(this).val(), 10);
        extension_settings[MODULE_NAME][key] = val;
        $(spanId).text(val);
        saveSettingsDebounced();
      });
    $(spanId).text(s[key] ?? defVal);
  }

  // ---- Long-term memory -----------------------------------------------
  $('#sm_longterm_enabled')
    .prop('checked', s.longterm_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].longterm_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectMemories(ctrl.getSelectedCharacterName()).catch(console.error);
    });

  $('#sm_longterm_extract_every')
    .val(s.longterm_extract_every)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].longterm_extract_every = val;
      $('#sm_longterm_extract_every_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_longterm_extract_every_value').text(s.longterm_extract_every);

  $('#sm_longterm_max_memories')
    .val(s.longterm_max_memories)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].longterm_max_memories = val;
      $('#sm_longterm_max_memories_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_longterm_max_memories_value').text(s.longterm_max_memories);

  $('#sm_longterm_template')
    .val(s.longterm_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].longterm_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sm_longterm_position"][value="${s.longterm_position}"]`).prop('checked', true);
  $('input[name="sm_longterm_position"]').on('change', function () {
    extension_settings[MODULE_NAME].longterm_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_longterm_depth')
    .val(s.longterm_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].longterm_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_longterm_role')
    .val(s.longterm_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].longterm_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_longterm_inject_budget_value').text(s.longterm_inject_budget ?? 500);
  $('#sm_longterm_inject_budget')
    .val(s.longterm_inject_budget ?? 500)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].longterm_inject_budget = v;
      $('#sm_longterm_inject_budget_value').text(v);
      saveSettingsDebounced();
    });

  $('#sm_read_only').on('change', async function () {
    const val = $(this).prop('checked');
    await setFreshStart(val);

    if (val) {
      // Record where this read-only window starts so we know which messages
      // to ghost if the user disables it later. setReadOnlyStartIndex also
      // records the current timestamp for session memory purging.
      const context = getContext();
      await setReadOnlyStartIndex(context.chat?.length ?? 0);
      $('body').addClass('sm-read-only');
    } else {
      const startIndex = getReadOnlyStartIndex();
      const startTime = getReadOnlyStartTime();
      const context = getContext();
      const endIndex = (context.chat?.length ?? 1) - 1;
      const hasWindow = startIndex !== null && endIndex >= startIndex;

      const commit = hasWindow
        ? await callGenericPopup(
            'Commit memories from this read-only session?\n\n' +
              'OK - Keep session memories and extract long-term memories from this window.\n' +
              'Cancel - Discard all memories and hide messages from this window.',
            POPUP_TYPE.CONFIRM,
          )
        : false;

      if (commit) {
        // Lift the gate and process the window as if it had always been active.
        await setReadOnlyStartIndex(null);
        $('body').removeClass('sm-read-only');
        await commitReadOnlyWindow(startIndex);
      } else {
        // Discard: purge session memories then ghost the messages.
        if (startTime !== null) {
          await purgeSessionMemoriesSince(startTime).catch((err) =>
            console.error('[SmartMemory] Session memory purge failed:', err),
          );
        }
        if (hasWindow) {
          await hideChatMessageRange(startIndex, endIndex, false);
        }
        await setReadOnlyStartIndex(null);
        $('body').removeClass('sm-read-only');
      }
    }

    await injectMemories(ctrl.getSelectedCharacterName());
    await injectSessionMemories();
    updateSessionUI();
  });

  $('#sm_extract_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (ctrl.extractionRunning || ctrl.consolidationRunning) return;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    ctrl.extractionRunning = true;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting memories...');
    try {
      const context = getContext();
      const recentMessages = ctrl.getStableExtractionWindowWithFallback(context.chat, 20);
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
      ctrl.extractionRunning = false;
    }
  });

  $('#sm_clear_memories').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    if (!(await callGenericPopup(`Clear all memories for "${characterName}"?`, POPUP_TYPE.CONFIRM)))
      return;
    clearCharacterMemories(characterName);
    clearCanon(characterName);
    saveSettingsDebounced();
    updateLongTermUI(characterName);
    updateCanonUI(characterName);
    injectMemories(null).catch(console.error);
    setStatusMessage('Memories cleared.');
  });

  // ---- Session memory -------------------------------------------------
  $('#sm_session_enabled')
    .prop('checked', s.session_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].session_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectSessionMemories();
    });

  $('#sm_session_extract_every')
    .val(s.session_extract_every)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].session_extract_every = val;
      $('#sm_session_extract_every_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_session_extract_every_value').text(s.session_extract_every);

  $('#sm_session_max_memories')
    .val(s.session_max_memories)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].session_max_memories = val;
      $('#sm_session_max_memories_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_session_max_memories_value').text(s.session_max_memories);

  $('#sm_session_template')
    .val(s.session_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].session_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sm_session_position"][value="${s.session_position}"]`).prop('checked', true);
  $('input[name="sm_session_position"]').on('change', function () {
    extension_settings[MODULE_NAME].session_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_session_depth')
    .val(s.session_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].session_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_session_role')
    .val(s.session_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].session_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_session_inject_budget_value').text(s.session_inject_budget ?? 400);
  $('#sm_session_inject_budget')
    .val(s.session_inject_budget ?? 400)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].session_inject_budget = v;
      $('#sm_session_inject_budget_value').text(v);
      saveSettingsDebounced();
    });

  $('#sm_extract_session_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (isFreshStart()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting session memories...');
    try {
      const context = getContext();
      const recentMessages = ctrl.getStableExtractionWindowWithFallback(context.chat, 40);
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
    if (!(await callGenericPopup('Clear all session memories for this chat?', POPUP_TYPE.CONFIRM)))
      return;
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
      extension_settings[MODULE_NAME].scene_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectSceneHistory();
    });

  $('#sm_scene_ai_detect')
    .prop('checked', s.scene_ai_detect)
    .on('change', function () {
      extension_settings[MODULE_NAME].scene_ai_detect = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_scene_max_history')
    .val(s.scene_max_history)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].scene_max_history = val;
      $('#sm_scene_max_history_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_scene_max_history_value').text(s.scene_max_history);

  $(`input[name="sm_scene_position"][value="${s.scene_position}"]`).prop('checked', true);
  $('input[name="sm_scene_position"]').on('change', function () {
    extension_settings[MODULE_NAME].scene_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_scene_depth')
    .val(s.scene_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].scene_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_scene_role')
    .val(s.scene_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].scene_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_scene_inject_budget_value').text(s.scene_inject_budget ?? 300);
  $('#sm_scene_inject_budget')
    .val(s.scene_inject_budget ?? 300)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].scene_inject_budget = v;
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
      const messages =
        ctrl.sceneMessageBuffer.length > 0 ? ctrl.sceneMessageBuffer : context.chat.slice(-40);
      const summary = await summarizeScene(messages);
      if (summary) {
        const history = loadSceneHistory();
        const max = extension_settings[MODULE_NAME].scene_max_history ?? 5;
        history.push({ summary, ts: Date.now() });
        if (history.length > max) history.splice(0, history.length - max);
        await saveSceneHistory(history);
        // Reset the buffer - we just archived what was in it.
        ctrl.sceneMessageBuffer = [];
        ctrl.sceneBufferLastIndex = -1;
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
    if (!(await callGenericPopup('Clear all scene history for this chat?', POPUP_TYPE.CONFIRM)))
      return;
    await clearSceneHistory();
    injectSceneHistory();
    updateScenesUI();
    setStatusMessage('Scene history cleared.');
  });

  // ---- Story arcs -----------------------------------------------------
  $('#sm_arcs_enabled')
    .prop('checked', s.arcs_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].arcs_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectArcs();
    });

  $('#sm_arcs_max')
    .val(s.arcs_max)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].arcs_max = val;
      $('#sm_arcs_max_value').text(val);
      saveSettingsDebounced();
    });
  $('#sm_arcs_max_value').text(s.arcs_max);

  $(`input[name="sm_arcs_position"][value="${s.arcs_position}"]`).prop('checked', true);
  $('input[name="sm_arcs_position"]').on('change', function () {
    extension_settings[MODULE_NAME].arcs_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sm_arcs_depth')
    .val(s.arcs_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].arcs_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_arcs_role')
    .val(s.arcs_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].arcs_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sm_arcs_inject_budget_value').text(s.arcs_inject_budget ?? 200);
  $('#sm_arcs_inject_budget')
    .val(s.arcs_inject_budget ?? 200)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].arcs_inject_budget = v;
      $('#sm_arcs_inject_budget_value').text(v);
      saveSettingsDebounced();
    });

  $('#sm_extract_arcs_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting story arcs...');
    try {
      const context = getContext();
      const recentMessages = ctrl.getStableExtractionWindowWithFallback(context.chat, 100);
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
    if (!(await callGenericPopup('Clear all story arcs for this chat?', POPUP_TYPE.CONFIRM)))
      return;
    await clearArcs();
    injectArcs();
    updateArcsUI();
    setStatusMessage('Arcs cleared.');
  });

  // ---- Away recap -----------------------------------------------------
  $('#sm_recap_enabled')
    .prop('checked', s.recap_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].recap_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_recap_threshold')
    .val(s.recap_threshold_hours)
    .on('input', function () {
      const val = parseFloat($(this).val());
      extension_settings[MODULE_NAME].recap_threshold_hours = val;
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
    if (ctrl.extractionRunning || ctrl.compactionRunning) {
      toastr.warning('An extraction is already running.', 'Smart Memory', { timeOut: 3000 });
      return;
    }
    const characterName = ctrl.getSelectedCharacterName();
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
        !(await callGenericPopup(
          'Memories already exist for one or more characters. Running Memorize Chat again may add near-duplicate entries on top of existing ones.\n\nContinue?',
          POPUP_TYPE.CONFIRM,
        ))
      )
        return;
    }

    // The catch-up loop holds extractionRunning=true for its entire duration.
    // This blocks the background extraction path in onCharacterMessageRendered
    // from running concurrently, so consolidationRunning does not need a
    // separate check here - no other path can interleave with catch-up while
    // extractionRunning is set.
    ctrl.extractionRunning = true;
    ctrl.compactionRunning = true;
    ctrl.catchUpCancelled = false;
    $('#sm_catch_up').hide();
    $('#sm_cancel_catch_up').show().prop('disabled', false);

    try {
      const context = getContext();
      const settings = extension_settings[MODULE_NAME];

      // Use the stable window first so an in-progress trailing swipe candidate
      // is not ingested during catch-up.
      const stableChat = ctrl.getStableExtractionWindowWithFallback(
        context.chat,
        context.chat.length,
      );

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
        if (ctrl.catchUpCancelled) break;

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

        if (settings.longterm_enabled && !isFreshStart()) {
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
            if (settings.consolidation_enabled) {
              setStatusMessage(`Catching up... (${i}/${total} messages - consolidating ${name})`);
              await consolidateMemories(name).catch((err) => {
                console.error('[SmartMemory] Catch-up long-term consolidation error (chunk):', err);
              });
            }
          }
        }
        if (settings.session_enabled && !isFreshStart()) {
          setStatusMessage(`Catching up... (${i}/${total} messages - extracting session)`);
          await extractSessionMemories(chunk).catch((err) => {
            console.error('[SmartMemory] Catch-up session extraction error (chunk):', err);
          });
          setStatusMessage(`Catching up... (${i}/${total} messages - consolidating session)`);
          await consolidateSessionMemories().catch((err) => {
            console.error('[SmartMemory] Catch-up session consolidation error (chunk):', err);
          });
        }
        if (settings.arcs_enabled && !isFreshStart()) {
          setStatusMessage(`Catching up... (${i}/${total} messages - extracting arcs)`);
          await extractArcs(chunk, characterName).catch((err) => {
            console.error('[SmartMemory] Catch-up arc extraction error (chunk):', err);
          });
        }

        // Re-inject after each chunk so the token display reflects what is
        // actually stored, not just what was injected before catch-up started.
        if (settings.longterm_enabled && characterName) {
          await injectMemories(characterName);
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

      if (!ctrl.catchUpCancelled) {
        // Scene: walk through the full chat using heuristic break detection,
        // summarizing each detected scene. AI detection is skipped here - it
        // would cost one model call per message across potentially hundreds of
        // messages. The heuristic is free and good enough for bulk processing.
        if (settings.scene_enabled) {
          setStatusMessage('Detecting and summarizing scenes...');
          const sceneHistory = loadSceneHistory();
          const max = settings.scene_max_history ?? 5;
          const minMessages = settings.scene_min_messages ?? 3;
          let sceneBuffer = [];

          /**
           * Deduplicates a candidate summary against the last three stored scenes,
           * mirroring the check in processSceneBreak. Returns true if the summary
           * is too similar to an existing entry and should be skipped.
           */
          const isDuplicateScene = async (candidate) => {
            const recent = sceneHistory.slice(-3);
            for (const prev of recent) {
              const { score, semantic } = await sceneSimilarity(candidate, prev.summary);
              const threshold = semantic ? 0.82 : 0.55;
              if (score >= threshold) return true;
            }
            return false;
          };

          for (const msg of allMessages) {
            if (ctrl.catchUpCancelled) break;
            sceneBuffer.push(msg);

            const msgText = msg.mes ?? '';
            if (detectSceneBreakHeuristic(msgText) && sceneBuffer.length >= minMessages) {
              const sceneSummary = await summarizeScene(sceneBuffer).catch((err) => {
                console.error('[SmartMemory] Catch-up scene summary failed:', err);
                return null;
              });
              if (sceneSummary && !(await isDuplicateScene(sceneSummary))) {
                sceneHistory.push({
                  summary: sceneSummary,
                  ts: Date.now(),
                  source_memory_ids: [],
                });
                if (sceneHistory.length > max) sceneHistory.splice(0, sceneHistory.length - max);
              }
              sceneBuffer = [];
            }
          }

          // Summarize any remaining messages after the last break as the current scene.
          if (!ctrl.catchUpCancelled && sceneBuffer.length >= minMessages) {
            const sceneSummary = await summarizeScene(sceneBuffer).catch((err) => {
              console.error('[SmartMemory] Catch-up final scene summary failed:', err);
              return null;
            });
            if (sceneSummary && !(await isDuplicateScene(sceneSummary))) {
              sceneHistory.push({ summary: sceneSummary, ts: Date.now(), source_memory_ids: [] });
              if (sceneHistory.length > max) sceneHistory.splice(0, sceneHistory.length - max);
            }
          }

          await saveSceneHistory(sceneHistory).catch((err) => {
            console.error('[SmartMemory] Catch-up scene history save failed:', err);
          });
          ctrl.sceneMessageBuffer = [];
          ctrl.sceneBufferLastIndex = -1;
          updateTokenDisplay();
        }

        // Final consolidation pass for any entries that didn't accumulate enough
        // to hit the per-chunk threshold (e.g. a type that only got 1-2 new entries
        // across the whole chat). Forces consolidation regardless of threshold.
        if (settings.longterm_enabled && settings.consolidation_enabled) {
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
      if (!ctrl.catchUpCancelled && settings.profiles_enabled) {
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
      await injectMemories(characterName);
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
      maybeInjectUnified();
      updateTokenDisplay();
      saveSettingsDebounced();

      if (ctrl.catchUpCancelled) {
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
      ctrl.extractionRunning = false;
      ctrl.compactionRunning = false;
      ctrl.catchUpCancelled = false;
    }
  });

  $('#sm_cancel_catch_up').on('click', function () {
    ctrl.catchUpCancelled = true;
    $(this).prop('disabled', true);
    setStatusMessage('Cancelling...');
  });

  // ---- Clear Chat Context ---------------------------------------------
  $('#sm_clear_chat_context').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (
      !(await callGenericPopup(
        'Clear all Smart Memory context for this chat?\n\nThis will erase the summary, session memories, scene history, and story arcs. Long-term memories are not affected.',
        POPUP_TYPE.CONFIRM,
      ))
    )
      return;

    const characterName = ctrl.getSelectedCharacterName();
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
    ctrl.sceneMessageBuffer = [];
    ctrl.sceneBufferLastIndex = -1;
    setStatusMessage('Chat context cleared.');
  });

  // ---- Fresh Start ----------------------------------------------------
  $('#sm_fresh_start_button').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = ctrl.getSelectedCharacterName();
    const nameLabel = characterName ? `"${characterName}"` : 'this character';
    if (
      !(await callGenericPopup(
        `Fresh Start - this will permanently delete all long-term memories for ${nameLabel} and clear all Smart Memory context for this chat.\n\nThis cannot be undone. Continue?`,
        POPUP_TYPE.CONFIRM,
      ))
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
    await injectMemories(characterName);
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
    updateCanonUI(characterName);
    updateProfilesUI(null);
    updateTokenDisplay();
    ctrl.sceneMessageBuffer = [];
    ctrl.sceneBufferLastIndex = -1;
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
      extension_settings[MODULE_NAME].embedding_enabled = $(this).prop('checked');
      $('#sm_embedding_config').toggle(extension_settings[MODULE_NAME].embedding_enabled);
      // Reset failure flag so the next attempt gets a clean slate.
      clearEmbeddingFailed();
      $('#sm_embedding_test_result').text('');
      updateEmbeddingNotice();
      saveSettingsDebounced();
    });
  $('#sm_embedding_config').toggle(s.embedding_enabled);

  $('#sm_embedding_url')
    .val(s.embedding_url ?? '')
    .on('input', function () {
      extension_settings[MODULE_NAME].embedding_url = $(this).val().trim();
      clearEmbeddingFailed();
      $('#sm_embedding_test_result').text('');
      updateEmbeddingNotice();
      saveSettingsDebounced();
    });

  $('#sm_embedding_model')
    .val(s.embedding_model ?? 'nomic-embed-text')
    .on('input', function () {
      extension_settings[MODULE_NAME].embedding_model = $(this).val().trim();
      clearEmbeddingFailed();
      $('#sm_embedding_test_result').text('');
      updateEmbeddingNotice();
      saveSettingsDebounced();
    });

  $('#sm_embedding_keep')
    .prop('checked', s.embedding_keep)
    .on('change', function () {
      extension_settings[MODULE_NAME].embedding_keep = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_embedding_test').on('click', async function () {
    const $btn = $(this);
    const $result = $('#sm_embedding_test_result');
    $btn.prop('disabled', true);
    $result.text('Testing...');
    try {
      const map = await getEmbeddingBatch(['smart memory test']);
      if (map.size > 0) {
        $result.html('<span style="color: var(--green, #5a8)">Connected</span>');
        clearEmbeddingFailed();
        updateEmbeddingNotice();
      } else {
        $result.html(
          '<span style="color: var(--warning, #ca6)">No response - check URL and model name</span>',
        );
      }
    } catch {
      $result.html(
        '<span style="color: var(--warning, #ca6)">Connection failed - is Ollama running?</span>',
      );
    } finally {
      $btn.prop('disabled', false);
    }
  });

  // "Set up embeddings" link in the notice scrolls to the dedup section.
  $('#sm_embedding_notice_link').on('click', function (e) {
    e.preventDefault();
    const $dedup = $('#sm_embedding_enabled').closest('details');
    if ($dedup.length) {
      $dedup.prop('open', true);
      $dedup[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  updateEmbeddingNotice();

  // ---- Profiles -------------------------------------------------------
  $('#sm_profiles_enabled')
    .prop('checked', s.profiles_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].profiles_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!extension_settings[MODULE_NAME].profiles_enabled) {
        setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
        updateTokenDisplay();
      } else {
        injectProfiles(ctrl.getSelectedCharacterName());
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
      extension_settings[MODULE_NAME].profiles_stale_threshold_minutes = v;
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
      extension_settings[MODULE_NAME].profiles_regen_every = v;
      saveSettingsDebounced();
    });

  $('#sm_profiles_regenerate').on('click', async function () {
    const characterName = ctrl.getSelectedCharacterName();
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
      extension_settings[MODULE_NAME].profiles_inject_budget = val;
      $profilesBudgetVal.text(val + ' tokens');
      saveSettingsDebounced();
      injectProfiles(ctrl.getSelectedCharacterName());
    });
  $profilesBudgetVal.text((s.profiles_inject_budget ?? 400) + ' tokens');

  const currentProfilesPosition = s.profiles_position ?? extension_prompt_types.IN_PROMPT;
  $(`input[name="sm_profiles_position"][value="${currentProfilesPosition}"]`).prop('checked', true);
  $('input[name="sm_profiles_position"]').on('change', function () {
    extension_settings[MODULE_NAME].profiles_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
    injectProfiles(ctrl.getSelectedCharacterName());
  });

  $('#sm_profiles_depth')
    .val(s.profiles_depth ?? 1)
    .on('input', function () {
      extension_settings[MODULE_NAME].profiles_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
      injectProfiles(ctrl.getSelectedCharacterName());
    });

  $('#sm_profiles_role')
    .val(s.profiles_role ?? extension_prompt_roles.SYSTEM)
    .on('change', function () {
      extension_settings[MODULE_NAME].profiles_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
      injectProfiles(ctrl.getSelectedCharacterName());
    });

  updateProfilesUI(loadProfiles(ctrl.getSelectedCharacterName()));

  // ---- Entity graph -------------------------------------------------------
  $('#sm_open_graph_btn').on('click', () => {
    showMemoryGraph(ctrl.getSelectedCharacterName());
  });

  // ---- Continuity checker ---------------------------------------------
  $('#sm_auto_check')
    .prop('checked', s.continuity_auto_check)
    .on('change', function () {
      extension_settings[MODULE_NAME].continuity_auto_check = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_auto_repair')
    .prop('checked', s.continuity_auto_repair)
    .on('change', function () {
      extension_settings[MODULE_NAME].continuity_auto_repair = $(this).prop('checked');
      saveSettingsDebounced();
    });

  // ---- Developer / debug ----------------------------------------------
  $('#sm_verbose_logging')
    .prop('checked', s.verbose_logging)
    .on('change', function () {
      extension_settings[MODULE_NAME].verbose_logging = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sm_unified_injection')
    .prop('checked', s.unified_injection ?? false)
    .on('change', function () {
      const enabled = $(this).prop('checked');
      extension_settings[MODULE_NAME].unified_injection = enabled;
      saveSettingsDebounced();
      if (enabled) {
        injectUnified();
      } else {
        // Restore individual slots from stored data so the normal path
        // resumes immediately without waiting for the next generation.
        const characterName = ctrl.getSelectedCharacterName();
        clearUnifiedSlot();
        const summary = loadAndInjectSummary();
        updateShortTermUI(summary);
        injectMemories(characterName);
        injectSessionMemories();
        injectSceneHistory();
        injectArcs();
        injectCanon(characterName);
        injectProfiles(characterName);
      }
      updateTokenDisplay();
    });

  $('#sm_check_continuity').on('click', async function () {
    const characterName = ctrl.getSelectedCharacterName();
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
        if (extension_settings[MODULE_NAME].continuity_auto_repair) {
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

  $('#sm_about').on('click', async function () {
    // Populate version from manifest.json so it stays in sync automatically.
    try {
      const manifest = await fetch(
        '/scripts/extensions/third-party/Smart-Memory/manifest.json',
      ).then((r) => r.json());
      $('#sm_about_version').text(manifest.version ?? '');
    } catch {
      $('#sm_about_version').text('');
    }
    const $modal = $('#sm_about_modal').clone().show();
    // Remove IDs from the clone so they do not duplicate the hidden template's IDs in the DOM.
    $modal.find('[id]').addBack('[id]').removeAttr('id');
    await callGenericPopup($modal[0], POPUP_TYPE.DISPLAY, '', {
      wide: false,
      large: false,
    });
  });
}
