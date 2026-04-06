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
 * Shared utility helpers for memory retention and consolidation.
 *
 * prioritizeMemories    - sorts memories by durability/importance/keyword-recurrence/recency
 * trimByPriority        - trims a memory array to a cap, keeping durable/high-importance/newer entries
 * reconcileTypeEntries  - merges promoted consolidation entries into a base, replacing overlapping originals
 * sortByTimeline        - sorts memories by timestamp (oldest to newest) for timeline-friendly injection
 */

function tokenSet(text) {
  return new Set((text || '').toLowerCase().split(/\s+/).filter(Boolean));
}

function jaccardSimilarity(a, b) {
  const aWords = tokenSet(a);
  const bWords = tokenSet(b);
  if (aWords.size === 0 || bWords.size === 0) return 0;
  const intersection = [...aWords].filter((w) => bWords.has(w)).length;
  const union = new Set([...aWords, ...bWords]).size;
  return union > 0 ? intersection / union : 0;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'that',
  'the',
  'their',
  'them',
  'there',
  'they',
  'this',
  'to',
  'us',
  'was',
  'we',
  'were',
  'with',
  'you',
  'your',
]);

const EXPIRATION_WEIGHT = {
  permanent: 3,
  session: 2,
  scene: 1,
};

function normalizeExpiration(value, fallback = 'session') {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'scene' || normalized === 'session' || normalized === 'permanent') {
    return normalized;
  }
  return fallback;
}

function keywordSet(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

function buildKeywordFrequency(memories) {
  const freq = new Map();
  for (const mem of memories) {
    const words = keywordSet(mem.content);
    for (const w of words) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return freq;
}

function keywordFrequencyScore(mem, freq) {
  let score = 0;
  for (const w of keywordSet(mem.content)) {
    score += freq.get(w) ?? 0;
  }
  return score;
}

/**
 * Trims a memory array to at most `max` entries, preferring to keep
 * durable memories, then high-importance and newer entries when dropping.
 * Also uses keyword-frequency weighting so repeated themes are retained.
 *
 * Returns a new array; does not mutate the input.
 *
 * @param {Array<{importance?: number, ts: number}>} memories
 * @param {number} max
 * @returns {Array}
 */
export function prioritizeMemories(memories) {
  const keywordFreq = buildKeywordFrequency(memories);
  return [...memories].sort((a, b) => {
    const ia = a.importance ?? 2;
    const ib = b.importance ?? 2;
    const ea = EXPIRATION_WEIGHT[normalizeExpiration(a.expiration)] ?? 2;
    const eb = EXPIRATION_WEIGHT[normalizeExpiration(b.expiration)] ?? 2;
    if (ea !== eb) return eb - ea; // keep permanent/session before scene
    if (ia !== ib) return ib - ia; // higher importance first
    const ka = keywordFrequencyScore(a, keywordFreq);
    const kb = keywordFrequencyScore(b, keywordFreq);
    if (ka !== kb) return kb - ka; // keep memories with repeated key terms
    return (b.ts ?? 0) - (a.ts ?? 0); // newer first within same tier
  });
}

export function trimByPriority(memories, max) {
  if (memories.length <= max) return memories;
  return prioritizeMemories(memories).slice(0, max);
}

/**
 * Returns a new array sorted by timeline (oldest to newest).
 * Falls back to the original index when timestamps tie/missing.
 *
 * @param {Array<{ts?: number}>} memories
 * @returns {Array}
 */
export function sortByTimeline(memories) {
  return [...memories]
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ta = Number.isFinite(a.m.ts) ? a.m.ts : Number.MAX_SAFE_INTEGER;
      const tb = Number.isFinite(b.m.ts) ? b.m.ts : Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map((x) => x.m);
}

/**
 * Reconciles a set of promoted consolidation entries against an existing base.
 *
 * When the model outputs an enriched or updated version of a base entry (e.g.
 * "We are married. Happily." as a follow-up to "We are married."), we want to
 * replace the original rather than append alongside it. This function uses
 * Jaccard word-overlap to detect when a promoted entry substantially overlaps
 * with a base entry of the same type - if it does, the base entry is replaced
 * in-place. Genuinely new entries are appended.
 *
 * @param {Array<{type: string, content: string}>} base - Stable consolidated entries for one type.
 * @param {Array<{type: string, content: string}>} promoted - Entries output by consolidation for the same type.
 * @param {number} threshold - Jaccard overlap threshold above which a promoted entry replaces a base entry.
 * @param {Array<{type: string, content: string, ts?: number}>} [timelinePool=[]] - Candidate entries for timestamp inference.
 * @returns {Array} The reconciled array (new array, base is not mutated).
 */
export function reconcileTypeEntries(base, promoted, threshold, timelinePool = []) {
  const sourcePool = timelinePool.length > 0 ? timelinePool : base;
  const reconciled = [...base];
  for (const mem of promoted) {
    const idx = reconciled.findIndex((ex) => {
      if (ex.type !== mem.type) return false;
      return jaccardSimilarity(mem.content, ex.content) > threshold;
    });

    let inferredTs = mem.ts;
    let bestScore = 0;
    for (const src of sourcePool) {
      if (src.type !== mem.type) continue;
      const score = jaccardSimilarity(mem.content, src.content);
      if (score > bestScore && Number.isFinite(src.ts)) {
        bestScore = score;
        inferredTs = src.ts;
      }
    }

    if (idx >= 0) {
      const existingTs = reconciled[idx].ts;
      reconciled[idx] = { ...mem, ts: Number.isFinite(existingTs) ? existingTs : inferredTs };
    } else {
      reconciled.push({ ...mem, ts: inferredTs });
    }
  }
  return reconciled;
}
