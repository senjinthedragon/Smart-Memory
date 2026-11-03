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
 * Shared utility helpers for memory retention, consolidation, and hybrid retrieval.
 *
 * prioritizeMemories        - sorts memories by durability/importance/keyword-recurrence/recency
 * trimByPriority            - trims a memory array to a cap, keeping durable/high-importance/newer entries
 * reconcileTypeEntries      - merges promoted consolidation entries into a base, replacing overlapping originals
 * sortByTimeline            - sorts memories by timestamp (oldest to newest) for timeline-friendly injection
 * extractTurnEntityMentions - lightweight regex extraction of proper-noun candidates from last messages
 * keywordSet                - returns the set of significant (3+ char, non-stopword) lowercase tokens from a string
 * deriveTriggers            - extracts keyword trigger candidates from a memory's content string (Profile B write path)
 * filterTriggersByFrequency - drops triggers that appear in more than `threshold` fraction of all memories
 * hybridScore               - weighted blend of utility, entity overlap, arc relevance, temporal proximity,
 *                             w5 turn similarity, and contextual relevance bonus (content-word overlap + LLM triggers)
 * hybridPrioritize          - sorts a memory array by hybridScore then applies a diversity floor;
 *                             accepts embedFn, lastTurnText, w5, and recentText in context
 * classifyTurn              - heuristic turn-type classifier (dialogue/action/transition/intimate)
 * adaptiveBudgets           - adjusts injection budgets per tier based on turn type
 * splitSummarySections      - splits a formatted short-term summary into numbered sections
 * truncateSummaryToBudget   - trims earlier summary sections while preserving Current Moment and Next Beat
 * matchSubjectToMember      - resolves an epistemic subject to a group member (exact/token/prefix)
 * setSmartMemoryLogger      - injects the logger used by the pure helpers (kept runtime-free)
 * partitionEpistemicEntriesBySubject - groups group-chat epistemic entries into per-character buckets
 *
 * Note: this module has no SillyTavern runtime dependencies. Embedding calls are injected via
 * the embedFn parameter so tests can run under plain Node without loading extensions.js.
 */

import { cosineSimilarity, jaccardSimilarity } from './similarity.js';
import { estimateTokens } from './constants.js';

// Module-level logger, injectable so these pure helpers stay importable under
// plain Node (logging.js pulls in the SillyTavern runtime). Production code
// wires this to smLog via setSmartMemoryLogger() on module load.
let smLog = () => {};

/**
 * Injects the Smart Memory logger used by the pure helpers (for example the
 * ambiguous-epistemic-subject warning). Kept injectable so this module has no
 * runtime dependency on logging.js or the SillyTavern runtime.
 * @param {(...args: any[]) => void} fn
 */
export function setSmartMemoryLogger(fn) {
  if (typeof fn === 'function') smLog = fn;
}

