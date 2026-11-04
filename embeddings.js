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
 * Supports two embedding sources: Ollama (/api/embed) and any OpenAI-compatible
 * endpoint (/v1/embeddings). Cosine similarity between vectors catches near-paraphrase
 * duplicates that word-overlap (Jaccard) misses - e.g. "Finn is Senjin's anchor" vs
 * "Finn serves as Senjin's emotional foundation" score near-zero in Jaccard but
 * ~0.92 in cosine space.
 *
 * Falls back to Jaccard automatically when embeddings are disabled, the model
 * is not available, or the API call fails - so the system degrades gracefully
 * for users who have not configured an embedding source.
 *
 * getEmbeddingBatch        - fetches vectors for multiple texts in one API call; accepts an optional AbortSignal
 * cosineSimilarity         - re-exported from similarity.js for callers that import here
 * batchVerify              - compares candidates against existing memories; returns
 *                            passed (new), superseded (pattern-confirmed updates),
 *                            uncertain (same-topic pairs for model confirmation), and
 *                            rejected (duplicates)
 * clearEmbeddingCache      - clears the in-session cache (call on chat change)
 * abortEmbeddingRequests   - aborts every in-flight embedding fetch (call on swipe/edit/delete)
 * hasEmbeddingFailed       - returns true when an embedding call has failed this session
 * clearEmbeddingFailed     - resets the failure flag (call when the user re-enables or reconfigures)
 * getHardwareProfile       - returns the active hardware profile ('a' or 'b')
 * saveEmbeddingApiKey - writes the API key to extension_settings
 * hasEmbeddingApiKey  - returns true when an API key is configured
 *
 * Cancellation scope note: only the embedding HTTP fetches issued here are
 * transport-cancellable. Main-API, WebLLM, and connection-profile generation in
 * generate.js is host-managed (SillyTavern owns the request) and cannot be
 * aborted from this module.
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { MODULE_NAME } from './constants.js';
import { memory_sources, isLocalUrl } from './generate.js';
import { cosineSimilarity, jaccardSimilarity, hasStateChangeMarker } from './similarity.js';

// In-session embedding cache: normalized text -> vector.
// Embeddings are deterministic for a given text + model, so caching within a
// session avoids redundant API calls during catch-up mode. Cleared on chat change.
const embeddingCache = new Map();

// Tracks whether the user has already been warned about an embedding failure
// this session so we don't spam a toastr on every extraction pass.
let embeddingWarnedThisSession = false;

/**
 * Holds every AbortController for currently in-flight embedding fetches. A Set
 * rather than a single slot because concurrent passes can overlap. Module-level
 * so index.js can cancel from outside the call stack via abortEmbeddingRequests()
 * when a swipe/edit/delete is requested. Local to this module (not shared with
 * generate.js) so the two cancellation domains stay independent.
 */
const activeEmbeddingAbortControllers = new Set();

/**
 * Cancels every in-flight embedding fetch immediately. Aborts each tracked
 * controller and clears the set; the aborted fetches resolve to an empty result
 * and callers fall back to keyword matching. Has no effect if no embedding
 * request is currently running.
 *
 * Cancellation scope: this only aborts embedding HTTP requests issued by this
 * module. Main-API/WebLLM/connection-profile generation in generate.js is
 * host-managed and is not transport-cancellable here.
 */
export function abortEmbeddingRequests() {
  for (const controller of activeEmbeddingAbortControllers) {
    try {
      controller.abort();
    } catch {
      // Ignore controllers that have already been aborted or disposed.
    }
  }
  activeEmbeddingAbortControllers.clear();
}

/**
 * Returns true when running inside a browser (SillyTavern's front-end context).
 * Node-based tooling and unit tests have no `window`, so they always take the
 * direct-fetch path.
 * @returns {boolean}
 */
function isBrowserContext() {
  return typeof window !== 'undefined';
}

/**
 * POSTs an embedding request, routing remote/cloud endpoints through
 * SillyTavern's server-side CORS proxy when running in a browser.
 *
 * Local addresses (localhost, private network ranges) are contacted directly -
 * they do not trigger browser CORS restrictions. Cloud providers such as OpenAI
 * reject cross-origin browser requests, so they are sent through `/proxy/<url>`
 * (SillyTavern's CORS proxy middleware) using ST's request headers. If the proxy
 * is disabled or unavailable we fall back to a direct request so local
 * reverse-proxies and same-origin setups still work.
 *
 * @param {string} url - Fully-qualified embedding endpoint URL.
 * @param {Object} payload - JSON request body.
 * @param {string} [apiKey] - Optional bearer token for OpenAI-compatible APIs.
 * @param {AbortSignal} [signal] - Cancels the request when aborted.
 * @returns {Promise<Response>}
 */
