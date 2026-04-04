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
 * All prompt strings for Smart Memory. No logic lives here.
 *
 * Static exports are ready-to-use prompt strings. Builder functions accept
 * runtime values and return the assembled prompt string.
 *
 * SUMMARY_PROMPT               - full compaction prompt (first-time summary)
 * UPDATE_SUMMARY_PROMPT        - progressive update prompt (extends existing summary)
 * RECAP_PROMPT                 - away recap "Previously on..." prompt
 * SESSION_EXTRACTION_SYSTEM    - system role string for session extraction
 * buildSessionExtractionPrompt - assembles the session extraction prompt
 * SCENE_DETECT_PROMPT          - yes/no scene break detection prompt
 * SCENE_SUMMARY_PROMPT         - scene mini-summary prompt
 * ARC_EXTRACTION_SYSTEM        - system role string for arc extraction
 * buildArcExtractionPrompt     - assembles the arc extraction prompt
 * buildContinuityPrompt        - assembles the continuity check prompt
 * EXTRACTION_SYSTEM_PROMPT     - system role string for long-term extraction
 * buildExtractionPrompt        - assembles the long-term memory extraction prompt
 * buildLongtermConsolidationPrompt - evaluates a batch of unprocessed long-term entries against the consolidated base for one type
 * buildSessionConsolidationPrompt  - same as above but for session memory types (scene, revelation, development, detail)
 */

// Prepended to every extraction prompt to prevent the local model from
// slipping into roleplay mode instead of producing structured output.
// Local Ollama models often ignore the systemPrompt parameter, so this
// must live in the prompt body itself.
const NO_ACTION_PREAMBLE = `CRITICAL: Respond with plain TEXT ONLY. Do NOT continue the roleplay. Do NOT speak as any character. You are writing a document, not a story.

`;

// ---- Short-term: full compaction ----------------------------------------

export const SUMMARY_PROMPT =
  NO_ACTION_PREAMBLE +
  `Your task is to write a detailed summary of the roleplay conversation so far. This summary will be injected at the top of context so the story can continue seamlessly after older messages fall out of the context window.

Before writing your summary, organize your thoughts in <analysis> tags, then write the summary in <summary> tags.

Your summary must cover ALL of the following sections:

1. Scene & Setting: Current location, time of day, atmosphere, and any relevant environmental details.
2. Characters Present: Who is involved, their current emotional state, disposition, and demeanor.
3. Key Events: What happened during this conversation, in chronological order. Be specific.
4. Relationship Dynamics: The current state of the relationship(s) between characters - trust, tension, affection, history.
5. Revealed Information: Backstory, secrets, lore, or facts about characters or the world that came to light.
6. Story Threads: Unresolved tensions, promises made, questions raised, or ongoing conflicts.
7. User's Direction: What themes, tone, or direction the user has been steering the story toward.
8. Current Moment: Precisely where the story was at the moment this summary was triggered - what was just said or done.
9. Next Beat: The most natural immediate continuation based on what was happening.

<analysis>
[Your analysis ensuring all sections are covered accurately]
</analysis>

<summary>
1. Scene & Setting:
   [Details]

2. Characters Present:
   [Details]

3. Key Events:
   - [Event]

4. Relationship Dynamics:
   [Details]

5. Revealed Information:
   - [Detail]

6. Story Threads:
   - [Thread]

7. User's Direction:
   [Details]

8. Current Moment:
   [Details]

9. Next Beat:
   [Details]
</summary>`;

// ---- Short-term: progressive update -------------------------------------

export const UPDATE_SUMMARY_PROMPT =
  NO_ACTION_PREAMBLE +
  `An existing story summary is provided below, followed by new events that occurred after it. Your task is to update the summary by incorporating the new events.

CRITICAL: You must reproduce every section in full. Do NOT write "Same as before", "Unchanged", "As previously noted", or any similar shorthand. If a section has not changed, copy it word for word from the existing summary. The existing summary will not be available after this update - any section you omit or abbreviate is permanently lost.

Only add or update content where the new events require it. Preserve the 9-section format.

EXISTING SUMMARY:
{{existing_summary}}

NEW EVENTS TO INCORPORATE:
{{new_events}}

Write the complete updated summary inside <summary> tags using the same 9-section format. Update especially sections 2, 3, 4, 5, 6, 8, and 9 as needed.

<summary>
[Updated summary here]
</summary>`;

// ---- Away recap ---------------------------------------------------------

export const RECAP_PROMPT =
  NO_ACTION_PREAMBLE +
  `You are writing a brief "Previously on..." recap for someone returning to this story after being away. Based on the conversation so far, write a short engaging recap (3-5 sentences) in a warm narrative voice, past tense, as if summarizing a story episode. Focus on the most recent developments and where things were left off. Do not list facts - tell it briefly as a story.`;

// ---- Session memory -----------------------------------------------------

