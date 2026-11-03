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
 * Pure parsing and formatting functions with no SillyTavern runtime dependencies.
 *
 * All functions here operate on plain strings and return plain data - no
 * getContext(), setExtensionPrompt(), or module-level mutable state. Isolating
 * them here means they can be unit-tested without a SillyTavern runtime context.
 * The consuming modules (arcs.js, compaction.js, continuity.js, longterm.js,
 * scenes.js, session.js) import from here rather than defining their own copies.
 *
 * parseExtractionOutput     - parses [type:score:expiration:entity=...] tagged lines from long-term extraction; tolerates trailing [score:expiration] appended to content
 * parseSessionOutput        - parses [type:score:expiration:entity=...] tagged lines from session extraction; tolerates trailing [score:expiration] appended to content
 * parseArcOutput            - parses [arc] / [resolved] tagged lines from arc extraction
 * parseContradictions       - parses contradiction lines from a continuity check response
 * formatSummary             - strips model analysis scaffolding and extracts the summary text
 * detectSceneBreakHeuristic - pattern-based scene break check, no model call required
 * parseProfileOutput        - extracts character_state, world_state, and relationship_matrix from profile generation output
 * parseTriggerResponse           - parses the comma-separated keyword list from a trigger generation response
 * parseRelationshipDeltaResponse - parses per-pair relationship state changes with magnitude from a delta response
 * parseEpistemicResponse         - parses the five-tag knowledge map output from an epistemic extraction pass
 * parseEpistemicRetireIndices     - extracts the set of 1-based entry indices the model flagged for retirement
 * parseStateCardResponse         - parses structured current-state field output into a Map of key -> fields
 * mergeStateCardFields           - applies parsed fields onto an existing card with collection add/remove semantics
 *
 * All new memory objects produced by the parse functions carry the full graph
 * field set (id, source_messages, entities, time_scope, valid_from, valid_to,
 * supersedes, superseded_by, contradicts) so callers never need to add them
 * separately. IDs are generated fresh here; supersession links are populated
 * later by the verifier pass in graph-migration.js.
 */

import { MEMORY_TYPES, SESSION_TYPES, generateMemoryId } from './constants.js';

// ---- Shared helpers -----------------------------------------------------

/**
 * Strips a trailing metadata tag that some models append to content instead of
 * embedding in the opening bracket. Matches patterns like `[2:session]`,
 * `[3:permanent]`, `[2]`, `[session]` at the end of the content string.
 *
 * When found, the tag is removed from the content text and the extracted score
 * and expiration are returned so callers can use them as fallback values when
 * the bracket modifiers did not supply them.
 *
 * @param {string} content - Raw content string, possibly with trailing tag.
 * @returns {{ content: string, importance: number|null, expiration: string|null }}
 */
function stripTrailingTag(content) {
  // Match an optional score (1/2/3) and/or expiration keyword at the end.
  // The tag must contain at least one of them to be considered metadata.
  const m = content.match(/\[\s*(?:([123])\s*:?\s*)?(scene|session|permanent)?\s*\]\s*$/i);
  if (!m || (!m[1] && !m[2])) return { content, importance: null, expiration: null };
  return {
    content: content.slice(0, m.index).trim(),
    importance: m[1] ? parseInt(m[1], 10) : null,
    expiration: m[2] ? m[2].toLowerCase() : null,
  };
}

// ---- Long-term extraction -----------------------------------------------

/**
 * Parses "[type:importance:expiration] content" tagged lines from the model's
 * long-term extraction output. Lines with unrecognised types, very short content,
 * or that don't match the format are silently skipped.
 *
 * Accepted format (spaces around ':' are optional):
 *   [fact] The character's name is Elara.
 *   [relationship:3] She trusts the innkeeper completely.
 *   [event:2:session] They sealed the pact at dawn.
 *
 * @param {string} text - Raw model response.
 * @returns {Array<{type: string, content: string, importance: number, expiration: string, ts: number, consolidated: boolean}>}
 */
export function parseExtractionOutput(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];

  const results = [];
  // Capture type and all modifier fields as a single string, then parse them
  // separately. This is resilient to local models reordering optional fields
  // (score, expiration, entity=) or omitting some of them.
  const linePattern = /^\[(fact|relationship|preference|event)([^\]]*)\]\s*(.+)$/gim;
  let match;

  while ((match = linePattern.exec(text)) !== null) {
    const type = match[1].toLowerCase();
    const modifiers = match[2]; // e.g. ":2:permanent" or ":2:permanent:entity=Senjin,Alex"
    const trailing = stripTrailingTag(match[3].trim());
    // Nested/malformed bracket tags can leave leading `]` noise on the content
    // (e.g. `[fact:...:entity=[Nested]] Content` yields `] Content`). Strip it.
    const content = trailing.content.replace(/^[\]\s]+/, '').trim();

    if (!MEMORY_TYPES.includes(type) || content.length <= 5) continue;

    // Extract optional score (first standalone 1/2/3 preceded by colon).
    // Fall back to trailing tag value if the bracket modifiers omitted it.
    const importanceMatch = modifiers.match(/:\s*([123])\b/);
    const importance = importanceMatch
      ? parseInt(importanceMatch[1], 10)
      : (trailing.importance ?? 2);

    // Extract optional expiration keyword. Fall back to trailing tag value.
    const expirationMatch = modifiers.match(/:\s*(scene|session|permanent)\b/i);
    const expiration = expirationMatch
      ? expirationMatch[1].toLowerCase()
      : (trailing.expiration ?? 'permanent');

    // Extract optional entity names list. Stops at the next colon so reordering
    // does not bleed into other fields. Nested/malformed brackets may leave a
    // name wrapped in `[`/`]`; strip those before use.
    const entityMatch = modifiers.match(/entity=([^:\n]*)/i);
    const rawEntityNames = entityMatch
      ? entityMatch[1]
          .split(',')
          .map((n) => n.replace(/[[\]]/g, '').trim())
          .filter((n) => n.length > 0)
      : [];

    // New entries start as unprocessed - they will be evaluated against the
    // consolidated base before being promoted.
    // _raw_entity_names is a transient pipeline field: resolved to entity ids
    // and stripped before the memory reaches storage.
    results.push({
      type,
      content,
      importance,
      expiration,
      ts: Date.now(),
      consolidated: false,
      _raw_entity_names: rawEntityNames,
      // Graph fields - supersession links are added by the verifier pass.
      id: generateMemoryId(),
      source_messages: [],
      entities: [],
      time_scope: 'global',
      valid_from: null,
      valid_to: null,
      supersedes: [],
      superseded_by: null,
      contradicts: [],
    });
  }

  return results;
}

