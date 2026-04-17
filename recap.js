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
 * Away recap: generates a "Previously on..." summary when the user returns
 * to a chat after being away longer than the configured threshold, and
 * displays it as a dismissible modal popup for the user.
 *
 * updateLastActive - records the current time as lastActive in chatMetadata
 * getAwayHours    - returns hours since last active (0 if below threshold)
 * generateRecap   - generates the recap text via the model
 * displayRecap    - shows the recap in a dismissible modal popup
 */

import { generateMemorySummarize } from './generate.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY } from './constants.js';
import { RECAP_PROMPT } from './prompts.js';

/**
 * Records the current timestamp as lastActive in chatMetadata.
 * Called on chat load and after each AI response to keep the clock accurate.
 * Uses the debounced save to avoid hammering storage on every message.
 */
export function updateLastActive() {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].lastActive = Date.now();
  context.saveMetadataDebounced?.();
}

/**
 * Checks whether a recap should be generated based on time away.
 * Returns the gap in hours if it meets the threshold, or 0 if not.
 * @returns {number} Hours since last active, or 0 if below threshold.
 */
export function getAwayHours() {
  const context = getContext();
  const meta = context.chatMetadata?.[META_KEY];

  // Prefer the precise lastActive timestamp. Fall back to summaryUpdated if
  // Smart Memory was not active the last time this chat was open - that gives
  // a rough "last seen" time from the most recent compaction pass.
  const lastSeen = meta?.lastActive ?? meta?.summaryUpdated ?? null;
  if (!lastSeen) return 0;

  const gapHours = (Date.now() - lastSeen) / (1000 * 60 * 60);
  const threshold = extension_settings[MODULE_NAME].recap_threshold_hours ?? 4;
  return gapHours >= threshold ? gapHours : 0;
}

/**
 * Generates a "Previously on..." recap using the current chat context.
 * @returns {Promise<string|null>} The recap text, or null on failure.
 */
export async function generateRecap() {
  const settings = extension_settings[MODULE_NAME];
  try {
    const response = await generateMemorySummarize(RECAP_PROMPT, {
      responseLength: settings.recap_response_length ?? 300,
    });
    return response?.trim() || null;
  } catch (err) {
    console.error('[SmartMemory] Recap generation failed:', err);
    throw err;
  }
}

/**
 * Displays the recap as a dismissible modal popup for the user.
 * The modal shows how long the user was away and the recap text.
 * Clicking Dismiss or clicking outside the card closes it.
 * @param {string|null} recap - The recap text to display.
 * @param {number} [hoursAway] - Pre-computed away hours. If omitted, computed
 *   fresh via getAwayHours(). Callers that already have the value should pass
 *   it in - by the time displayRecap runs, updateLastActive() may have already
 *   reset the clock and getAwayHours() would return 0.
 */
export function displayRecap(recap, hoursAway) {
  if (!recap) return;

  // Remove any existing recap modal before showing a new one.
  $('#sm_recap_overlay').remove();

  const hours = hoursAway !== undefined ? hoursAway : getAwayHours();
  const hoursRounded = Math.round(hours * 10) / 10;
  const timeNote =
    hoursRounded > 24
      ? `You've been away for ${Math.round(hoursRounded / 24)} day(s).`
      : `You're returning after a short break (${hoursRounded}h).`;

  const overlay = $('<div id="sm_recap_overlay">').css({
    position: 'fixed',
    inset: '0',
    background: 'rgba(0,0,0,0.65)',
    zIndex: 10000,
    display: 'flex',
    // flex-start + margin:auto on the card centers when there is room, and
    // lets the card start at the top (with padding breathing room) when there
    // is not - preventing the card from being pushed off the top of the screen
    // on mobile where browser chrome shrinks the visible area below 100vh.
    alignItems: 'flex-start',
    justifyContent: 'center',
    overflowY: 'auto',
    padding: '16px',
  });

  const card = $('<div>').css({
    background: 'var(--black-2, #1a1a2e)',
    border: '1px solid var(--border-color, #444)',
    borderRadius: '8px',
    padding: '24px',
    maxWidth: '580px',
    width: '100%',
    // margin:auto distributes free vertical space equally, centering the card
    // when it fits. When the card is tall, the overlay scrolls instead.
    marginTop: 'auto',
    marginBottom: 'auto',
    overflowY: 'auto',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
  });

  const title = $('<h3>Previously on...</h3>').css({
    marginTop: 0,
    fontSize: '1.1em',
  });

  const timeLabel = $('<p>').text(timeNote).css({
    fontSize: '0.8em',
    opacity: 0.6,
    margin: '0 0 14px 0',
  });

  const content = $('<p>').text(recap).css({ lineHeight: 1.65, margin: 0 });

  const footer = $('<div>').css({ marginTop: '18px', textAlign: 'right' });
  const dismissBtn = $('<button>Dismiss</button>').addClass('menu_button');

  dismissBtn.on('click', () => overlay.remove());
  // Also dismiss when clicking the backdrop outside the card.
  overlay.on('click', (e) => {
    if (e.target === overlay[0]) overlay.remove();
  });

  footer.append(dismissBtn);
  card.append(title, timeLabel, content, footer);
  overlay.append(card);
  $('body').append(overlay);
}