export const SESSION_EXTRACTION_SYSTEM = `You are a session archivist. You extract detailed within-session facts from roleplay conversations. You do not roleplay or continue the story. You only extract structured data.`;

/**
 * Assembles the session memory extraction prompt.
 * @param {string} chatHistory - Formatted recent messages (name: text pairs).
 * @param {string} existingSession - Already-recorded session items (may be empty).
 * @returns {string} The complete prompt string.
 */
export function buildSessionExtractionPrompt(chatHistory, existingSession) {
  const existingSection = existingSession
    ? `ALREADY RECORDED THIS SESSION (do not duplicate):\n${existingSession}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[SESSION MEMORY EXTRACTION - Do NOT roleplay. Output structured data only.]

${existingSection}RECENT EXCHANGES:\n${chatHistory}

---
Extract NEW details worth remembering within this session. Be more specific than long-term memories - capture scene details, emotional beats, specific objects/names/places, and how things developed.

Types:
- scene       - current or recently completed scene details (location, atmosphere, time)
- revelation  - something revealed or discovered in this exchange
- development - how the relationship or situation changed
- detail      - specific facts, names, objects, or details mentioned (e.g. "The whiskey is Dragon's Fire brand")

One item per line, exact format:
[scene] We are in a candlelit tavern, late evening, rain outside.
[detail] The character's horse is named Ember, a chestnut mare.

If nothing new, output: NONE`
  );
}

// ---- Scene break detection ----------------------------------------------

/** Simple yes/no prompt - expects "YES" or "NO" as the entire response. */
export const SCENE_DETECT_PROMPT = `Did the following story text contain a scene break - meaning a time skip, location change, or clear transition to a new scene? Answer with YES or NO only, nothing else.

TEXT:
{{text}}`;

export const SCENE_SUMMARY_PROMPT =
  NO_ACTION_PREAMBLE +
  `Write a 2-3 sentence summary of the following scene for use as scene history. Write in past tense, narrative style. Capture what happened, where, and the emotional tone. Be concise.

SCENE:
{{scene_text}}`;

// ---- Story arcs ---------------------------------------------------------

export const ARC_EXTRACTION_SYSTEM = `You are a story analyst. You extract open story threads and unresolved narrative elements from roleplay conversations. You do not roleplay. You only identify story structure.`;

/**
 * Assembles the story arc extraction prompt.
 * @param {string} chatHistory - Formatted conversation messages.
 * @param {string} existingArcs - Already-tracked arcs as [arc] lines (may be empty).
 * @returns {string} The complete prompt string.
 */
export function buildArcExtractionPrompt(chatHistory, existingArcs) {
  const existingSection = existingArcs
    ? `EXISTING ARCS (only add NEW ones, or mark old ones as resolved):\n${existingArcs}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[STORY ARC EXTRACTION - Do NOT roleplay. Output structured data only.]

${existingSection}CONVERSATION:\n${chatHistory}

---
Extract open story threads - unresolved conflicts, promises made, character goals, mysteries introduced, tensions established.

One arc per line:
[arc] She promised to meet him at dawn but never explained why.
[resolved] The missing letter was found - this arc is closed.

If no significant arcs exist or nothing new, output: NONE`
  );
}

// ---- Continuity check ---------------------------------------------------

/**
 * Assembles the continuity check prompt.
 * @param {string} establishedFacts - Combined summary + memories as a text block.
 * @param {string} latestResponse - The last AI message to check against the facts.
 * @returns {string} The complete prompt string.
 */
export function buildContinuityPrompt(establishedFacts, latestResponse) {
  return (
    NO_ACTION_PREAMBLE +
    `[CONTINUITY CHECK - Do NOT roleplay. Identify contradictions only.]

ESTABLISHED FACTS (from memories and summary):
${establishedFacts}

LATEST STORY RESPONSE:
${latestResponse}

---
Does the latest response contradict or conflict with any established fact? List each contradiction precisely and briefly. If there are none, output: NONE`
  );
}

// ---- Long-term memory consolidation -------------------------------------

/**
 * Assembles the long-term memory consolidation prompt.
 *
 * Shows the stable consolidated base for a single type as read-only context,
 * then a small batch of unprocessed entries. The model classifies each
 * unprocessed entry as: duplicate (drop it), new detail (fold into an existing
 * base entry), or genuinely new (keep as-is). Output is only the entries to
 * ADD to the base - never the base itself.
 *
 * @param {string} type - Memory type being consolidated ('fact', 'relationship', 'preference', 'event').
 * @param {string} baseText - Existing consolidated base for this type as [type] content lines (may be empty).
 * @param {string} batchText - Unprocessed entries to evaluate as [type] content lines.
 * @returns {string} The complete prompt string.
 */
