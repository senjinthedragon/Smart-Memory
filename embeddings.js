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
 * Semantic embedding support for memory deduplication and supersession detection.
 *
 * Uses Ollama's /api/embed endpoint to produce vector representations of memory
 * content. Cosine similarity between vectors catches near-paraphrase duplicates
 * that word-overlap (Jaccard) misses - e.g. "Finn is Senjin's anchor" vs
 * "Finn serves as Senjin's emotional foundation" score near-zero in Jaccard but
 * ~0.92 in cosine space.
 *
 * Falls back to Jaccard automatically when embeddings are disabled, the model
 * is not available, or the API call fails - so the system degrades gracefully
 * for users who have not installed an embedding model.
 *
 * getEmbeddingBatch   - fetches vectors for multiple texts in one API call
 * getEmbedding        - single-text wrapper around getEmbeddingBatch
 * cosineSimilarity    - computes cosine similarity between two vectors
 * batchVerify         - compares candidates against existing memories; returns
 *                       passed (new), superseded (state-change updates), and
 *                       rejected (duplicates)
 * clearEmbeddingCache - clears the in-session cache (call on chat change)
 */

import { extension_settings } from '../../../extensions.js';
import { MODULE_NAME } from './constants.js';

// In-session embedding cache: normalized text -> vector.
// Embeddings are deterministic for a given text + model, so caching within a
// session avoids redundant API calls during catch-up mode. Cleared on chat change.
const embeddingCache = new Map();

/**
 * Fetches embedding vectors for a list of texts in a single API call.
 * Texts already in the cache are not re-fetched. Returns a Map from
 * normalized text to vector. Any text that fails (bad response, network
 * error) will be absent from the returned Map - callers fall back to Jaccard.
 * @param {string[]} texts
 * @returns {Promise<Map<string, number[]>>}
 */
export async function getEmbeddingBatch(texts) {
  const settings = extension_settings[MODULE_NAME];
  const result = new Map();

  if (!settings.embedding_enabled || !Array.isArray(texts) || texts.length === 0) return result;

  const normalized = texts.map((t) => String(t || '').trim()).filter(Boolean);
  if (normalized.length === 0) return result;

  // Populate from cache first - only fetch what is missing.
  const uncached = [];
  for (const text of normalized) {
    if (embeddingCache.has(text)) {
      result.set(text, embeddingCache.get(text));
    } else {
      uncached.push(text);
    }
  }

  if (uncached.length === 0) return result;

  const baseUrl = (settings.embedding_url || 'http://localhost:11434').replace(/\/$/, '');
  const model = settings.embedding_model || 'nomic-embed-text';
  const keep = settings.embedding_keep ?? false;

  try {
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: uncached,
        model,
        keep_alive: keep ? -1 : undefined,
        truncate: true,
      }),
    });

    if (!response.ok) return result;

    const data = await response.json();
    const embeddings = data?.embeddings;
    if (!Array.isArray(embeddings)) return result;

    for (let i = 0; i < uncached.length; i++) {
      const vector = embeddings[i];
      if (Array.isArray(vector) && vector.length > 0) {
        embeddingCache.set(uncached[i], vector);
        result.set(uncached[i], vector);
      }
    }
  } catch {
    // Network error, model not found, Ollama not running - callers fall back to Jaccard.
  }

  return result;
}

/**
 * Fetches a normalized embedding vector for a single text.
 * Convenience wrapper around getEmbeddingBatch for single-text callers.
 * Returns null if embeddings are disabled or the API call fails.
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
export async function getEmbedding(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return null;
  const result = await getEmbeddingBatch([normalized]);
  return result.get(normalized) ?? null;
}

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

// Patterns that signal a memory is describing a state change rather than
// restating an existing fact. Used to distinguish supersession from duplication:
// two memories about the same topic where the new one contains a state-change
// marker are treated as supersession (old fact retired), not duplication (rejected).
//
// Deliberately conservative - false negatives (missing a supersession) are
// handled by later consolidation; false positives (wrongly retiring a valid
// memory) are harder to recover from.
const STATE_CHANGE_PATTERNS = [
  /\bno longer\b/i,
  /\bnot anymore\b/i,
  /\bno more\b/i,
  /\bstopped\b/i,
  /\bmoved (?:to|away|from|out)\b/i,
  /\bbroke up\b/i,
  /\bformerly\b/i,
  /\bused to\b/i,
  /\bbecame\b/i,
  /\bswitched (?:to|from)\b/i,
  /\bnow (?:lives?|works?|is|has)\b/i,
  /\breconciled\b/i,
  /\bseparated\b/i,
  /\bended the\b/i,
];

/**
 * Returns true if the text contains a word or phrase that signals a change
 * in state rather than a restatement of an existing fact.
 * @param {string} text
 * @returns {boolean}
 */
function hasStateChangeMarker(text) {
  return STATE_CHANGE_PATTERNS.some((p) => p.test(text));
}

