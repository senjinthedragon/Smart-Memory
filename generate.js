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
 * LLM dispatch layer for Smart Memory operations.
 *
 * All generation calls within the extension go through the two functions here
 * rather than calling generateRaw / generateQuietPrompt directly. This allows
 * the user to route memory work to a different LLM than the one running the
 * roleplay - for example, a dedicated local model via Ollama while the main
 * chat uses a larger roleplay-tuned model.
 *
 * memory_sources                - enum of supported sources: 'main' | 'webllm' | 'ollama' | 'openai_compatible' | 'connection_profile'
 * generateMemoryExtract         - for extraction tasks (self-contained prompt, no chat context needed);
 *                                 automatically strips reasoning blocks on non-main paths
 *                                 using ST's reasoning template list (main API path handled by ST itself)
 * generateMemorySummarize       - for summarization tasks (needs the full chat context)
 * fetchOllamaModels             - returns the list of models installed in a local Ollama instance
 * abortCurrentMemoryGeneration  - cancels any in-flight Ollama or OpenAI-compat fetch immediately
 */

import {
  generateRaw,
  generateQuietPrompt,
  getMaxContextSize,
  getRequestHeaders,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { reasoning_templates, parseReasoningFromString } from '../../../../scripts/reasoning.js';
import { estimateTokens, MEMORY_GENERATION_BUDGET, MODULE_NAME } from './constants.js';
import {
  isWebLlmSupported,
  generateWebLlmChatPrompt,
  ConnectionManagerRequestService,
} from '../../shared.js';

/**
 * Returns the configured generation budget from settings, falling back to
 * MEMORY_GENERATION_BUDGET if the setting has not been set.
 * @returns {number} Token limit, or -1 for unlimited.
 */
function getGenerationBudget() {
  return extension_settings[MODULE_NAME]?.generation_budget ?? MEMORY_GENERATION_BUDGET;
}

/**
 * Returns the max_tokens value to request for a call that asked for responseLength.
 * Per-call lengths (300-600) are sized for the visible output only, so a thinking
 * model can burn the whole allowance on reasoning and return nothing. The generation
 * budget is used as a floor, matching what the Ollama and OpenAI-compat paths already
 * request. Returns 0 when the budget is unlimited (-1), meaning "send no cap".
 * @param {number} responseLength
 * @returns {number}
 */
function getRequestLimit(responseLength) {
  const budget = getGenerationBudget();
  if (budget === -1) return 0;
  return Math.max(responseLength || 0, budget);
}

/**
 * Holds every AbortController for currently running Ollama or OpenAI-compat
 * fetches. A Set rather than a single slot because retries create a fresh
 * controller per attempt, so more than one could exist briefly. Module-level so
 * index.js can cancel from outside the call stack via
 * abortCurrentMemoryGeneration() when a swipe/edit/delete is requested.
 */
const activeAbortControllers = new Set();

/**
 * Sleeps for the given duration, resolving early if the signal aborts. Used in
 * place of a bare setTimeout in the retry paths so an in-flight retry can be
 * cancelled immediately by abortCurrentMemoryGeneration() instead of holding
 * the caller open for the full RETRY_DELAY_MS.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Strips reasoning blocks from a raw model response using SillyTavern's
 * reasoning template list. Tries every loaded template (non-strict mode so
 * the block does not have to be at the very start of the string) and returns
 * the content with all matched blocks removed.
 *
 * This piggybacks on ST's template knowledge so new model families are
 * supported automatically when ST adds templates for them, without any
 * changes needed here.
 *
 * Applied on every extraction path, since generateRaw on the main API does not
 * strip reasoning for text completion backends.
 *
 * @param {string} text
 * @returns {string}
 */
function stripThinkingBlocks(text) {
  if (!text) return text;
  let result = text;
  for (const template of reasoning_templates) {
    const parsed = parseReasoningFromString(result, { strict: false }, template);
    if (parsed?.content !== undefined && parsed.content !== result) {
      result = parsed.content;
    }
  }
  return result.trim();
}

/**
 * Cancels any in-flight Ollama or OpenAI-compat memory generation immediately.
 * Aborts every tracked controller (there can be more than one during a retry
 * cycle) and clears the set. The aborted fetch returns an empty string to its
 * caller, which the existing empty-response guards in compaction.js and the
 * extraction functions treat as "nothing to do" - the operation is silently
 * skipped rather than erroring.
 * Has no effect if no external generation is currently running.
 */
export function abortCurrentMemoryGeneration() {
  for (const c of activeAbortControllers) {
    try {
      c.abort();
    } catch {
      // Ignore controllers that have already been aborted or disposed.
    }
  }
  activeAbortControllers.clear();
}

/** Available LLM sources for memory operations. */
export const memory_sources = {
  main: 'main',
  webllm: 'webllm',
  ollama: 'ollama',
  openai_compatible: 'openai_compatible',
  connection_profile: 'connection_profile',
};

/**
 * Returns the currently configured memory source, defaulting to 'main'.
 * @returns {string}
 */
function getSource() {
  return extension_settings[MODULE_NAME]?.source ?? memory_sources.main;
}

/**
 * Returns the configured ST connection profile ID, or null if not set.
 * @returns {string|null}
 */
function getConnectionProfileId() {
  return extension_settings[MODULE_NAME]?.connection_profile_id ?? null;
}

/**
 * Sends a prompt through a saved ST connection profile using ConnectionManagerRequestService.
 * Works with any profile type the connection manager supports (Ollama, OpenAI-compatible,
 * cloud providers, etc.). The profile must exist and have a supported API type.
 * @param {string} prompt
 * @param {Array} [priorMessages] - Optional prior turn messages (chat completion profiles only).
 * @param {number} [maxTokens]
 * @returns {Promise<string>}
 */
async function generateWithConnectionProfile(
  prompt,
  priorMessages = [],
  maxTokens = getGenerationBudget(),
) {
  const profileId = getConnectionProfileId();
  if (!profileId)
    throw new Error(
      'No ST connection profile selected. Choose a profile in Smart Memory settings.',
    );

  // Build a messages array so chat completion profiles get conversational context.
  // For text completion profiles, ConnectionManagerRequestService constructs the
  // prompt string internally using the profile's instruct template.
  const messages = [...priorMessages, { role: 'user', content: prompt }];
  const limit = maxTokens > 0 ? maxTokens : undefined;
  const result = await ConnectionManagerRequestService.sendRequest(profileId, messages, limit);
  // result is ExtractedData with a `.content` field containing the response text.
  return result?.content ?? '';
}

/**
 * Returns the configured Ollama base URL, stripped of trailing slashes.
 * @returns {string}
 */
function getOllamaUrl() {
  return (extension_settings[MODULE_NAME]?.ollama_url || 'http://localhost:11434').replace(
    /\/$/,
    '',
  );
}

/**
 * Fetches the list of model names installed in a local Ollama instance.
 * Throws if the request fails or Ollama is unreachable.
 * @param {string} [baseUrl] - Ollama base URL. Defaults to the configured URL.
 * @returns {Promise<string[]>} Sorted list of model names.
 */
export async function fetchOllamaModels(baseUrl) {
  const url = (baseUrl || getOllamaUrl()).replace(/\/$/, '');
  const response = await fetch(`${url}/api/tags`);
  if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);
  const data = await response.json();
  return (data.models || [])
    .map((m) => m.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .sort();
}

/**
 * Sends a prompt to an Ollama instance and returns the response text.
 * Uses the /api/chat endpoint with a single user message.
 *
 * When onChunk is provided, the request streams (Ollama emits one JSON
 * object per line, NDJSON-style) and onChunk is called after every line
 * with the accumulated { content, thinking } so far. This is only used by
 * the model test panel to show a live preview - production extraction calls
 * this without onChunk and gets the same single-shot behavior as before.
 *
 * @param {string} prompt
 * @param {Array} [priorMessages] - Optional prior messages for summarization context.
 * @param {number} [numPredict] - Token generation limit passed as Ollama's num_predict option.
 * @param {(snapshot: {content: string, thinking: string}) => void} [onChunk] - optional streaming preview callback
 * @returns {Promise<string>}
 */
async function generateOllama(
  prompt,
  priorMessages = [],
  numPredict = getGenerationBudget(),
  onChunk = null,
) {
  const settings = extension_settings[MODULE_NAME];
  const url = getOllamaUrl();
  const model = settings?.ollama_model;
  if (!model) throw new Error('No Ollama model selected. Choose a model in Smart Memory settings.');

  const messages = [...priorMessages, { role: 'user', content: prompt }];
  const streaming = typeof onChunk === 'function';

  const thisController = new AbortController();
  activeAbortControllers.add(thisController);
  try {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: streaming,
        options: {
          num_predict: numPredict,
        },
      }),
      signal: thisController.signal,
    });
    if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);

    if (!streaming) {
      const data = await response.json();
      return data.message?.content ?? '';
    }

    let content = '';
    let thinking = '';
    let buffer = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);
        content += chunk.message?.content ?? '';
        thinking += chunk.message?.thinking ?? '';
        onChunk({ content, thinking });
      }
    }
    return content;
  } catch (err) {
    if (err.name === 'AbortError') return '';
    throw err;
  } finally {
    activeAbortControllers.delete(thisController);
  }
}

