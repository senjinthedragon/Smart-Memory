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
 * Stateful character and world profiles regenerated from graph state.
 *
 * Profiles are compact snapshots injected every turn at low token cost as stable
 * anchors for the AI. They are regenerated from stored memories on a schedule -
 * not from raw chat - so they stay coherent even after compaction removes older
 * messages. Profile generation is a single sequential model call that produces
 * all three sections at once to minimise round-trips on local hardware.
 *
 * Stored in chatMetadata.smartMemory.profiles as a per-character map:
 *   { [characterName]: { character_state, world_state, relationship_matrix, generated_at } }
 *
 * In group chats each member has their own entry so switching the character
 * selector in the settings panel shows the correct character's profile.
 *
 * loadProfiles         - returns stored profiles for a character from chatMetadata (null if none)
 * areProfilesStale     - true if a character's profiles are older than the configured threshold
 * generateProfiles     - calls the model and saves the result; returns the profiles
 * injectProfiles       - pushes the specified character's profiles into the prompt
 * clearProfiles        - removes stored profiles and clears the injection slot
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { generateMemoryExtract } from './generate.js';
import { estimateTokens, MODULE_NAME, META_KEY, PROMPT_KEY_PROFILES } from './constants.js';
import { loadCharacterMemories, formatMemoriesForPrompt } from './longterm.js';
import { loadSessionMemories } from './session.js';
import { loadCharacterEntityRegistry } from './graph-migration.js';
import { buildProfileGenerationPrompt } from './prompts.js';
import { parseProfileOutput } from './parsers.js';
import { smLog } from './logging.js';

// Default staleness threshold: 30 minutes. Profiles generated within this
// window are considered current and will not be regenerated on chat load.
const DEFAULT_STALE_THRESHOLD_MS = 30 * 60 * 1000;

// ---- Storage ------------------------------------------------------------

/**
 * Returns stored profiles for the given character from chatMetadata, or null if none exist yet.
 * @param {string} characterName
 * @returns {{character_state: string, world_state: string, relationship_matrix: string, generated_at: number}|null}
 */
export function loadProfiles(characterName) {
  if (!characterName) return null;
  const context = getContext();
  return context.chatMetadata?.[META_KEY]?.profiles?.[characterName] ?? null;
}

/**
 * Persists profiles for the given character to chatMetadata.
 * @param {{character_state: string, world_state: string, relationship_matrix: string, generated_at: number}} profiles
 * @param {string} characterName
 */
async function saveProfiles(profiles, characterName) {
  if (!characterName) return;
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  if (!context.chatMetadata[META_KEY].profiles) context.chatMetadata[META_KEY].profiles = {};
  context.chatMetadata[META_KEY].profiles[characterName] = profiles;
  await context.saveMetadata();
}

/**
 * Returns true if stored profiles for the given character are older than the configured
 * threshold or do not exist yet. Used to decide whether to regenerate on chat load.
 * @param {number} [thresholdMs] - Staleness threshold in milliseconds.
 * @param {string} [characterName]
 * @returns {boolean}
 */
export function areProfilesStale(thresholdMs = DEFAULT_STALE_THRESHOLD_MS, characterName) {
  const profiles = loadProfiles(characterName);
  if (!profiles) return true;
  return Date.now() - (profiles.generated_at ?? 0) > thresholdMs;
}

// ---- Generation ---------------------------------------------------------

/**
 * Calls the model to regenerate character/world profiles from stored memories
 * and saves the result to chatMetadata.
 *
 * Loads active long-term memories, session memories, and the character entity
 * registry. Passes them all to buildProfileGenerationPrompt in one call.
 * Returns null and logs a warning if the model produces unparseable output.
 *
 * @param {string} characterName - Active character name.
 * @returns {Promise<{character_state: string, world_state: string, relationship_matrix: string, generated_at: number}|null>}
 */
