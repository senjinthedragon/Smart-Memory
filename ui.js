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
 * Pure display layer: all functions that read state and write to the DOM.
 * Zero coupling to index.js state variables - safe to import from anywhere.
 *
 * TOKEN_TIERS             - metadata for each injection tier (key, label, colour)
 * PERSONAL_TIERS          - per-character tiers shown in group-chat rows
 * getGroupMembers         - ordered list of character names in the current group
 * estimateCharPersonalTokens - stored token footprint for one character's personal tiers
 * updateTokenDisplay      - refreshes the token usage bar chart
 * setStatusMessage        - updates the status bar text in the settings panel header
 * setContinuityBadge      - updates the contradiction count badge in the header
 * showSearchResults       - renders a dismissible modal with /sm-search results
 * initTooltips            - wires up the floating tooltip on .sm-info elements
 * updateShortTermUI       - syncs the short-term summary textarea
 * updateCanonUI           - populates the canon display and status line
 * updateLongTermUI             - re-renders the long-term memories list and entity panel
 * updateRelationshipHistoryUI  - re-renders the relationship history panel with edit/delete/add controls
 * buildTypePicker         - builds a custom type-picker widget
 * initTypePickers         - registers the document-level close handler for type pickers
 * updateEmbeddingNotice   - shows/hides the embedding inactive notice
 * updateFreshStartUI      - syncs the fresh-start checkbox and body class
 * updateSessionUI         - re-renders the session memory list
 * updateScenesUI          - re-renders the scene history list
 * updateArcsUI            - re-renders the story arcs list
 * updateProfilesUI        - renders the profiles display panel
 * updateEntityPanel       - renders the entity registry panel
 * showEntityTimeline      - shows an inline timeline for a single entity
 * renderMemoriesList      - renders the long-term memories list with edit/delete controls
 * updateEpistemicUI       - re-renders the Perspectives & Secrets entry list with add/edit/delete controls
 */

import { extension_prompts, saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  estimateTokens,
  MODULE_NAME,
  META_KEY,
  MEMORY_TYPES,
  SESSION_TYPES,
  PROMPT_KEY_LONG,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SHORT,
  PROMPT_KEY_CANON,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_RELATIONSHIPS,
  PROMPT_KEY_EPISTEMIC,
  PROMPT_KEY_STATE_LEDGER,
} from './constants.js';
import {
  loadCharacterMemories,
  saveCharacterMemories,
  injectMemories,
  loadRelationshipHistory,
  saveRelationshipHistory,
  injectRelationshipHistory,
} from './longterm.js';
import { loadSessionMemories, saveSessionMemories, injectSessionMemories } from './session.js';
import { loadSceneHistory } from './scenes.js';
import {
  loadArcs,
  saveArcs,
  deleteArc,
  resolveArcWithSummary,
  injectArcs,
  promoteArc,
  demoteArc,
  reopenArc,
  loadArcSummaries,
  loadPersistentArcs,
  savePersistentArcs,
  loadGroupPersistentArcs,
  saveGroupPersistentArcs,
} from './arcs.js';
import { loadCanon } from './canon.js';
import { loadProfiles } from './profiles.js';
import {
  loadCharacterEntityRegistry,
  loadSessionEntityRegistry,
  saveCharacterEntityRegistry,
  saveSessionEntityRegistry,
  setEntityType,
  deleteEntityById,
  mergeEntitiesById,
} from './graph-migration.js';
import { getUnifiedTierBreakdown } from './unified-inject.js';
import { hasEmbeddingFailed } from './embeddings.js';
import {
  getTierTrimStats,
  hasAnyTrimmedTier,
  hasTrimToastFired,
  markTrimToastFired,
  isChatLoadComplete,
} from './trim-stats.js';
import { sameGroupId, escapeHtml } from './memory-utils.js';
import {
  loadEpistemicKnowledge,
  saveEpistemicKnowledge,
  injectEpistemicKnowledge,
  shrinkEpistemicBudgetIfPossible,
} from './epistemic.js';
import {
  getStateCard,
  setStateCard,
  deleteStateCard,
  migrateStateLedgerKey,
  isStateLedgerEnabled,
  injectStateLedger,
  STATE_CARD_FIELDS,
  STATE_CARD_TYPES,
} from './state-ledger.js';

// ---- Local helpers (not exported) ----------------------------------------

function getSettings() {
  return extension_settings[MODULE_NAME];
}

/** Returns the active character name, or null if no character is loaded. */
function getCurrentCharacterName() {
  const context = getContext();
  return context.name2 || context.characterName || null;
}

/**
 * Returns the character name the settings panel should operate on.
 * Reads from the DOM selector which is always in sync with the index.js
 * selectedGroupCharacter variable, so no state import is needed here.
 * @returns {string|null}
 */
function getSelectedCharacterName() {
  if (getContext().groupId) {
    return $('#sm_group_char_select').val() || null;
  }
  return getCurrentCharacterName();
}

// ---- Constants -----------------------------------------------------------

// Tier colours use OKLCH for perceptual uniformity: 10 hues at 36-degree
// intervals (360/10) with fixed lightness and chroma give maximum perceptual
// separation regardless of the display. oklch(62% 0.14 H).
const TIER_COLORS = {
  relationships: 'oklch(62% 0.14 0)',
  scenes: 'oklch(62% 0.14 36)',
  state: 'oklch(62% 0.14 72)',
  epistemic: 'oklch(62% 0.14 108)',
  shortterm: 'oklch(62% 0.14 144)',
  profiles: 'oklch(62% 0.14 180)',
  canon: 'oklch(62% 0.14 216)',
  longterm: 'oklch(62% 0.14 252)',
  session: 'oklch(62% 0.14 288)',
  arcs: 'oklch(62% 0.14 324)',
};

/**
 * Metadata for each injection tier used by the token usage display.
 * Order determines the visual stacking order in the bar chart.
 */