async function fetchEmbeddingEndpoint(url, payload, apiKey = '', signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const body = JSON.stringify(payload);

  // Only absolute HTTP(S) targets outside the local network need the proxy.
  // Relative/same-origin URLs are already served by SillyTavern.
  const isRemoteHttp = /^https?:\/\//i.test(url) && !isLocalUrl(url);
  if (isRemoteHttp && isBrowserContext()) {
    try {
      const response = await fetch(`/proxy/${url}`, {
        method: 'POST',
        headers: { ...getRequestHeaders(), ...headers },
        body,
        signal,
      });
      if (response.ok) return response;
      // Non-2xx usually means the CORS proxy is disabled (config.yaml) or the
      // upstream rejected the request. Fall through to a direct attempt.
    } catch {
      // Network error reaching the proxy - fall through to a direct attempt.
      // A caller-triggered abort is surfaced by the direct fetch below, which
      // also receives the signal and rejects immediately when it is aborted.
    }
  }

  return fetch(url, { method: 'POST', headers, body, signal });
}

/**
 * Fetches embedding vectors for a list of texts in a single API call.
 * Texts already in the cache are not re-fetched. Returns a Map from
 * normalized text to vector. Any text that fails (bad response, network
 * error) will be absent from the returned Map - callers fall back to Jaccard.
 *
 * The request is tracked in a module-level Set so abortEmbeddingRequests() can
 * cancel it; an optional caller-supplied signal is linked so either source can
 * abort the fetch. Aborted requests resolve to the partial result (usually
 * empty) without logging a failure toast.
 *
 * @param {string[]} texts
 * @param {AbortSignal} [signal] - Optional caller signal to cancel the fetch.
 * @returns {Promise<Map<string, number[]>>}
 */
export async function getEmbeddingBatch(texts, signal) {
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

  const baseUrl = (settings.embedding_url || 'http://localhost:11434')
    .replace(/\/$/, '')
    .replace(/\/v1$/, '');
  const model = settings.embedding_model || 'nomic-embed-text';
  const keep = settings.embedding_keep ?? false;
  const source = settings.embedding_source ?? 'ollama';
  // Remote endpoints in the browser require SillyTavern's CORS proxy; this lets
  // the catch block explain the real cause when the request fails.
  const isRemoteHttp = /^https?:\/\//i.test(baseUrl) && !isLocalUrl(baseUrl);

  // One controller per request, registered so abortEmbeddingRequests() can
  // cancel it. A caller-supplied signal is linked in so either aborts the fetch.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  activeEmbeddingAbortControllers.add(controller);

  try {
    let vectors;
    if (source === 'openai_compatible') {
      // OpenAI-compatible endpoint: /v1/embeddings
      // Response shape: { data: [{ embedding: [...] }, ...] }
      const apiKey = settings.embedding_api_key || '';
      const response = await fetchEmbeddingEndpoint(
        `${baseUrl}/v1/embeddings`,
        { input: uncached, model },
        apiKey,
        controller.signal,
      );
      if (!response.ok) return result;
      const data = await response.json();
      if (!Array.isArray(data?.data)) return result;
      vectors = data.data.map((entry) => entry?.embedding ?? null);
    } else {
      // Ollama endpoint: /api/embed
      // Response shape: { embeddings: [[...], ...] }
      const response = await fetchEmbeddingEndpoint(
        `${baseUrl}/api/embed`,
        {
          input: uncached,
          model,
          keep_alive: keep ? -1 : undefined,
          truncate: true,
        },
        '',
        controller.signal,
      );
      if (!response.ok) return result;
      const data = await response.json();
      if (!Array.isArray(data?.embeddings)) return result;
      vectors = data.embeddings;
    }

    for (let i = 0; i < uncached.length; i++) {
      const vector = vectors[i];
      if (Array.isArray(vector) && vector.length > 0) {
        embeddingCache.set(uncached[i], vector);
        result.set(uncached[i], vector);
      }
    }
  } catch (err) {
    // A swipe/edit/delete (or an explicit abortEmbeddingRequests() call) aborted
    // this request - stay silent and let the caller fall back to keyword matching.
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      return result;
    }
    // Network error, model not found, server not running - callers fall back to Jaccard.
    // Warn once per session so the user knows deduplication quality is degraded.
    console.error('[SmartMemory] Embedding request failed:', err);
    if (!embeddingWarnedThisSession) {
      embeddingWarnedThisSession = true;
      // A remote endpoint contacted directly from the browser is almost always
      // blocked by CORS. SillyTavern can proxy it, but only when enabled in
      // config.yaml. Give the user the exact fix rather than a generic warning.
      if (isRemoteHttp && isBrowserContext()) {
        toastr?.error(
          'Remote embedding API failed (likely blocked by CORS). In SillyTavern, set enableCORSProxy: true in config.yaml and restart, or switch to a local Ollama embedding model.',
          'Smart Memory',
          { timeOut: 12000 },
        );
      } else {
        toastr?.warning(
          'Embedding model unreachable - falling back to keyword matching. Check your embedding URL and model name.',
          'Smart Memory',
          { timeOut: 8000 },
        );
      }
    }
  } finally {
    activeEmbeddingAbortControllers.delete(controller);
    signal?.removeEventListener?.('abort', onCallerAbort);
  }

  return result;
}

