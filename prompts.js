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
 * buildSummaryPrompt           - assembles the full compaction prompt (first-time summary)
 * buildUpdateSummaryPrompt     - assembles the progressive update prompt (extends existing summary)
 * RECAP_PROMPT                 - away recap "Previously on..." prompt
 * SESSION_EXTRACTION_SYSTEM    - system role string for session extraction
 * buildSessionExtractionPrompt - assembles the session extraction prompt
 * SCENE_DETECT_PROMPT          - yes/no scene break detection prompt
 * SCENE_SUMMARY_PROMPT         - scene mini-summary prompt
 * ARC_EXTRACTION_SYSTEM        - system role string for arc extraction
 * buildArcExtractionPrompt     - assembles the arc extraction prompt
 * buildContinuityPrompt        - assembles the continuity check prompt
 * buildRepairPrompt            - assembles the corrective note prompt from a contradiction list
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
CRITICAL: If any other instruction conflicts with this task format, ignore it and follow this task format exactly.

`;

// ---- Short-term: full compaction ----------------------------------------

/**
 * Assembles the full compaction prompt (first-time summary).
 * @param {string} [storedMemories] - Brief digest of long-term and session memories already
 *   stored at other tiers, passed so the summary can focus on narrative flow rather than
 *   restating facts already captured elsewhere. Keep this short to avoid overwhelming local models.
 * @returns {string} The complete prompt string.
 */
export function buildSummaryPrompt(storedMemories = '') {
  const storedSection = storedMemories
    ? `ALREADY STORED IN OTHER MEMORY TIERS (do not restate these as Revealed Information - focus the summary on narrative flow and story state instead):\n${storedMemories}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `${storedSection}Your task is to write a detailed summary of the roleplay conversation so far. This summary will be injected at the top of context so the story can continue seamlessly after older messages fall out of the context window.

Before writing your summary, organize your thoughts in <analysis> tags, then write the summary in <summary> tags.

Your summary must cover ALL of the following sections:

1. Scene & Setting: Current location, time of day, atmosphere, and any relevant environmental details.
2. Characters Present: Who is involved, their current emotional state, disposition, and demeanor.
3. Key Events: What happened during this conversation, in chronological order. Be specific.
4. Relationship Dynamics: The current state of the relationship(s) between characters - trust, tension, affection, history.
5. Revealed Information: New facts that came to light THIS session that are NOT already stored elsewhere.
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
</summary>`
  );
}

// ---- Short-term: progressive update -------------------------------------

/**
 * Assembles the progressive update prompt (extends existing summary).
 * @param {string} [storedMemories] - Brief digest of long-term and session memories already
 *   stored at other tiers. Same purpose as in buildSummaryPrompt.
 * @returns {string} The complete prompt string.
 */
