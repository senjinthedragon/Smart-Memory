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
 * parseExtractionOutput     - parses [type:score:expiration:entity=...] tagged lines from long-term extraction
 * parseSessionOutput        - parses [type:score:expiration:entity=...] tagged lines from session extraction
 * parseArcOutput            - parses [arc] / [resolved] tagged lines from arc extraction
 * parseContradictions       - parses contradiction lines from a continuity check response
 * formatSummary             - strips model analysis scaffolding and extracts the summary text
 * detectSceneBreakHeuristic - pattern-based scene break check, no model call required
 *
 * All new memory objects produced by the parse functions carry the full graph
 * field set (id, source_messages, entities, time_scope, valid_from, valid_to,
 * supersedes, superseded_by, contradicts) so callers never need to add them
 * separately. IDs are generated fresh here; supersession links are populated
 * later by the verifier pass in graph-migration.js.
 */

import { MEMORY_TYPES, SESSION_TYPES, generateMemoryId } from './constants.js';

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
    const content = match[3].trim();

    if (!MEMORY_TYPES.includes(type) || content.length <= 5) continue;

    // Extract optional score (first standalone 1/2/3 preceded by colon).
    const importanceMatch = modifiers.match(/:\s*([123])\b/);
    const importance = importanceMatch ? parseInt(importanceMatch[1], 10) : 2;

    // Extract optional expiration keyword.
    const expirationMatch = modifiers.match(/:\s*(scene|session|permanent)\b/i);
    const expiration = expirationMatch ? expirationMatch[1].toLowerCase() : 'permanent';

    // Extract optional entity names list. Stops at the next colon so reordering
    // does not bleed into other fields.
    const entityMatch = modifiers.match(/entity=([^:[\]]*)/i);
    const rawEntityNames = entityMatch
      ? entityMatch[1]
          .split(',')
          .map((n) => n.trim())
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
    const content = match[3].trim();

    if (!SESSION_TYPES.includes(type) || content.length <= 3) continue;

    const importanceMatch = modifiers.match(/:\s*([123])\b/);
    const importance = importanceMatch ? parseInt(importanceMatch[1], 10) : 2;

    const expirationMatch = modifiers.match(/:\s*(scene|session|permanent)\b/i);
    const expiration = expirationMatch ? expirationMatch[1].toLowerCase() : 'session';

    const entityMatch = modifiers.match(/entity=([^:[\]]*)/i);
    const rawEntityNames = entityMatch
      ? entityMatch[1]
          .split(',')
          .map((n) => n.trim())
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
    if (content.length > 5) toAdd.push({ content, ts: Date.now() });
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

  return text
    .split('\n')
    .map((line) => line.replace(/^[-•*\d.]+\s*/, '').trim())
    .filter((line) => line.length > 0);
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
  // up to the first <summary> tag so it doesn't bleed into the summary content.
  let result = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim();
  // Fallback: unclosed <analysis> - strip from tag to start of <summary>
  result = result.replace(/<analysis>[\s\S]*?(?=<summary>)/i, '').trim();
  // Try a complete <summary>...</summary> block first.
  const fullMatch = result.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (fullMatch) {
    return fullMatch[1].trim();
  }
  // If the closing tag is missing the model was cut off mid-response.
  // Extract whatever content appeared after the opening tag rather than
  // falling back to the raw string which still contains the opening tag.
  const partialMatch = result.match(/<summary>([\s\S]*)/i);
  if (partialMatch) {
    return partialMatch[1].trim();
  }
  return result;
}

// ---- Scene break heuristics ---------------------------------------------

// Patterns that reliably signal a scene transition in roleplay prose.
// Grouped by category for easier tuning: time skips, location transitions,
// and explicit separator markers authors use between scenes.
const SCENE_BREAK_PATTERNS = [
  // Time skips - relative (hours/days/weeks/months/years later)
  /\b(later that (day|night|evening|morning)|the next (day|morning|evening|night)|hours later|days later|weeks later|months later|years? later|a (few )?(hours?|days?|weeks?|months?|years?) (later|passed|had passed)|the following (day|morning|week|month|year)|some time later|meanwhile|after (a while|some time)|that (evening|night|afternoon|morning))\b/i,
  // Time skips - absolute jumps ("a year passed", "three months went by")
  /\b(a (year|month|week|decade)|several (years?|months?|weeks?|days?)|[a-z]+ (years?|months?|weeks?|days?) (passed|went by|had passed|had gone by))\b/i,
  // Location transitions - arriving at a named or distinct new place.
  // Deliberately narrow: "entered the room" is not a scene break, but
  // "arrived at the castle" or "found herself in a foreign city" is.
  /\b(arrived at (the|a|an)\s+\w+|found (himself|herself|themselves|myself|yourself) (in|at) (a|an|the)\s+\w+|made (his|her|their|my|your) way (to|into) (the|a|an)\s+\w+|fled (to|into) (the|a|an)\s+\w+|escaped (to|into) (the|a|an)\s+\w+)\b/i,
  // Location transitions - establishing a new base or camp.
  /\b(settled (in|into|down in)|made (a|his|her|their|my) (home|camp|base) (in|at)|took (shelter|refuge) (in|at|among))\b/i,
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