// ---- Session extraction -------------------------------------------------

/**
 * Parses "[type:importance:expiration] content" tagged lines from the model's
 * session extraction output. Lines with unrecognised types or very short content
 * are skipped. The minimum content length (> 3) is intentionally lower than
 * long-term extraction (> 5) since session details tend to be specific and short.
 *
 * Accepted format (spaces around ':' are optional):
 *   [scene] Candlelit tavern, late evening, rain outside.
 *   [revelation:3] She admits the letter was forged.
 *
 * @param {string} text - Raw model response.
 * @returns {Array<{type: string, content: string, importance: number, expiration: string, ts: number, consolidated: boolean}>}
 */
export function parseSessionOutput(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];
  const results = [];
  // Same flexible bracket-content approach as parseExtractionOutput.
  const pattern = /^\[(scene|revelation|development|detail)([^\]]*)\]\s*(.+)$/gim;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const type = match[1].toLowerCase();
    const modifiers = match[2];
    const trailing = stripTrailingTag(match[3].trim());
    // Same malformed/nested bracket resilience as parseExtractionOutput.
    const content = trailing.content.replace(/^[\]\s]+/, '').trim();

    if (!SESSION_TYPES.includes(type) || content.length <= 3) continue;

    const importanceMatch = modifiers.match(/:\s*([123])\b/);
    const importance = importanceMatch
      ? parseInt(importanceMatch[1], 10)
      : (trailing.importance ?? 2);

    const expirationMatch = modifiers.match(/:\s*(scene|session|permanent)\b/i);
    const expiration = expirationMatch
      ? expirationMatch[1].toLowerCase()
      : (trailing.expiration ?? 'session');

    const entityMatch = modifiers.match(/entity=([^:\n]*)/i);
    const rawEntityNames = entityMatch
      ? entityMatch[1]
          .split(',')
          .map((n) => n.replace(/[[\]]/g, '').trim())
          .filter((n) => n.length > 0)
      : [];

    // New entries start as unprocessed - they will be evaluated against the
    // consolidated base before being promoted.
    // _raw_entity_names is a transient pipeline field: resolved to entity ids
    // and stripped before the memory reaches storage.
    results.push({
      type,
      content,
      importance,
      expiration,
      ts: Date.now(),
      consolidated: false,
      _raw_entity_names: rawEntityNames,
      // Graph fields - session memories use 'session' scope by default.
      id: generateMemoryId(),
      source_messages: [],
      entities: [],
      time_scope: 'session',
      valid_from: null,
      valid_to: null,
      supersedes: [],
      superseded_by: null,
      contradicts: [],
    });
  }
  return results;
}

// ---- Arc extraction -----------------------------------------------------

/**
 * Parses the model's arc extraction response into lists of arcs to add and
 * indices of existing arcs to resolve.
 *
 * New arcs are tagged [arc]. Resolved arcs are tagged [resolved] - the text
 * after the tag is matched against existing arcs by Jaccard word-overlap
 * similarity: arcs with >= 25% overlap are marked for removal. This is
 * intentionally loose to handle the paraphrasing that local models often do.
 *
 * @param {string} text - Raw model response.
 * @param {Array} existingArcs - The current arc list (used for resolution matching).
 * @returns {{add: Array, resolve: number[]}} Arcs to add and indices to remove.
 */
export function parseArcOutput(text, existingArcs) {
  if (!text || text.trim().toUpperCase() === 'NONE') return { add: [], resolve: [] };

  const toAdd = [];
  const toResolve = [];

  const addPattern = /^\[arc\]\s+(.+)$/gim;
  const resolvedPattern = /^\[resolved\]\s+(.+)$/gim;

  let match;
  while ((match = addPattern.exec(text)) !== null) {
    const content = match[1].trim();
    // Require a minimum length to filter obvious noise; rely on the prompt
    // to distinguish arcs from facts rather than vocabulary-based signals,
    // which reject valid arcs from models that phrase threads as noun phrases.
    if (content.length > 15) toAdd.push({ content, ts: Date.now() });
  }

  while ((match = resolvedPattern.exec(text)) !== null) {
    const resolvedText = match[1].trim().toLowerCase();
    // Match against existing arcs using Jaccard word-overlap similarity.
    // A flat "overlap >= 2" count was brittle: short arcs with two shared
    // non-stop words would falsely co-resolve unrelated arcs, while word-form
    // differences (meet/met, promise/promised) caused genuine resolutions to
    // miss. A proportional similarity threshold handles both problems better.
    existingArcs.forEach((arc, idx) => {
      const arcWords = new Set(arc.content.toLowerCase().split(/\s+/).filter(Boolean));
      const resolvedWords = new Set(resolvedText.split(/\s+/).filter(Boolean));
      if (arcWords.size === 0 || resolvedWords.size === 0) return;
      const intersection = [...arcWords].filter((w) => resolvedWords.has(w)).length;
      const union = new Set([...arcWords, ...resolvedWords]).size;
      const similarity = intersection / union;
      // Threshold: require at least 25% Jaccard overlap. This is intentionally
      // permissive - the model already paraphrases the arc in the [resolved]
      // line so exact word matches are rare, but 25% rules out coincidental
      // two-word matches between completely unrelated arcs.
      if (similarity >= 0.25) toResolve.push(idx);
    });
  }

  // Deduplicate resolved indices in case multiple [resolved] lines matched the same arc.
  return { add: toAdd, resolve: [...new Set(toResolve)] };
}