function tokenSet(text) {
  return new Set((text || '').toLowerCase().split(/\s+/).filter(Boolean));
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

export function keywordSet(text) {
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
 * Extracts keyword trigger candidates from a memory content string.
 *
 * Returns the set of lowercase word tokens (4+ chars, non-stopword) from the
 * content, minus any token that exactly matches a name in excludeNames. Names
 * are excluded unconditionally because they appear in almost every memory and
 * would become useless high-frequency triggers that match everything.
 *
 * @param {string} content - Memory content string.
 * @param {string[]} [excludeNames=[]] - Character/group-member names to exclude.
 * @returns {string[]} Deduplicated array of candidate trigger tokens.
 */
export function deriveTriggers(content, excludeNames = []) {
  const excluded = new Set(excludeNames.map((n) => n.toLowerCase().trim()));
  return [
    ...new Set(
      String(content || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !excluded.has(w)),
    ),
  ];
}

/**
 * Filters a set of trigger candidates by corpus frequency.
 *
 * Triggers that appear (as a substring) in more than `threshold` fraction of
 * all supplied memories are dropped - these are setting-omnipresent terms that
 * would fire on nearly every turn and add no signal. At threshold=0.35 a term
 * must be present in fewer than 35% of memories to be kept.
 *
 * @param {string[]} triggers - Candidate trigger tokens from deriveTriggers.
 * @param {Object[]} allMemories - Full active memory array to compute frequency against.
 * @param {number} [threshold=0.35] - Maximum fraction of memories a term may appear in.
 * @returns {string[]} Filtered trigger array.
 */
export function filterTriggersByFrequency(triggers, allMemories, threshold = 0.35) {
  if (!triggers || triggers.length === 0 || allMemories.length === 0) return triggers ?? [];
  const maxCount = Math.ceil(allMemories.length * threshold);
  return triggers.filter((t) => {
    let count = 0;
    for (const m of allMemories) {
      if (
        String(m.content || '')
          .toLowerCase()
          .includes(t)
      ) {
        if (++count > maxCount) return false;
      }
    }
    return true;
  });
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
  // Retired memories (superseded by a newer fact) should always sort below active
  // ones so they are the first candidates for eviction. A near-zero score ensures
  // they never crowd out active memories during priority-based trimming.
  if (mem.superseded_by) return 0.001;

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
 * @param {function(string[]): Promise<Map<string, number[]>>} [embedFn] - Embedding fetcher.
 *   Defaults to a no-op (returns empty Map) so callers in tests do not need the ST runtime.
 *   Production callers should pass getEmbeddingBatch from embeddings.js.
 * @returns {Promise<Array>} The reconciled array (new array, base is not mutated).
 */
export async function reconcileTypeEntries(
  base,
  promoted,
  threshold,
  timelinePool = [],
  embedFn = async () => new Map(),
) {
  const sourcePool = timelinePool.length > 0 ? timelinePool : base;

  // Batch-embed all unique content strings up front so similarity checks use
  // cosine distance rather than Jaccard word-overlap. Falls back to Jaccard
  // per-pair when the embedding call fails or returns no vector for a text.
  const allTexts = [...new Set([...base, ...promoted, ...sourcePool].map((m) => m.content))];
  const vectorMap = await embedFn(allTexts);

  const simFn = (a, b) => {
    const va = vectorMap.get(a);
    const vb = vectorMap.get(b);
    if (va && vb) return cosineSimilarity(va, vb);
    return jaccardSimilarity(a, b);
  };

  const reconciled = [...base];
  for (const mem of promoted) {
    const idx = reconciled.findIndex((ex) => {
      if (ex.type !== mem.type) return false;
      return simFn(mem.content, ex.content) > threshold;
    });

    // Default to now so the entry always has a valid timestamp even if no
    // source pool entry scores above the minimum inference threshold.
    let inferredTs = Number.isFinite(mem.ts) ? mem.ts : Date.now();
    let bestScore = 0;
    // Require a minimum similarity before accepting an inferred timestamp - a
    // near-random match is not a meaningful source for the timeline.
    const MIN_TS_INFERENCE_SCORE = 0.3;
    for (const src of sourcePool) {
      if (src.type !== mem.type) continue;
      const score = simFn(mem.content, src.content);
      if (score > bestScore && score >= MIN_TS_INFERENCE_SCORE && Number.isFinite(src.ts)) {
        bestScore = score;
        inferredTs = src.ts;
      }
    }

    if (idx >= 0) {
      const existingTs = reconciled[idx].ts;
      // Carry entity links forward from the base entry. A consolidated memory
      // may use pronouns ("she") instead of the entity's name, so the registry
      // reconciler cannot re-link it via content substring alone. By preserving
      // the base entry's entities array, reconcileEntityRegistry can re-link
      // using the ID directly rather than guessing from content.
      const inheritedEntities =
        (reconciled[idx].entities ?? []).length > 0
          ? reconciled[idx].entities
          : (mem.entities ?? []);
      // Carry triggers forward from the base entry. Consolidation re-parses memory
      // content from LLM output which produces trigger-less objects; without this
      // any triggers from the pre-consolidation version of the memory are silently
      // dropped and cannot be regenerated (the trigger loop skips existing memories).
      const inheritedTriggers =
        (reconciled[idx].triggers ?? []).length > 0
          ? reconciled[idx].triggers
          : (mem.triggers ?? undefined);
      reconciled[idx] = {
        ...mem,
        ts: Number.isFinite(existingTs) ? existingTs : inferredTs,
        entities: inheritedEntities,
        ...(inheritedTriggers !== undefined ? { triggers: inheritedTriggers } : {}),
      };
    } else {
      reconciled.push({ ...mem, ts: inferredTs });
    }
  }
  return reconciled;
}

// ---- Hybrid retrieval scoring -------------------------------------------

// Common words that start sentences and would be false-positives in
// proper-noun extraction (they look like proper nouns but are not entity names).
const SENTENCE_STARTERS = new Set([
  'i',
  'he',
  'she',
  'we',
  'they',
  'you',
  'it',
  'the',
  'a',
  'an',
  'my',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
  'this',
  'that',
  'these',
  'those',
  'what',
  'who',
  'where',
  'when',
  'why',
  'how',
  'which',
  'there',
  'here',
  'yes',
  'no',
  'not',
  'but',
  'and',
  'or',
  'so',
  'if',
  'as',
  'at',
  'in',
  'on',
  'to',
  'of',
  'do',
  'did',
  'is',
  'are',
  'was',
  'were',
  'have',
  'had',
]);

/**
 * Extracts a set of lowercase proper-noun candidate names from the last 1-2
 * chat messages. Uses a lightweight regex pass - no model call required.
 *
 * A word is considered a proper-noun candidate if:
 * - it starts with an uppercase letter
 * - it is not a common sentence-starter
 * - it is at least 2 characters long
 *
 * Used to compute entity overlap between stored memories and the current turn.
 *
 * @param {Array<{mes?: string, name?: string}>} messages - Last 1-2 messages from context.chat.
 * @returns {Set<string>} Lowercase candidate proper nouns.
 */
export function extractTurnEntityMentions(messages) {
  const mentions = new Set();
  for (const msg of messages) {
    const text = String(msg?.mes || '');
    // Match sequences of title-case words (e.g. "The Silver Tavern", "Lady Vael")
    const matches = text.match(/\b[A-Z][a-z]{1,}/g) ?? [];
    for (const word of matches) {
      const lower = word.toLowerCase();
      if (!SENTENCE_STARTERS.has(lower)) {
        mentions.add(lower);
      }
    }
  }
  return mentions;
}

// Time-scope proximity weight: how "close to now" each scope is.
// scene > session > arc > global for injection relevance.
const TIME_SCOPE_PROXIMITY = { scene: 2, session: 1, arc: 0.5, global: 0 };

// Expiration proximity weight: scene-expiry memories are the most
// temporally specific, permanent ones are always relevant but diffuse.
const EXPIRATION_PROXIMITY = { scene: 2, session: 1, permanent: 0 };

/**
 * Computes the weighted hybrid retrieval score for a single memory.
 *
 * Combines five signals:
 *   w1 * utility_score       - existing importance/durability/retrieval composite
 *   w2 * entity_overlap      - 0-1, fraction of memory entities mentioned in the current turn
 *   w3 * arc_relevance       - 0-1, cosine similarity to the most relevant open arc
 *                              (pre-computed by hybridPrioritize; falls back to Jaccard)
 *   w4 * temporal_proximity  - 0-1, how time-scoped the memory is relative to the current moment
 *   w5 * turn_similarity     - 0-1, cosine similarity to the last AI turn text
 *                              (pre-computed by hybridPrioritize; 0 when absent)
 *                              w5 = 0.2 (Profile A) or 0.6 (Profile B)
 *   - contradiction_penalty  - flat deduction when the memory has unresolved contradictions
 *
 * @param {Object} mem - Memory object.
 * @param {{
 *   keywordFreq?: Map<string, number>,
 *   turnMentions?: Set<string>,
 *   entityRegistry?: Array<{id: string, name: string, aliases?: string[]}>,
 *   arcs?: Array<{content: string}>,
 *   arcSimilarities?: Map<string, number>,
 *   turnSimilarities?: Map<string, number>,
 *   w5?: number,
 *   recentText?: string,
 * }} [context={}] - Optional per-turn signals. arcSimilarities and turnSimilarities map
 *   memory id to pre-computed cosine scores - provided by hybridPrioritize.
 *   recentText is the lowercased concatenation of the last few chat messages,
 *   used to evaluate activation triggers.
 * @returns {number}
 */
export function hybridScore(mem, context = {}) {
  if (mem.superseded_by) return 0.001;

  const {
    keywordFreq = null,
    turnMentions = null,
    entityRegistry = null,
    arcs = null,
    arcSimilarities = null,
    turnSimilarities = null,
    w5 = 0,
    recentText = '',
  } = context;

  // w1: existing utility score (0-500+ range, dominates when other signals are absent)
  const utility = memoryUtilityScore(mem, keywordFreq);

  // w2: entity overlap - how many of this memory's entity ids map to entity names
  // that appear in the current turn's text. Requires both turnMentions and a registry.
  let entityOverlap = 0;
  if (
    turnMentions &&
    turnMentions.size > 0 &&
    entityRegistry &&
    Array.isArray(mem.entities) &&
    mem.entities.length > 0
  ) {
    let matched = 0;
    for (const entityId of mem.entities) {
      const entry = entityRegistry.find((e) => e.id === entityId);
      if (!entry) continue;
      const names = [entry.name, ...(entry.aliases ?? [])].map((n) => n.toLowerCase());
      if (names.some((n) => turnMentions.has(n))) matched++;
    }
    entityOverlap = matched / mem.entities.length;
  }

  // w3: arc relevance - how closely this memory relates to any open arc.
  // Uses pre-computed cosine similarities when hybridPrioritize has already
  // fetched them; falls back to inline Jaccard when not available.
  let arcRelevance = 0;
  if (arcSimilarities && arcSimilarities.has(mem.id)) {
    arcRelevance = arcSimilarities.get(mem.id);
  } else if (arcs && arcs.length > 0) {
    const memWords = tokenSet(mem.content);
    for (const arc of arcs) {
      const arcWords = tokenSet(arc.content);
      const intersection = [...memWords].filter((w) => arcWords.has(w)).length;
      const union = new Set([...memWords, ...arcWords]).size;
      const sim = union > 0 ? intersection / union : 0;
      if (sim > arcRelevance) arcRelevance = sim;
    }
  }

  // w4: temporal proximity - how "right now" is this memory?
  // Blend of time_scope and expiration so scene-tagged session memories
  // (the most temporally specific) score highest.
  const scopeProx = TIME_SCOPE_PROXIMITY[mem.time_scope || 'global'] ?? 0;
  const expProx = EXPIRATION_PROXIMITY[normalizeExpiration(mem.expiration, 'permanent')] ?? 0;
  const temporalProximity = (scopeProx + expProx) / 4; // normalise to 0-1 (scopeProx max 2 + expProx max 2 = 4)

  // w5: turn similarity - cosine similarity between this memory and the last AI
  // turn text. Pre-computed by hybridPrioritize and passed in turnSimilarities;
  // 0 when not available (no embeddings, no lastTurnText, or w5 = 0).
  const turnSim = turnSimilarities?.get(mem.id) ?? 0;

  // Contradiction penalty: subtract a fixed amount when the memory has
  // unresolved contradictions so the retrieval system prefers clean facts.
  const contradictionPenalty =
    Array.isArray(mem.contradicts) && mem.contradicts.length > 0 ? 50 : 0;

  // Contextual relevance bonus: rewards memories whose content overlaps with
  // the current turn text. For Profile B memories that carry LLM-suggested
  // triggers (synonyms and contextual cues not in the content itself), those
  // are checked first and score higher per hit. For all memories, content-word
  // overlap against the recent turn is the baseline signal - this is meaningful
  // because it surfaces memories about what is actually being discussed right now,
  // which noun-derived triggers would redundantly replicate from the content anyway.
  // Capped at 3 hits so a single verbose memory cannot dominate the budget.
  let triggerBonus = 0;
  if (recentText) {
    const recentWords = new Set(recentText.split(/\W+/).filter((w) => w.length >= 4));
    let hits = 0;
    // LLM-suggested triggers (Profile B): higher bonus per hit because they add
    // signal beyond what direct content matching already provides.
    if (Array.isArray(mem.triggers) && mem.triggers.length > 0) {
      for (const t of mem.triggers) {
        if (recentWords.has(t)) {
          triggerBonus += 80;
          if (++hits >= 3) break;
        }
      }
    }
    // Content-word overlap (all profiles): bonus for significant words from the
    // memory content that appear in the recent turn. Uses keywordSet (3+ chars,
    // non-stopword) so common words do not inflate the score.
    if (hits < 3) {
      for (const w of keywordSet(mem.content)) {
        if (recentWords.has(w)) {
          triggerBonus += 40;
          if (++hits >= 3) break;
        }
      }
    }
  }

  return (
    utility +
    entityOverlap * 100 +
    arcRelevance * 60 +
    temporalProximity * 30 +
    turnSim * w5 * 100 +
    triggerBonus -
    contradictionPenalty
  );
}

/**
 * Sorts a memory array by hybridScore (descending) given the current-turn
 * context. Equivalent to prioritizeMemories but uses the enriched signal set
 * when context information is available.
 *
 * Pre-computes arc relevance for every memory in one embedding batch call so
 * hybridScore can use cosine similarity rather than Jaccard for that signal.
 * Falls back to the inline Jaccard path inside hybridScore when the embedding
 * call returns no vectors (embedding disabled, model unavailable, etc.).
 *
 * @param {Array} memories
 * @param {{
 *   turnMentions?: Set<string>,
 *   entityRegistry?: Array,
 *   arcs?: Array,
 *   embedFn?: function(string[]): Promise<Map<string, number[]>>,
 *   recentText?: string,
 * }} [context={}] - embedFn defaults to a no-op so tests do not need the ST runtime.
 *   Production callers should pass getEmbeddingBatch from embeddings.js.
 *   recentText is the lowercased concatenation of recent messages for trigger matching.
 * @returns {Promise<Array>}
 */
/**
 * Applies a diversity floor to an already-score-sorted memory array.
 *
 * The hybrid scorer can produce outputs dominated by a single type when
 * several entries of that type happen to score high (e.g., many recently
 * recalled relationship memories outscoring a single fact). The diversity
 * floor guarantees that the best entry from each required type appears in
 * the first positions of the output, so it is seen by the model and
 * survives tight budget trimming.
 *
 * Entries are promoted in `floorTypes` order. Within the promoted group,
 * their relative score order is preserved. The rest of the list follows
 * in score order with no duplicates.
 *
 * @param {Array} sorted - Memories already sorted by hybrid score (highest first).
 * @param {string[]} floorTypes - Types that must have at least one representative at the front.
 * @returns {Array} Reordered array with floor representatives promoted.
 */
function applyDiversityFloor(sorted, floorTypes) {
  if (!floorTypes || floorTypes.length === 0) return sorted;

  // Pick the highest-scoring (earliest in sorted) entry for each floor type.
  const promoted = new Set();
  for (const type of floorTypes) {
    const best = sorted.find((m) => m.type === type && !promoted.has(m));
    if (best) promoted.add(best);
  }

  if (promoted.size === 0) return sorted;

  // Promoted entries first (in their natural score order), then the rest.
  return [...sorted.filter((m) => promoted.has(m)), ...sorted.filter((m) => !promoted.has(m))];
}

export async function hybridPrioritize(memories, context = {}) {
  const {
    arcs = null,
    floorTypes = [],
    embedFn = async () => new Map(),
    lastTurnText = '',
    w5 = 0,
  } = context;
  // recentText (for trigger matching) passes through via the ...context spread below.
  const keywordFreq = buildKeywordFrequency(memories);

  // Pre-compute arc and turn similarities via a single embedding batch.
  // Includes memory texts + arc texts + the last-turn text when any of these
  // signals are active - one API call regardless of how many are requested.
  const memTexts = memories.map((m) => m.content);
  const arcTexts = arcs ? arcs.map((a) => a.content) : [];
  const lastTurnNorm = String(lastTurnText || '').trim();
  const needsEmbeddings =
    memories.length > 0 && (arcTexts.length > 0 || (lastTurnNorm.length > 0 && w5 > 0));

  let arcSimilarities = null;
  let turnSimilarities = null;

  if (needsEmbeddings) {
    const allTexts = [...memTexts, ...arcTexts, ...(lastTurnNorm && w5 > 0 ? [lastTurnNorm] : [])];
    const vectorMap = await embedFn(allTexts);

    if (vectorMap.size > 0) {
      if (arcTexts.length > 0) {
        arcSimilarities = new Map();
        const arcVectors = arcTexts.map((t) => vectorMap.get(t)).filter(Boolean);
        for (const mem of memories) {
          const memVec = vectorMap.get(mem.content);
          if (!memVec || arcVectors.length === 0) continue;
          const maxSim = Math.max(...arcVectors.map((av) => cosineSimilarity(memVec, av)));
          arcSimilarities.set(mem.id, maxSim);
        }
      }

      if (lastTurnNorm && w5 > 0) {
        const turnVec = vectorMap.get(lastTurnNorm);
        if (turnVec) {
          turnSimilarities = new Map();
          for (const mem of memories) {
            const memVec = vectorMap.get(mem.content);
            if (memVec) turnSimilarities.set(mem.id, cosineSimilarity(memVec, turnVec));
          }
        }
      }
    }
  }

  const ctx = { ...context, keywordFreq, arcSimilarities, turnSimilarities };
  const sorted = [...memories].sort((a, b) => {
    const sa = hybridScore(a, ctx);
    const sb = hybridScore(b, ctx);
    if (sa !== sb) return sb - sa;
    return numberOr(b.ts, 0) - numberOr(a.ts, 0) || 0;
  });

  return applyDiversityFloor(sorted, floorTypes);
}

// ---- Adaptive token budget ----------------------------------------------

// Keywords that signal each turn type. Grouped by increasing specificity
// so the classifier can return early on a clear match.
const INTIMATE_PATTERNS = [
  /\b(kiss(?:es|ed)?|caress(?:es|ed)?|embrace[sd]?|moan(?:s|ed)?|whisper(?:s|ed)?|tender(?:ly)?|gentle(?:ly)?|touch(?:es|ed)?|stroke[sd]?)\b/i,
  /\b(blush(?:es|ed)?|heart (races?|pounds?|flutters?)|pulse quicken|breath(?:es|ing)? (quicken|catch|hitch))\b/i,
];

const ACTION_PATTERNS = [
  /\b(stab(?:s|bed)?|slash(?:es|ed)?|shoot[s]?|shot|explod(?:es|ed)?|punch(?:es|ed)?|run(?:s|ning)?|flee[s]?|fled|dodge[sd]?|charge[sd]?|attack(?:s|ed)?|fight(?:s|ing)?|battle[sd]?)\b/i,
  /\b(blood(?:y)?|wound(?:s|ed)?|injur(?:es|ed|y)?|sweat(?:s|ing)?|adrenaline|chaos|panic(?:s|ked)?|urgent(?:ly)?)\b/i,
];

const TRANSITION_PATTERNS = [
  /\b(hours? later|days? later|weeks? later|the next (day|morning|night)|after (a while|some time)|meanwhile|time (passed?|skip(?:ped)?)|some time later|later that)\b/i,
  /\b(arrived? (at|in)|returned? (to|home)|left (the|a)|moved? (to|out|away)|journey(?:ed)?|travelled?|woke up)\b/i,
];

/**
 * Classifies the current AI response turn into one of four categories using
 * lightweight pattern matching. No model call - heuristic only.
 *
 * Categories:
 *   dialogue    - conversation-heavy, few scene changes (default)
 *   action      - physical events, fast-paced, high detail
 *   transition  - timeskip, location change, scene boundary
 *   intimate    - relationship/ERP-focused content
 *
 * @param {string} lastMessage - The most recent AI message text.
 * @returns {'dialogue'|'action'|'transition'|'intimate'}
 */
export function classifyTurn(lastMessage) {
  if (!lastMessage) return 'dialogue';
  // Intimate and transition are checked first - they are the most distinctive
  // and should override the action classifier when both apply.
  if (INTIMATE_PATTERNS.some((p) => p.test(lastMessage))) return 'intimate';
  if (TRANSITION_PATTERNS.some((p) => p.test(lastMessage))) return 'transition';
  if (ACTION_PATTERNS.some((p) => p.test(lastMessage))) return 'action';
  return 'dialogue';
}

// Budget multiplier table per turn type and tier.
// Multipliers > 1.0 shift tokens toward that tier; < 1.0 shift away.
// Total budget is capped at the user's configured maximum so this only
// redistributes the existing budget rather than inflating it.
const BUDGET_MULTIPLIERS = {
  //            longterm  session  scenes  arcs  profiles
  dialogue: { longterm: 1.2, session: 0.8, scenes: 0.7, arcs: 1.0, profiles: 1.2 },
  action: { longterm: 0.8, session: 1.3, scenes: 1.2, arcs: 1.0, profiles: 0.8 },
  transition: { longterm: 1.0, session: 0.9, scenes: 1.0, arcs: 1.3, profiles: 1.0 },
  intimate: { longterm: 0.9, session: 1.2, scenes: 1.0, arcs: 0.8, profiles: 1.3 },
};

/**
 * Returns adjusted token budgets for each injection tier based on the
 * current turn type. Base budgets come from the user's settings; multipliers
 * shift allocation without increasing the total.
 *
 * Total is preserved: if shifting would exceed the sum of all base budgets,
 * all tiers are scaled down proportionally so the total stays constant.
 *
 * @param {{
 *   longterm_inject_budget?: number,
 *   session_inject_budget?: number,
 *   scene_inject_budget?: number,
 *   arcs_inject_budget?: number,
 *   profiles_inject_budget?: number,
 * }} settings - The extension settings object.
 * @param {'dialogue'|'action'|'transition'|'intimate'} turnType
 * @returns {{ longterm: number, session: number, scenes: number, arcs: number, profiles: number }}
 */
export function adaptiveBudgets(settings, turnType) {
  const base = {
    longterm: settings.longterm_inject_budget ?? 500,
    session: settings.session_inject_budget ?? 400,
    scenes: settings.scene_inject_budget ?? 300,
    arcs: settings.arcs_inject_budget ?? 400,
    profiles: settings.profiles_inject_budget ?? 200,
  };

  const multipliers = BUDGET_MULTIPLIERS[turnType] ?? BUDGET_MULTIPLIERS.dialogue;
  const totalBase = Object.values(base).reduce((s, v) => s + v, 0);

  const adjusted = {};
  let totalAdjusted = 0;
  for (const [key, val] of Object.entries(base)) {
    adjusted[key] = Math.round(val * multipliers[key]);
    totalAdjusted += adjusted[key];
  }

  // If the adjusted total exceeds the original total, scale all tiers down
  // proportionally so reallocation never creates tokens from nothing.
  if (totalAdjusted > totalBase) {
    const scale = totalBase / totalAdjusted;
    for (const key of Object.keys(adjusted)) {
      adjusted[key] = Math.round(adjusted[key] * scale);
    }
  }

  return adjusted;
}

// ---- Summary section helpers ------------------------------------------------

// Canonical summary section titles, keyed by section number. A numbered line is
// only treated as a section header when its title matches the canonical title
// for that number. Without this, numbered lists inside Section 3 (Key Events)
// - e.g. "8. Fought the bandits" - are mis-identified as Sections 8 and 9, which
// corrupts truncation by treating story beats as the Current Moment/Next Beat.
const SUMMARY_SECTION_TITLES = {
  1: /^scene\s*(?:&|and)\s*setting\b/i,
  2: /^characters?\s+present\b/i,
  3: /^key\s+events?\b/i,
  4: /^relationship\s+dynamics\b/i,
  5: /^revealed\s+information\b/i,
  6: /^story\s+threads?\b/i,
  7: /^user'?s?\s+direction\b/i,
  8: /^current\s+moment\b/i,
  9: /^next\s+beat\b/i,
};

// Matches a normalized numbered line, e.g. "3. Key Events", "3) Key Events",
// "3: Key Events", or "3 - Key Events". The captured title is validated against
// SUMMARY_SECTION_TITLES before use.
const SUMMARY_SECTION_HEADER_RE = /^([1-9])\s*[.)\:\-]\s*(.+)$/;

/**
 * Normalizes a raw summary line by stripping markdown heading and emphasis
 * markers and a trailing delimiter, so plain ("3. Key Events:") and
 * markdown-decorated forms ("### 3. Key Events", "3. **Key Events:**",
 * "**3. Key Events**", "3) Key Events:") all collapse to the same "N. Title"
 * shape before the numbered-header pattern is applied.
 * @param {string} line
 * @returns {string}
 */
function normalizeSummaryHeaderLine(line) {
  return String(line ?? '')
    .replace(/^[ \t]*(?:#{1,6}\s+)?/, '')
    .replace(/\*\*|__/g, '')
    .replace(/[:\-–—]\s*$/, '')
    .trim();
}

/**
 * Splits a formatted short-term summary into its numbered sections.
 *
 * Returns the text before the first section as `preamble` and one entry per
 * recognised section. Only lines whose number maps to a canonical section title
 * count as headers, so numbered lists nested inside a section's body are ignored.
 * Section numbers must increase monotonically for the same reason - a nested
 * "8." inside Section 3 is rejected once Section 3 has been seen.
 *
 * Markdown decorations are tolerated: `### N. Title`, `N. **Title:**`,
 * `**N. Title**`, `N) Title:`, and `N. Title:` all parse.
 *
 * Any text that does not follow the numbered format keeps the whole input in
 * `preamble` with an empty `sections` array.
 *
 * @param {string} summary
 * @returns {{ preamble: string, sections: Array<{num: number, text: string}> }}
 */
export function splitSummarySections(summary) {
  const text = String(summary ?? '');
  const lines = text.split('\n');

  const headers = [];
  let lastNum = 0;
  let offset = 0;
  for (const rawLine of lines) {
    const lineStart = offset;
    offset += rawLine.length + 1; // account for the '\n' separator

    const match = normalizeSummaryHeaderLine(rawLine).match(SUMMARY_SECTION_HEADER_RE);
    if (!match) continue;

    const num = Number(match[1]);
    const title = match[2].trim();
    const titlePattern = SUMMARY_SECTION_TITLES[num];
    if (!titlePattern || !titlePattern.test(title)) continue;
    // Enforce monotonic numbering so numbered sub-items inside Section 3
    // ("8. Fought the bandits") cannot be misread as Sections 8 and 9.
    if (num <= lastNum) continue;

    headers.push({ num, index: lineStart });
    lastNum = num;
  }

  if (headers.length === 0) return { preamble: text.trim(), sections: [] };

  const preamble = text.slice(0, headers[0].index).trim();
  const sections = headers.map((header, i) => {
    const start = header.index;
    const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
    return { num: header.num, text: text.slice(start, end).trim() };
  });
  return { preamble, sections };
}

/**
 * Truncates a plain string to a token budget, cutting from the end.
 * Falls back to the original string when the budget is not a positive number.
 *
 * @param {string} text
 * @param {number} budget
 * @returns {string}
 */
function truncateTextTail(text, budget) {
  if (!Number.isFinite(budget) || budget <= 0) return text;
  if (estimateTokens(text) <= budget) return text;
  const ratio = budget / estimateTokens(text);
  const sliceAt = Math.max(1, Math.floor(text.length * ratio));
  const boundary = text.lastIndexOf('.', sliceAt);
  const cut = boundary > sliceAt * 0.8 ? boundary + 1 : sliceAt;
  return `${text.slice(0, cut)} ... [truncated]`;
}

/**
 * Head-truncates a numbered section so its most recent content survives.
 * The section heading is preserved and a short marker is inserted.
 *
 * @param {{num: number, text: string}} section
 * @param {number} maxTokens
 * @returns {string}
 */
function headTruncateSection(section, maxTokens) {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return section.text;
  if (estimateTokens(section.text) <= maxTokens) return section.text;

  // Preserve the "N. Title:" heading. Sections without one get a generic header.
  const headingMatch = section.text.match(/^\s*(\d+\.\s*[^:\n]*:)/);
  const heading = headingMatch ? headingMatch[1] : `${section.num}. `;
  const body = headingMatch
    ? section.text.slice((headingMatch.index ?? 0) + heading.length)
    : section.text;
  const marker = ' ... [earlier content trimmed]\n';
  const overhead = estimateTokens(heading + marker);
  const bodyBudget = Math.max(1, Math.floor(maxTokens - overhead));
  const ratio = Math.min(1, bodyBudget / Math.max(1, estimateTokens(body)));
  let sliceAt = Math.max(1, Math.floor(body.length * ratio));
  let tail = body.slice(body.length - sliceAt);

  // Start at a line/sentence boundary when one is close to the cut point.
  const lineBreak = tail.indexOf('\n');
  if (lineBreak >= 0 && lineBreak < tail.length * 0.35) {
    tail = tail.slice(lineBreak + 1);
  } else {
    const sentence = tail.indexOf('. ');
    if (sentence >= 0 && sentence < tail.length * 0.35) {
      tail = tail.slice(sentence + 2);
    }
  }

  return `${heading}${marker}${tail}`.trim();
}

/**
 * Truncates a formatted short-term summary while preserving the most valuable
 * tail sections - Current Moment (8) and Next Beat (9). Earlier narrative
 * sections are kept in priority order (Key Events first), and Section 3 is
 * head-truncated when only a partial section fits.
 *
 * When no numbered sections can be parsed, falls back to end truncation.
 *
 * @param {string} summary
 * @param {number} budget - Maximum estimated tokens.
 * @returns {string}
 */
export function truncateSummaryToBudget(summary, budget) {
  const text = String(summary ?? '');
  const maxTokens = Number(budget);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return text;
  if (estimateTokens(text) <= maxTokens) return text;

  const { preamble, sections } = splitSummarySections(text);
  if (sections.length === 0) return truncateTextTail(text, maxTokens);

  // Sections 8 and 9 are the anchors the model needs to continue the scene.
  const tailSections = sections.filter((s) => s.num >= 8);
  if (tailSections.length === 0) return truncateTextTail(text, maxTokens);

  const tailText = tailSections.map((s) => s.text).join('\n\n');
  const tailTokens = estimateTokens(tailText);
  const marker = '... [earlier summary sections trimmed]';
  const markerTokens = estimateTokens(marker);

  // If the anchor sections alone exceed the budget, keep them intact rather
  // than cutting the Current Moment. They are the highest-value content.
  if (tailTokens >= maxTokens) return tailText;

  let remaining = maxTokens - tailTokens - markerTokens;

  // Earlier sections retained in priority order. Event chronology (3) matters
  // most; scene dressing (1) is the first thing to sacrifice.
  const priority = [3, 6, 5, 2, 4, 7, 1];
  const keptHead = new Map();
  for (const num of priority) {
    const section = sections.find((s) => s.num === num);
    if (!section) continue;
    const sectionTokens = estimateTokens(section.text);
    if (sectionTokens <= remaining) {
      keptHead.set(num, section.text);
      remaining -= sectionTokens;
    } else if (num === 3 && remaining > 40) {
      keptHead.set(num, headTruncateSection(section, remaining));
      remaining = 0;
    }
  }

  const headText = [...keptHead.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value)
    .join('\n\n');
  const trimmedHead = headText ? `${headText}\n\n${marker}` : marker;
  return `${preamble ? `${preamble}\n\n` : ''}${trimmedHead}\n\n${tailText}`;
}

/**
 * Resolves an epistemic subject to one of the group's canonical member names.
 *
 * Weak models rarely echo a full member name in the subject field: they write
 * the first name, a token, or a partial form ("Elara" for "Elara Voss", "Kael"
 * for "Kael Draven", "Picard" for "Jean-Luc Picard"). This matcher accepts, in
 * order of confidence:
 * - an exact case-insensitive name match
 * - a whitespace-separated token of the member (first name / surname)
 * - a prefix/suffix match ("Elara" against "Elara Voss")
 *
 * Arbitrary substring matching is deliberately NOT used: "Evan" must not match
 * "Evangeline Cole". When more than one member matches the subject, the match is
 * refused (returns null) rather than guessing - putting a secret into the wrong
 * character's store is worse than dropping it.
 *
 * @param {string} subject
 * @param {string[]} memberNames
 * @returns {string|null} The canonical member name, or null when no member
 *   matches or the match is ambiguous.
 */
export function matchSubjectToMember(subject, memberNames) {
  const s = String(subject ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;

  const names = Array.isArray(memberNames) ? memberNames.filter(Boolean) : [];
  if (names.length === 0) return null;

  // 1. Exact case-insensitive match.
  for (const member of names) {
    if (String(member).toLowerCase() === s) return member;
  }

  // 2. Complete whitespace-separated token, or a prefix/suffix bounded by a
  //    space. `name.includes(subject)` is intentionally NOT used - it produces
  //    substring false positives like "Evan" -> "Evangeline Cole".
  const matches = [];
  for (const member of names) {
    const m = String(member).toLowerCase();
    const tokens = m.split(/\s+/).filter(Boolean);
    if (tokens.includes(s) || m.startsWith(`${s} `) || m.endsWith(` ${s}`)) {
      matches.push(member);
    }
  }

  if (matches.length === 0) return null;

  // 3. Ambiguity guard: more than one member matched, so the subject cannot be
  //    attributed without risk. Refuse rather than silently pick the first.
  if (matches.length > 1) {
    smLog(
      `[SmartMemory] Ambiguous epistemic subject "${subject}" matched multiple members - skipped to prevent misattribution.`,
    );
    return null;
  }

  return matches[0];
}

/**
 * Partitions parsed epistemic entries into per-character buckets.
 *
 * Group extraction returns entries for several characters in one response.
 * Each entry is assigned to the group member whose name matches its subject
 * using matchSubjectToMember (exact, first-name/token, prefix/suffix, or
 * substring). Entries whose subject is not a group member are returned in
 * `skipped` so the caller can log them rather than storing them under an
 * arbitrary key.
 *
 * @param {Array<{subject?: string}>} entries
 * @param {string[]} memberNames
 * @returns {{ grouped: Map<string, Array<Object>>, skipped: Array<Object> }}
 */
export function partitionEpistemicEntriesBySubject(entries, memberNames) {
  const names = [];
  const seen = new Set();
  for (const raw of memberNames ?? []) {
    if (!raw) continue;
    const name = String(raw);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  const grouped = new Map();
  for (const name of names) grouped.set(name, []);

  const skipped = [];
  for (const entry of entries ?? []) {
    const name = matchSubjectToMember(entry?.subject, names);
    if (!name) {
      skipped.push(entry);
      continue;
    }
    grouped.get(name).push({ ...entry, subject: name });
  }

  return { grouped, skipped };
}
