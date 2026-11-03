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

import { hasStateChangeMarker } from './similarity.js';

/** Only these contradiction categories are permitted through validation. */
export const CONTINUITY_CATEGORIES = ['permanent_trait', 'backstory', 'world_rule', 'death'];

// Active in-story transformation / transition verbs. When one of these appears
// in the same clause as the quoted trait, the trait is being changed on-screen -
// that is story progression, not a permanent contradiction. The checker prompt
// asks the model to ignore these, but weak models still report them, so the
// validator drops them deterministically.
const TRANSFORMATION_PATTERNS = [
  /\bturned\b/i,
  /\bturns\b/i,
  /\bturning\b/i,
  /\bbecame\b/i,
  /\bbecomes\b/i,
  /\bbecoming\b/i,
  /\bchanged\b/i,
  /\bchanges\b/i,
  /\bchanging\b/i,
  /\btransformed\b/i,
  /\btransforms\b/i,
  /\btransforming\b/i,
  /\bmutated\b/i,
  /\bmutates\b/i,
  /\baltered\b/i,
  /\baltering\b/i,
  /\bhealed\b/i,
  /\bheals\b/i,
  /\bhealing\b/i,
  /\bdyed\b/i,
  /\bdyeing\b/i,
  /\bredyed\b/i,
  /\bdisguised\b/i,
  /\bdisguise\b/i,
  /\bsevered\b/i,
  /\bcast (?:a|the) spell\b/i,
  /\bspell\b/i,
  /\bcurse\b/i,
  /\bcursed\b/i,
  /\benchanted\b/i,
  /\bpolymorphed\b/i,
  /\bregrew\b/i,
  /\bgrew back\b/i,
  /\bshifted\b/i,
  /\bshift(?:s|ing)? (?:shape|form|into)\b/i,
];

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
 * Splits text into sentence-ish fragments on sentence punctuation and newlines.
 * Used to isolate the clause surrounding a quoted trait so transformation
 * markers can be detected locally rather than across the whole response.
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Returns true when the given sentence describes an active, on-screen
 * transformation or transition - the trait is being changed by the story rather
 * than silently contradicting an established permanent fact.
 * @param {string} sentence
 * @returns {boolean}
 */
function sentenceShowsTransformation(sentence) {
  if (!sentence) return false;
  if (TRANSFORMATION_PATTERNS.some((pattern) => pattern.test(sentence))) return true;
  return hasStateChangeMarker(sentence);
}

/**
 * Returns true when the recent transcript already depicts this same transition,
 * meaning the latest response is continuing an established story event rather
 * than introducing an unmotivated contradiction.
 * @param {string} recentTranscript
 * @param {string} quote - Normalized response quote.
 * @returns {boolean}
 */
function transcriptDepictsTransition(recentTranscript, quote) {
  if (!recentTranscript || !quote) return false;

  const normalizedTranscript = normalize(recentTranscript);
  // The quoted state already appears in the transcript - the story reached it
  // before this turn, so it is established progression.
  if (normalizedTranscript.includes(quote)) return true;

  // Otherwise look for a transformation clause in the transcript that shares
  // meaningful words with the quote (e.g. "a spell turned her eyes crimson"
  // paired with a quote about her eyes).
  const quoteWords = new Set(quote.split(/\s+/).filter((w) => w.length >= 3));
  return splitSentences(recentTranscript).some((sentence) => {
    if (!sentenceShowsTransformation(sentence)) return false;
    const words = normalize(sentence)
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    return words.some((w) => quoteWords.has(w));
  });
}

/**
 * Validates a model-reported contradiction against the actual evidence.
 *
 * A contradiction is only accepted when ALL of the following hold:
 * - its category is one of the permanent categories
 * - it supplies a substantive why_not_progression explanation
 * - response_quote appears verbatim (normalized) in the latest response
 * - fact appears verbatim (normalized) in the baseline notes
 * - the quoted trait is not being actively transformed on-screen
 *
 * The final check rejects false positives where a permanent trait is described
 * differently because the story itself is changing it in-scene (a spell turned
 * her eyes crimson, she dyed her hair, his leg was severed, and so on). That is
 * progression, not a contradiction.
 *
 * Anything else is treated as unverifiable and dropped. This is the main guard
 * against the checker inventing drift that the transcript disproves.
 *
 * @param {Object} issue - Parsed contradiction object.
 * @param {string} latestText - The latest AI response text.
 * @param {string} factsText - The established-facts/baseline block.
 * @param {string} [recentTranscript=''] - The turns preceding the latest response.
 * @returns {boolean} True when the issue is safe to act on.
 */
export function validateIssue(issue, latestText, factsText, recentTranscript = '') {
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

  // Reject active in-story transformations. Find the sentence in the latest
  // response that contains the quote and check whether it describes a change.
  const containingSentence =
    splitSentences(latestText).find((sentence) => normalize(sentence).includes(quote)) ?? '';
  if (sentenceShowsTransformation(containingSentence)) return false;

  // If the recent transcript already depicts this transition, it is progression.
  if (transcriptDepictsTransition(recentTranscript, quote)) return false;

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
 * The note is only valid while the conversation is still poised to apply it:
 * - the anchor must still be an AI message at its recorded index
 * - its text hash must still match (not swiped, edited, or deleted)
 * - no later AI turn may exist yet - once another response was generated, the
 *   note is stale and would be applied to a branch it was never written for
 * - at most one non-system message (the immediate pending user turn) may follow
 *
 * @param {Array<{mes?: string, is_user?: boolean, is_system?: boolean}>} chat
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
  // The anchor must be an assistant turn - a repair note is anchored on the AI
  // response that triggered it.
  if (anchor.is_user || anchor.is_system) return false;

  if (hashText(anchor.mes) !== pendingRepair.anchorHash) return false;

  const trailing = chat.slice(idx + 1);
  // Another AI turn was generated after the anchor: the note is stale.
  if (trailing.some((m) => m && !m.is_user && !m.is_system)) return false;
  // Only the immediate pending user turn may follow the anchor.
  if (trailing.filter((m) => m && !m.is_system).length > 1) return false;

  return true;
}