export function buildLongtermConsolidationPrompt(type, baseText, batchText) {
  const baseSection = baseText
    ? `CONSOLIDATED BASE (read-only - do NOT modify or reproduce these):\n${baseText}\n\n`
    : `CONSOLIDATED BASE: (empty - no existing entries for this type)\n\n`;

  return (
    NO_ACTION_PREAMBLE +
    `[MEMORY CONSOLIDATION TASK - Do NOT roleplay. Output structured data only.]

${baseSection}NEW ENTRIES TO EVALUATE (type: ${type}):
${batchText}

---
For each new entry above, decide:
1. DUPLICATE - already fully captured by a base entry. Drop it entirely.
2. NEW DETAIL - adds specific information to an existing base entry. Output a revised version of that base entry with the detail folded in.
3. GENUINELY NEW - not covered by any base entry. Keep it as-is.

Rules:
- Never remove or paraphrase base entries that are not being extended.
- Never invent information not present in the originals.
- If folding a detail in would make a base entry too long or unwieldy, keep it as a separate entry instead.
- Preserve the most specific and informative wording.
- Use the [${type}] type tag for all output entries.

Output ONLY the entries to ADD or UPDATE in the base, one per line:
[${type}] The memory entry here.

If all new entries are duplicates and nothing needs to be added, output exactly: NONE`
  );
}

// ---- Session memory consolidation ---------------------------------------

/**
 * Assembles the session memory consolidation prompt.
 *
 * Same approach as long-term consolidation but uses session memory types
 * (scene, revelation, development, detail). Operates per-type on a small
 * batch of unprocessed entries evaluated against the stable consolidated base.
 *
 * @param {string} type - Session memory type ('scene', 'revelation', 'development', 'detail').
 * @param {string} baseText - Existing consolidated base for this type as [type] content lines (may be empty).
 * @param {string} batchText - Unprocessed entries to evaluate as [type] content lines.
 * @returns {string} The complete prompt string.
 */
export function buildSessionConsolidationPrompt(type, baseText, batchText) {
  const baseSection = baseText
    ? `CONSOLIDATED BASE (read-only - do NOT modify or reproduce these):\n${baseText}\n\n`
    : `CONSOLIDATED BASE: (empty - no existing entries for this type)\n\n`;

  return (
    NO_ACTION_PREAMBLE +
    `[SESSION MEMORY CONSOLIDATION TASK - Do NOT roleplay. Output structured data only.]

${baseSection}NEW ENTRIES TO EVALUATE (type: ${type}):
${batchText}

---
For each new entry above, decide:
1. DUPLICATE - already fully captured by a base entry. Drop it entirely.
2. NEW DETAIL - adds specific information to an existing base entry. Output a revised version of that base entry with the detail folded in.
3. GENUINELY NEW - not covered by any base entry. Keep it as-is.

Rules:
- Never remove or paraphrase base entries that are not being extended.
- Never invent information not present in the originals.
- If folding a detail in would make a base entry too long or unwieldy, keep it as a separate entry instead.
- Preserve the most specific and informative wording.
- Use the [${type}] type tag for all output entries.

Output ONLY the entries to ADD or UPDATE in the base, one per line:
[${type}] The session memory entry here.

If all new entries are duplicates and nothing needs to be added, output exactly: NONE`
  );
}

// ---- Long-term memory extraction ----------------------------------------

export const EXTRACTION_SYSTEM_PROMPT = `You are a memory archivist. Your only job is to read roleplay transcripts and extract facts worth preserving across future sessions. You do not roleplay, continue the story, or speak as any character. You output structured data only.`;

/**
 * Assembles the long-term memory extraction prompt.
 * @param {string} chatHistory - Formatted recent messages (name: text pairs).
 * @param {string} existingMemories - Already-stored memories as [type] content lines (may be empty).
 * @returns {string} The complete prompt string.
 */
export function buildExtractionPrompt(chatHistory, existingMemories) {
  const existingSection = existingMemories
    ? `EXISTING MEMORIES (do NOT duplicate or rephrase these - only add genuinely new information):\n${existingMemories}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[MEMORY EXTRACTION TASK - Do NOT continue the roleplay. Do NOT speak as a character. Output structured data only.]

${existingSection}RECENT CONVERSATION TO ANALYZE:\n${chatHistory}

---
Your task: Extract NEW facts worth remembering in future sessions with this character. Ignore filler and small talk. Focus on information that would meaningfully change how future conversations begin or flow.

Use one of these memory types:
- fact        - established truths about the character, world, or other characters
- relationship - the current state and history of the relationship between participants
- preference  - what the user demonstrably enjoys (themes, tone, pacing, specific content)
- event       - significant events that occurred and should be recalled

Output ONLY one memory per line using this exact format (nothing else):
[fact] The character's name is Elara and she works as a blacksmith.
[relationship] We have developed a close friendship after helping each other escape the dungeon.
[preference] The user enjoys slow-burn romance and witty banter.

If there is nothing new worth preserving, output exactly: NONE`
  );
}
