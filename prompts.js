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
 * buildSessionExtractionPrompt - assembles the session extraction prompt
 * buildSceneDetectPrompt       - assembles the yes/no scene break detection prompt with prior context
 * SCENE_SUMMARY_PROMPT         - scene mini-summary prompt
 * buildArcExtractionPrompt     - assembles the arc extraction prompt
 * buildArcSummaryPrompt        - assembles the arc resolution summary prompt
 * buildContinuityPrompt        - assembles the continuity check prompt
 * buildRepairPrompt            - assembles the corrective note prompt from a contradiction list
 * buildExtractionPrompt        - assembles the long-term memory extraction prompt
 * buildLongtermConsolidationPrompt - evaluates a batch of unprocessed long-term entries against the consolidated base for one type
 * buildSessionConsolidationPrompt  - same as above but for session memory types (scene, revelation, development, detail)
 * buildProfileGenerationPrompt     - generates character_state, world_state, and relationship_matrix from stored memories
 * buildCanonSummaryPrompt          - generates a stable per-character canon narrative from arc summaries and memories
 * buildSupersessionConfirmPrompt   - binary UPDATE/INDEPENDENT prompt for model-confirmed supersession (method B)
 *
 * Entity tagging: both extraction prompts instruct the model to append an
 * optional `:entity=Name1,Name2` suffix to the bracket tag for any memory
 * that involves a named character, place, or object. The suffix is parsed
 * and normalised to entity registry ids by the extraction wiring in
 * longterm.js and session.js. It is intentionally optional so the model can
 * omit it when no named entities are relevant rather than hallucinating names.
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

IMPORTANT: Summarize only the actual roleplay exchanges between characters. Do NOT reproduce, restate, or copy any injected memory context that appears before the conversation - this includes character history, long-term memories, character profiles, scene history, session details, or story arcs. Those are already stored separately. Only the story events that happened in the chat messages belong in this summary.

Write the summary inside <summary> tags. Cover all nine sections below - do not skip or abbreviate any of them.

<summary>
1. Scene & Setting: Current location, time of day, atmosphere, and any relevant environmental details.

2. Characters Present: Who is involved, their current emotional state, disposition, and demeanor.

3. Key Events: What happened during this conversation, in chronological order. Be specific.

4. Relationship Dynamics: The current state of the relationship(s) between characters - trust, tension, affection, history.

5. Revealed Information: New facts that came to light THIS session that are NOT already stored elsewhere.

6. Story Threads: Unresolved tensions, promises made, questions raised, or ongoing conflicts.

7. User's Direction: What themes, tone, or direction the user has been steering the story toward.

8. Current Moment: Precisely where the story was at the moment this summary was triggered - what was just said or done.

9. Next Beat: The most natural immediate continuation based on what was happening.
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

IMPORTANT: Summarize only the actual roleplay exchanges between characters. Do NOT reproduce, restate, or copy any injected memory context - this includes character history, long-term memories, character profiles, scene history, session details, or story arcs. Those are already stored separately. Only story events from the chat messages belong in this summary.

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

Write the complete updated summary inside <summary> tags using the same 9-section format. Reproduce all nine sections in full.

