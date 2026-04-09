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
 * Semantic embedding support for memory deduplication.
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
 * batchVerify         - compares a list of candidates against existing vectors
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
 * Batch-verifies a list of candidate memory texts against existing memory texts.
 *
 * All unique texts (candidates + existing) are embedded in a single API call,
 * then cosine similarity is computed locally - one nomic call per verification
 * pass instead of one call per candidate. Falls back to Jaccard per-pair when
 * embeddings are unavailable.
 *
 * Returns a Set of candidate texts that are NOT near-duplicates of any existing
 * entry. Callers use this set to filter their candidate arrays.
 *
 * Thresholds:
 *   semantic=true  -> same-type: 0.82, cross-type: 0.88
 *   semantic=false -> same-type: 0.65, cross-type: 0.75
 *
 * @param {Array<{content: string, type: string}>} candidates
 * @param {Array<{content: string, type: string}>} existing
 * @returns {Promise<{passed: Set<string>, semantic: boolean}>}
 *   passed  - Set of candidate content strings that are not near-duplicates
 *   semantic - true if cosine was used, false if Jaccard fallback was used
 */
export async function batchVerify(candidates, existing) {
  const passed = new Set();
  if (!candidates || candidates.length === 0) return { passed, semantic: false };

  // Collect all unique texts needed and embed them in one call.
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

    let isDuplicate = false;
    for (const ex of existing) {
      const exText = String(ex.content || '')
        .toLowerCase()
        .trim();

      // Select threshold and scoring method per pair. Fall back to Jaccard
      // with Jaccard thresholds when either vector is missing - using a
      // semantic threshold against a Jaccard score would give wrong results.
      let score;
      let sameThreshold;
      let crossThreshold;
      const exVec = anyEmbeddings ? (vectorMap.get(exText) ?? null) : null;
      if (candVec && exVec) {
        score = cosineSimilarity(candVec, exVec);
        sameThreshold = 0.82;
        crossThreshold = 0.88;
      } else {
        score = jaccardSimilarity(candText, exText);
        sameThreshold = 0.65;
        crossThreshold = 0.75;
      }

      const threshold = ex.type === cand.type ? sameThreshold : crossThreshold;
      if (score > threshold) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) passed.add(candText);
  }

  const useSemantic = anyEmbeddings;

  return { passed, semantic: useSemantic };
}

/**
 * Clears the in-session embedding cache.
 * Called on CHAT_CHANGED / CHAT_LOADED to prevent unbounded memory growth.
 */
export function clearEmbeddingCache() {
  embeddingCache.clear();
}
