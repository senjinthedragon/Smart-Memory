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
 * hybridScore               - weighted blend of utility, entity overlap, arc relevance, and temporal proximity
 * hybridPrioritize          - sorts a memory array by hybridScore given current-turn context
 * classifyTurn              - heuristic turn-type classifier (dialogue/action/transition/intimate)
 * adaptiveBudgets           - adjusts injection budgets per tier based on turn type
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
 * Combines four synchronous signals:
 *   w1 * utility_score       - existing importance/durability/retrieval composite
 *   w2 * entity_overlap      - 0-1, fraction of memory entities mentioned in the current turn
 *   w3 * arc_relevance       - 0-1, Jaccard overlap with any open arc content
 *   w4 * temporal_proximity  - 0-1, how time-scoped the memory is relative to the current moment
 *   - contradiction_penalty  - flat deduction when the memory has unresolved contradictions
 *
 * Semantic similarity (w5) is intentionally omitted here because it requires
 * an async embedding call. The calling code can pre-compute and inject it as
 * part of the utility score or a future extension to this context.
 *
 * @param {Object} mem - Memory object.
 * @param {{
 *   keywordFreq?: Map<string, number>,
 *   turnMentions?: Set<string>,
 *   entityRegistry?: Array<{id: string, name: string, aliases?: string[]}>,
 *   arcs?: Array<{content: string}>,
 * }} [context={}] - Optional per-turn signals for the extra scoring components.
 * @returns {number}
 */
export function hybridScore(mem, context = {}) {
  if (mem.superseded_by) return 0.001;

  const { keywordFreq = null, turnMentions = null, entityRegistry = null, arcs = null } = context;

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

  // w3: arc relevance - Jaccard overlap between memory content and any open arc.
  // Taking the max across all arcs so a memory that directly addresses the most
  // pressing unresolved thread is boosted maximally.
  let arcRelevance = 0;
  if (arcs && arcs.length > 0) {
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
  const temporalProximity = (scopeProx + expProx) / 4; // normalise to 0-1

  // Contradiction penalty: subtract a fixed amount when the memory has
  // unresolved contradictions so the retrieval system prefers clean facts.
  const contradictionPenalty =
    Array.isArray(mem.contradicts) && mem.contradicts.length > 0 ? 50 : 0;

  return (
    utility +
    entityOverlap * 100 +
    arcRelevance * 60 +
    temporalProximity * 30 -
    contradictionPenalty
  );
}

/**
 * Sorts a memory array by hybridScore (descending) given the current-turn
 * context. Equivalent to prioritizeMemories but uses the enriched signal set
 * when context information is available.
 *
 * Builds the keyword frequency from the pool once and passes it into each
 * score call so repeated keywords within the pool are weighted correctly.
 *
 * @param {Array} memories
 * @param {{
 *   turnMentions?: Set<string>,
 *   entityRegistry?: Array,
 *   arcs?: Array,
 * }} [context={}]
 * @returns {Array}
 */
export function hybridPrioritize(memories, context = {}) {
  const keywordFreq = buildKeywordFrequency(memories);
  const ctx = { ...context, keywordFreq };
  return [...memories].sort((a, b) => {
    const sa = hybridScore(a, ctx);
    const sb = hybridScore(b, ctx);
    if (sa !== sb) return sb - sa;
    return numberOr(b.ts, 0) - numberOr(a.ts, 0) || 0;
  });
}

// ---- Adaptive token budget ----------------------------------------------

// Keywords that signal each turn type. Grouped by increasing specificity
// so the classifier can return early on a clear match.
const INTIMATE_PATTERNS = [
  /\b(kiss(?:es|ed)?|caress(?:es|ed)?|embrace[sd]?|moan(?:s|ed)?|whisper(?:s|ed)?|tender(?:ly)?|gentle(?:ly)?|touch(?:es|ed)?|stroke[sd]?)\b/i,
  /\b(blush(?:es|ed)?|heart (races?|pounds?|flutters?)|pulse quicken|breath(?:es|ing)? (quicken|catch|hitch))\b/i,
];

const ACTION_PATTERNS = [
  /\b(stab(?:s|bed)?|slash(?:es|ed)?|shoot[s]?|shot|explod(?:es|ed)?|punch(?:es|ed)?|run(?:s|ning)?|flee[s]?|fled|dodge[sd]?|dodge[sd]?|charge[sd]?|attack(?:s|ed)?|fight(?:s|ing)?|battle[sd]?)\b/i,
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
