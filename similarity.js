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
 * Pure math functions for memory similarity scoring. No SillyTavern runtime dependencies.
 *
 * Extracted here so unit tests can import memory-utils.js without pulling in
 * embeddings.js, which requires the ST runtime (extensions.js).
 *
 * cosineSimilarity     - cosine similarity between two equal-length vectors
 * jaccardSimilarity    - word-overlap similarity between two strings
 * STATE_CHANGE_PATTERNS - regexes that signal a state change vs. a restatement
 * hasStateChangeMarker - returns true when text contains a state-change signal
 */

/**
 * Computes cosine similarity between two equal-length vectors.
 * Returns 0 if either argument is null/empty or the lengths differ.
 * @param {number[]|null} a
 * @param {number[]|null} b
 * @returns {number} Similarity in [0, 1].
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Jaccard word-overlap similarity between two strings.
 * Returns 0 if either string is empty after tokenization.
 * @param {string} a
 * @param {string} b
 * @returns {number} Similarity in [0, 1].
 */
export function jaccardSimilarity(a, b) {
  const setA = new Set(
    String(a || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  const setB = new Set(
    String(b || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  if (setA.size === 0 || setB.size === 0) return 0;
  const overlap = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size || 1;
  return overlap / union;
}

// Patterns that signal a memory describes a state change rather than
// restating an existing fact. Used to distinguish supersession from duplication:
// two memories about the same topic where the new one contains a state-change
// marker are treated as supersession (old fact retired), not duplication (rejected).
//
// Deliberately conservative - false negatives (missing a supersession) are
// handled by later consolidation; false positives (wrongly retiring a valid
// memory) are harder to recover from.
export const STATE_CHANGE_PATTERNS = [
  /\bno longer\b/i,
  /\bnot anymore\b/i,
  /\bno more\b/i,
  /\bstopped\b/i,
  /\bmoved (?:to|away|from|out)\b/i,
  /\bbroke up\b/i,
  /\bformer(?:ly)?\b/i,
  /\bused to\b/i,
  /\bbecame\b/i,
  /\bswitched (?:to|from)\b/i,
  // "now" followed by any verb or noun signals a state update - broad but only
  // fires alongside a semantic similarity check so false positives are rare.
  /\bare now\b/i,
  /\bis now\b/i,
  /\bnow \w/i,
  /\breconciled\b/i,
  /\bseparated\b/i,
  /\bended the\b/i,
  /\bhas since\b/i,
  /\bonce (?:was|were|believed?|thought|feared?|distrusted?)\b/i,
];

/**
 * Returns true if the text contains a word or phrase that signals a change
 * in state rather than a restatement of an existing fact.
 * @param {string} text
 * @returns {boolean}
 */
export function hasStateChangeMarker(text) {
  return STATE_CHANGE_PATTERNS.some((p) => p.test(text));
}