// ---- Continuity check ---------------------------------------------------

// Phrases that indicate the model is saying "all clear" rather than listing
// contradictions. Local models often write verbose explanations instead of
// the single word "NONE" the prompt asks for.
const ALL_CLEAR_PATTERNS = [
  /\bno contradictions?\b/i,
  /\bno conflicts?\b/i,
  /\bdoes not contradict\b/i,
  /\bdoes not conflict\b/i,
  /\bconsistent with\b/i,
  /\baligns? with\b/i,
  /\bno issues? found\b/i,
];

/**
 * Parses the model's continuity check response into an array of contradiction strings.
 * Strips leading bullet/numbering characters. Returns an empty array if the
 * model responded with NONE or produced nothing usable.
 *
 * Only the first non-empty line is checked against all-clear phrases. This
 * prevents local models that write "No conflicts\n\nHere is my reasoning..."
 * from being treated as having found contradictions, while still allowing
 * responses whose first line is a real contradiction to be returned in full.
 *
 * @param {string} text - Raw model response.
 * @returns {string[]}
 */
export function parseContradictions(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];

  // Local models often write a verdict on the first line ("NO CONFLICTS",
  // "No contradictions found") followed by a verbose explanation, rather than
  // outputting NONE. Check only the first non-empty line so we don't
  // accidentally swallow a real contradiction response that happens to contain
  // an all-clear phrase mid-text.
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine && ALL_CLEAR_PATTERNS.some((p) => p.test(firstLine))) return [];

  return (
    text
      .split('\n')
      .map((line) => line.replace(/^[-•*\d.]+\s*/, '').trim())
      // Lines ending with ':' are section headers ("Here are the issues I found:"),
      // not contradictions. Filtering them prevents inflating the badge count.
      .filter((line) => line.length > 0 && !line.endsWith(':'))
  );
}

// ---- Summary formatting -------------------------------------------------

/**
 * Strips the <analysis> scratchpad block and unwraps the <summary> block
 * from the model's raw output. Falls back to the trimmed raw string if
 * no <summary> tags are present.
 *
 * Handles two truncation cases:
 * - Unclosed <analysis>: strips everything from <analysis> up to the first
 *   <summary> tag so analysis content does not bleed into the summary.
 * - Unclosed <summary>: extracts whatever content appeared after the opening
 *   tag rather than returning the entire raw string including the opening tag.
 *
 * @param {string} raw - Raw model output.
 * @returns {string} Cleaned summary text.
 */
export function formatSummary(raw) {
  // Strip analysis block - handle both closed and unclosed tags.
  // If the model didn't write </analysis>, strip everything from <analysis>
  // up to the first [SUMMARY] or <summary> marker.
  let result = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim();
  result = result.replace(/<analysis>[\s\S]*?(?=\[SUMMARY\]|<summary>)/i, '').trim();

  // Primary format: [SUMMARY]...[/SUMMARY] (non-HTML, avoids triggering HTML output).
  const bracketFull = result.match(/\[SUMMARY\]([\s\S]*?)\[\/SUMMARY\]/i);
  if (bracketFull) return stripHtmlTags(bracketFull[1].trim());

  const bracketPartial = result.match(/\[SUMMARY\]([\s\S]*)/i);
  if (bracketPartial) return stripHtmlTags(bracketPartial[1].trim());

  // Fallback: <summary>...</summary> for summaries stored before this change.
  const fullMatch = result.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (fullMatch) return stripHtmlTags(fullMatch[1].trim());

  const partialMatch = result.match(/<summary>([\s\S]*)/i);
  if (partialMatch) return stripHtmlTags(partialMatch[1].trim());

  // Last resort: strip any preamble before the first numbered section.
  const numberedStart = result.search(/^1\./m);
  if (numberedStart > 0) return stripHtmlTags(result.slice(numberedStart).trim());

  return stripHtmlTags(result);
}

/**
 * Removes HTML tags from a string. Some models decorate summary prose with
 * HTML markup (<p>, <strong>, etc.) despite being asked for plain text.
 * Replaces block-level tags with newlines to preserve paragraph breaks.
 * @param {string} text
 * @returns {string}
 */