<summary>
1. Scene & Setting:
2. Characters Present:
3. Key Events:
4. Relationship Dynamics:
5. Revealed Information:
6. Story Threads:
7. User's Direction:
8. Current Moment:
9. Next Beat:
</summary>`
  );
}

// ---- Away recap ---------------------------------------------------------

export const RECAP_PROMPT =
  NO_ACTION_PREAMBLE +
  `You are writing a brief "Previously on..." recap for someone returning to this story after being away. Based on the conversation so far, write a short engaging recap (3-5 sentences) in a warm narrative voice, past tense, as if summarizing a story episode. Focus on the most recent developments and where things were left off. Do not list facts - tell it briefly as a story. Output only the recap text. No notes, no commentary, no disclaimers.`;

// ---- Session memory -----------------------------------------------------

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
    ? `ALREADY RECORDED THIS SESSION (do not duplicate):\n${existingSession}\n\nIf something from this list has CHANGED, extract the updated version using explicit state-change language ("now", "no longer", "became", "stopped", etc.) so it can supersede the outdated entry rather than accumulating alongside it.\n\n`
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
- Transient physical state that won't outlast this moment (stained clothes, spilled food, current body positions)
- Generic atmosphere descriptions without story significance
- Anything already captured in long-term memory above

DO capture persistent physical anchors even if they feel minor - wounds sustained, physical features described for the first time, notable features of a named location, significant objects referenced by name. These ground the continuity checker.

Types:
- scene       - current or recently completed scene details (location, atmosphere, time, spatial layout)
- revelation  - something revealed or discovered in this exchange
- development - how the relationship or situation changed
- detail      - specific facts, names, objects, or physical details mentioned (e.g. "The whiskey is Dragon's Fire brand", "The inn has a locked cellar door", "She has green eyes")

SCORING CRITERIA:
- 1: Atmospheric or minor flavor detail
- 2: Useful context or meaningful update
- 3: Critical change, pivotal revelation, or defining moment

EXPIRATION CLASS (choose one):
- scene      - likely irrelevant after this scene transition
- session    - useful for this current chat/session
- permanent  - should persist as a durable memory

ENTITY TAGGING (optional but encouraged):
If the memory involves specific NAMED entities (proper nouns with a specific name - a character, a named location, a named object, an organisation), append :entity=Name/type pairs inside the bracket. Use the exact names as they appear in the conversation. Classify each as: character, place, object, faction, or concept. Do NOT tag generic nouns (whiskey, sword, horse, money, fire) - only tag them if they have a specific proper name (Jack Daniel's, Excalibur, Shadowmere). Omit this field entirely if no named entities are relevant - do not invent names.

One item per line, exact format:
[scene:2:scene] We are in a candlelit tavern, late evening, rain outside.
[detail:3:permanent:entity=Ember/character] The character's horse is named Ember, a chestnut mare.
[revelation:3:permanent:entity=Senjin/character,Kael/character] Senjin revealed that Kael is his estranged brother.
[revelation:1:session] He mentioned in passing that it rained last week.

FINAL RULE: Output ONLY [type:score:expiration] or [type:score:expiration:entity=...] lines. No headers. No intros. No explanations.
If nothing new, output exactly: NONE`
  );
}

// ---- Scene break detection ----------------------------------------------

/**
 * Assembles the scene break detection prompt.
 * Providing the previous message as context lets the model distinguish a
 * transition from a continuation of the same scene.
 * @param {string} currentMessage - The latest AI message to evaluate.
 * @param {string} [previousMessage] - The preceding AI message, if available.
 * @returns {string} The complete yes/no detection prompt.
 */
export function buildSceneDetectPrompt(currentMessage, previousMessage) {
  const prevSection = previousMessage
    ? `PREVIOUS MESSAGE (for context - the scene that just ended or is continuing):\n${previousMessage.slice(0, 600)}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[SCENE BREAK DETECTION - Answer YES or NO only.]

${prevSection}CURRENT MESSAGE:
${currentMessage.slice(0, 800)}

---
Did the CURRENT MESSAGE mark the start of a new scene?

A NEW SCENE starts when:
- A meaningful amount of time has passed (hours, days, sleep, dawn breaking, waking up after rest)
- The characters have moved to a clearly different location
- A hard narrative break occurs (portal, transition, loss of consciousness then recovery, etc.)

NOT a new scene:
- Action, combat, or drama continuing in the same location and moment
- Emotional beats or dialogue within the same continuous encounter
- The story picking up seconds or minutes after the previous message

Answer YES or NO only. Nothing else.`
  );
}

export const SCENE_SUMMARY_PROMPT =
  NO_ACTION_PREAMBLE +
  `Write a 2-3 sentence summary of the following scene for use as scene history. Write in past tense, narrative style. Capture what happened, where, and the emotional tone. Be concise. Output only the summary text. No notes, no commentary, no disclaimers.

SCENE:
{{scene_text}}`;

// ---- Story arcs ---------------------------------------------------------

/**
 * Assembles the story arc extraction prompt.
 * @param {string} chatHistory - Formatted conversation messages.
 * @param {string} existingArcs - Already-tracked arcs as [arc] lines (may be empty).
 * @returns {string} The complete prompt string.
 */
