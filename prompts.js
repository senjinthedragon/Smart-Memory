/**
 * All prompt strings for Smart Memory.
 */

// ─── Shared preamble ─────────────────────────────────────────────────────────

const NO_ACTION_PREAMBLE = `CRITICAL: Respond with plain TEXT ONLY. Do NOT continue the roleplay. Do NOT speak as any character. You are writing a document, not a story.

`;

// ─── Short-term: full compaction ─────────────────────────────────────────────

export const SUMMARY_PROMPT = NO_ACTION_PREAMBLE + `Your task is to write a detailed summary of the roleplay conversation so far. This summary will be injected at the top of context so the story can continue seamlessly after older messages fall out of the context window.

Before writing your summary, organize your thoughts in <analysis> tags, then write the summary in <summary> tags.

Your summary must cover ALL of the following sections:

1. Scene & Setting: Current location, time of day, atmosphere, and any relevant environmental details.
2. Characters Present: Who is involved, their current emotional state, disposition, and demeanor.
3. Key Events: What happened during this conversation, in chronological order. Be specific.
4. Relationship Dynamics: The current state of the relationship(s) between characters — trust, tension, affection, history.
5. Revealed Information: Backstory, secrets, lore, or facts about characters or the world that came to light.
6. Story Threads: Unresolved tensions, promises made, questions raised, or ongoing conflicts.
7. User's Direction: What themes, tone, or direction the user has been steering the story toward.
8. Current Moment: Precisely where the story was at the moment this summary was triggered — what was just said or done.
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

// ─── Short-term: progressive update ──────────────────────────────────────────

export const UPDATE_SUMMARY_PROMPT = NO_ACTION_PREAMBLE + `An existing story summary is provided below, followed by new events that occurred after it. Your task is to update the summary by incorporating the new events.

Do NOT rewrite existing content unless facts have changed. Only add or update what the new events require. Preserve the 9-section format.

EXISTING SUMMARY:
{{existing_summary}}

NEW EVENTS TO INCORPORATE:
{{new_events}}

Write the updated summary inside <summary> tags using the same 9-section format. Update especially sections 2, 3, 4, 5, 6, 8, and 9 as needed.

<summary>
[Updated summary here]
</summary>`;

// ─── Away recap ───────────────────────────────────────────────────────────────

export const RECAP_PROMPT = NO_ACTION_PREAMBLE + `You are writing a brief "Previously on..." recap for someone returning to this story after being away. Based on the conversation so far, write a short engaging recap (3–5 sentences) in a warm narrative voice, past tense, as if summarizing a story episode. Focus on the most recent developments and where things were left off. Do not list facts — tell it briefly as a story.`;

// ─── Session memory ───────────────────────────────────────────────────────────

export const SESSION_EXTRACTION_SYSTEM = `You are a session archivist. You extract detailed within-session facts from roleplay conversations. You do not roleplay or continue the story. You only extract structured data.`;

export function buildSessionExtractionPrompt(chatHistory, existingSession) {
    const existingSection = existingSession
        ? `ALREADY RECORDED THIS SESSION (do not duplicate):\n${existingSession}\n\n`
        : '';

    return `[SESSION MEMORY EXTRACTION — Do NOT roleplay. Output structured data only.]

${existingSection}RECENT EXCHANGES:\n${chatHistory}

---
Extract NEW details worth remembering within this session. Be more specific than long-term memories — capture scene details, emotional beats, specific objects/names/places, and how things developed.

Types:
- scene       — current or recently completed scene details (location, atmosphere, time)
- revelation  — something revealed or discovered in this exchange
- development — how the relationship or situation changed
- detail      — specific facts, names, objects, or details mentioned (e.g. "The whiskey is Dragon's Fire brand")

One item per line, exact format:
[scene] We are in a candlelit tavern, late evening, rain outside.
[detail] The character's horse is named Ember, a chestnut mare.

If nothing new, output: NONE`;
}

// ─── Scene break detection ────────────────────────────────────────────────────

export const SCENE_DETECT_PROMPT = `Did the following story text contain a scene break — meaning a time skip, location change, or clear transition to a new scene? Answer with YES or NO only, nothing else.

TEXT:
{{text}}`;

export const SCENE_SUMMARY_PROMPT = NO_ACTION_PREAMBLE + `Write a 2–3 sentence summary of the following scene for use as scene history. Write in past tense, narrative style. Capture what happened, where, and the emotional tone. Be concise.

SCENE:
{{scene_text}}`;

// ─── Story arcs ───────────────────────────────────────────────────────────────

export const ARC_EXTRACTION_SYSTEM = `You are a story analyst. You extract open story threads and unresolved narrative elements from roleplay conversations. You do not roleplay. You only identify story structure.`;

export function buildArcExtractionPrompt(chatHistory, existingArcs) {
    const existingSection = existingArcs
        ? `EXISTING ARCS (only add NEW ones, or mark old ones as resolved):\n${existingArcs}\n\n`
        : '';

    return `[STORY ARC EXTRACTION — Do NOT roleplay. Output structured data only.]

${existingSection}CONVERSATION:\n${chatHistory}

---
Extract open story threads — unresolved conflicts, promises made, character goals, mysteries introduced, tensions established.

One arc per line:
[arc] She promised to meet him at dawn but never explained why.
[resolved] The missing letter was found — this arc is closed.

If no significant arcs exist or nothing new, output: NONE`;
}

// ─── Continuity check ────────────────────────────────────────────────────────

export function buildContinuityPrompt(establishedFacts, latestResponse) {
    return `[CONTINUITY CHECK — Do NOT roleplay. Identify contradictions only.]

ESTABLISHED FACTS (from memories and summary):
${establishedFacts}

LATEST STORY RESPONSE:
${latestResponse}

---
Does the latest response contradict or conflict with any established fact? List each contradiction precisely and briefly. If there are none, output: NONE`;
}

// ─── Long-term memory extraction ─────────────────────────────────────────────

export const EXTRACTION_SYSTEM_PROMPT = `You are a memory archivist. Your only job is to read roleplay transcripts and extract facts worth preserving across future sessions. You do not roleplay, continue the story, or speak as any character. You output structured data only.`;

export function buildExtractionPrompt(chatHistory, existingMemories) {
    const existingSection = existingMemories
        ? `EXISTING MEMORIES (do NOT duplicate or rephrase these — only add genuinely new information):\n${existingMemories}\n\n`
        : '';

    return `[MEMORY EXTRACTION TASK — Do NOT continue the roleplay. Do NOT speak as a character. Output structured data only.]

${existingSection}RECENT CONVERSATION TO ANALYZE:\n${chatHistory}

---
Your task: Extract NEW facts worth remembering in future sessions with this character. Ignore filler and small talk. Focus on information that would meaningfully change how future conversations begin or flow.

Use one of these memory types:
- fact        — established truths about the character, world, or other characters
- relationship — the current state and history of the relationship between participants
- preference  — what the user demonstrably enjoys (themes, tone, pacing, specific content)
- event       — significant events that occurred and should be recalled

Output ONLY one memory per line using this exact format (nothing else):
[fact] The character's name is Elara and she works as a blacksmith.
[relationship] We have developed a close friendship after helping each other escape the dungeon.
[preference] The user enjoys slow-burn romance and witty banter.

If there is nothing new worth preserving, output exactly: NONE`;
}
