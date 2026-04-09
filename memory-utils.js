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

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

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
    const sa = memoryUtilityScore(a, keywordFreq);
    const sb = memoryUtilityScore(b, keywordFreq);
    if (sa !== sb) return sb - sa;
    return numberOr(b.ts, 0) - numberOr(a.ts, 0) || 0;
  });
}

/**
 * Utility-decay style score used for retention and trimming.
 * Higher score means "keep this memory longer".
 *
 * Signals:
 * - durability via expiration class
 * - explicit importance from extractor
 * - persona and intimacy relevance (character-card continuity)
 * - confidence (if present)
 * - retrieval count and confirmation freshness
 * - keyword recurrence in the current pool
 *
 * @param {Object} mem
 * @param {Map<string, number>} [keywordFreq]
 * @returns {number}
 */
export function memoryUtilityScore(mem, keywordFreq = null) {
  const expiration = EXPIRATION_WEIGHT[normalizeExpiration(mem.expiration)] ?? 2;
  const importance = numberOr(mem.importance, 2);
  const confidence = Math.max(0, Math.min(1, numberOr(mem.confidence, 0.7)));
  const personaRelevance = Math.max(0, Math.min(3, numberOr(mem.persona_relevance, 1)));
  const intimacyRelevance = Math.max(0, Math.min(3, numberOr(mem.intimacy_relevance, 1)));
  const retrievalCount = Math.max(0, numberOr(mem.retrieval_count, 0));
  const confirmedTs = numberOr(mem.last_confirmed_ts, mem.ts ?? 0);
  const recencyBoost = confirmedTs > 0 ? confirmedTs / 1e13 : 0;
  const keywordScore = keywordFreq ? keywordFrequencyScore(mem, keywordFreq) : 0;

  return (
    importance * 100 +
    expiration * 35 +
    confidence * 25 +
    personaRelevance * 25 +
    intimacyRelevance * 20 +
    Math.min(20, retrievalCount * 2) +
    keywordScore * 2 +
    recencyBoost
  );
}

export function trimByPriority(memories, max) {
  if (memories.length <= max) return memories;
  return prioritizeMemories(memories).slice(0, max);
}

/**
 * Selects protected memories that must be preserved during budget trimming.
 * Keeps at most one per requested type, preferring highest utility.
 *
 * @param {Array} memories
 * @param {Array<string>} requiredTypes
 * @returns {Array}
 */
export function selectProtectedMemories(memories, requiredTypes) {
  const prioritized = prioritizeMemories(memories);
  const selected = [];
  const used = new Set();
  for (const type of requiredTypes) {
    const pick = prioritized.find((m) => m.type === type && !used.has(m));
    if (pick) {
      selected.push(pick);
      used.add(pick);
    }
  }
  return selected;
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
 * Builds a compact "current scene state" block from session memories.
 * Prioritizes the newest memory per scene-oriented type.
 *
 * @param {Array<{type?: string, content?: string, ts?: number}>} memories
 * @returns {string}
 */
export function buildCurrentSceneStateBlock(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return '';

  const newestByType = new Map();
  for (const mem of memories) {
    const type = String(mem.type || '').toLowerCase();
    if (!['scene', 'development', 'detail', 'revelation'].includes(type)) continue;
    const existing = newestByType.get(type);
    const currentTs = Number.isFinite(mem.ts) ? mem.ts : 0;
    const existingTs = Number.isFinite(existing?.ts) ? existing.ts : 0;
    if (!existing || currentTs >= existingTs) {
      newestByType.set(type, mem);
    }
  }

  const lines = [];
  const scene = newestByType.get('scene');
  const development = newestByType.get('development');
  const detail = newestByType.get('detail');
  const revelation = newestByType.get('revelation');

  if (scene?.content) lines.push(`- Setting/atmosphere: ${scene.content}`);
  if (development?.content) lines.push(`- Relationship/situation shift: ${development.content}`);
  if (detail?.content) lines.push(`- Immediate continuity detail: ${detail.content}`);
  if (revelation?.content) lines.push(`- Newly revealed context: ${revelation.content}`);

  if (lines.length === 0) return '';
  return `Current scene state:\n${lines.join('\n')}`;
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

    // Default to now so the entry always has a valid timestamp even if no
    // source pool entry scores above the minimum inference threshold.
    let inferredTs = Number.isFinite(mem.ts) ? mem.ts : Date.now();
    let bestScore = 0;
    // Require a minimum similarity before accepting an inferred timestamp - a
    // near-random match (score ~0.05) is not a meaningful source for the timeline.
    const MIN_TS_INFERENCE_SCORE = 0.3;
    for (const src of sourcePool) {
      if (src.type !== mem.type) continue;
      const score = jaccardSimilarity(mem.content, src.content);
      if (score > bestScore && score >= MIN_TS_INFERENCE_SCORE && Number.isFinite(src.ts)) {
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