export function buildArcExtractionPrompt(chatHistory, existingArcs) {
  const existingSection = existingArcs
    ? `EXISTING OPEN ARCS (read-only context - do not copy, annotate, or re-output these):\n${existingArcs}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[STORY ARC EXTRACTION - Do NOT roleplay. Output structured data only.]

${existingSection}CONVERSATION:\n${chatHistory}

---
Extract open story threads - unresolved conflicts, promises made, character goals, mysteries introduced, tensions established.

Output format - one entry per line, two tags allowed:
  [arc] <new unresolved thread from this conversation, not already listed above>
  [resolved] <title or brief description of an existing arc that was explicitly closed>

Example output:
  [arc] Mira swore revenge on the merchant who sold her into slavery.
  [resolved] The missing heir was found alive in the northern keep.

Only output [arc] for threads that are NEW in this conversation - do not re-output existing arcs.
Only mark [resolved] if the conversation directly closes the arc - a promise kept, a mystery answered, a conflict ended. A related revelation is NOT a resolution. If new information makes an existing arc more urgent or complicated, it stays open.

If nothing new and nothing resolved, output: NONE`
  );
}

// ---- Continuity check ---------------------------------------------------

/**
 * Assembles the arc summary prompt for a resolved story arc.
 * The summary covers the full thread from opening through resolution.
 *
 * @param {string} arcContent - The resolved arc's content string.
 * @param {string} sceneSummaries - Joined scene summaries that occurred during the arc.
 * @param {string} memories - Key memories from the arc (formatted as [type] content lines).
 * @returns {string} The complete prompt string.
 */
export function buildArcSummaryPrompt(arcContent, sceneSummaries, memories) {
  const memSection = memories ? `\nKEY MEMORIES FROM THIS ARC:\n${memories}\n` : '';
  const sceneSection = sceneSummaries ? `\nSCENE SUMMARIES:\n${sceneSummaries}\n` : '';

  return (
    NO_ACTION_PREAMBLE +
    `[ARC SUMMARY - Do NOT roleplay. Write a summary paragraph only.]

Write a single paragraph summarising the story arc below from opening to resolution. Write in past tense, narrative style. Cover what happened, who was involved, and how it resolved. Be concise - aim for 3-5 sentences. Output only the paragraph, no labels or commentary.

ARC: ${arcContent}${sceneSection}${memSection}`
  );
}

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
For each new entry, work through these steps in order:

Step 1 - Find the base entry whose subject most closely matches the new entry.
Step 2 - If a match exists and the new entry adds no information not already in that base entry: DROP IT. Output nothing for this entry.
Step 3 - If a match exists and the new entry adds genuinely new detail about the same subject: output ONE merged line that folds all unique details from both into a single concise statement. Do NOT output the original base entry - only the merged replacement.
Step 4 - If no base entry covers the same subject at all: output the new entry as-is.

Rules:
- SAME SUBJECT = same person, physical feature, relationship, or fact, even if worded differently. "Roderick is a ranger" and "Roderick is a seasoned ranger who prefers solitude" are the same subject.
- When merging, rewrite as one unified statement - do not append details with "also" or "additionally".
- NEW information OVERRIDES outdated or conflicting base information.
- Never invent information not present in the base or new entries.
- One line per distinct subject.

Scoring for output entries:
- importance 1: minor flavor detail, 2: useful context, 3: critical trait or major event
- expiration: scene (fades after scene), session (fades after chat), permanent (durable fact)

Output ONLY the entries to ADD or UPDATE in the base, one per line.

Example output:
[fact:3:permanent] Mira lost her sister to the plague three winters ago.
[relationship:2:permanent] Kael distrusts Mira but owes her a debt.

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
For each new entry, work through these steps in order:

Step 1 - Find the base entry whose subject most closely matches the new entry.
Step 2 - If a match exists and the new entry adds no information not already in that base entry: DROP IT. Output nothing for this entry.
Step 3 - If a match exists and the new entry adds genuinely new detail about the same subject: output ONE merged line that folds all unique details from both into a single concise statement. Do NOT output the original base entry - only the merged replacement.
Step 4 - If no base entry covers the same subject at all: output the new entry as-is.

Rules:
- SAME SUBJECT = same scene, event, or detail, even if worded differently.
- When merging, rewrite as one unified statement - do not append details with "also" or "additionally".
- NEW information OVERRIDES outdated or conflicting base information.
- Never invent information not present in the base or new entries.
- One line per distinct subject.

Scoring for output entries:
- importance 1: passing detail, 2: useful session context, 3: pivotal moment or key revelation
- expiration: scene (fades after scene transition), session (relevant for this chat only), permanent (durable across sessions)

Output ONLY the entries to ADD or UPDATE in the base, one per line.

Example output:
[scene:2:session] Candlelit tavern, late evening, rain hammering the shutters.
[detail:1:session] Senjin left his pack by the door when they entered.