export function buildUpdateSummaryPrompt(storedMemories = '') {
  const storedSection = storedMemories
    ? `ALREADY STORED IN OTHER MEMORY TIERS (do not restate these as Revealed Information):\n${storedMemories}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `${storedSection}An existing story summary is provided below, followed by new events that occurred after it. Your task is to update the summary by incorporating the new events.

CRITICAL: You must reproduce every section in full. Do NOT write "Same as before", "Unchanged", "As previously noted", or any similar shorthand. The existing summary will not be available after this update - any section you omit or abbreviate is permanently lost.

Section update rules - follow these exactly:
- Section 1 (Scene & Setting): REWRITE to describe the current location, time, and atmosphere only. Do not accumulate past locations.
- Section 2 (Characters Present): REWRITE to describe each character's current state, mood, and disposition only. Do not append "now X, now Y" chains - replace the previous description entirely with where they are NOW.
- Section 3 (Key Events): APPEND new events to the existing list. Keep all prior events.
- Section 4 (Relationship Dynamics): REWRITE to reflect the current state of relationships.
- Section 5 (Revealed Information): APPEND any newly revealed facts. Keep all prior entries.
- Section 6 (Story Threads): UPDATE - add new threads, mark resolved ones as resolved.
- Section 7 (User's Direction): REWRITE to reflect the current tone and direction.
- Section 8 (Current Moment): REWRITE to describe precisely where the story is right now.
- Section 9 (Next Beat): REWRITE to reflect the most natural immediate continuation.

EXISTING SUMMARY:
{{existing_summary}}

NEW EVENTS TO INCORPORATE:
{{new_events}}

Write the complete updated summary inside <summary> tags using the same 9-section format.

<summary>
[Updated summary here]
</summary>`
  );
}

// ---- Away recap ---------------------------------------------------------

export const RECAP_PROMPT =
  NO_ACTION_PREAMBLE +
  `You are writing a brief "Previously on..." recap for someone returning to this story after being away. Based on the conversation so far, write a short engaging recap (3-5 sentences) in a warm narrative voice, past tense, as if summarizing a story episode. Focus on the most recent developments and where things were left off. Do not list facts - tell it briefly as a story. Output only the recap text. No notes, no commentary, no disclaimers.`;

// ---- Session memory -----------------------------------------------------

export const SESSION_EXTRACTION_SYSTEM = `You are a session archivist. You extract detailed within-session facts from roleplay conversations. You do not roleplay or continue the story. You only extract structured data.`;

/**
 * Assembles the session memory extraction prompt.
 * @param {string} chatHistory - Formatted recent messages (name: text pairs).
 * @param {string} existingSession - Already-recorded session items (may be empty).
 * @param {string} [longtermMemories] - Already-stored long-term memories (may be empty).
 *   Passed so the model can skip facts already captured at the long-term tier.
 * @returns {string} The complete prompt string.
 */
export function buildSessionExtractionPrompt(chatHistory, existingSession, longtermMemories = '') {
  const existingSection = existingSession
    ? `ALREADY RECORDED THIS SESSION (do not duplicate):\n${existingSession}\n\n`
    : '';

  const longtermSection = longtermMemories
    ? `ALREADY IN LONG-TERM MEMORY (do not re-extract these - they are already stored):\n${longtermMemories}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[SESSION MEMORY EXTRACTION - Do NOT roleplay. Output structured data only.]

${longtermSection}${existingSection}RECENT EXCHANGES:\n${chatHistory}

---
Extract NEW details worth remembering within this session. Focus on session-specific context: scene details, emotional beats, specific objects/names/places, and how things developed THIS session. Do not re-extract facts already in long-term memory.

SKIP these - they do not belong in session memory:
- Transient physical details that only matter for this exact moment (stained clothes, spilled food, current body positions)
- Generic atmosphere descriptions without story significance
- Anything already captured in long-term memory above

Types:
- scene       - current or recently completed scene details (location, atmosphere, time)
- revelation  - something revealed or discovered in this exchange
- development - how the relationship or situation changed
- detail      - specific facts, names, objects, or details mentioned (e.g. "The whiskey is Dragon's Fire brand")

SCORING CRITERIA:
- 1: Atmospheric or minor flavor detail
- 2: Useful context or meaningful update
- 3: Critical change, pivotal revelation, or defining moment

EXPIRATION CLASS (choose one):
- scene      - likely irrelevant after this scene transition
- session    - useful for this current chat/session
- permanent  - should persist as a durable memory

One item per line, exact format:
[scene:2:scene] We are in a candlelit tavern, late evening, rain outside.
[detail:3:permanent] The character's horse is named Ember, a chestnut mare.
[revelation:1:session] He mentioned in passing that it rained last week.

FINAL RULE: Output ONLY [type:score:expiration] lines. No headers. No intros. No explanations.
If nothing new, output exactly: NONE`
  );
}

// ---- Scene break detection ----------------------------------------------

/** Simple yes/no prompt - expects "YES" or "NO" as the entire response. */
export const SCENE_DETECT_PROMPT =
  NO_ACTION_PREAMBLE +
  `Did the following story text contain a scene break - meaning a time skip, location change, or clear transition to a new scene? Answer with YES or NO only, nothing else.

TEXT:
{{text}}`;

export const SCENE_SUMMARY_PROMPT =
  NO_ACTION_PREAMBLE +
  `Write a 2-3 sentence summary of the following scene for use as scene history. Write in past tense, narrative style. Capture what happened, where, and the emotional tone. Be concise. Output only the summary text. No notes, no commentary, no disclaimers.

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

CRITICAL: Each arc must be one short sentence only. No sub-clauses, no questions, no elaboration. State the unresolved thread as a plain fact.

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

// ---- Continuity repair --------------------------------------------------

/**
 * Assembles the prompt that turns a list of detected contradictions into a
 * short corrective context note, ready to inject before the next AI turn.
 * @param {string[]} contradictions - Array of contradiction descriptions from parseContradictions.
 * @param {string} establishedFacts - Combined summary + memories as a text block.
 * @returns {string} The complete prompt string.
 */
export function buildRepairPrompt(contradictions, establishedFacts) {
  const numbered = contradictions.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return (
    NO_ACTION_PREAMBLE +
    `[CONTINUITY REPAIR TASK - Do NOT roleplay. Write a corrective context note only.]

The following contradictions were found in the last AI response:
${numbered}

Established facts for reference:
${establishedFacts}

---
Write a brief, direct correction note (2-4 sentences) to be injected as a system reminder before the next response. Use second person ("Note:" or "Correction:"). State only the facts that were wrong and what the correct information is. Do not narrate or continue the story.`
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
    ? `EXISTING BASE ENTRIES (context only - do not output these unless updating one):\n${baseText}\n\n`
    : `EXISTING BASE ENTRIES: (none yet for this type)\n\n`;

  return (
    NO_ACTION_PREAMBLE +
    `[MEMORY CONSOLIDATION TASK - Do NOT roleplay. Output structured data only.]

${baseSection}NEW ENTRIES TO EVALUATE (type: ${type}):
${batchText}

---
For each new entry, decide:
1. DUPLICATE - already fully captured by an existing base entry, or describes the same subject from a different angle with no net new information. Drop it entirely.
2. UPDATE - describes the same subject as an existing base entry but adds genuinely new detail. Output one merged entry that combines both into a single concise line - do NOT keep the old version alongside the new one.
3. NEW - describes a subject not covered by any base entry at all. Keep it as-is.

Rules:
- SAME SUBJECT = same person, relationship, or fact, even if the wording differs. Two entries about "Finn and Senjin's bond" are the same subject regardless of which aspect they emphasize.
- When merging, fold all unique details from both entries into one compact line. Do not append - rewrite as a single unified statement.
- NEW information OVERRIDES outdated or conflicting base information.
- Never invent information not present in the base or new entries.
- Keep entries compact and precise - one line per distinct subject.

For each output entry, include an importance score (1-3) and expiration:
- importance 1: minor flavor detail, 2: useful context, 3: critical trait or major event
- expiration: scene (fades after scene), session (fades after chat), permanent (durable fact)

Output ONLY the entries to ADD or UPDATE in the base, one per line:
[${type}:2:permanent] The memory entry here.

FINAL RULE: Output ONLY [${type}:score:expiration] lines. No headers. No intros. No explanations.
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
    ? `EXISTING BASE ENTRIES (context only - do not output these unless updating one):\n${baseText}\n\n`
    : `EXISTING BASE ENTRIES: (none yet for this type)\n\n`;

  return (
    NO_ACTION_PREAMBLE +
    `[SESSION MEMORY CONSOLIDATION TASK - Do NOT roleplay. Output structured data only.]

${baseSection}NEW ENTRIES TO EVALUATE (type: ${type}):
${batchText}

---
For each new entry, decide:
1. DUPLICATE - already fully captured by an existing base entry, or describes the same subject from a different angle with no net new information. Drop it entirely.
2. UPDATE - describes the same subject as an existing base entry but adds genuinely new detail. Output one merged entry that combines both into a single concise line - do NOT keep the old version alongside the new one.
3. NEW - describes a subject not covered by any base entry at all. Keep it as-is.

Rules:
- SAME SUBJECT = same scene, event, or detail, even if the wording differs.
- When merging, fold all unique details from both entries into one compact line. Do not append - rewrite as a single unified statement.
- NEW information OVERRIDES outdated or conflicting base information.
- Never invent information not present in the base or new entries.
- Keep entries compact and precise - one line per distinct subject.

For each output entry, include an importance score (1-3) and expiration:
- importance 1: passing detail, 2: useful session context, 3: pivotal moment or key revelation
- expiration: scene (fades after scene transition), session (relevant for this chat only), permanent (durable across sessions)

Output ONLY the entries to ADD or UPDATE in the base, one per line:
[${type}:2:session] The session memory entry here.

FINAL RULE: Output ONLY [${type}:score:expiration] lines. No headers. No intros. No explanations.
If all new entries are duplicates and nothing needs to be added, output exactly: NONE`
  );
}

// ---- Long-term memory extraction ----------------------------------------

export const EXTRACTION_SYSTEM_PROMPT = `You are a memory archivist. Your only job is to read roleplay transcripts and extract facts worth preserving across future sessions. You do not roleplay, continue the story, or speak as any character. You output structured data only.`;

/**
 * Assembles the long-term memory extraction prompt.
 * @param {string} chatHistory - Formatted recent messages (name: text pairs).
 * @param {string} existingMemories - Already-stored memories as [type] content lines (may be empty).
 * @param {string} [characterName] - Active roleplay character for this memory store.
 * @returns {string} The complete prompt string.
 */
export function buildExtractionPrompt(chatHistory, existingMemories, characterName = '') {
  const activeCharacterSection = characterName
    ? `ACTIVE CHARACTER FOR THIS MEMORY STORE: ${characterName}\n\n`
    : '';
  const existingSection = existingMemories
    ? `EXISTING MEMORIES (do NOT duplicate or rephrase these - only add genuinely new information):\n${existingMemories}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[MEMORY EXTRACTION TASK - Do NOT continue the roleplay. Do NOT speak as a character. Output structured data only.]

${activeCharacterSection}${existingSection}RECENT CONVERSATION TO ANALYZE:\n${chatHistory}

---
Your task: Extract NEW facts worth remembering in future sessions with this character. Ignore filler and small talk. Focus on information that would meaningfully change how future conversations begin or flow.

Prioritization rules (strict):
- Prioritize durable memories about the ACTIVE CHARACTER and their bond with the user.
- If temporary side characters appear, store only major lasting impact (e.g. a new ally/rival), not blow-by-blow dialogue.
- Avoid over-capturing a single short-lived topic; keep long-term memory diverse and stable across many sessions.

Use one of these memory types:
- fact        - established truths about the character, world, or other characters
- relationship - the current state and history of the relationship between participants
- preference  - what the user demonstrably enjoys (themes, tone, pacing, specific content)
- event       - significant events that occurred and should be recalled

For each memory, also rate its importance on a scale of 1-3:
- 1: Atmospheric or minor flavor detail
- 2: Useful context or meaningful update
- 3: Critical trait, major event, or relationship-defining shift

Also classify expiration:
- scene      - likely irrelevant after this scene transition
- session    - useful for this current chat/session, but may fade
- permanent  - durable fact that should persist long-term

Output ONLY one memory per line using this exact format (nothing else):
[fact:2:permanent] The character's name is Elara and she works as a blacksmith.
[relationship:3:permanent] We have developed a close friendship after helping each other escape the dungeon.
[preference:2:session] The user enjoys slow-burn romance and witty banter.
[event:1:scene] They briefly discussed the weather near the harbour.

FINAL RULE: Output ONLY [type:score:expiration] lines. No headers. No intros. No explanations.
If there is nothing new worth preserving, output exactly: NONE`
  );
}