export async function generateProfiles(characterName) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.profiles_enabled || !characterName) return null;

  // Only pass active (non-retired) memories to the profile prompt.
  const longtermMemories = loadCharacterMemories(characterName).filter((m) => !m.superseded_by);
  const sessionMemories = loadSessionMemories().filter((m) => !m.superseded_by);

  if (longtermMemories.length === 0 && sessionMemories.length === 0) {
    // Nothing stored yet - skip generation rather than producing empty profiles.
    return null;
  }

  const ltText = formatMemoriesForPrompt(longtermMemories);
  const sessText =
    sessionMemories.length > 0
      ? sessionMemories.map((m) => `[${m.type}] ${m.content}`).join('\n')
      : '';

  // Pass entity registry names for the relationship matrix. Only character and
  // place entities are useful here - concepts and objects clutter the output.
  const entityRegistry = loadCharacterEntityRegistry(characterName);
  const entities = entityRegistry
    .filter((e) => e.type === 'character' || e.type === 'place')
    .map((e) => ({ name: e.name, type: e.type }));

  const prompt = buildProfileGenerationPrompt(characterName, ltText, sessText, entities);

  try {
    const response = await generateMemoryExtract(prompt, {
      responseLength: settings.profiles_response_length ?? 400,
    });

    smLog('[SmartMemory] Profile generation response:', response);

    if (!response) return null;

    const parsed = parseProfileOutput(response);
    if (!parsed) {
      console.warn(
        '[SmartMemory] Profile generation produced unparseable output. Check format above.',
      );
      return null;
    }

    const profiles = { ...parsed, generated_at: Date.now() };
    await saveProfiles(profiles, characterName);
    return profiles;
  } catch (err) {
    console.error('[SmartMemory] Profile generation failed:', err);
    return null;
  }
}

// ---- Injection ----------------------------------------------------------

/**
 * Formats profiles into a compact text block for prompt injection.
 * Sections with empty content are omitted so the block stays short when
 * the model only populated some sections.
 * @param {{character_state: string, world_state: string, relationship_matrix: string}} profiles
 * @param {number} budget - Token budget for the profiles block.
 * @returns {string}
 */
function formatProfiles(profiles, budget) {
  // Build sections in priority order: character_state is least important
  // (drop first to preserve relationship context), relationship_matrix last.
  const sections = [
    { key: 'character_state', label: 'Character state:' },
    { key: 'world_state', label: 'World state:' },
    { key: 'relationship_matrix', label: 'Relationships:' },
  ];

  // Start with all non-empty sections as a mutable array of text blocks.
  // Trimming rebuilds from the array rather than text-replacing, so repeated
  // phrasings across sections cannot cause partial removal.
  const activeParts = sections
    .filter(({ key }) => profiles[key])
    .map(({ key, label }) => `${label}\n${profiles[key]}`);

  // Drop sections from the front (least important first) until under budget.
  while (estimateTokens(activeParts.join('\n\n')) > budget && activeParts.length > 1) {
    activeParts.shift();
  }

  return activeParts.join('\n\n');
}

/**
 * Injects the given character's stored profiles into the prompt via setExtensionPrompt.
 * Clears the slot if profiles are disabled, the character is unknown, or nothing is stored.
 * @param {string} [characterName]
 */
export function injectProfiles(characterName) {
  const settings = extension_settings[MODULE_NAME];

  if (!settings.profiles_enabled) {
    setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
    return;
  }

  const profiles = loadProfiles(characterName);
  if (!profiles) {
    setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
    return;
  }

  const budget = settings.profiles_inject_budget ?? 200;
  const text = formatProfiles(profiles, budget);

  if (!text) {
    setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
    return;
  }

  const template = settings.profiles_template ?? '{{profiles}}';
  const content = template.replace('{{profiles}}', text);

  setExtensionPrompt(
    PROMPT_KEY_PROFILES,
    content,
    settings.profiles_position ?? extension_prompt_types.IN_PROMPT,
    settings.profiles_depth ?? 1,
    false,
    settings.profiles_role ?? extension_prompt_roles.SYSTEM,
  );
}

/**
 * Clears stored profiles from chatMetadata and removes the injection slot.
 * If characterName is provided, only that character's entry is removed.
 * If omitted, all profiles for the chat are removed.
 * @param {string} [characterName]
 */
export async function clearProfiles(characterName) {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]?.profiles) {
    if (characterName) {
      delete context.chatMetadata[META_KEY].profiles[characterName];
    } else {
      delete context.chatMetadata[META_KEY].profiles;
    }
    await context.saveMetadata();
  }
  setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
}