FINAL RULE: Output ONLY [${type}:score:expiration] lines. No headers. No intros. No explanations.
If all new entries are duplicates and nothing needs to be added, output exactly: NONE`
  );
}

// ---- Profile generation -------------------------------------------------

/**
 * Assembles the profile generation prompt.
 *
 * Asks the model to produce three sections from stored memories:
 *   character_state  - current goals, emotional posture, fears, loyalties
 *   world_state      - current location, threats, unresolved events, time context
 *   relationship_matrix - one line per named entity with directional state + confidence
 *
 * All three sections are requested in one call to avoid extra model round-trips
 * on local hardware. Output uses XML-style tags so the parser can locate each
 * section independently even if the model adds surrounding text.
 *
 * @param {string} characterName - Active character name.
 * @param {string} longtermMemories - Active long-term memories as [type] content lines.
 * @param {string} sessionMemories  - Active session memories as [type] content lines (may be empty).
 * @param {Array<{name: string, type: string}>} [entities] - Known entities for the relationship matrix.
 * @returns {string} The complete prompt string.
 */
export function buildProfileGenerationPrompt(
  characterName,
  longtermMemories,
  sessionMemories,
  entities = [],
) {
  const ltSection = longtermMemories
    ? `LONG-TERM MEMORIES:\n${longtermMemories}\n\n`
    : 'LONG-TERM MEMORIES: (none yet)\n\n';

  const sessSection = sessionMemories
    ? `SESSION MEMORIES:\n${sessionMemories}\n\n`
    : 'SESSION MEMORIES: (none yet)\n\n';

  const entitySection =
    entities.length > 0
      ? `KNOWN ENTITIES: ${entities.map((e) => `${e.name} (${e.type})`).join(', ')}\n\n`
      : '';

  const charLabel = characterName || 'the character';

  return (
    NO_ACTION_PREAMBLE +
    `[PROFILE GENERATION TASK - Do NOT roleplay. Output structured data only.]

${ltSection}${sessSection}${entitySection}Generate a compact state snapshot for the active roleplay character "${charLabel}". Base everything strictly on the memories above - do not invent facts not in the source material. If a field cannot be determined from the memories, write "unknown".

Output exactly three sections using these tags. Keep every field to one line. Write factually:

<character_state>
Goals: [current goals and motivations]
Emotional posture: [current emotional state - e.g. stable, anxious, in love, grieving]
Active fears: [active fears or unresolved tensions, or "none identified"]
Loyalties: [current loyalties and commitments]
</character_state>

<world_state>
Location: [current location and atmosphere]
Threats: [active threats or pressures, or "none identified"]
Unresolved: [unresolved events or open situations, or "none identified"]
Time: [time context - time of day, season, elapsed time since a key event, or "unknown"]
</world_state>

<relationship_matrix>
[EntityName] ([type]): [directional one-line state] [confidence: 0.X]
(one line per entity from the KNOWN ENTITIES list; omit this section entirely if no entities are known)
</relationship_matrix>`
  );
}

// ---- Long-term memory extraction ----------------------------------------

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
    ? `EXISTING MEMORIES (do NOT duplicate or rephrase these - only add genuinely new information):\n${existingMemories}\n\nIf a fact has CHANGED since an existing memory was written, extract the updated version using explicit state-change language so it can supersede the old entry. Use phrases like "now", "no longer", "formerly", "became", "used to", "moved to", "stopped" - e.g. "Alex no longer distrusts Finn" or "Alex and Finn are now lovers". Without this phrasing, both the old and new fact will be stored redundantly.\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[MEMORY EXTRACTION TASK - Do NOT continue the roleplay. Do NOT speak as a character. Output structured data only.]

${activeCharacterSection}${existingSection}RECENT CONVERSATION TO ANALYZE:\n${chatHistory}

---
Your task: Extract NEW facts worth remembering in future sessions with this character. Ignore filler and small talk. Focus on information that would meaningfully change how future conversations begin or flow.

Prioritization rules (strict):
- Prioritize durable memories about the ACTIVE CHARACTER and their bond with the user.
- Physical traits are durable facts - appearance, scars, injuries, distinctive features, notable possessions. Capture these at importance 2-3. They are the anchors a continuity checker depends on.
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