/**
 * Returns true if the given URL points to a local or private network address.
 * Local URLs are fetched directly from the browser; remote URLs are routed
 * through ST's server-side proxy to avoid CORS restrictions.
 * Covers IPv4 loopback, all RFC-1918 private ranges, and IPv6 loopback,
 * link-local, and unique-local ranges.
 * @param {string} url
 * @returns {boolean}
 */
export function isLocalUrl(url) {
  try {
    const { hostname } = new URL(url);
    // Strip brackets from IPv6 addresses (e.g. [::1] -> ::1)
    const host = hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      /^192\.168\./.test(host) ||
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^fc/i.test(host) || // IPv6 unique local fc00::/7
      /^fd/i.test(host) || // IPv6 unique local fd00::/8
      /^fe80/i.test(host) // IPv6 link-local
    );
  } catch {
    return false;
  }
}

/**
 * Sends a prompt to an OpenAI-compatible API and returns the response text.
 *
 * Local URLs (localhost, private network ranges) are fetched directly from
 * the browser - no CORS issue since they are same-network. Remote/cloud URLs
 * are routed through ST's server-side proxy (/api/backends/chat-completions/generate)
 * to avoid CORS restrictions that cloud providers impose on browser origins.
 *
 * When onChunk is provided and the URL is local, the request streams via
 * SSE ("data: {...}" lines, OpenAI-compatible format) and onChunk is called
 * after every event with the accumulated { content, thinking } so far.
 * Remote/proxied requests never stream, regardless of onChunk - this is only
 * used by the model test panel for a live preview on local servers.
 *
 * @param {string} prompt
 * @param {Array} [priorMessages] - Optional prior messages for summarization context.
 * @param {number} responseLength
 * @param {(snapshot: {content: string, thinking: string}) => void} [onChunk] - optional streaming preview callback (local URLs only)
 * @returns {Promise<string>}
 */