function stripHtmlTags(text) {
  return text
    .replace(/<\/(p|div|br|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- Profile output parsing ---------------------------------------------

/**
 * Extracts character_state, world_state, and relationship_matrix from the
 * model's profile generation output. Looks for XML-style section tags:
 *
 *   <character_state>...</character_state>
 *   <world_state>...</world_state>
 *   <relationship_matrix>...</relationship_matrix>
 *
 * Returns null if none of the three sections are present (bad output).
 * Partial output (one or two sections found) is returned with the missing
 * sections as null rather than empty strings, so callers can distinguish an
 * omitted section from one the model deliberately left blank - a partial
 * profile is still better than no profile.
 *
 * @param {string} response - Raw model output from buildProfileGenerationPrompt.
 * @returns {{character_state: string|null, world_state: string|null, relationship_matrix: string|null}|null}
 */
export function parseProfileOutput(response) {
  if (!response) return null;

  /**
   * Extracts the content between a pair of XML-style tags.
   * @param {string} tag
   * @returns {string|null}
   */
  function extractSection(tag) {
    const m = response.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].trim() : null;
  }

  const character_state = extractSection('character_state');
  const world_state = extractSection('world_state');
  const relationship_matrix = extractSection('relationship_matrix');

  // All three missing = unusable response.
  if (!character_state && !world_state && !relationship_matrix) return null;

  return {
    character_state: character_state ?? null,
    world_state: world_state ?? null,
    relationship_matrix: relationship_matrix ?? null,
  };
}

// ---- Trigger keyword parser ---------------------------------------------

/**
 * Parses the comma-separated keyword list returned by buildTriggerGenerationPrompt.
 *
 * Filters out any token that is already a word in the memory content - the
 * model sometimes repeats content words despite the instruction. Also drops
 * tokens that are too short, too long, or contain no alphabetic characters.
 * Caps output at 6 entries in case the model over-generates.
 *
 * @param {string} response - Raw model response to the trigger generation prompt.
 * @param {string} memoryContent - The memory content the triggers are for.
 * @returns {string[]} Filtered, lowercased trigger tokens.
 */
export function parseTriggerResponse(response, memoryContent) {
  const contentWords = new Set(
    String(memoryContent || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
  return String(response || '')
    .split(/[,\n]/)
    .flatMap((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .split(/\s+/),
    )
    .filter((t) => t.length >= 3 && t.length <= 40 && /[a-z]/.test(t) && !contentWords.has(t))
    .slice(0, 6);
}

// ---- Relationship delta parser ------------------------------------------

// Matches lines like "Senjin -> Asher: warm(high), cautious(low)"
// The arrow can be -> or the unicode → character. The subject may contain
// hyphens (Jean-Luc, Mary-Jane, Al-Haitham) - only the actual arrow token ends
// it, so use a lookahead instead of excluding "-" outright.
const RELATIONSHIP_LINE_RE = /^((?:(?!->|→)[^:])+?)\s*(?:->|→)\s*([^:]+?)\s*:\s*(.+)$/;
// Matches the inline magnitude suffix: word(low|medium|high)
const INLINE_MAGNITUDE_RE = /\((\s*low|medium|high\s*)\)/i;
const MAGNITUDE_KEYWORDS = new Set(['low', 'medium', 'high']);
// Numeric order for magnitude comparison - used to resolve duplicate root words.
const MAGNITUDE_ORDER = { low: 0, medium: 1, high: 2 };
// Transitional phrases the model sometimes uses to describe change - strip them.
const TRANSITION_RE =
  /\b(?:then\s+(?:more\s+)?|increasingly\s+|still\s+|even\s+more\s+|becoming\s+(?:more\s+)?)/gi;
// Hedge words that should be stripped from descriptor words. Downgrading hedges
// ("slightly", "somewhat") force magnitude to low; upgrading hedges ("very",
// "deeply") force magnitude to high. The magnitude override only applies when
// no explicit inline magnitude was present in the token.
const DOWNGRADE_HEDGE_RE = /^(?:slightly|somewhat|a\s+bit|a\s+little|mildly)\s+/i;
const UPGRADE_HEDGE_RE = /^(?:very|extremely|deeply|intensely|profoundly)\s+/i;

/**
 * Parses the model's relationship delta response into an array of update objects.
 *
 * Each output object has the shape:
 *   { subject: string, target: string, updates: Array<{word, magnitude}>, removals: string[] }
 *
 * updates  - descriptors to add or update (with per-word magnitudes)
 * removals - descriptor words prefixed with ! that should be removed from the stored state
 *
 * Lines that do not match the expected format are silently skipped.
 * Output NONE from the model produces an empty array.
 *
 * @param {string} response - Raw model output from buildRelationshipDeltaPrompt.
 * @returns {Array<{subject: string, target: string, updates: Array<{word: string, magnitude: string}>, removals: string[]}>}
 */
export function parseRelationshipDeltaResponse(response) {
  const lines = String(response || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.toUpperCase() !== 'NONE');

  const results = [];
  for (const line of lines) {
    const match = RELATIONSHIP_LINE_RE.exec(line);
    if (!match) continue;

    const subject = match[1].trim();
    const target = match[2].trim();
    const rest = match[3].trim();

    const updates = [];
    const removals = [];

    for (const token of rest.split(',')) {
      const raw = token.trim();
      if (!raw) continue;

      // Removal marker: !descriptor
      if (raw.startsWith('!')) {
        const word = raw
          .slice(1)
          .replace(INLINE_MAGNITUDE_RE, '')
          .replace(TRANSITION_RE, '')
          .replace(/[^a-z\s-]/g, '')
          .trim()
          .toLowerCase();
        if (word) removals.push(word);
        continue;
      }

      // Parse inline magnitude: word(medium) or word (medium)
      const magMatch = INLINE_MAGNITUDE_RE.exec(raw);
      let magnitude = magMatch ? magMatch[1].trim().toLowerCase() : 'medium';
      let word = raw
        .replace(INLINE_MAGNITUDE_RE, '')
        .replace(TRANSITION_RE, '')
        .replace(/[^a-z\s-]/g, '')
        .trim()
        .toLowerCase();

      // Strip hedge words and adjust magnitude when no explicit magnitude was given.
      // "slightly nervous" → nervous(low); "very nervous" → nervous(high).
      if (!magMatch) {
        if (DOWNGRADE_HEDGE_RE.test(word)) {
          word = word.replace(DOWNGRADE_HEDGE_RE, '').trim();
          magnitude = 'low';
        } else if (UPGRADE_HEDGE_RE.test(word)) {
          word = word.replace(UPGRADE_HEDGE_RE, '').trim();
          magnitude = 'high';
        }
      } else {
        // Even with an explicit magnitude, strip the hedge from the word itself.
        word = word.replace(DOWNGRADE_HEDGE_RE, '').replace(UPGRADE_HEDGE_RE, '').trim();
      }

      if (word && !MAGNITUDE_KEYWORDS.has(word)) {
        updates.push({ word, magnitude });
      }
    }

    // Deduplicate updates by root word: hedge normalization can produce the same
    // word twice with different magnitudes (e.g. "slightly nervous(medium)" and
    // "nervous(medium)" both survive the token loop). Keep only the highest magnitude.
    const deduped = new Map();
    for (const { word, magnitude } of updates) {
      const existing = deduped.get(word);
      if (!existing || MAGNITUDE_ORDER[magnitude] > MAGNITUDE_ORDER[existing.magnitude]) {
        deduped.set(word, { word, magnitude });
      }
    }
    const dedupedUpdates = [...deduped.values()];

    if (subject && target && (dedupedUpdates.length > 0 || removals.length > 0)) {
      results.push({ subject, target, updates: dedupedUpdates, removals });
    }
  }
  return results;
}

// ---- Scene break heuristics ---------------------------------------------

// Patterns that reliably signal a scene transition in roleplay prose.
// Grouped by category for easier tuning: time skips, location transitions,
// and explicit separator markers authors use between scenes.
const SCENE_BREAK_PATTERNS = [
  // Time skips - relative (hours/days/weeks/months/years later)
  // "that evening/night/morning" removed - too broad, fires on incidental
  // references like "that morning he made breakfast" within the same scene.
  /\b(later that (day|night|evening|morning)|the next (day|morning|evening|night)|hours later|days later|weeks later|months later|years? later|a (few )?(hours?|days?|weeks?|months?|years?) (later|passed|had passed)|the following (day|morning|week|month|year)|some time later|meanwhile|after (a while|some time))\b/i,
  // Time skips - absolute jumps ("a year passed", "three months went by")
  /\b(a (year|month|week|decade)|several (years?|months?|weeks?|days?)|[a-z]+ (years?|months?|weeks?|days?) (passed|went by|had passed|had gone by))\b/i,
  // Location transitions - arriving at a named or distinct new place.
  // Allows one or two-word place names and possessives ("Asher's cabin").
  // "entered the room" is still excluded - that is not a scene break.
  /\b(arrived at (the|a|an|\w+'s)\s+\w+(\s+\w+)?|found (himself|herself|themselves|myself|yourself) (in|at) (a|an|the)\s+\w+(\s+\w+)?|made (his|her|their|my|your) way (to|into) (the|a|an|\w+'s)\s+\w+(\s+\w+)?|fled (to|into) (the|a|an)\s+\w+(\s+\w+)?|escaped (to|into) (the|a|an)\s+\w+(\s+\w+)?)\b/i,
  // Location transitions - purposeful travel to a new place.
  // "headed to the door" is a false positive risk but acceptable - in RP
  // context a door is rarely a destination, and the alternative is missing
  // every cabin/barn/hall transition.
  /\b((headed|led (him|her|them|us)|walked|wandered) (over )?(to|into|toward) (the|a|an|\w+'s)\s+\w+(\s+\w+)?)\b/i,
  // Location transitions - establishing a new base or camp.
  /\b(settled (in|into|down in)|made (a|his|her|their|my) (home|camp|base) (in|at)|took (shelter|refuge) (in|at|among))\b/i,
  // Dawn/dusk transitions implying time passage through sleep or rest.
  /\b(as (dawn|morning|daylight|the sun) (broke|crept|arrived|filtered through|rose|spread)|when (dawn|morning) (came|broke|arrived))\b/i,
  /\b(as (night|darkness|dusk|evening) (fell|settled|crept|arrived|descended)|when (night|darkness|dusk) (came|fell|settled))\b/i,
  // Sleep transitions - falling asleep signals the end of a scene.
  /\b(dozed? off|fell asleep|drifted off( to sleep)?|fell into (a |an? )?(deep )?(sleep|slumber))\b/i,
  // Wake transitions - waking up after sleep, with or without dawn markers.
  // The previous pattern required dawn/morning/light which missed natural
  // "they woke up" transitions common in RP.
  /\b((woke|stirred|roused) (up\b|(as |to find\b|beside\b|from (a |his |her |their )?(sleep|slumber|nap|rest))|(as (dawn|morning|light)|with the (sun|light|dawn))))\b/i,
  // Wake from unconsciousness/injury - "regained consciousness", "came to".
  // "opened his eyes" alone is too broad (fires mid-scene); requiring a result
  // clause ("to find", "and found/saw") keeps it to genuine recovery moments.
  /\b(regained consciousness|came to (his|her|their|my|your) senses?|opened (his|her|their|my|your) eyes (to find|and (found|saw)))\b/i,
  // Location transitions - returning to a place after an absence.
  /\b(returned (to|back to) (the|a|an|\w+'s)\s+\w+(\s+\w+)?|made (his|her|their|my|your) way back (to|into) (the|a|an|\w+'s)\s+\w+(\s+\w+)?)\b/i,
  // Location transitions - formal arrival phrasing.
  /\b(upon (arriving|reaching|entering) (at )?(the|a|an|\w+'s)\s+\w+(\s+\w+)?)\b/i,
  // Time skips - "the morning after", "by morning/nightfall/dawn/dusk".
  /\b(the morning after|by (morning|nightfall|dawn|dusk|daybreak|sundown|nighttime))\b/i,
  // Time skips - "in the days/weeks/months that followed".
  /\b(in the (days?|weeks?|months?|years?) (that|which) followed)\b/i,
  // Explicit separator markers (---, ***, * * *)
  /^[-*~]{3,}$/m,
  /\*\s*\*\s*\*/,
];

/**
 * Checks the message text against known scene-break patterns.
 * Fast and free - no model call required.
 * @param {string} messageText - The last AI message to inspect.
 * @returns {boolean} True if a scene break pattern is detected.
 */
export function detectSceneBreakHeuristic(messageText) {
  return SCENE_BREAK_PATTERNS.some((pattern) => pattern.test(messageText));
}

// ---- State Ledger bounds & pruning -----------------------------------------

/**
 * Maximum character length allowed for any single state card field string.
 * Prevents prompt-injection or malformed model responses from bloating the
 * ledger or token footprint.
 */
export const MAX_STATE_FIELD_LENGTH = 500;

/**
 * Maximum number of state cards retained in the ledger. When exceeded,
 * non-character cards are pruned oldest-first so character state - the most
 * narratively important - survives longest.
 */
export const MAX_STATE_LEDGER_CARDS = 100;

/**
 * Truncates a string to `max` characters without splitting a surrogate pair
 * (which would leave a lone surrogate / broken emoji or rare CJK glyph).
 *
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
function safeTruncate(value, max) {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/**
 * Truncates any string field longer than MAX_STATE_FIELD_LENGTH. Non-string
 * values (partial-removal descriptors) pass through untouched. Pure, so it is
 * safe to call from tests.
 *
 * @param {Object} fields
 * @returns {Object}
 */
export function capStateFieldValues(fields) {
  const capped = {};
  for (const [field, value] of Object.entries(fields ?? {})) {
    capped[field] =
      typeof value === 'string' && value.length > MAX_STATE_FIELD_LENGTH
        ? safeTruncate(value, MAX_STATE_FIELD_LENGTH)
        : value;
  }
  return capped;
}

/**
 * Enforces MAX_STATE_LEDGER_CARDS by deleting cards in place. Non-character
 * cards are removed first (oldest insertion order first); if that is not enough
 * to cover the excess, the oldest remaining cards are removed as well.
 *
 * @param {Object} ledger
 * @param {number} [max=MAX_STATE_LEDGER_CARDS]
 * @returns {number} Number of cards removed.
 */
export function pruneStateLedger(ledger, max = MAX_STATE_LEDGER_CARDS) {
  const keys = Object.keys(ledger);
  if (keys.length <= max) return 0;

  const excess = keys.length - max;
  let removed = 0;

  // Pass 1: delete non-character cards oldest-first (by insertion order, which
  // Object.keys preserves for non-integer keys).
  for (const key of keys) {
    if (removed >= excess) break;
    const type = ledger[key]?.type ?? (key.includes('|') ? key.split('|')[1] : key.split(':')[1]);
    if (type !== 'character' && !key.endsWith('|character')) {
      delete ledger[key];
      removed++;
    }
  }

  // Pass 2: if still over the cap, delete oldest remaining cards regardless of type.
  if (removed < excess) {
    for (const key of Object.keys(ledger)) {
      if (removed >= excess) break;
      delete ledger[key];
      removed++;
    }
  }

  return removed;
}

// ---- Epistemic extraction parser ----------------------------------------

// Matches: [hiding] Concealer from Target | content
const EPISTEMIC_HIDING_RE = /^\[hiding\]\s+(.+?)\s+from\s+(.+?)\s*\|\s*(.+)$/i;
// Matches: [tag] Subject | content  (for knows/unaware/suspects/believes)
const EPISTEMIC_STANDARD_RE = /^\[(\w+)\]\s+(.+?)\s*\|\s*(.+)$/i;
const EPISTEMIC_VALID_TYPES = new Set(['knows', 'unaware', 'suspects', 'believes', 'hiding']);

/**
 * Parses the output of an epistemic extraction prompt into structured entries.
 *
 * Handles two line shapes:
 * - Standard: `[tag] Character | content`
 * - Hiding:   `[hiding] Concealer from Target | content`
 *
 * Lines that do not match either pattern, start with '#' or '-' (model notes),
 * or carry an unrecognised tag are silently skipped. Output 'NONE' returns an
 * empty array.
 *
 * @param {string} text - Raw model output.
 * @returns {Array<{type: string, subject: string, target: string|null, content: string}>}
 */
export function parseEpistemicResponse(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];

  const entries = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;

    // Try hiding pattern first - it has a more specific structure.
    let match = EPISTEMIC_HIDING_RE.exec(line);
    if (match) {
      entries.push({
        type: 'hiding',
        subject: match[1].trim(),
        target: match[2].trim(),
        content: match[3].trim(),
      });
      continue;
    }

    match = EPISTEMIC_STANDARD_RE.exec(line);
    if (match) {
      const type = match[1].toLowerCase();
      if (!EPISTEMIC_VALID_TYPES.has(type)) continue;
      entries.push({
        type,
        subject: match[2].trim(),
        target: null,
        content: match[3].trim(),
      });
    }
  }

  return entries;
}

const EPISTEMIC_RETIRE_LINE_RE = /^\[retire\]/i;

/**
 * Maximum number of existing entries the model may retire in a single
 * epistemic extraction pass. Caps runaway `[retire]` output so one bad response
 * cannot wipe a character's whole knowledge base.
 */
export const MAX_EPISTEMIC_RETIREMENTS = 5;

/**
 * Extracts the set of 1-based entry indices the model flagged for retirement.
 *
 * Expects lines of the form `[retire] <number>` mixed in with the regular
 * epistemic output. Only positive integers are returned - zero, negatives, and
 * non-numeric noise are ignored. At most MAX_EPISTEMIC_RETIREMENTS indices are
 * returned per pass; further valid indices are dropped.
 *
 * Lenient parsing: accepts `[retire]3`, `[retire] #2`, `[retire] 1, 3`,
 * trailing punctuation, and other weak-model variations by extracting all
 * digit sequences from any line that starts with `[retire]`.
 *
 * @param {string} text - Raw model output from an epistemic extraction pass.
 * @returns {Set<number>} 1-based indices to retire from the existing entry list.
 */
export function parseEpistemicRetireIndices(text) {
  const indices = new Set();
  if (!text) return indices;
  for (const raw of text.split('\n')) {
    if (indices.size >= MAX_EPISTEMIC_RETIREMENTS) break;
    const trimmed = raw.trim();
    if (!EPISTEMIC_RETIRE_LINE_RE.test(trimmed)) continue;
    const nums = trimmed.replace(EPISTEMIC_RETIRE_LINE_RE, '').match(/\d+/g);
    if (!nums) continue;
    for (const n of nums) {
      const value = Number(n);
      // Only 1-based positive integers are meaningful entry indices.
      if (!Number.isInteger(value) || value <= 0) continue;
      indices.add(value);
      if (indices.size >= MAX_EPISTEMIC_RETIREMENTS) break;
    }
  }
  return indices;
}

// ---- State card parser ------------------------------------------------------

/**
 * Noise values that parsers must strip - placeholder strings Qwen emits instead
 * of omitting unknown fields as instructed.
 */
const STATE_NOISE_VALUES = new Set([
  'unknown',
  'none',
  'none mentioned',
  'not mentioned',
  'not specified',
  'not applicable',
  'n/a',
  'na',
  'unspecified',
]);

/**
 * Collection-style fields whose values accumulate (injuries, carried items,
 * environmental hazards, damage, disguises). Only these may be cleared by the
 * natural-language end-state words below. Attribute fields (location, owner,
 * mood, ...) must not be wiped by a placeholder like `none` - that usually just
 * means "unmentioned in this excerpt".
 */
const REMOVABLE_COLLECTION_FIELDS = new Set([
  'injuries',
  'carried_items',
  'hazards',
  'damage',
  'outfit_disguise',
]);

/** End-state words that clear a removable collection field outright. */
const COLLECTION_CLEAR_VALUES = new Set([
  'none',
  'empty',
  'healed',
  'cleared',
  'repaired',
  'removed',
  'all healed',
  'all cleared',
  'none left',
  'nothing left',
]);

/** Attribute fields only clear on an explicit `cleared` (or `!`-prefix). */
const ATTRIBUTE_CLEAR_VALUES = new Set(['cleared']);

// `<collection>=healed: <item>` / `=dropped: <item>` removes a single item from
// the stored list instead of wiping the whole field.
const COLLECTION_PARTIAL_REMOVAL_RE = /^(?:healed|dropped|removed|cleared)\s*:\s*(.+)$/i;

/**
 * Collection-style fields that accumulate comma/semicolon-separated items.
 * On merge these get add/remove semantics rather than being replaced wholesale.
 */
const STATE_COLLECTION_FIELDS = new Set([
  'injuries',
  'carried_items',
  'hazards',
  'damage',
  'outfit_disguise',
]);

/**
 * Splits a stored collection string into trimmed, non-empty items.
 * @param {*} value
 * @returns {string[]}
 */
function splitCollectionItems(value) {
  return String(value ?? '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Case-insensitive item match: exact, substring, or all target tokens present
 * in the item. Used for partial removals and de-duplication.
 * @param {string} item
 * @param {string} target
 * @returns {boolean}
 */
function collectionItemMatches(item, target) {
  const haystack = String(item ?? '')
    .toLowerCase()
    .trim();
  const needle = String(target ?? '')
    .toLowerCase()
    .trim();
  if (!haystack || !needle) return false;
  if (haystack === needle || haystack.includes(needle)) return true;
  const haystackTokens = haystack.split(/\s+/);
  return needle.split(/\s+/).every((token) => haystackTokens.includes(token));
}

/**
 * Appends items to a list, skipping any already present (either direction).
 * @param {string[]} items
 * @param {string[]} additions
 * @returns {string[]}
 */
function appendUniqueItems(items, additions) {
  const result = [...items];
  for (const raw of additions) {
    const item = String(raw ?? '').trim();
    if (!item) continue;
    const exists = result.some(
      (existing) => collectionItemMatches(existing, item) || collectionItemMatches(item, existing),
    );
    if (!exists) result.push(item);
  }
  return result;
}

/**
 * Applies parsed state-card fields onto an existing card with collection-aware
 * add/remove semantics.
 *
 * Non-collection fields are replaced (with `''` clearing a field). Collection
 * fields (`injuries`, `carried_items`, `hazards`, `damage`, `outfit_disguise`):
 * - a `''` value clears the field entirely
 * - a `{ removeItems }` descriptor removes matching items and keeps the rest
 * - a plain string value appends its items if not already present
 *
 * Pure - no SillyTavern runtime dependency - so it can be unit-tested directly.
 *
 * @param {Object} [existing={}] - Current stored card fields.
 * @param {Object} [incoming={}] - Parsed fields from parseStateCardResponse.
 * @returns {Object} The merged field object.
 */
export function mergeStateCardFields(existing = {}, incoming = {}) {
  const merged = { ...(existing ?? {}) };
  for (const [field, value] of Object.entries(incoming ?? {})) {
    if (!STATE_COLLECTION_FIELDS.has(field)) {
      merged[field] = value;
      continue;
    }

    const current = typeof merged[field] === 'string' ? splitCollectionItems(merged[field]) : [];

    // Structured partial removal descriptor.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const removeItems = Array.isArray(value.removeItems) ? value.removeItems : [];
      const addItems = Array.isArray(value.addItems) ? value.addItems : [];
      let items = current.filter(
        (item) => !removeItems.some((r) => collectionItemMatches(item, r)),
      );
      items = appendUniqueItems(items, addItems);
      merged[field] = items.join(', ');
      continue;
    }

    // Explicit clear.
    if (value === '' || value === null || value === undefined) {
      merged[field] = '';
      continue;
    }

    // Plain string value: append new items (deduped), never wipe the rest.
    merged[field] = appendUniqueItems(current, splitCollectionItems(value)).join(', ');
  }
  return merged;
}

/**
 * Parses the structured state card extraction output into a Map of ledger key
 * to fields object.
 *
 * Expected input format (one entity per line):
 *   [state:EntityName:type] field=value | field=value
 *
 * Noise values (unknown, none, none mentioned, etc.) are stripped per field.
 * Entity entries where no fields survive filtering are dropped entirely.
 *
 * @param {string} raw - Raw model response text.
 * @returns {Map<string, Object>} Map keyed by `name|type`, values are field objects.
 */
export function parseStateCardResponse(raw) {
  const result = new Map();
  if (!raw) return result;

  // Match [state:EntityName:type] at the start of each line.
  const lineRe = /\[state:([^\]]+):([^\]]+)\]\s*(.*)$/i;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toUpperCase() === 'NONE') continue;

    const match = lineRe.exec(trimmed);
    if (!match) continue;

    const name = match[1].trim();
    const type = match[2].trim().toLowerCase();
    const rest = match[3].trim();

    if (!name || !type || !rest) continue;

    const fields = {};
    const clearedFields = new Set();
    // field -> array of item names to remove from the stored collection.
    const removalItems = new Map();
    for (const chunk of rest.split('|')) {
      const trimmedChunk = chunk.trim();
      if (!trimmedChunk) continue;

      // Bare clearing marker for a collection field: `!carried_items` (no '=').
      // Only collection fields are recognised this way so a stray `!word` token
      // cannot silently clear an unrelated attribute.
      if (trimmedChunk.startsWith('!') && !trimmedChunk.includes('=')) {
        const bareField = trimmedChunk.slice(1).trim().toLowerCase().replace(/\s+/g, '_');
        if (REMOVABLE_COLLECTION_FIELDS.has(bareField)) clearedFields.add(bareField);
        continue;
      }

      const eqIdx = trimmedChunk.indexOf('=');
      if (eqIdx === -1) continue;
      const fieldName = trimmedChunk.slice(0, eqIdx).trim().toLowerCase().replace(/\s+/g, '_');
      if (!fieldName) continue;
      const value = trimmedChunk.slice(eqIdx + 1).trim();
      const lowerValue = value.toLowerCase();
      const isCollection = REMOVABLE_COLLECTION_FIELDS.has(fieldName);

      // An empty value always clears the field outright.
      if (value === '') {
        clearedFields.add(fieldName);
        continue;
      }

      if (isCollection) {
        // `field=!item` removes a single item from the stored list rather than
        // wiping the whole field (`field=!` alone still clears it).
        if (value.startsWith('!')) {
          const item = value.slice(1).trim();
          if (!item) {
            clearedFields.add(fieldName);
          } else {
            const list = removalItems.get(fieldName) ?? [];
            list.push(item);
            removalItems.set(fieldName, list);
          }
          continue;
        }

        // `field=healed: item` / `field=dropped: item` partial removal.
        const partial = value.match(COLLECTION_PARTIAL_REMOVAL_RE);
        if (partial) {
          const list = removalItems.get(fieldName) ?? [];
          list.push(partial[1].trim());
          removalItems.set(fieldName, list);
          continue;
        }

        // End-state words ("all healed", "none left", "cleared", "empty", ...)
        // clear the whole collection field.
        if (COLLECTION_CLEAR_VALUES.has(lowerValue)) {
          clearedFields.add(fieldName);
          continue;
        }

        // Strip other noise values - do not store placeholders.
        if (STATE_NOISE_VALUES.has(lowerValue)) continue;

        // Otherwise the value is a list of items to add/append.
        fields[fieldName] = value;
        continue;
      }

      // Attribute fields: an explicit `!`-prefix or `cleared` wipes the value.
      // A placeholder like `location=none` is "unmentioned" and is skipped.
      if (value.startsWith('!') || ATTRIBUTE_CLEAR_VALUES.has(lowerValue)) {
        clearedFields.add(fieldName);
        continue;
      }
      if (STATE_NOISE_VALUES.has(lowerValue)) continue;
      fields[fieldName] = value;
    }

    // Drop the entry only if it contributes no values, clears, or removals.
    if (Object.keys(fields).length === 0 && clearedFields.size === 0 && removalItems.size === 0) {
      continue;
    }

    const key = `${name.toLowerCase().trim()}|${type}`;
    // Merge with any earlier line for the same key (model may split across lines).
    // _name stores the original-case display name - the key itself is lowercased
    // for stable merging but the prompt should show the character's real name.
    const existing = result.get(key) ?? {};
    const merged = { _name: name, ...existing, ...fields };
    // An empty string clears a field during the collection-aware merge in
    // mergeStateCardFields (and state-ledger.js), which is how a field is wiped.
    for (const fieldName of clearedFields) {
      merged[fieldName] = '';
    }
    // Partial removals become structured descriptors the merge applies against
    // the stored list, preserving items that were not targeted.
    for (const [fieldName, items] of removalItems) {
      const prior =
        merged[fieldName] && typeof merged[fieldName] === 'object'
          ? (merged[fieldName].removeItems ?? [])
          : [];
      merged[fieldName] = { removeItems: [...prior, ...items] };
    }
    result.set(key, merged);
  }

  return result;
}