// cosineSimilarity, jaccardSimilarity, STATE_CHANGE_PATTERNS, and hasStateChangeMarker
// live in similarity.js (no ST runtime deps) so unit tests can load embeddings
// consumers without pulling in extensions.js. Re-exported here for callers that
// already import from embeddings.js.
export { cosineSimilarity } from './similarity.js';

/**
 * Writes the embedding API key to extension_settings.
 * @param {string} value
 */
export function saveEmbeddingApiKey(value) {
  extension_settings[MODULE_NAME].embedding_api_key = value;
  saveSettingsDebounced();
}

/**
 * Returns true when an embedding API key is configured.
 * @returns {boolean}
 */
export function hasEmbeddingApiKey() {
  return !!extension_settings[MODULE_NAME]?.embedding_api_key;
}

/**
 * Returns true if an embedding API call has failed at least once this session.
 * Used by the UI to show a persistent warning when embeddings are silently
 * falling back to keyword matching.
 * @returns {boolean}
 */
export function hasEmbeddingFailed() {
  return embeddingWarnedThisSession;
}

/**
 * Resets the embedding failure flag. Call when the user re-enables embeddings
 * or changes the URL/model so the next call gets a fresh chance.
 */
export function clearEmbeddingFailed() {
  embeddingWarnedThisSession = false;
}

/**
 * Returns the active hardware profile: 'a' (local/low-VRAM) or 'b' (hosted).
 *
 * Auto-detects from the configured memory source:
 *   - ollama or webllm -> Profile A
 *   - main or openai_compatible -> Profile B
 *
 * Can be overridden by the user in settings (hardware_profile: 'a' | 'b').
 *
 * Defined here (rather than index.js) so all modules can import it without
 * creating circular dependencies.
 *
 * @returns {'a'|'b'}
 */