async function generateOpenAICompat(
  prompt,
  priorMessages = [],
  responseLength = getGenerationBudget(),
  onChunk = null,
) {
  const settings = extension_settings[MODULE_NAME];
  const baseUrl = (settings?.openai_compat_url || '').replace(/\/$/, '').replace(/\/v1$/, '');
  if (!baseUrl) throw new Error('No API URL configured for OpenAI Compatible source.');
  const apiKey = settings?.openai_compat_key || '';
  const model = settings?.openai_compat_model || '';

  const messages = [...priorMessages, { role: 'user', content: prompt }];

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const thisController = new AbortController();
    activeAbortControllers.add(thisController);
    const local = isLocalUrl(baseUrl);
    const streaming = local && typeof onChunk === 'function';
    try {
      let response;
      if (local) {
        // Direct fetch for local servers - no CORS issue on private network addresses.
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: model || undefined,
            messages,
            max_tokens: responseLength > 0 ? responseLength : undefined,
            stream: streaming,
          }),
          signal: thisController.signal,
        });
      } else {
        // Route remote/cloud URLs through ST's proxy to avoid CORS restrictions.
        // ST's CUSTOM source appends /chat/completions to custom_url, so pass baseUrl/v1.
        const proxyBody = {
          chat_completion_source: 'custom',
          custom_url: `${baseUrl}/v1`,
          messages,
          model: model || undefined,
          max_tokens: responseLength > 0 ? responseLength : undefined,
          stream: false,
        };
        // Pass the API key via custom_include_headers (YAML key: value format) so it
        // overrides the empty Authorization header ST builds from its stored CUSTOM secret.
        if (apiKey) {
          proxyBody.custom_include_headers = `Authorization: Bearer ${apiKey}`;
        }
        response = await fetch('/api/backends/chat-completions/generate', {
          method: 'POST',
          headers: getRequestHeaders(),
          body: JSON.stringify(proxyBody),
          signal: thisController.signal,
        });
      }

      if (response.ok) {
        if (!streaming) {
          const data = await response.json();
          if (data?.error) throw new Error(data.error.message || 'OpenAI Compatible API error');
          return data.choices?.[0]?.message?.content ?? '';
        }

        let content = '';
        let thinking = '';
        let buffer = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const event of events) {
            const line = event.replace(/^data:\s*/, '').trim();
            if (!line || line === '[DONE]') continue;
            const chunk = JSON.parse(line);
            const delta = chunk.choices?.[0]?.delta ?? {};
            content += delta.content ?? '';
            thinking += delta.reasoning_content ?? delta.reasoning ?? '';
            onChunk({ content, thinking });
          }
        }
        return content;
      }

      // Retry on 5xx (transient server errors) and 429 (rate limiting from
      // free-tier cloud providers). Do not retry other 4xx - those are
      // permanent errors (auth failure, bad request) that retrying won't fix.
      if ((response.status >= 500 || response.status === 429) && attempt < MAX_RETRIES) {
        if (thisController.signal.aborted) return '';
        await abortableSleep(RETRY_DELAY_MS, thisController.signal);
        if (thisController.signal.aborted) return '';
        continue;
      }
      throw new Error(`OpenAI Compatible API responded with ${response.status}`);
    } catch (err) {
      if (err.name === 'AbortError') return '';
      // Retry on network-level errors (ETIMEDOUT, ECONNRESET, etc.) - same reasoning
      // as 5xx: transient failures that a retry may resolve.
      if (attempt < MAX_RETRIES && !err.message.includes('responded with 4')) {
        if (thisController.signal.aborted) return '';
        await abortableSleep(RETRY_DELAY_MS, thisController.signal);
        if (thisController.signal.aborted) return '';
        continue;
      }
      throw err;
    } finally {
      activeAbortControllers.delete(thisController);
    }
  }
  // Unreachable but satisfies linters.
  return '';
}