export const TOKEN_TIERS = [
  { key: PROMPT_KEY_LONG, label: 'Long-term', color: TIER_COLORS.longterm },
  { key: PROMPT_KEY_SESSION, label: 'Session', color: TIER_COLORS.session },
  { key: PROMPT_KEY_SHORT, label: 'Short-term', color: TIER_COLORS.shortterm },
  { key: PROMPT_KEY_CANON, label: 'Canon', color: TIER_COLORS.canon },
  { key: PROMPT_KEY_SCENES, label: 'Scenes', color: TIER_COLORS.scenes },
  { key: PROMPT_KEY_ARCS, label: 'Arcs', color: TIER_COLORS.arcs },
  { key: PROMPT_KEY_PROFILES, label: 'Profiles', color: TIER_COLORS.profiles },
  { key: PROMPT_KEY_RELATIONSHIPS, label: 'Relationships', color: TIER_COLORS.relationships },
  { key: PROMPT_KEY_EPISTEMIC, label: 'Perspectives', color: TIER_COLORS.epistemic },
  { key: PROMPT_KEY_STATE_LEDGER, label: 'State', color: TIER_COLORS.state },
];

// Personal tiers shown in per-character group rows. Shared tiers (session,
// scenes, arcs, short-term) are omitted - they are identical across all group
// members and already represented in the top bar.
export const PERSONAL_TIERS = [
  { key: 'longterm', label: 'Long-term', color: TIER_COLORS.longterm },
  { key: 'canon', label: 'Canon', color: TIER_COLORS.canon },
  { key: 'profiles', label: 'Profiles', color: TIER_COLORS.profiles },
];

// ---- Display functions ---------------------------------------------------

/**
 * Returns the ordered list of character names in the current group chat,
 * or null when not in a group chat.
 * @returns {string[]|null}
 */
export function getGroupMembers() {
  const context = getContext();
  if (!context.groupId) return null;
  const group = context.groups?.find((g) => sameGroupId(g.id, context.groupId));
  if (!group) return null;
  return (group.members ?? [])
    .map((avatarId) => context.characters.find((c) => c.avatar === avatarId)?.name)
    .filter(Boolean);
}

/**
 * Estimates the stored token footprint of a character's personal memory tiers:
 * long-term memories, canon, and profiles. Does not include shared tiers
 * (session, scenes, arcs, short-term) which are identical for all group members.
 *
 * Reads from stored data rather than injected content, so values reflect the
 * full memory footprint before budget trimming.
 *
 * @param {string} charName
 * @returns {{ longterm: number, canon: number, profiles: number, total: number }}
 */
export function estimateCharPersonalTokens(charName) {
  const memories = loadCharacterMemories(charName).filter((m) => !m.superseded_by);
  const longtermTokens =
    memories.length > 0 ? estimateTokens(memories.map((m) => `- ${m.content}`).join('\n')) : 0;

  const canon = loadCanon(charName);
  const canonTokens = canon ? estimateTokens(canon.text) : 0;

  const profiles = loadProfiles(charName);
  const profileTokens = profiles
    ? estimateTokens(
        [profiles.character_state, profiles.world_state, profiles.relationship_matrix]
          .filter(Boolean)
          .join('\n'),
      )
    : 0;

  return {
    longterm: longtermTokens,
    canon: canonTokens,
    profiles: profileTokens,
    total: longtermTokens + canonTokens + profileTokens,
  };
}

/**
 * Reads the currently injected content for each tier from extension_prompts
 * and updates the token usage bar chart and totals line. In group chats,
 * also renders a compact per-character row for each group member showing their
 * stored personal memory footprint (long-term, canon, profiles).
 *
 * Called after any injection or chat change so the display stays current.
 * Uses the estimateTokens heuristic (~4 chars/token) - fast, synchronous,
 * accurate enough for budget tuning.
 */