/**
 * Jaccard word-overlap similarity between two strings. Used as a fallback when
 * embeddings are unavailable.
 * @param {string} a
 * @param {string} b
 * @returns {number} Similarity in [0, 1].
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const overlap = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size || 1;
  return overlap / union;
}

/**
 * Batch-verifies a list of candidate memories against existing memories,
 * classifying each candidate into one of three buckets:
 *
 *   passed     - genuinely new information, should be added
 *   superseded - same topic as an existing memory but state has changed;
 *                the existing memory should be retired and this one added
 *   (neither)  - near-duplicate with no state change; silently dropped
 *
 * All unique texts are embedded in a single API call, then cosine similarity
 * is computed locally. Falls back to Jaccard when embeddings are unavailable.
 *
 * Supersession heuristic (Profile A - no model call):
 *   When a candidate scores above the "same-topic" lower threshold against an
 *   existing memory of the same type, AND the candidate text contains a
 *   state-change marker (e.g. "no longer", "moved to", "became"), it is
 *   classified as superseding the best-matching existing memory rather than
 *   being rejected as a duplicate.
 *
 * Thresholds (semantic / Jaccard fallback):
 *   duplicate threshold  0.82 / 0.65  - above this, same-type = duplicate
 *   same-topic threshold 0.55 / 0.40  - above this, same-topic check applies
 *   cross-type duplicate 0.88 / 0.75
 *
 * @param {Array<{content: string, type: string, id?: string}>} candidates
 * @param {Array<{content: string, type: string, id?: string}>} existing
 * @returns {Promise<{passed: Set<string>, superseded: Map<string, string>, semantic: boolean}>}
 *   passed     - Set of candidate content strings (lowercase) that are new
 *   superseded - Map from candidate content string to the id of the existing
 *                memory it replaces (only present when ex.id is available)
 *   semantic   - true if cosine similarity was used, false if Jaccard
 */
export async function batchVerify(candidates, existing) {
  const passed = new Set();
  const superseded = new Map(); // candContent -> existingId
  if (!candidates || candidates.length === 0) return { passed, superseded, semantic: false };

  // Embed all unique texts in one call.
  const allTexts = [
    ...candidates.map((m) =>
      String(m.content || '')
        .toLowerCase()
        .trim(),
    ),
    ...existing.map((m) =>
      String(m.content || '')
        .toLowerCase()
        .trim(),
    ),
  ];
  const vectorMap = await getEmbeddingBatch(allTexts);
  const anyEmbeddings = vectorMap.size > 0;

  for (const cand of candidates) {
    const candText = String(cand.content || '')
      .toLowerCase()
      .trim();
    const candVec = anyEmbeddings ? (vectorMap.get(candText) ?? null) : null;
    const candHasStateChange = hasStateChangeMarker(candText);

    let isDuplicate = false;
    let bestSupersessionScore = 0;
    let bestSupersessionId = null;

    for (const ex of existing) {
      const exText = String(ex.content || '')
        .toLowerCase()
        .trim();
      const exVec = anyEmbeddings ? (vectorMap.get(exText) ?? null) : null;

      // Choose scoring method and thresholds. Fall back to Jaccard with its
      // own thresholds when either vector is missing - mixing methods and
      // thresholds produces wrong results.
      let score, dupThreshold, crossDupThreshold, sameTopicThreshold;
      if (candVec && exVec) {
        score = cosineSimilarity(candVec, exVec);
        dupThreshold = 0.82;
        crossDupThreshold = 0.88;
        sameTopicThreshold = 0.55;
      } else {
        score = jaccardSimilarity(candText, exText);
        dupThreshold = 0.65;
        crossDupThreshold = 0.75;
        sameTopicThreshold = 0.4;
      }

      const isSameType = ex.type === cand.type;
      const effectiveDupThreshold = isSameType ? dupThreshold : crossDupThreshold;

      if (score >= effectiveDupThreshold) {
        // High similarity: would normally be a duplicate. If the candidate
        // contains a state-change marker it is superseding this fact instead.
        if (isSameType && candHasStateChange && ex.id && score > bestSupersessionScore) {
          bestSupersessionScore = score;
          bestSupersessionId = ex.id;
        } else {
          isDuplicate = true;
          break;
        }
      } else if (isSameType && score >= sameTopicThreshold && candHasStateChange && ex.id) {
        // Medium similarity on same topic + state-change marker: likely supersession
        // even though the wording has changed enough that it didn't hit the dup threshold.
        if (score > bestSupersessionScore) {
          bestSupersessionScore = score;
          bestSupersessionId = ex.id;
        }
      }
    }

    if (isDuplicate) continue; // silently drop

    if (bestSupersessionId !== null) {
      // Supersession: candidate replaces an existing memory.
      superseded.set(candText, bestSupersessionId);
      passed.add(candText); // still added to the store, just linked
    } else {
      passed.add(candText);
    }
  }

  return { passed, superseded, semantic: anyEmbeddings };
}

/**
 * Clears the in-session embedding cache.
 * Called on CHAT_CHANGED / CHAT_LOADED to prevent unbounded memory growth.
 */
export function clearEmbeddingCache() {
  embeddingCache.clear();
}