export function getHardwareProfile() {
  const s = extension_settings[MODULE_NAME] ?? {};
  const override = s.hardware_profile ?? 'auto';
  if (override === 'a') return 'a';
  if (override === 'b') return 'b';
  const source = s.source ?? memory_sources.main;
  return source === memory_sources.ollama || source === memory_sources.webllm ? 'a' : 'b';
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
 * @returns {Promise<{passed: Set<string>, superseded: Map<string, string>, confirmed: Set<string>, uncertain: Array, semantic: boolean}>}
 *   passed     - Set of candidate content strings (lowercase) that are new
 *   superseded - Map from candidate content string to the id of the existing
 *                memory it replaces (only present when ex.id is available)
 *   confirmed  - Set of existing memory ids that were re-extracted this pass
 *                (duplicate candidate matched them, confirming they are still true)
 *   uncertain  - Pairs that scored above the same-topic threshold but had no
 *                state-change pattern; the caller should run a model confirmation
 *                call (method B) for each before deciding
 *                Each entry: { candText, candObj, existingId, existingContent, score }
 *   semantic   - true if cosine similarity was used, false if Jaccard
 */
export async function batchVerify(candidates, existing) {
  const passed = new Set();
  const superseded = new Map(); // candContent -> existingId
  const confirmed = new Set(); // existingId -> confirmed this extraction pass
  const uncertain = []; // pairs for model confirmation (B)
  if (!candidates || candidates.length === 0)
    return { passed, superseded, confirmed, uncertain, semantic: false };

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

  // Hoist the profile lookup: it can't change mid-pass and calling it inside
  // the inner loop is pure overhead proportional to candidates * existing.
  const profile = getHardwareProfile();

  for (const cand of candidates) {
    const candText = String(cand.content || '')
      .toLowerCase()
      .trim();
    const candVec = anyEmbeddings ? (vectorMap.get(candText) ?? null) : null;
    const candHasStateChange = hasStateChangeMarker(candText);

    let isDuplicate = false;
    let confirmedId = null; // id of the existing memory being confirmed by this duplicate
    let bestSupersessionScore = 0;
    let bestSupersessionId = null;
    // Best same-type pair above the same-topic threshold that had no pattern match.
    // Collected so the caller can run a model confirmation call (B) if needed.
    let bestUncertainScore = 0;
    let bestUncertainId = null;
    let bestUncertainContent = null;

    for (const ex of existing) {
      const exText = String(ex.content || '')
        .toLowerCase()
        .trim();
      const exVec = anyEmbeddings ? (vectorMap.get(exText) ?? null) : null;

      // Choose scoring method and thresholds. Fall back to Jaccard with its
      // own thresholds when either vector is missing - mixing methods and
      // thresholds produces wrong results.
      //
      // Profile B (hosted) uses slightly higher dup thresholds so nuanced
      // memories from powerful models are less likely to be incorrectly
      // rejected as duplicates of semantically adjacent but distinct facts.
      // Profile B also uses a lower same-topic threshold to catch more
      // supersession candidates, since hosted models write more varied prose.
      let score, dupThreshold, crossDupThreshold, sameTopicThreshold;
      if (candVec && exVec) {
        score = cosineSimilarity(candVec, exVec);
        if (profile === 'b') {
          dupThreshold = 0.85;
          crossDupThreshold = 0.91;
          sameTopicThreshold = 0.52;
        } else {
          dupThreshold = 0.82;
          crossDupThreshold = 0.88;
          sameTopicThreshold = 0.55;
        }
      } else {
        score = jaccardSimilarity(candText, exText);
        if (profile === 'b') {
          dupThreshold = 0.68;
          crossDupThreshold = 0.78;
          sameTopicThreshold = 0.38;
        } else {
          dupThreshold = 0.65;
          crossDupThreshold = 0.75;
          sameTopicThreshold = 0.4;
        }
      }

      const isSameType = ex.type === cand.type;
      const effectiveDupThreshold = isSameType ? dupThreshold : crossDupThreshold;

      if (score >= effectiveDupThreshold) {
        // High similarity: would normally be a duplicate. If the candidate
        // contains a state-change marker it is superseding this fact instead.
        // Without a pattern, mark as uncertain so B can make the call.
        // Exception: if the content is identical after normalization, always
        // treat as a duplicate - a memory cannot supersede itself.
        const contentIdentical = candText === exText;
        if (isSameType && ex.id && !contentIdentical) {
          if (candHasStateChange && score > bestSupersessionScore) {
            bestSupersessionScore = score;
            bestSupersessionId = ex.id;
          } else if (!candHasStateChange && score > bestUncertainScore) {
            bestUncertainScore = score;
            bestUncertainId = ex.id;
            bestUncertainContent = ex.content;
          }
        } else {
          isDuplicate = true;
          confirmedId = ex.id ?? null;
          break;
        }
      } else if (isSameType && score >= sameTopicThreshold && ex.id) {
        if (candHasStateChange && score > bestSupersessionScore) {
          // Medium similarity on same topic + state-change marker: likely supersession.
          bestSupersessionScore = score;
          bestSupersessionId = ex.id;
        } else if (!candHasStateChange && score > bestUncertainScore) {
          // Same topic, no pattern - let B decide.
          bestUncertainScore = score;
          bestUncertainId = ex.id;
          bestUncertainContent = ex.content;
        }
      }
    }

    if (isDuplicate) {
      // The candidate matched an existing memory - that memory is confirmed still true.
      if (confirmedId) confirmed.add(confirmedId);
      continue; // silently drop the candidate
    }

    if (bestSupersessionId !== null) {
      // Pattern confirmed supersession.
      superseded.set(candText, bestSupersessionId);
      passed.add(candText);
    } else {
      passed.add(candText);
      // Queue for model confirmation if there was a same-topic pair with no pattern.
      if (bestUncertainId !== null) {
        uncertain.push({
          candText,
          candObj: cand,
          existingId: bestUncertainId,
          existingContent: bestUncertainContent,
          score: bestUncertainScore,
        });
      }
    }
  }

  return { passed, superseded, confirmed, uncertain, semantic: anyEmbeddings };
}

/**
 * Clears the in-session embedding cache.
 * Called on CHAT_CHANGED / CHAT_LOADED to prevent unbounded memory growth.
 */
export function clearEmbeddingCache() {
  embeddingCache.clear();
}
