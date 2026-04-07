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
 * memory_sources          - enum of supported sources: 'main' | 'webllm' | 'ollama' | 'openai_compatible'
 * generateMemoryExtract   - for extraction tasks (self-contained prompt, no chat context needed)
 * generateMemorySummarize - for summarization tasks (needs the full chat context)
 * fetchOllamaModels       - returns the list of models installed in a local Ollama instance
 */

import { generateRaw, generateQuietPrompt } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { isWebLlmSupported, generateWebLlmChatPrompt } from '../../shared.js';
import { MODULE_NAME } from './constants.js';

/** Available LLM sources for memory operations. */
export const memory_sources = {
  main: 'main',
  webllm: 'webllm',
  ollama: 'ollama',
  openai_compatible: 'openai_compatible',
};

/**
 * Returns the currently configured memory source, defaulting to 'main'.
 * @returns {string}
 */
function getSource() {
  return extension_settings[MODULE_NAME]?.source ?? memory_sources.main;
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
  return (data.models || []).map((m) => m.name).sort();
}

/**
 * Sends a prompt to an Ollama instance and returns the response text.
 * Uses the /api/chat endpoint with a single user message.
 * @param {string} prompt
 * @param {Array} [priorMessages] - Optional prior messages for summarization context.
 * @param {number} responseLength
 * @returns {Promise<string>}
 */
async function generateOllama(prompt, priorMessages = [], responseLength = 600) {
  const settings = extension_settings[MODULE_NAME];
  const url = getOllamaUrl();
  const model = settings?.ollama_model;
  if (!model) throw new Error('No Ollama model selected. Choose a model in Smart Memory settings.');

  const messages = [...priorMessages, { role: 'user', content: prompt }];
  const response = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { num_predict: responseLength > 0 ? responseLength : -1 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama responded with ${response.status}`);
  const data = await response.json();
  return data.message?.content ?? '';
}

/**
 * Sends a prompt to an OpenAI-compatible API and returns the response text.
 * @param {string} prompt
 * @param {Array} [priorMessages] - Optional prior messages for summarization context.
 * @param {number} responseLength
 * @returns {Promise<string>}
 */
async function generateOpenAICompat(prompt, priorMessages = [], responseLength = 600) {
  const settings = extension_settings[MODULE_NAME];
  const baseUrl = (settings?.openai_compat_url || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('No API URL configured for OpenAI Compatible source.');
  const apiKey = settings?.openai_compat_key || '';
  const model = settings?.openai_compat_model || '';

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const messages = [...priorMessages, { role: 'user', content: prompt }];
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || undefined,
      messages,
      max_tokens: responseLength > 0 ? responseLength : undefined,
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI Compatible API responded with ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
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
 * @returns {Promise<string>} The raw model response
 */
export async function generateMemoryExtract(prompt, { responseLength = 600 } = {}) {
  const source = getSource();

  if (source === memory_sources.ollama) {
    return generateOllama(prompt, [], responseLength);
  }

  if (source === memory_sources.openai_compatible) {
    return generateOpenAICompat(prompt, [], responseLength);
  }

  if (source === memory_sources.webllm) {
    if (!isWebLlmSupported()) {
      console.warn(
        `[${MODULE_NAME}] WebLLM source selected but WebLLM is not available, falling back to main`,
      );
    } else {
      const messages = [{ role: 'user', content: prompt }];
      const params = responseLength > 0 ? { max_tokens: responseLength } : {};
      return await generateWebLlmChatPrompt(messages, params);
    }
  }

  // Default: main API. instruct:false prevents the instruct template from
  // wrapping the extraction prompt, which is important for our tagged-line
  // output format ([type:score:expiration] lines). This is a supported
  // generateRaw parameter in SillyTavern. The parsers are also resilient -
  // they only match valid tagged lines and ignore everything else - so even
  // if this were silently ignored the output would still parse correctly.
  return await generateRaw({ prompt, instruct: false, quietToLoud: false, responseLength });
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
  { responseLength = 1500, skipWIAN = true } = {},
) {
  const source = getSource();

  // For direct API sources, build the chat context ourselves and append the
  // quiet prompt as the final user message - same approach as WebLLM.
  if (source === memory_sources.ollama || source === memory_sources.openai_compatible) {
    const context = getContext();
    const priorMessages = (context.chat ?? [])
      .filter((msg) => !msg.is_system)
      .map((msg) => ({ role: msg.is_user ? 'user' : 'assistant', content: msg.mes ?? '' }));

    if (source === memory_sources.ollama) {
      return generateOllama(quietPrompt, priorMessages, responseLength);
    }
    return generateOpenAICompat(quietPrompt, priorMessages, responseLength);
  }

  if (source === memory_sources.webllm) {
    if (!isWebLlmSupported()) {
      console.warn(
        `[${MODULE_NAME}] WebLLM source selected but WebLLM is not available, falling back to main`,
      );
    } else {
      const context = getContext();
      const messages = (context.chat ?? [])
        .filter((msg) => !msg.is_system)
        .map((msg) => ({
          role: msg.is_user ? 'user' : 'assistant',
          content: msg.mes ?? '',
        }));
      messages.push({ role: 'user', content: quietPrompt });
      const params = responseLength > 0 ? { max_tokens: responseLength } : {};
      return await generateWebLlmChatPrompt(messages, params);
    }
  }

  // Default: main API
  return await generateQuietPrompt({
    quietPrompt,
    quietToLoud: false,
    skipWIAN,
    responseLength,
    removeReasoning: true,
  });
}