/**
 * Generate a response for extraction tasks.
 *
 * The prompt must be fully self-contained - all context the model needs (chat
 * history, existing memories, etc.) should already be embedded in the prompt
 * string. This is how all extraction prompts in prompts.js are written.
 *
 * @param {string} prompt - The complete prompt to send
 * @param {object} [options]
 * @param {number} [options.responseLength=600] - Max tokens to generate
 * @param {(snapshot: {content: string, thinking: string}) => void} [options.onChunk] - optional streaming preview callback; only honored for the Ollama and local OpenAI Compatible sources
 * @returns {Promise<string>} The raw model response
 */
export async function generateMemoryExtract(prompt, { responseLength = 600, onChunk = null } = {}) {
  const source = getSource();
  let raw;

  if (source === memory_sources.ollama) {
    raw = await generateOllama(prompt, [], undefined, onChunk);
  } else if (source === memory_sources.openai_compatible) {
    raw = await generateOpenAICompat(prompt, [], undefined, onChunk);
  } else if (source === memory_sources.connection_profile) {
    raw = await generateWithConnectionProfile(prompt, [], getRequestLimit(responseLength));
  } else if (source === memory_sources.webllm) {
    if (!isWebLlmSupported()) {
      console.warn(
        `[${MODULE_NAME}] WebLLM source selected but WebLLM is not available, falling back to main`,
      );
      raw = await generateRaw({
        prompt,
        instruct: false,
        quietToLoud: false,
        responseLength: getRequestLimit(responseLength) || null,
      });
    } else {
      const messages = [{ role: 'user', content: prompt }];
      const limit = getRequestLimit(responseLength);
      const params = limit > 0 ? { max_tokens: limit } : {};
      raw = await generateWebLlmChatPrompt(messages, params);
    }
  } else {
    // Default: main API. instruct:false prevents the instruct template from
    // wrapping the extraction prompt, which is important for our tagged-line
    // output format ([type:score:expiration] lines). This is a supported
    // generateRaw parameter in SillyTavern. The parsers are also resilient -
    // they only match valid tagged lines and ignore everything else - so even
    // if this were silently ignored the output would still parse correctly.
    raw = await generateRaw({
      prompt,
      instruct: false,
      quietToLoud: false,
      responseLength: getRequestLimit(responseLength) || null,
    });
  }

  // Strip on every path, main API included: generateRaw does not remove reasoning
  // blocks on text completion backends (e.g. KoboldCpp with Gemma 4), and stripping
  // already-clean text is a no-op.
  const stripped = stripThinkingBlocks(raw ?? '');
  // Truncate to responseLength characters as a rough bound - the thinking block
  // may have inflated the raw output far beyond the intended budget.
  // 4 chars/token is a conservative estimate; actual token count may be lower.
  // Floor at generation_budget so thinking models that produce long reasoning blocks
  // don't have their actual output silently truncated when responseLength is tuned tightly.
  // When the generation budget is -1 (unlimited), skip truncation entirely.
  const charLimit =
    responseLength > 0 && getGenerationBudget() !== -1
      ? Math.max(responseLength, getGenerationBudget()) * 4
      : Infinity;
  return stripped.length > charLimit ? stripped.slice(0, charLimit) : stripped;
}