export function updateTokenDisplay() {
  const bar = document.getElementById('sm_token_bar');
  if (!bar) return;

  // ---- Top bar: actual injected content for the active character ----------

  // In unified mode the individual slots are empty - use the breakdown saved
  // by the last injectUnified call so tier colours are still visible.
  const settings = getSettings();
  const tiers = (
    settings.unified_injection
      ? getUnifiedTierBreakdown()
      : TOKEN_TIERS.map((t) => ({
          ...t,
          tokens: estimateTokens(extension_prompts[t.key]?.value ?? ''),
        }))
  ).filter((t) => t.tokens > 0);

  const total = tiers.reduce((sum, t) => sum + t.tokens, 0);
  const maxContext = getContext().maxContext || 0;

  // Each segment's width is its share of total SM tokens. The title tooltip
  // carries the detail breakdown that the old legend used to show inline.
  bar.innerHTML = '';
  for (const tier of tiers) {
    const widthPct = total > 0 ? ((tier.tokens / total) * 100).toFixed(1) : 0;
    const sharePct = total > 0 ? ((tier.tokens / total) * 100).toFixed(0) : 0;
    const seg = document.createElement('div');
    seg.style.width = `${widthPct}%`;
    seg.style.background = tier.color;

    const trimStats = getTierTrimStats(tier.key);
    const isTrimmed = trimStats && trimStats.full > trimStats.injected;
    seg.className = isTrimmed ? 'sm-token-segment sm-token-trimmed' : 'sm-token-segment';

    if (isTrimmed) {
      const dropped = trimStats.full - trimStats.injected;
      seg.title =
        `${tier.label}: ~${tier.tokens.toLocaleString()} tokens injected (${sharePct}%)\n` +
        `~${dropped.toLocaleString()} tokens trimmed to fit budget`;
    } else {
      seg.title = `${tier.label}: ~${tier.tokens.toLocaleString()} tokens (${sharePct}%)`;
    }

    bar.appendChild(seg);
  }

  const contextPct = maxContext && total ? ((total / maxContext) * 100).toFixed(1) : '0';
  const usedEl = document.getElementById('sm_token_used');
  const maxEl = document.getElementById('sm_token_max');
  const pctEl = document.getElementById('sm_token_pct');
  if (usedEl) usedEl.textContent = `~${total.toLocaleString()}`;
  if (maxEl) maxEl.textContent = maxContext ? maxContext.toLocaleString() : '?';
  if (pctEl) pctEl.textContent = contextPct;

  // Fire a one-time notification the first time any tier is found to be trimming
  // content. Users who never open the settings panel will still see this once,
  // prompting them to check the token bar. Subsequent calls are silent.
  if (isChatLoadComplete() && hasAnyTrimmedTier() && !hasTrimToastFired()) {
    markTrimToastFired();
    toastr.warning(
      'One or more memory tiers are trimming content to stay within budget. Check the token bar in Smart Memory settings.',
      'Smart Memory',
      { timeOut: 8000, extendedTimeOut: 4000, closeButton: true },
    );
  }

  // ---- Per-character rows (group chats only) ------------------------------

  const groupRowsEl = document.getElementById('sm_token_group_rows');
  if (!groupRowsEl) return;

  const members = getGroupMembers();
  if (!members || members.length === 0) {
    groupRowsEl.style.display = 'none';
    return;
  }

  groupRowsEl.style.display = '';
  groupRowsEl.innerHTML = '';

  const activeChar = getSelectedCharacterName();

  for (const member of members) {
    const personal = estimateCharPersonalTokens(member);
    const isActive = member === activeChar;

    const row = document.createElement('div');
    row.className = 'sm-token-group-row' + (isActive ? ' sm-token-active' : '');
    row.title = `Click to view ${member}'s memories`;
    row.addEventListener('click', () => {
      $('#sm_group_char_select').val(member).trigger('change');
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'sm-token-group-name';
    nameEl.textContent = member;
    row.appendChild(nameEl);

    const barWrap = document.createElement('div');
    barWrap.className = 'sm-token-mini-bar-wrap';
    const miniBar = document.createElement('div');
    miniBar.className = 'sm-token-mini-bar';

    if (personal.total > 0) {
      for (const tier of PERSONAL_TIERS) {
        const tierTokens = personal[tier.key];
        if (tierTokens === 0) continue;
        const widthPct = ((tierTokens / personal.total) * 100).toFixed(1);
        const seg = document.createElement('div');
        seg.className = 'sm-token-segment';
        seg.style.width = `${widthPct}%`;
        seg.style.background = tier.color;
        seg.title = `${tier.label}: ~${tierTokens.toLocaleString()} tokens (stored)`;
        miniBar.appendChild(seg);
      }
    }

    barWrap.appendChild(miniBar);
    row.appendChild(barWrap);

    const countEl = document.createElement('span');
    countEl.className = 'sm-token-group-count';
    if (personal.total > 0) {
      countEl.textContent = `~${personal.total.toLocaleString()}`;
      countEl.title = 'Stored memory size before budget trimming';
    } else {
      countEl.textContent = 'no data';
    }
    row.appendChild(countEl);

    groupRowsEl.appendChild(row);
  }
}

/** Updates the status bar text shown at the top of the settings panel. */
export function setStatusMessage(msg) {
  $('#sm_status').text(msg);
}

/**
 * Updates the continuity badge shown in the settings panel header.
 * Called after the Profile B auto-check completes each AI turn.
 * @param {number|null} count - Contradiction count from checkContinuity, or null to clear.
 */
export function setContinuityBadge(count) {
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
export function showSearchResults(query, results) {
  $('#sm_search_overlay').remove();

  // Use a <dialog> element so it renders in the browser's top layer, immune
  // to ST's transformed ancestors that trap position:fixed divs on mobile.
  const dialog = document.createElement('dialog');
  dialog.id = 'sm_search_overlay';

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
  const dismiss = () => {
    dialog.close();
    dialog.remove();
  };
  $dismiss.on('click', dismiss);
  $(dialog).on('click', (e) => {
    if (e.target === dialog) dismiss();
  });
  $footer.append($dismiss);
  card.append($footer);
  $(dialog).append(card);
  document.body.appendChild(dialog);
  dialog.showModal();
}

/**
 * Injects a single #sm-tooltip div into <body> and wires up hover/focus
 * events on all .sm-info elements inside the settings panel.
 *
 * Using position:fixed on the tooltip div means it escapes ST's
 * overflow:hidden extensions panel and is never clipped at the edge.
 */
export function initTooltips() {
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
export function updateShortTermUI(summary) {
  $('#sm_current_summary').val(summary || '');
}

/**
 * Updates the Canon section UI to reflect the currently stored canon for the
 * given character. Populates the display textarea and status line.
 * @param {string|null} characterName
 */
export function updateCanonUI(characterName) {
  const canon = characterName ? loadCanon(characterName) : null;
  $('#sm_canon_display').val(canon?.text || '');
  if (canon) {
    const arcCount = loadArcSummaries().length;
    $('#sm_canon_status').text(
      `Canon: ${estimateTokens(canon.text)} tokens, sourced from ${arcCount} arc summar${arcCount === 1 ? 'y' : 'ies'}.`,
    );
  } else {
    $('#sm_canon_status').text('');
  }
}

/** Re-renders the long-term memories list and entity panel for the given character. */
export function updateLongTermUI(characterName) {
  const memories = characterName ? loadCharacterMemories(characterName) : [];
  renderMemoriesList(memories, characterName);
  updateEntityPanel(characterName);
}

/**
 * Renders the relationship history panel for the given character.
 * Each pair is shown as an editable row with subject, arrow, target,
 * descriptors, magnitude, and delete/edit controls.
 * @param {string|null} characterName
 */
export function updateRelationshipHistoryUI(characterName) {
  const $list = $('#sm_relationships_list');
  $list.empty();

  const history = characterName ? loadRelationshipHistory(characterName) : {};
  const pairs = Object.entries(history);

  if (pairs.length === 0) {
    $list.append('<div class="sm_no_char">No relationship history yet.</div>');
    return;
  }

  for (const [key, state] of pairs) {
    const [subject, target] = key.split('→').map((s) => s.trim());
    const descriptors = state.descriptors ?? [];
    // Display as "word(magnitude), word(magnitude)" for per-descriptor magnitudes.
    const descriptorStr = descriptors.map((d) => `${d.word}(${d.magnitude})`).join(', ');
    // For the edit form, serialize as "word(magnitude), ..." so it round-trips cleanly.
    const descriptorFieldVal = descriptorStr;

    const $row = $('<div class="sm_memory_item">');

    const $content = $('<div class="sm_memory_content">').text(
      `${subject} → ${target}: ${descriptorStr}`,
    );

    const $editBtn = $('<button class="sm_memory_action menu_button" title="Edit">')
      .append('<i class="fa-solid fa-pencil"></i>')
      .on('click', () => {
        // Populate the add form for editing this pair.
        $('#sm_rel_subject').val(subject);
        $('#sm_rel_target').val(target);
        $('#sm_rel_descriptors').val(descriptorFieldVal);
        $('#sm_relationship_add_form').show();
        // Store the key being edited so save can delete the old one.
        $('#sm_relationship_add_form').data('editing', key);
        $('#sm_rel_subject').focus();
      });

    const $deleteBtn = $(
      '<button class="sm_memory_action sm_memory_delete menu_button" title="Delete">',
    )
      .append('<i class="fa-solid fa-trash-can"></i>')
      .on('click', async () => {
        const h = loadRelationshipHistory(characterName);
        delete h[key];
        saveRelationshipHistory(characterName, h);
        saveSettingsDebounced();
        injectRelationshipHistory(characterName);
        updateRelationshipHistoryUI(characterName);
        updateTokenDisplay();
      });

    $row.append($content, $editBtn, $deleteBtn);
    $list.append($row);
  }
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
export function buildTypePicker(types) {
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
export function initTypePickers() {
  $(document).on('click.smTypePicker', (e) => {
    if (!$(e.target).closest('.sm-type-picker').length) {
      $('.sm-type-picker').removeClass('open');
    }
  });
}

/**
 * Shows or hides the embedding inactive notice at the top of the settings panel.
 * Visible when embeddings are disabled in settings OR when an API call has
 * failed this session (meaning the model is enabled but unreachable).
 */
export function updateEmbeddingNotice() {
  const settings = getSettings();
  const inactive = !settings.embedding_enabled || hasEmbeddingFailed();
  $('#sm_embedding_notice').toggle(inactive);
}

/** Syncs the Fresh Start checkbox state. */
export function updateFreshStartUI(freshStart) {
  $('#sm_read_only').prop('checked', !!freshStart);
  $('body').toggleClass('sm-read-only', !!freshStart);
}

/**
 * Re-renders the session memory list with per-entry edit and delete buttons.
 * Shows a placeholder when no session memories exist yet.
 */
export function updateSessionUI() {
  const memories = loadSessionMemories();
  const $list = $('#sm_session_list');
  $list.empty();

  if (memories.length === 0) {
    $list.append('<div class="sm_no_char">No session memories yet.</div>');
  }

  const sortedSession = [...memories].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const hasRetiredSession = sortedSession.some((m) => m.superseded_by);

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

  sortedSession.forEach((mem) => {
    // Display order is sorted by ts, but edit/delete index into the stored
    // (unsorted) array, so use the position in that array, not the sorted one.
    const idx = memories.indexOf(mem);
    const isRetired = Boolean(mem.superseded_by);
    const hasConflict = Array.isArray(mem.contradicts) && mem.contradicts.length > 0;
    const retiredClass = isRetired ? ' sm_memory_retired' : '';
    const retiredBadge = isRetired
      ? '<span class="sm_memory_retired_badge" title="This memory was superseded by a newer fact">retired</span>'
      : '';
    const supersededByLink = isRetired
      ? `<button class="sm_superseded_by_link menu_button" data-superseded-by="${escapeHtml(mem.superseded_by)}" title="Jump to the memory that replaced this one">→ superseded by</button>`
      : '';
    const conflictBadge = hasConflict
      ? `<span class="sm_memory_conflict_badge" title="This memory conflicts with ${mem.contradicts.length} other ${mem.contradicts.length === 1 ? 'memory' : 'memories'} - run the continuity checker to review"><i class="fa-solid fa-triangle-exclamation"></i></span>`
      : '';

    const importanceDots = '●'.repeat(mem.importance ?? 1);
    const expiration = mem.expiration ?? 'session';
    const $item = $(`
            <div class="sm_memory_item${retiredClass}" data-index="${idx}" data-memory-id="${escapeHtml(mem.id || '')}" ${isRetired ? 'style="display:none"' : ''}>
                <span class="sm_memory_type sm_type_${mem.type}">${mem.type}</span>
                <span class="sm_memory_importance sm_importance_${mem.importance ?? 1}" title="Importance ${mem.importance ?? 1}/3">${importanceDots}</span>
                <span class="sm_memory_expiration sm_expiration_${expiration}" title="Expires: ${expiration}">${expiration}</span>
                ${retiredBadge}${supersededByLink}${conflictBadge}
                <span class="sm_memory_text">${$('<div>').text(mem.content).html()}</span>
                ${Array.isArray(mem.source_messages) && mem.source_messages.length > 0 ? `<button class="sm_jump_source menu_button" data-source-start="${mem.source_messages[mem.source_messages.length - 1][0]}" data-source-end="${mem.source_messages[mem.source_messages.length - 1][1]}" title="Jump to source message"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>` : ''}
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

  $list.find('.sm_jump_source').on('click', function () {
    const startIdx = parseInt($(this).data('source-start'), 10);
    const endIdx = parseInt($(this).data('source-end'), 10);
    const $startMsg = $(`#chat .mes[mesid="${startIdx}"]`);
    if (!$startMsg.length) return;
    // Close the extensions panel so the chat is visible when the scroll lands.
    if ($('#rm_extensions_block').hasClass('openDrawer')) {
      $('#extensions-settings-button .drawer-toggle').trigger('click');
    }
    // Scroll to the first message in the source range.
    setTimeout(() => {
      const $chat = $('#chat');
      const scrollTarget = $startMsg.offset().top - $chat.offset().top + $chat.scrollTop();
      $chat.animate({ scrollTop: scrollTarget }, 400);
      // Flash all messages in the range so the user can see what produced this memory.
      const FLASH_DURATION_MS = 2400; // 3 pulses × 0.8 s each
      for (let i = startIdx; i <= endIdx; i++) {
        const $m = $(`#chat .mes[mesid="${i}"]`);
        if ($m.length) {
          $m.addClass('sm_source_flash');
          setTimeout(() => $m.removeClass('sm_source_flash'), FLASH_DURATION_MS);
        }
      }
    }, 300);
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
export function updateScenesUI() {
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
export function updateArcsUI() {
  const arcs = loadArcs();
  const $list = $('#sm_arcs_list');
  const $resolvedList = $('#sm_resolved_arcs_list');
  const $resolvedSection = $('#sm_resolved_arcs_section');
  $list.empty();
  $resolvedList.empty();

  const ctx = getContext();
  const groupId = ctx.groupId ?? null;
  const charName = groupId ? null : getCurrentCharacterName();
  const canPin = !!(charName || groupId);

  const activeArcs = arcs.filter((a) => !a.resolved);
  const resolvedArcs = arcs.filter((a) => a.resolved);

  if (activeArcs.length === 0) {
    $list.append('<div class="sm_no_char">No open story threads.</div>');
  }

  arcs.forEach((arc, idx) => {
    const isPersistent = !!arc.persistent;
    const isResolved = !!arc.resolved;

    if (isResolved) {
      const $item = $(`
              <div class="sm_arc_item sm_arc_persistent sm_arc_resolved" data-index="${idx}">
                  <span class="sm_arc_text">${$('<div>').text(arc.content).html()}</span>
                  <button class="sm_reopen_arc menu_button" data-index="${idx}" title="Re-open this thread"><i class="fa-solid fa-rotate-left"></i></button>
                  <button class="sm_remove_resolved_arc menu_button" data-index="${idx}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
              </div>
          `);
      $resolvedList.append($item);
    } else {
      const pinTitle = isPersistent
        ? 'Unpin - keep only in this chat'
        : 'Pin - carry this thread into future chats';
      const $item = $(`
              <div class="sm_arc_item${isPersistent ? ' sm_arc_persistent' : ''}" data-index="${idx}">
                  <span class="sm_arc_text">${$('<div>').text(arc.content).html()}</span>
                  ${canPin ? `<button class="sm_pin_arc menu_button${isPersistent ? ' sm_pin_active' : ''}" data-index="${idx}" title="${pinTitle}"><i class="fa-solid fa-thumbtack"></i></button>` : ''}
                  <button class="sm_edit_arc menu_button" data-index="${idx}" title="Edit this arc">
                      <i class="fa-solid fa-pencil"></i>
                  </button>
                  <button class="sm_resolve_arc menu_button" data-index="${idx}" title="Resolve this thread and generate an arc summary. Best used right after the thread concludes in the story - the summary is built from recent scene context, so resolving old threads may produce vague results.">
                      <i class="fa-solid fa-check"></i>
                  </button>
                  <button class="sm_delete_arc menu_button" data-index="${idx}" title="Delete this thread without summarising">
                      <i class="fa-solid fa-trash-can"></i>
                  </button>
              </div>
          `);
      $list.append($item);
    }
  });

  // Show the resolved section only when there are resolved arcs.
  $resolvedSection.toggle(resolvedArcs.length > 0);

  $resolvedList.find('.sm_reopen_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    await reopenArc(idx, charName, groupId);
    injectArcs();
    updateArcsUI();
  });

  $resolvedList.find('.sm_remove_resolved_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const arc = loadArcs()[idx];
    if (!arc) return;
    await deleteArc(idx, charName, groupId);
    if (groupId) {
      const gP = loadGroupPersistentArcs(groupId);
      saveGroupPersistentArcs(
        groupId,
        gP.filter((p) => p.content !== arc.content),
      );
    } else if (charName) {
      const cP = loadPersistentArcs(charName);
      savePersistentArcs(
        charName,
        cP.filter((p) => p.content !== arc.content),
      );
    }
    injectArcs();
    updateArcsUI();
  });

  $list.find('.sm_pin_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const arc = loadArcs()[idx];
    if (!arc) return;
    if (arc.persistent) {
      await demoteArc(idx, charName, groupId);
    } else {
      await promoteArc(idx, charName, groupId);
    }
    injectArcs();
    updateArcsUI();
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
    $item.find('.sm_pin_arc').hide();
    $item.find('.sm_delete_arc').hide();
    const $save = $('<button class="sm_save_arc menu_button" title="Save">Save</button>');
    const $cancel = $('<button class="sm_cancel_arc menu_button" title="Cancel">Cancel</button>');
    $item.append($save, $cancel);

    $save.on('click', async () => {
      const newContent = $textarea.val().trim();
      if (!newContent) return;
      const arcs = loadArcs();
      if (!arcs[idx]) return;
      const oldContent = arcs[idx].content;
      const isPersistent = !!arcs[idx].persistent;
      arcs[idx].content = newContent;
      await saveArcs(arcs);
      // Mirror content edits into the persistent store so the updated text
      // carries into future chats instead of the old version resurfacing.
      if (isPersistent) {
        if (groupId) {
          const gPersistent = loadGroupPersistentArcs(groupId);
          const match = gPersistent.find((p) => p.content === oldContent);
          if (match) {
            match.content = newContent;
            saveGroupPersistentArcs(groupId, gPersistent);
          }
        } else if (charName) {
          const cPersistent = loadPersistentArcs(charName);
          const match = cPersistent.find((p) => p.content === oldContent);
          if (match) {
            match.content = newContent;
            savePersistentArcs(charName, cPersistent);
          }
        }
      }
      injectArcs();
      updateArcsUI();
    });

    $cancel.on('click', () => updateArcsUI());
  });

  $list.find('.sm_resolve_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const summaryGenerated = await resolveArcWithSummary(idx, charName, groupId);
    if (summaryGenerated) {
      $(document).trigger('smart_memory:arc_resolved_with_summary', [charName, groupId]);
    }
    injectArcs();
    updateArcsUI();
  });

  $list.find('.sm_delete_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    await deleteArc(idx, charName, groupId);
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
export function updateProfilesUI(profiles) {
  const $display = $('#sm_profiles_display');
  $display.empty();

  if (!profiles) {
    $display.append('<span class="sm-muted">No profiles generated yet.</span>');
    return;
  }

  const sections = [
    { key: 'character_state', label: 'Character state' },
    { key: 'world_state', label: 'World state' },
    { key: 'relationship_matrix', label: 'Current Relationships' },
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
export function updateEntityPanel(characterName) {
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
      <div class="sm_entity_row" data-entity-id="${escapeHtml(entity.id)}" style="position:relative;">
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
          // Migrate state card to the new key so it stays coupled to the entity.
          if (t !== entity.type) await migrateStateLedgerKey(entity.name, entity.type, t);
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

      const otherEntities = entities.filter((en) => en.id !== entity.id);
      if (otherEntities.length === 0) return;

      const $picker = $('<div class="sm_entity_type_picker">');
      $picker.append(
        $('<div style="font-size:0.75em;opacity:0.6;padding:2px 8px 4px;">Merge into:</div>'),
      );
      for (const target of otherEntities) {
        const label = target.name + (target.type !== 'unknown' ? ` (${target.type})` : '');
        const safeLabel = $('<div>').text(label).html();
        const $opt = $(`<div class="sm_entity_type_option">${safeLabel}</div>`);
        $opt.on('click', async (ev) => {
          ev.stopPropagation();
          $picker.remove();

          const srcCard = getStateCard(entity.name, entity.type);
          const dstCard = getStateCard(target.name, target.type);

          // If both entities have state cards and the ledger is enabled, ask which to keep.
          // When the ledger is disabled, silently keep the destination card.
          if (isStateLedgerEnabled() && srcCard && dstCard) {
            const $modal = $(`
              <dialog class="sm_state_merge_modal">
                <div class="sm_state_merge_modal_inner">
                  <div class="sm_state_merge_title">Both entities have state cards</div>
                  <div class="sm_state_merge_body">
                    Merging <strong>${$('<span>').text(entity.name).html()}</strong> into
                    <strong>${$('<span>').text(target.name).html()}</strong> will discard one state card.
                    Which card should survive?
                  </div>
                  <div class="sm_state_merge_actions">
                    <button class="menu_button sm_state_keep_src">Keep "${$('<span>').text(entity.name).html()}" card</button>
                    <button class="menu_button sm_state_keep_dst">Keep "${$('<span>').text(target.name).html()}" card</button>
                    <button class="menu_button sm_state_cancel">Cancel</button>
                  </div>
                </div>
              </dialog>
            `);

            const closeModal = () => {
              $modal[0].close();
              $modal.remove();
            };
            // Escape key: treat as cancel.
            $modal[0].addEventListener('cancel', closeModal);

            const doMerge = async (keepSrc) => {
              closeModal();
              const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
              const ltMems = characterName ? loadCharacterMemories(characterName) : [];
              const sessReg = loadSessionEntityRegistry();
              const sessMems = loadSessionMemories();
              mergeEntitiesById(entity.id, target.id, ltReg, ltMems, sessReg, sessMems);
              if (characterName) {
                saveCharacterEntityRegistry(characterName, ltReg);
                saveCharacterMemories(characterName, ltMems);
              }
              await saveSessionEntityRegistry(sessReg);
              await saveSessionMemories(sessMems);
              // Discard the loser card, copy the winner card to the surviving key.
              await deleteStateCard(entity.name, entity.type);
              await deleteStateCard(target.name, target.type);
              const winnerFields = keepSrc ? srcCard : dstCard;
              await setStateCard(target.name, target.type, winnerFields);
              await persistAndRefresh();
            };

            $modal.find('.sm_state_keep_src').on('click', () => doMerge(true));
            $modal.find('.sm_state_keep_dst').on('click', () => doMerge(false));
            $modal.find('.sm_state_cancel').on('click', closeModal);
            document.body.appendChild($modal[0]);
            $modal[0].showModal();
            return;
          }

          const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
          const ltMems = characterName ? loadCharacterMemories(characterName) : [];
          const sessReg = loadSessionEntityRegistry();
          const sessMems = loadSessionMemories();
          mergeEntitiesById(entity.id, target.id, ltReg, ltMems, sessReg, sessMems);
          if (characterName) {
            saveCharacterEntityRegistry(characterName, ltReg);
            saveCharacterMemories(characterName, ltMems);
          }
          await saveSessionEntityRegistry(sessReg);
          await saveSessionMemories(sessMems);
          // If only the source had a card, copy it to the surviving (target) key.
          if (srcCard) {
            await deleteStateCard(entity.name, entity.type);
            await setStateCard(target.name, target.type, srcCard);
          }
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

      const doDelete = async () => {
        const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
        const ltMems = characterName ? loadCharacterMemories(characterName) : [];
        const sessReg = loadSessionEntityRegistry();
        const sessMems = loadSessionMemories();
        deleteEntityById(entity.id, ltReg, ltMems);
        deleteEntityById(entity.id, sessReg, sessMems);
        if (characterName) {
          saveCharacterEntityRegistry(characterName, ltReg);
          saveCharacterMemories(characterName, ltMems);
        }
        await saveSessionEntityRegistry(sessReg);
        await saveSessionMemories(sessMems);
        // Clean up any associated state card.
        if (STATE_CARD_TYPES.has(entity.type)) await deleteStateCard(entity.name, entity.type);
        await persistAndRefresh();
      };

      // Warn before discarding a populated state card - only when the ledger is enabled.
      // When disabled, the card is silently deleted alongside the entity.
      if (
        isStateLedgerEnabled() &&
        STATE_CARD_TYPES.has(entity.type) &&
        getStateCard(entity.name, entity.type)
      ) {
        $row.find('.sm_delete_state_warning').remove();
        const $warn = $(`
          <div class="sm_delete_state_warning">
            <span>This entity has a state card. Delete anyway?</span>
            <button class="menu_button sm_delete_anyway">Delete</button>
            <button class="menu_button sm_delete_cancel">Cancel</button>
          </div>
        `);
        $warn.find('.sm_delete_anyway').on('click', async () => {
          $warn.remove();
          await doDelete();
        });
        $warn.find('.sm_delete_cancel').on('click', () => $warn.remove());
        $row.append($warn);
        return;
      }

      await doDelete();
    });

    $panel.append($row);

    // State card subsection - only when the ledger is enabled and the entity type supports state cards.
    if (isStateLedgerEnabled() && STATE_CARD_TYPES.has(entity.type)) {
      const fields = STATE_CARD_FIELDS[entity.type] ?? [];
      const existingCard = getStateCard(entity.name, entity.type);

      const $section = $('<div class="sm_state_card_section">');

      // Summary header line: shows populated fields or a placeholder.
      const summaryParts = existingCard
        ? fields.filter((f) => existingCard[f]).map((f) => `${f}: ${existingCard[f]}`)
        : [];
      const summaryText = summaryParts.length > 0 ? summaryParts.join(' | ') : 'No state card';
      const $header = $(
        `<div class="sm_state_card_header sm-muted">${$('<div>').text(summaryText).html()}</div>`,
      );

      const $editBtn = $(
        `<button class="sm_state_card_edit_btn menu_button" title="${existingCard ? 'Edit state card' : 'Add state card'}">
          <i class="fa-solid ${existingCard ? 'fa-pen' : 'fa-plus'}"></i>
        </button>`,
      );

      const $headerRow = $('<div class="sm_state_card_header_row">');
      $headerRow.append($header, $editBtn);
      $section.append($headerRow);

      // Editor: hidden until the edit button is clicked.
      const $editor = $('<div class="sm_state_card_editor" style="display:none;">');
      const $inputs = {};
      for (const f of fields) {
        const $field = $('<div class="sm_state_card_field">');
        const label = f.replace(/_/g, ' ');
        const currentVal = existingCard?.[f] ?? '';
        const safeId = `sm_sc_${entity.id}_${f}`;
        $field.append(`<label for="${safeId}">${label}</label>`);
        const $inp = $(`<input type="text" id="${safeId}" class="text_pole" value="">`);
        $inp.val(currentVal);
        $field.append($inp);
        $inputs[f] = $inp;
        $editor.append($field);
      }

      const $actions = $('<div class="sm_state_card_actions">');
      const $saveBtn = $('<button class="menu_button">Save</button>');
      const $cancelBtn = $('<button class="menu_button">Cancel</button>');
      const $clearBtn = $(
        '<button class="menu_button sm_state_card_clear_btn">Clear card</button>',
      );
      $actions.append($saveBtn, $cancelBtn, existingCard ? $clearBtn : null);
      $editor.append($actions);
      $section.append($editor);

      $editBtn.on('click', (e) => {
        e.stopPropagation();
        const opening = !$editor.is(':visible');
        $editor.toggle(opening);
        const $icon = $editBtn.find('i');
        if (opening) {
          $icon.removeClass('fa-pen fa-plus').addClass('fa-times');
        } else {
          $icon.removeClass('fa-times').addClass(existingCard ? 'fa-pen' : 'fa-plus');
        }
      });

      $saveBtn.on('click', async (e) => {
        e.stopPropagation();
        const newFields = {};
        for (const f of fields) {
          const v = ($inputs[f].val() ?? '').trim();
          if (v) newFields[f] = v;
        }
        await setStateCard(entity.name, entity.type, newFields);
        injectStateLedger();
        updateEntityPanel(characterName);
        updateTokenDisplay();
      });

      $cancelBtn.on('click', (e) => {
        e.stopPropagation();
        $editor.hide();
      });

      $clearBtn.on('click', async (e) => {
        e.stopPropagation();
        await deleteStateCard(entity.name, entity.type);
        injectStateLedger();
        updateEntityPanel(characterName);
        updateTokenDisplay();
      });

      $panel.append($section);
    } else if (isStateLedgerEnabled() && entity.type === 'unknown') {
      // Model failed to classify this entity - hint that retyping it unlocks the state card.
      $panel.append(
        '<div class="sm_state_card_section sm-muted" style="font-size:0.85em;padding:2px 0 4px 4px;">' +
          '<i class="fa-solid fa-circle-info"></i> Change type to enable state card' +
          '</div>',
      );
    }
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
export function showEntityTimeline(entity, characterName) {
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
      const when =
        mem.valid_from != null
          ? `msg #${mem.valid_from}`
          : mem.ts != null
            ? new Date(mem.ts).toLocaleString()
            : 'unknown';
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
 * @param {Array} memories - Memory array for the character.
 * @param {string|null} characterName - Character name, used for save/inject calls.
 */
export function renderMemoriesList(memories, characterName) {
  const $list = $('#sm_memories_list');
  $list.empty();

  if (!characterName) {
    $list.append('<div class="sm_no_char">No character selected.</div>');
    return;
  }

  if (memories.length === 0) {
    $list.append('<div class="sm_no_char">No memories stored yet for this character.</div>');
  }

  const sorted = [...memories].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const hasRetired = sorted.some((m) => m.superseded_by);

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
      $(this).html(
        `<i class="fa-solid ${showing ? 'fa-eye-slash' : 'fa-eye'}"></i> ${showing ? 'Show' : 'Hide'} retired memories`,
      );
    });
  }

  sorted.forEach((mem, idx) => {
    const isRetired = Boolean(mem.superseded_by);
    const hasConflict = Array.isArray(mem.contradicts) && mem.contradicts.length > 0;
    const retiredClass = isRetired ? ' sm_memory_retired' : '';
    const retiredBadge = isRetired
      ? '<span class="sm_memory_retired_badge" title="This memory was superseded by a newer fact">retired</span>'
      : '';
    const supersededByLink = isRetired
      ? `<button class="sm_superseded_by_link menu_button" data-superseded-by="${escapeHtml(mem.superseded_by)}" title="Jump to the memory that replaced this one">→ superseded by</button>`
      : '';
    const conflictBadge = hasConflict
      ? `<span class="sm_memory_conflict_badge" title="This memory conflicts with ${mem.contradicts.length} other ${mem.contradicts.length === 1 ? 'memory' : 'memories'} - run the continuity checker to review"><i class="fa-solid fa-triangle-exclamation"></i></span>`
      : '';

    const importanceDots = '●'.repeat(mem.importance ?? 1);
    const expiration = mem.expiration ?? 'permanent';
    const $item = $(`
            <div class="sm_memory_item${retiredClass}" data-index="${idx}" data-memory-id="${escapeHtml(mem.id || '')}" ${isRetired ? 'style="display:none"' : ''}>
                <span class="sm_memory_type sm_type_${mem.type}">${mem.type}</span>
                <span class="sm_memory_importance sm_importance_${mem.importance ?? 1}" title="Importance ${mem.importance ?? 1}/3">${importanceDots}</span>
                <span class="sm_memory_expiration sm_expiration_${expiration}" title="Expires: ${expiration}">${expiration}</span>
                ${retiredBadge}${supersededByLink}${conflictBadge}
                <span class="sm_memory_text">${$('<div>').text(mem.content).html()}</span>
                ${Array.isArray(mem.source_messages) && mem.source_messages.length > 0 && mem.source_chat_id === getContext().chatId ? `<button class="sm_jump_source menu_button" data-source-start="${mem.source_messages[mem.source_messages.length - 1][0]}" data-source-end="${mem.source_messages[mem.source_messages.length - 1][1]}" title="Jump to source message"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>` : ''}
                <button class="sm_edit_memory menu_button" data-memory-id="${escapeHtml(mem.id || '')}" title="Edit this memory" ${isRetired ? 'style="display:none"' : ''}>
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="sm_delete_memory menu_button" data-memory-id="${escapeHtml(mem.id || '')}" title="Delete this memory">
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

  $list.find('.sm_jump_source').on('click', function () {
    const startIdx = parseInt($(this).data('source-start'), 10);
    const endIdx = parseInt($(this).data('source-end'), 10);
    const $startMsg = $(`#chat .mes[mesid="${startIdx}"]`);
    if (!$startMsg.length) return;
    // Close the extensions panel so the chat is visible when the scroll lands.
    if ($('#rm_extensions_block').hasClass('openDrawer')) {
      $('#extensions-settings-button .drawer-toggle').trigger('click');
    }
    // Scroll to the first message in the source range.
    setTimeout(() => {
      const $chat = $('#chat');
      const scrollTarget = $startMsg.offset().top - $chat.offset().top + $chat.scrollTop();
      $chat.animate({ scrollTop: scrollTarget }, 400);
      // Flash all messages in the range so the user can see what produced this memory.
      const FLASH_DURATION_MS = 2400; // 3 pulses × 0.8 s each
      for (let i = startIdx; i <= endIdx; i++) {
        const $m = $(`#chat .mes[mesid="${i}"]`);
        if ($m.length) {
          $m.addClass('sm_source_flash');
          setTimeout(() => $m.removeClass('sm_source_flash'), FLASH_DURATION_MS);
        }
      }
    }, 300);
  });

  $list.find('.sm_edit_memory').on('click', function () {
    const memId = $(this).data('memory-id');
    const $item = $(this).closest('.sm_memory_item');
    const $textSpan = $item.find('.sm_memory_text');
    const current = loadCharacterMemories(characterName);
    const mem = current.find((m) => m.id === memId);
    if (!mem) return;

    // Replace text span with an inline textarea for editing.
    const $textarea = $('<textarea class="sm_memory_edit_input">').val(mem.content);
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
      const target = memories.find((m) => m.id === memId);
      if (!target) return;
      target.content = newContent;
      saveCharacterMemories(characterName, memories);
      saveSettingsDebounced();
      injectMemories(characterName).catch(console.error);
      renderMemoriesList(loadCharacterMemories(characterName), characterName);
    });

    $cancel.on('click', () =>
      renderMemoriesList(loadCharacterMemories(characterName), characterName),
    );
  });

  $list.find('.sm_delete_memory').on('click', function () {
    const memId = $(this).data('memory-id');
    const current = loadCharacterMemories(characterName);
    const idx = current.findIndex((m) => m.id === memId);
    if (idx === -1) return;
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
    injectMemories(characterName).catch(console.error);
    renderMemoriesList(loadCharacterMemories(characterName), characterName);
  });
}

// ---- Perspectives & Secrets UI ------------------------------------------

const EPISTEMIC_TYPE_LABELS = {
  knows: 'Knows',
  suspects: 'Suspects',
  unaware: 'Unaware',
  believes: 'Believes (false)',
  hiding: 'Hiding',
};

/**
 * Re-renders the Perspectives & Secrets entry list for a character.
 * Each entry gets an edit and delete button. An add form is appended after the list.
 * believes and hiding entries are grouped behind a spoiler to avoid unintentional
 * player-side reveals in collaborative RP.
 *
 * @param {string|null} characterName - Card character name (storage key).
 */
export function updateEpistemicUI(characterName) {
  const $list = $('#sm_epistemic_list');
  $list.empty();

  const entries = characterName ? loadEpistemicKnowledge(characterName) : [];

  if (entries.length === 0) {
    $list.append('<div class="sm_no_char">No perspective entries yet.</div>');
    return;
  }

  const spoilerTypes = new Set(['believes', 'hiding']);
  const open = entries.filter((e) => !spoilerTypes.has(e.type));
  const secret = entries.filter((e) => spoilerTypes.has(e.type));

  /**
   * Builds and appends a single entry row to a target container.
   * @param {Object} entry
   * @param {jQuery} $target
   */
  function appendEntryRow(entry, $target) {
    const typeLabel = EPISTEMIC_TYPE_LABELS[entry.type] ?? entry.type;
    const displayText =
      entry.type === 'hiding'
        ? `${entry.subject} / ${typeLabel} from ${entry.target}: ${entry.content}`
        : `${entry.subject} / ${typeLabel}: ${entry.content}`;

    const $row = $('<div class="sm_memory_item">');
    const $content = $('<div class="sm_memory_content">').text(displayText);

    const $editBtn = $('<button class="sm_memory_action menu_button" title="Edit">')
      .append('<i class="fa-solid fa-pencil"></i>')
      .on('click', () => {
        $('#sm_ep_type').val(entry.type);
        $('#sm_ep_subject').val(entry.subject);
        $('#sm_ep_target').val(entry.target ?? '');
        $('#sm_ep_content').val(entry.content);
        // Show target field only for hiding type.
        $('.sm_ep_target_field').toggle(entry.type === 'hiding');
        $('#sm_epistemic_add_form').data('editing', entry.id).show();
        $('#sm_ep_subject').focus();
      });

    const $deleteBtn = $(
      '<button class="sm_memory_action sm_memory_delete menu_button" title="Delete">',
    )
      .append('<i class="fa-solid fa-trash-can"></i>')
      .on('click', () => {
        const current = loadEpistemicKnowledge(characterName);
        saveEpistemicKnowledge(
          characterName,
          current.filter((e) => e.id !== entry.id),
        );
        shrinkEpistemicBudgetIfPossible(characterName, characterName);
        injectEpistemicKnowledge(characterName, characterName);
        updateEpistemicUI(characterName);
        updateTokenDisplay();
      });

    $row.append($content, $editBtn, $deleteBtn);
    $target.append($row);
  }

  for (const entry of open) appendEntryRow(entry, $list);

  // Always render the spoiler block so the user knows it exists and can tell
  // whether any believes/hiding entries were extracted.
  const $details = $('<details class="sm_epistemic_spoiler">');
  const $summary = $(`
    <summary class="sm_epistemic_spoiler_summary">
      <span class="sm_spoiler_closed"><i class="fa-solid fa-lock"></i> Spoiler - false beliefs and hidden secrets <em>(click to reveal)</em></span>
      <span class="sm_spoiler_open"><i class="fa-solid fa-lock-open"></i> False beliefs and hidden secrets <em>(click to hide)</em></span>
    </summary>
  `);

  // Intercept the open action to warn before revealing spoiler content.
  // Closing needs no confirmation - the user has already seen the content.
  $summary.on('click', (e) => {
    if (!$details.prop('open')) {
      e.preventDefault();
      if (
        confirm(
          'This will reveal hidden character secrets - false beliefs and things the character is concealing.\n\nOpen spoiler?',
        )
      ) {
        $details.prop('open', true);
      }
    }
  });

  $details.append($summary);

  if (secret.length === 0) {
    $details.append(
      '<div class="sm_no_char" style="padding: 4px 0;">No false beliefs or hidden secrets found.</div>',
    );
  } else {
    for (const entry of secret) appendEntryRow(entry, $details);
  }

  $list.append($details);
}
