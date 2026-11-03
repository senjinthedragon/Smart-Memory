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
 * Pure, dependency-free helpers for the continuity verification and anchored
 * forward-repair pipeline.
 *
 * These live apart from continuity.js so they can be unit-tested under plain
 * Node without loading SillyTavern's runtime modules (extensions.js, script.js).
 * continuity.js imports and re-exports them, so the public pipeline API is
 * still exposed from continuity.js.
 *
 * buildRecentTranscript       - renders the preceding chat turns as [USER]/[Name] lines
 * hashText                    - stable lightweight non-cryptographic text hash
 * validateIssue               - rejects an issue unless every evidence field checks out
 * buildForwardRepairNote      - builds the non-retracting continuity note
 * parseContinuityJson         - parses the model's strict-JSON continuity response
 * isPendingRepairAnchorValid  - verifies a queued repair still matches its anchor message
 */

/** Only these contradiction categories are permitted through validation. */
export const CONTINUITY_CATEGORIES = ['permanent_trait', 'backstory', 'world_rule', 'death'];

const CATEGORY_SET = new Set(CONTINUITY_CATEGORIES);

// Generic non-answers that do not count as a substantive justification.
const PLACEHOLDER_REASONS = new Set([
  'n/a',
  'na',
  'none',
  'no',
  'unknown',
  'unclear',
  'not applicable',
  'not sure',
  '...',
]);

/**
 * Collapses whitespace and lowercases text so "verbatim" checks tolerate
 * formatting differences (line wrapping, case) without accepting paraphrases.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Builds a transcript of the turns preceding an anchor message.
 *
 * The transcript is the ground truth the continuity checker reasons against -
 * it is what the story actually wrote, in order - while baseline notes are
 * known to lag behind. User turns are labelled [USER]; character turns use the
 * message's stored character name.
 *
 * @param {Array<{mes?: string, is_user?: boolean, is_system?: boolean, name?: string}>} chat
 * @param {number} endIdx - Exclusive end index (usually the anchor message index).
 * @param {number} [windowSize=6] - Maximum number of preceding messages to include.
 * @returns {string} Newline-separated transcript, or '' when nothing is available.
 */
export function buildRecentTranscript(chat, endIdx, windowSize = 6) {
  if (!Array.isArray(chat) || chat.length === 0) return '';

  const end = Number.isInteger(endIdx) ? Math.max(0, Math.min(endIdx, chat.length)) : chat.length;
  const size = Number.isInteger(windowSize) && windowSize > 0 ? windowSize : 6;
  const start = Math.max(0, end - size);

  const lines = [];
  for (let i = start; i < end; i++) {
    const message = chat[i];
    if (!message || message.is_system || typeof message.mes !== 'string' || !message.mes) continue;
    const speaker = message.is_user ? 'USER' : message.name || message.characterName || 'CHARACTER';
    lines.push(`[${speaker}] ${message.mes}`);
  }
  return lines.join('\n\n');
}

/**
 * Lightweight, stable, non-cryptographic hash of message text.
 *
 * Used to detect whether the message a continuity note was anchored to has
 * since been swiped, edited, or deleted. A changed hash invalidates the queued
 * note so it can never be applied to a rewritten turn.
 *
 * @param {string} str
 * @returns {string} Unsigned 32-bit hash as a hexadecimal string.
 */
export function hashText(str) {
  const text = String(str ?? '');
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    // hash * 33 ^ char (djb2-xor)
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Validates a model-reported contradiction against the actual evidence.
 *
 * A contradiction is only accepted when ALL of the following hold:
 * - its category is one of the permanent categories
 * - it supplies a substantive why_not_progression explanation
 * - response_quote appears verbatim (normalized) in the latest response
 * - fact appears verbatim (normalized) in the baseline notes
 *
 * Anything else is treated as unverifiable and dropped. This is the main guard
 * against the checker inventing drift that the transcript disproves.
 *
 * @param {Object} issue - Parsed contradiction object.
 * @param {string} latestText - The latest AI response text.
 * @param {string} factsText - The established-facts/baseline block.
 * @returns {boolean} True when the issue is safe to act on.
 */
export function validateIssue(issue, latestText, factsText) {
  if (!issue || typeof issue !== 'object') return false;

  const category = String(issue.category ?? '')
    .trim()
    .toLowerCase();
  if (!CATEGORY_SET.has(category)) return false;

  const reason = String(issue.why_not_progression ?? '').trim();
  if (reason.length < 10 || PLACEHOLDER_REASONS.has(reason.toLowerCase())) return false;

  const quote = normalize(issue.response_quote);
  if (quote.length < 3) return false;
  if (!normalize(latestText).includes(quote)) return false;

  const fact = normalize(issue.fact);
  if (fact.length < 3) return false;
  if (!normalize(factsText).includes(fact)) return false;

  return true;
}

/**
 * Builds a forward-only continuity note from validated issues.
 *
 * The note deliberately never asks the model to revoke, undo, or re-narrate a
 * past event. Everything already written in the conversation stands; the note
 * only suggests keeping permanent facts consistent going forward, and explicitly
 * tells the model to ignore it if the story legitimately changed them.
 *
 * @param {Array<Object|string>} issues - Validated issues (objects or plain facts).
 * @param {string} characterName - Responding character (reserved for framing).
 * @returns {string} The note text, or '' when there is nothing to note.
 */
export function buildForwardRepairNote(issues, characterName) {
  // Reserved for future per-character framing; the note itself is character-agnostic.
  void characterName;

  const facts = (Array.isArray(issues) ? issues : [])
    .map((issue) => (typeof issue === 'string' ? issue : issue?.fact))
    .map((fact) => String(fact ?? '').trim())
    .filter(Boolean);

  if (facts.length === 0) return '';

  const factList = facts.join('; ');
  return `[Continuity note, background only: earlier in the story it was established that ${factList}. Everything already written in this conversation has happened and stands. Do NOT retract, undo, or re-narrate any past event. Where it fits naturally, keep these facts consistent from now on. If the conversation has legitimately changed them, ignore this note.]`;
}

/**
 * Parses the continuity checker's strict-JSON response.
 *
 * Tolerates markdown code fences and leading/trailing prose by extracting the
 * outermost JSON object. Returns only object entries from the contradictions
 * array; malformed input yields an empty array so a bad response can never
 * produce a repair.
 *
 * @param {string} response - Raw model response.
 * @returns {Array<Object>} Parsed contradiction objects.
 */
export function parseContinuityJson(response) {
  if (!response) return [];

  let text = String(response).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) text = text.slice(first, last + 1);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  let list = parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    list = parsed.contradictions ?? parsed.issues ?? [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

/**
 * Checks whether a queued repair is still anchored to an unchanged message.
 *
 * The anchor is the last AI message that existed when the continuity check ran.
 * If that message was swiped, edited, or deleted, its text hash no longer
 * matches and the queued note must be discarded - otherwise it could be applied
 * to a story branch it was never written for.
 *
 * @param {Array<{mes?: string}>} chat
 * @param {{anchorIdx?: number, anchorHash?: string}|null} pendingRepair
 * @returns {boolean}
 */
export function isPendingRepairAnchorValid(chat, pendingRepair) {
  if (!pendingRepair || typeof pendingRepair !== 'object') return false;
  if (!Array.isArray(chat)) return false;

  const idx = pendingRepair.anchorIdx;
  if (!Number.isInteger(idx) || idx < 0 || idx >= chat.length) return false;

  const anchor = chat[idx];
  if (!anchor || typeof anchor.mes !== 'string') return false;

  return hashText(anchor.mes) === pendingRepair.anchorHash;
}