/**
 * Trims a messages array to the most recent entries that fit within a token budget.
 * Drops from the front (oldest messages) so the most recent context is preserved.
 * Always keeps at least one message so the caller never receives an empty array.
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} budget - Max tokens of message content to keep.
 * @returns {Array<{role: string, content: string}>}
 */
function trimToBudget(messages, budget) {
  let total = 0;
  const kept = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i].content);
    if (kept.length > 0 && total + tokens > budget) break;
    kept.unshift(messages[i]);
    total += tokens;
  }
  return kept;
}

/**
 * Generate a response for summarization tasks that need the full chat context.
 *
 * For the main API this appends the instruction to the current chat context via
 * generateQuietPrompt. For WebLLM it reads context.chat directly and builds an
 * equivalent messages array, then appends the instruction as the final user turn.
 *
 * @param {string} quietPrompt - The summarization instruction to append
 * @param {object} [options]
 * @param {number} [options.responseLength=1500] - Max tokens to generate
 * @param {boolean} [options.skipWIAN=true] - Skip world info / author's note
 * @returns {Promise<string>} The raw model response
 */
export async function generateMemorySummarize(
  quietPrompt,
  { responseLength = 1500, skipWIAN = true, includeLastMessage = false, chatMessages = null } = {},
) {
  const source = getSource();

  // For direct API sources (Ollama, OpenAI-compat, connection profile), build the chat
  // context ourselves and append the quiet prompt as the final user message.
  if (
    source === memory_sources.ollama ||
    source === memory_sources.openai_compatible ||
    source === memory_sources.connection_profile
  ) {
    let priorMessages;
    if (chatMessages !== null) {
      // Caller provides the messages directly. An empty array is valid - used
      // by progressive compaction where the prompt body already embeds both the
      // existing summary and the new events, so sending the full chat again
      // would duplicate the new messages.
      priorMessages = chatMessages;
    } else {
      const context = getContext();
      const chat = context.chat ?? [];
      const lastMsg = chat[chat.length - 1];
      const stableChat =
        !includeLastMessage && lastMsg && !lastMsg.is_user && !lastMsg.is_system
          ? chat.slice(0, -1)
          : chat;
      const allMessages = stableChat
        .filter((msg) => !msg.is_system)
        .map((msg) => ({ role: msg.is_user ? 'user' : 'assistant', content: msg.mes ?? '' }));

      // Trim to the most recent messages that fit within 60% of the context window.
      // Short-term memory is about recent context, not the entire chat history - sending
      // all messages from a long RP would overflow a local model's context completely.
      priorMessages = trimToBudget(allMessages, getMaxContextSize(responseLength) * 0.6);
    }

    let rawDirect;
    if (source === memory_sources.ollama) {
      rawDirect = await generateOllama(quietPrompt, priorMessages);
    } else if (source === memory_sources.connection_profile) {
      rawDirect = await generateWithConnectionProfile(
        quietPrompt,
        priorMessages,
        getRequestLimit(responseLength),
      );
    } else {
      rawDirect = await generateOpenAICompat(quietPrompt, priorMessages);
    }
    const strippedDirect = stripThinkingBlocks(rawDirect ?? '');
    const charLimitDirect =
      responseLength > 0 && getGenerationBudget() !== -1
        ? Math.max(responseLength, getGenerationBudget()) * 4
        : Infinity;
    return strippedDirect.length > charLimitDirect
      ? strippedDirect.slice(0, charLimitDirect)
      : strippedDirect;
  }

  if (source === memory_sources.webllm) {
    if (!isWebLlmSupported()) {
      console.warn(
        `[${MODULE_NAME}] WebLLM source selected but WebLLM is not available, falling back to main`,
      );
    } else {
      const context = getContext();
      const chat = context.chat ?? [];
      const lastMsg = chat[chat.length - 1];
      const stableChat =
        !includeLastMessage && lastMsg && !lastMsg.is_user && !lastMsg.is_system
          ? chat.slice(0, -1)
          : chat;
      const allMessages = stableChat
        .filter((msg) => !msg.is_system)
        .map((msg) => ({
          role: msg.is_user ? 'user' : 'assistant',
          content: msg.mes ?? '',
        }));
      const trimmed = trimToBudget(allMessages, getMaxContextSize(responseLength) * 0.6);
      trimmed.push({ role: 'user', content: quietPrompt });
      const limit = getRequestLimit(responseLength);
      const params = limit > 0 ? { max_tokens: limit } : {};
      return stripThinkingBlocks((await generateWebLlmChatPrompt(trimmed, params)) ?? '');
    }
  }

  // Default: main API
  return await generateQuietPrompt({
    quietPrompt,
    quietToLoud: false,
    skipWIAN,
    responseLength: getRequestLimit(responseLength) || null,
    removeReasoning: true,
  });
}