ENTITY TAGGING (optional but encouraged):
If the memory involves specific NAMED entities (proper nouns with a specific name - a character, a named location, a named object, an organisation), append :entity=Name/type pairs inside the bracket. Use the exact names as they appear in the conversation. Classify each as: character, place, object, faction, or concept. Do NOT tag generic nouns (whiskey, sword, horse, money, fire) - only tag them if they have a specific proper name (Jack Daniel's, Excalibur, Shadowmere). Omit this field entirely if no named entities are relevant - do not invent names.

Output ONLY one memory per line using this exact format (nothing else):
[fact:2:permanent] The character's name is Elara and she works as a blacksmith.
[fact:2:permanent:entity=Elara/character] Elara has a burn scar on her right forearm from an accident at the forge.
[relationship:3:permanent:entity=Elara/character] We have developed a close friendship after helping each other escape the dungeon.
[event:2:permanent:entity=Elara/character,Kael/character] Elara and Kael fought side by side at the bridge.
[preference:2:session] The user enjoys slow-burn romance and witty banter.
[event:1:scene] They briefly discussed the weather near the harbour.

FINAL RULE: Output ONLY [type:score:expiration] or [type:score:expiration:entity=...] lines. No headers. No intros. No explanations.
If there is nothing new worth preserving, output exactly: NONE`
  );
}

// ---- Supersession confirmation (method B) --------------------------------

/**
 * Builds the narrow binary prompt used to confirm whether a new memory
 * updates/replaces an existing one (UPDATE) or is independently true (INDEPENDENT).
 * Called only for pairs that scored above the same-topic similarity threshold
 * but had no state-change pattern - i.e. the cheap checks were inconclusive.
 *
 * Intentionally minimal: two sentences in, one word out. Short context means
 * even weak local models answer reliably.
 *
 * @param {string} newMemory      - Content of the newly extracted memory.
 * @param {string} existingMemory - Content of the existing stored memory.
 * @returns {string} The complete prompt string.
 */
export function buildSupersessionConfirmPrompt(newMemory, existingMemory) {
  return (
    `[MEMORY CLASSIFICATION - Output one word only: UPDATE or INDEPENDENT]\n\n` +
    `Existing memory: ${existingMemory}\n` +
    `New memory:      ${newMemory}\n\n` +
    `Does the new memory UPDATE or REPLACE the existing memory, making it ` +
    `outdated or no longer fully accurate?\n` +
    `Or are both memories INDEPENDENTLY TRUE at the same time?\n\n` +
    `Output exactly one word: UPDATE or INDEPENDENT`
  );
}

// ---- Canon summary ------------------------------------------------------

/**
 * Assembles the canon summary prompt for a character.
 * Canon is a stable multi-paragraph narrative document covering who the
 * character is, what has happened, and the current state of key relationships.
 * It is sourced from arc summaries and high-importance long-term memories.
 *
 * @param {string} characterName - Active character name.
 * @param {string[]} arcSummaries - Resolved arc summary paragraphs.
 * @param {string} longtermMemories - High-importance long-term memories as [type] content lines.
 * @returns {string} The complete prompt string.
 */
export function buildCanonSummaryPrompt(characterName, arcSummaries, longtermMemories) {
  const charLabel = characterName || 'the character';
  const arcSection =
    arcSummaries.length > 0
      ? `RESOLVED ARC SUMMARIES:\n${arcSummaries.map((s, i) => `Arc ${i + 1}: ${s}`).join('\n\n')}\n\n`
      : 'RESOLVED ARC SUMMARIES: (none)\n\n';
  const memSection = longtermMemories
    ? `KEY MEMORIES:\n${longtermMemories}\n\n`
    : 'KEY MEMORIES: (none)\n\n';

  return (
    NO_ACTION_PREAMBLE +
    `[CANON SUMMARY TASK - Do NOT roleplay. Write a narrative document only.]

${arcSection}${memSection}Write a canon summary for "${charLabel}". This is a stable narrative document that captures the essential truth of what has happened in the story so far and who the character is now. Base everything strictly on the source material above - do not invent facts. Write in past tense, narrative style.

Structure the output as three paragraphs with these headings:

WHO THEY ARE:
[A paragraph on the character's identity, core traits, relationships, and current emotional state based on what has happened]

WHAT HAS HAPPENED:
[A paragraph summarising the key events and arcs in the story so far]

CURRENT STATE:
[A paragraph on where things stand now - unresolved tensions, active goals, and where the story is heading]

Output only the three labelled paragraphs. No preamble, no disclaimers.`
  );
}
