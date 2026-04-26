# Smart Memory

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://github.com/senjinthedragon/Smart-Memory/blob/main/LICENSE)
[![Author: Senjin the Dragon](https://img.shields.io/badge/Author-Senjin_the_Dragon-gold.svg)](https://github.com/senjinthedragon)

Give your AI a memory. Smart Memory is a SillyTavern extension that quietly works in the background, keeping your AI oriented in long stories, aware of what happened this session, and grounded in facts it has learned across every previous chat with a character - even after weeks away.

It runs automatically. You don't have to do anything special to use it. Just chat, and it takes care of the rest.

Both 1:1 chats and group chats are supported. In group chats, each character gets their own independent memory store and receives their own memory context before they generate. A character selector in the settings panel lets you switch between group members to view and manage each character's memories, profiles, and entity registry independently.

_This is an independent extension for SillyTavern and is not affiliated with the SillyTavern development team._

![Smart Memory settings panel](https://raw.githubusercontent.com/senjinthedragon/Smart-Memory/main/assets/smart-memory.webp)

## ☕ Support the Developer

I'm a solo developer building tools to make AI roleplay better for everyone. Smart Memory is maintained in my free time, and as I'm currently navigating some financial challenges, any support means a lot.

If this extension adds something to your stories, please consider:

- **[Sponsoring me on GitHub](https://github.com/sponsors/senjinthedragon)**
- **[Buying me a coffee on Ko-fi](https://ko-fi.com/senjinthedragon)**
- **Bitcoin:** `bc1qjsaqw6rjcmhv6ywv2a97wfd4zxnae3ncrn8mf9`
- **Starring this repository** to help others find it.

## Installation

- In SillyTavern, open the **Extensions** menu (the stack of cubes icon)
- Click **Install extension**
- Paste: `https://github.com/senjinthedragon/Smart-Memory`
- Click **Install just for me** (or for all users if you're on a shared server)

Restart SillyTavern. **Smart Memory** will appear in your Extensions panel.

## What It Does

Smart Memory runs several memory tiers in the background, each focused on a different slice of your story's history.

### Short-term Memory - Context Summary

When your conversation grows long enough to approach your AI's context limit, Smart Memory automatically summarizes everything so far and keeps that summary injected at the top of context. Older messages can fall out of the window without the AI losing the thread of the story.

After the first summary exists, only new messages are processed and folded in - the summary grows with your story rather than being rewritten from scratch every time. The summary is also aware of what is stored in long-term and session memory, so it focuses on narrative flow rather than restating facts already captured elsewhere.

The rolling summary is separate from canon - both can be active at the same time, each injected via its own slot.

### Long-term Memory - Persistent Facts

Facts, relationship history, preferences, and significant events are extracted from your chats and stored per character. These memories survive across all sessions - when you open a new chat with a character, everything the AI has learned about them is already there waiting.

Over time, memories are automatically consolidated so the same information does not pile up in slightly different forms. Semantic embedding comparison catches near-paraphrase duplicates before they are stored. You end up with a clean, rich picture of the character rather than a cluttered list.

When a new memory describes a **state change** on the same topic as an existing one ("no longer", "moved to", "became") the old memory is automatically retired and replaced rather than left alongside the newer fact as a contradiction.

### Session Memory - Within-Chat Details

Granular details from the current session - scene descriptions, things that were revealed, how the relationship shifted, specific objects or places that were mentioned. More detailed than long-term memory, and scoped to this chat only. It does not carry over to future sessions, but it keeps the AI grounded in the specifics of what is happening right now.

Session extraction is aware of what is already stored in long-term memory and skips facts that are already captured there, so the two tiers complement rather than duplicate each other.

### Character and World Profiles

After each extraction pass, Smart Memory generates compact state snapshots from stored memories and injects them alongside the other tiers:

- **Character state** - current emotional state, active goals, relationship posture
- **World state** - active threads in the setting, recent developments, current scene context
- **Relationship matrix** - one-line directional summary per named entity with a confidence score

Profiles are regenerated after each extraction pass and on chat load if stale. On Profile B, an optional message-count schedule can keep them fresh between extraction passes. A manual regenerate button is available in the settings panel.

In group chats, each character has their own independent profile. Switching the character selector updates the profiles panel to show that character's snapshot, and each character's profile is injected into context when they are about to respond.

### Scene Detection and History

Smart Memory watches for scene transitions - time skips, location changes, those little `---` dividers authors use between scenes. When one is detected, a short summary of the completed scene is saved. The last few scene summaries are kept in context so the AI always knows where the story has been, not just where it is.

### Story Arcs - Open Threads

Unresolved narrative threads - promises made, character goals, mysteries introduced, tensions left hanging - are tracked and kept in context. When the story resolves one, it gets marked closed and a short narrative summary of that arc is generated for the record. This keeps the AI oriented toward where the story is going, not just reacting to the last message.

Story arcs are normally chat-local - they start fresh with each new chat. If you are running a story across multiple chats with the same character (new chats as chapters rather than fresh starts), you can **pin an arc** using the thumbtack button next to it. Pinned arcs are stored at the character level and automatically appear in every new chat with that character. Unpinning returns the arc to chat-local scope; resolving a pinned arc removes it from future chats automatically.

### Canon

Once you have at least one resolved arc summary, you can generate a **canon document** - a stable prose narrative synthesized from those arc summaries and high-importance long-term facts. Think of it as a "story bible" for the character: not a list of extracted facts, but a composed history written by the model from everything it has learned.

Canon is injected via its own dedicated slot, independent of the rolling short-term summary. Both can be active at the same time: the summary covers recent events, canon covers the broader history. Canon is stored at the character level (like long-term memories, not per-chat), so it carries forward to new chats with the same character. It is cleared by **Fresh Start** and by the **Clear** button in the Long-term Memory section.

### Away Recap

Come back after a long break and not quite remember where you left off? Smart Memory generates a short "Previously on..." recap and shows it as a dismissible popup so you can read it before the AI responds. It disappears after the first response - just a gentle reminder, not a permanent fixture.

### Continuity Checker

A manual tool you can reach for when something feels off. Click **Check Last Response** (or use `/sm-check`) and Smart Memory asks the AI whether the last response contradicts anything in your established facts. Useful for catching drift in long stories - the AI suddenly forgetting a character detail, reversing a decision that was made, that kind of thing.

Enable **Auto-repair contradictions** to go one step further: when contradictions are found, Smart Memory makes a second model call to generate a brief corrective note and injects it into the next AI response turn. The note is cleared automatically after that response - it is a one-shot nudge, not a permanent injection. This costs one extra model call per check, so it is disabled by default.

On **Profile B** (hosted models), the continuity check runs automatically after every AI turn - no button click required. A small badge appears next to the "Smart Memory" header in the settings panel: **clean** (fades after a few seconds) when nothing is found, or **N conflicts** (stays visible until the next check) when issues are detected. The **Auto-check after each response** checkbox lets you disable this automatic check while staying on Profile B - useful if you prefer to run checks manually or want to reduce model calls. Auto-repair still requires its own checkbox to be enabled. On Profile A (local hardware) the check is manual-only and the auto-check and auto-repair controls are dimmed.

> **Note:** The continuity checker is only as good as the model doing the checking, and it only knows what is stored in Smart Memory - not what is on the character card by heart. Think of it as a sanity check, not a guarantee.

### Token Usage Display

A small bar in the settings panel shows how many tokens each memory tier is currently injecting. It updates after every generation, so you can see at a glance whether Smart Memory is taking up a sensible amount of your context budget.

---

## Recommended Setup

Smart Memory is designed to work _alongside_ SillyTavern's built-in vector storage, not replace it. Think of them as complementary layers:

| Layer                         | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| **Message Limit** extension   | Hard cap on raw messages in context - your VRAM budget           |
| **Vector storage**            | Retrieves specific details on demand when they are relevant      |
| **Smart Memory - session**    | Always-present curated details from the current chat             |
| **Smart Memory - short-term** | Always-present narrative summary of everything before the window |
| **Smart Memory - long-term**  | Always-present character facts from all previous sessions        |

If you are on limited VRAM (8GB or less), keep the Message Limit extension enabled and consider lowering **Max session memories** to around 15 to keep prompt size comfortable.

### Recommended local model

For local Ollama setups with limited VRAM (8GB or less), the best tested model for Smart Memory's extraction and summarization tasks is:

**`huihui_ai/qwen3-vl-abliterated:8b-instruct`**

It follows structured output formats reliably, handles explicit roleplay content without refusals, and fits comfortably at 4-bit quantization on an 8GB card alongside the embedding model.

Other 8B-class models tested against Smart Memory's prompts consistently produced garbled or nonsense output once the combined prompt length (chat history + existing memories + instructions) exceeded their effective context window. Smart Memory's extraction prompts are longer than typical chat prompts - a model that works fine for roleplay may still struggle here. If you try a different model and get malformed output, context overflow is the most likely cause.

### Injection depth stacking order

Smart Memory's defaults are designed to layer cleanly alongside vector storage. Depth is distance from the user's last message - depth 0 is right before the AI responds, higher numbers are further back.

| Tier      | Position  | Depth | Notes                                           |
| --------- | --------- | ----- | ----------------------------------------------- |
| Arcs      | In-chat   | 2     | Shares depth with ST chat vectors intentionally |
| Session   | In-chat   | 3     | Just above ST's default vector depth            |
| Scenes    | In-chat   | 6     | Further back - past scene context               |
| Long-term | In-prompt | -     | Near character card                             |
| Short-term| In-prompt | -     | Rolling narrative summary                       |
| Canon     | In-prompt | -     | Stable character history, separate slot         |
| Profiles  | In-prompt | -     | State snapshots, near character card            |

The away recap is shown as a popup to the user, not injected into the prompt.

If you change ST's vector storage depth, set session memory one higher so it still layers above vectors.

---

## Settings

All settings are saved automatically per profile.

### Simple and Advanced Mode

The settings panel has two modes:

- **Simple mode** (default) - shows only the most commonly adjusted controls: hardware profile, extraction frequency (Low/Medium/High), and a single total memory context budget slider. Consolidation, injection templates, compaction tuning, and all per-tier position/depth/role settings are hidden and run on sensible defaults.
- **Advanced mode** - reveals everything: per-tier budgets, injection positions, depths, roles, template fields, compaction threshold, response lengths, and the Consolidation section. Toggle it with the **Advanced mode** checkbox at the top of the settings panel.

Switching from simple to advanced never overwrites your values - the advanced controls always show the current state, including any values previously set by the simple-mode sliders.

### Hardware Profile

Smart Memory can automatically adapt its behavior based on your setup.

| Setting          | Default | Description                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardware profile | Auto    | Auto-detects from your memory source. Ollama or WebLLM selects Profile A (minimal model calls, heuristic-based signals). Main API or OpenAI Compatible selects Profile B (richer extraction, all retrieval signals active, auto-canon). Override with "Profile A" or "Profile B" if the auto-detection does not match your setup |

### Memory LLM

Selects which LLM handles all Smart Memory work - summarization, extraction, and recap generation. Setting this to a lighter model leaves your main roleplay LLM free for the actual story.

Options: **Main API**, **Ollama**, **OpenAI Compatible**, or **WebLLM Extension**.

> **Note:** Some OpenAI Compatible providers (including Nvidia NIM) block direct browser connections due to CORS restrictions. If requests fail, run a local proxy such as LiteLLM and point the URL to that instead.

### Memory Deduplication

Smart Memory uses an embedding model to detect near-duplicate memories that differ only in wording. This catches cases that keyword matching misses - for example, "Finn is Senjin's anchor" and "Finn serves as Senjin's emotional foundation" score near-zero in word overlap but are identified as the same fact by vector similarity. The same model is also used to compute arc relevance during retrieval and consolidation overlap detection.

The embedding model is tiny and can run on CPU - it does not compete with your main model for VRAM.

When an embedding model is not available, the system falls back to word-overlap comparison automatically.

| Setting                 | Default                         | Description                                                                                                                              |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Use semantic embeddings | On                              | Compare memories by meaning rather than word overlap                                                                                     |
| Ollama URL              | _(blank, uses localhost:11434)_ | Only change if your embedding model is on a different port                                                                               |
| Embedding model         | `nomic-embed-text`              | Ollama model tag for embedding generation                                                                                                |
| Keep model in memory    | Off                             | Keeps the embedding model loaded in Ollama between calls rather than unloading after each use - faster for repeated deduplication passes |

**Requirements:** The embedding model must be installed in Ollama before enabling this. If you already use SillyTavern's built-in Vector Storage extension with Ollama, you likely have `nomic-embed-text` installed already. If not:

```sh
ollama pull nomic-embed-text
```

### Short-term Memory

| Setting                   | Default                      | Description                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable auto-summarization | On                           | Summarize automatically at threshold                                                                                                                                                                                                                                                                                      |
| Context threshold         | 80%                          | Summarize when context reaches this % of the model's limit                                                                                                                                                                                                                                                                |
| Summary response length   | 2000 tokens                  | Length budget for the summary - also acts as the injection cap                                                                                                                                                                                                                                                            |
| Injection template        | `Story so far:\n{{summary}}` | Wrapper text around the summary                                                                                                                                                                                                                                                                                           |
| Injection position        | In-prompt                    | Where in the prompt the summary appears                                                                                                                                                                                                                                                                                   |

### Canon

| Setting            | Default                          | Description                                                                                          |
| ------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Enable canon       | On                               | Inject canon and allow auto-regeneration. Disabling suppresses both injection and Profile B auto-gen |
| Injection budget   | 800 tokens                       | Canon text is trimmed from the end if it exceeds this limit                                          |
| Injection template | `Character history:\n{{canon}}`  | Wrapper text around the canon document                                                               |
| Injection position | In-prompt                        | Where in the prompt canon appears                                                                    |

The **Generate Canon** button synthesizes a prose narrative from resolved arc summaries and high-importance long-term facts, stores it at the character level, and immediately injects it into the canon slot. At least one resolved arc summary is required. On Profile B this regenerates automatically after each arc extraction pass. Canon is stored at the character level and survives across chats - it is cleared by Fresh Start and the Long-term Memory Clear button.

### Long-term Memory

| Setting                    | Default                                               | Description                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable long-term memory    | On                                                    | Extract and inject persistent character facts                                                                                                                                                           |
| Extract every N messages   | 3                                                     | How often automatic extraction runs                                                                                                                                                                     |
| Max memories per character | 25                                                    | Hard cap on total stored memories. Storage is also balanced per type - no single type (fact, relationship, preference, event) can exceed `max / 4` entries, so one category cannot crowd out the others |
| Injection token budget     | 500                                                   | Least important memories are trimmed first when the budget is exceeded - based on importance, expiration, recency, and how often a memory has been recalled                                             |
| Injection template         | `Memories from previous conversations:\n{{memories}}` | Wrapper text                                                                                                                                                                                            |
| Injection position         | In-prompt                                             | Where in the prompt memories appear                                                                                                                                                                     |

The long-term list shows a **retired** badge on superseded entries. A "Show retired memories" toggle reveals them. Each retired entry has a "superseded by" link to the replacement. Memories with unresolved contradictions show a yellow warning indicator.

### Session Memory

| Setting                  | Default                                   | Description                                                                                         |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Enable session memory    | On                                        | Extract and inject within-session details                                                           |
| Extract every N messages | 3                                         | How often automatic extraction runs                                                                 |
| Max session memories     | 30                                        | Consider lowering to ~15 on limited VRAM                                                            |
| Injection token budget   | 400                                       | Least important memories trimmed first when exceeded - based on importance, expiration, and recency |
| Injection template       | `Details from this session:\n{{session}}` | Wrapper text                                                                                        |
| Injection position       | In-chat @ depth 3                         | Sits just above ST's default vector depth                                                           |

### Consolidation

Consolidation runs after each extraction pass and asks the LLM to merge near-duplicate or redundant entries into richer single items. This prevents the same information accumulating in slightly different forms across sessions. It runs silently in the background and is recommended for all setups.

The Consolidation section is only shown in advanced mode. In simple mode it is always on with the defaults below.

| Setting                              | Default | Description                                                                               |
| ------------------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| Enable consolidation                 | On      | Master toggle - disabling this skips consolidation for both long-term and session memory  |
| Long-term: consolidate [fact] after  | 4       | Number of unprocessed entries before a consolidation pass fires for that type             |
| Long-term: consolidate [relationship]| 3       |                                                                                           |
| Long-term: consolidate [preference]  | 3       |                                                                                           |
| Long-term: consolidate [event]       | 4       |                                                                                           |
| Session: consolidate [scene] after   | 3       | Number of unprocessed session entries before consolidation fires for that type            |
| Session: consolidate [revelation]    | 3       |                                                                                           |
| Session: consolidate [development]   | 3       |                                                                                           |
| Session: consolidate [detail]        | 3       |                                                                                           |

### Character and World Profiles

| Setting                | Default    | Description                                                                                          |
| ---------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| Enable profiles        | On         | Generate and inject state snapshots after each extraction pass                                       |
| Stale threshold        | 30 minutes | Regenerate on chat load if profiles are older than this                                              |
| Also regenerate every  | Off (0)    | Profile B only. Regenerate every N messages even if extraction did not run. 0 = extraction-pass only |
| Response length        | 600 tokens | Budget for the profile generation model call                                                         |
| Injection token budget | 400        | Trim profiles content if it exceeds this many tokens                                                 |
| Injection position     | In-prompt  | Where in the prompt profiles appear                                                                  |

A live token count shows how many tokens the current profiles are using. A **Regenerate Profiles Now** button forces immediate regeneration. The current profiles are shown read-only below the controls.

### Scene Detection

| Setting                | Default           | Description                                             |
| ---------------------- | ----------------- | ------------------------------------------------------- |
| Enable scene detection | On                | Detect breaks and store scene history                   |
| AI detection           | Off               | More accurate but costs an extra model call per message |
| Keep last N scenes     | 5                 | How many scene summaries to retain                      |
| Injection token budget | 300               | Oldest scenes dropped first when exceeded               |
| Injection position     | In-chat @ depth 6 | Further back in context                                 |

### Story Arcs

| Setting                | Default           | Description                                 |
| ---------------------- | ----------------- | ------------------------------------------- |
| Enable arc tracking    | On                | Extract and inject open narrative threads   |
| Max tracked arcs       | 10                | Oldest arcs dropped when limit is exceeded  |
| Injection token budget | 700               | Oldest arcs trimmed first when exceeded     |
| Injection position     | In-chat @ depth 2 | Near current action, alongside chat vectors |

### Away Recap Settings

| Setting      | Default | Description                                   |
| ------------ | ------- | --------------------------------------------- |
| Enable recap | On      | Show a recap popup when returning after a gap |
| Threshold    | 4 hours | Minimum time away before a recap is generated |

### Continuity Checker

| Setting                        | Default | Description                                                                                                                                                                                           |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto-check after each response | On      | Profile B only. Automatically run the continuity check after every AI response. Disable to reduce model calls while staying on Profile B                                                              |
| Auto-repair contradictions     | Off     | Profile B only. When contradictions are found, generate a brief corrective note and inject it into the next response. Cleared automatically after that response. Costs one extra model call per check |

---

## Entity Registry

Smart Memory tracks named entities - characters, places, objects, factions, and concepts - as they appear across extracted memories. The extraction model classifies each entity by type using the context of the memory it was found in, so invented names and setting-specific terminology are handled correctly without any word lists.

A collapsible **Entity Registry** panel in the settings shows all tracked entities with:

- Type badge (character / place / object / faction / concept)
- Number of memories referencing the entity
- Last seen message index
- A timeline button that expands a vertical timeline of all memories involving that entity, ordered chronologically, with retired entries shown in muted style

The registry is built from both the persistent (long-term) and session stores and is updated after each extraction pass.

---

## Manual Operations

All manual operations are in the **Configuration** section at the top of the panel, or inside their respective tier sections.

### Read-only Mode

The **Read-only mode - protect character memories** toggle sits just below the chat action buttons. When enabled, the character arrives with all their memories and behaves normally, but nothing from this chat is saved back to their persistent state - no new long-term memories, arcs, canon, or profiles are written.

Use it to try out a risky scene before committing it to the character's history, or for a consequence-free session. Turn it off again afterward and their memories are exactly as you left them.

When you turn read-only off, all messages generated during that window are automatically hidden from the AI - they will never be picked up by future extraction passes or included in context. The "Delete messages" option in the chat context menu is also suppressed while read-only is active to prevent message deletions from corrupting the hidden range. You can toggle read-only on and off multiple times in the same chat; each window is ghosted independently when disabled.

### Memorize Chat

Reads the full chat history and builds memories from it - long-term facts, session details, scene history, story arcs, summary, and profiles. Use this to bring Smart Memory up to speed on an existing chat or to build up a character's long-term memory from previous sessions.

In group chats, Memorize Chat processes all active group members - not just the one currently selected in the character selector. Each member gets their own extraction pass with a filtered message window (their own messages plus user messages), their own consolidation pass, and their own profiles generated at the end.

A **Cancel** button appears during processing. Cancelling stops the loop cleanly between chunks - partial results are saved.

If memories already exist for one or more characters, a confirmation prompt will appear before processing begins - running Memorize Chat repeatedly on the same chat can introduce near-duplicate entries on top of existing ones. Use **Forget This Chat** first if you want a clean re-run.

Only accepted messages are processed - swiped alternatives are ignored.

To build long-term memory from multiple older chats, simply open each one and run Memorize Chat. Memories accumulate and deduplicate automatically. Skip any chats you would rather not include.

### Forget This Chat

Clears all Smart Memory context for the current chat - summary, session memories, scene history, story arcs, profiles, and the session entity registry. Long-term memories and the persistent entity registry are not touched. Useful before a Memorize Chat run to re-derive everything cleanly from scratch.

### Fresh Start

Clears everything for a clean slate - long-term memories, canon, and entity registry for the current character plus all chat-scoped tiers (summary, session memories, scene history, arcs, profiles). Does not suppress future memory generation; the AI will begin building fresh memories from the next message onward. Asks for confirmation before proceeding - this cannot be undone.

To prevent a specific chat from contributing to long-term memory at all, use the **Read-only mode** toggle at the top of the settings panel instead.

### Per-tier Extract Buttons

Each memory tier has its own **Extract Now** or **Extract** button that processes a recent window of messages - not the full chat. Useful for pulling in the latest exchanges outside the automatic schedule.

| Button                | Window                           |
| --------------------- | -------------------------------- |
| Long-term Extract Now | Last 20 messages                 |
| Session Extract Now   | Last 40 messages                 |
| Extract Arcs Now      | Last 100 messages                |
| Extract Scene         | Scene buffer or last 40 messages |

For the full chat backlog, use **Memorize Chat** instead.

### Other Per-tier Buttons

- **Summarize Now** - forces a short-term summary right now, ignoring the threshold
- **Generate Canon** - synthesizes a prose narrative from resolved arc summaries and high-importance facts and injects it into the canon slot. Requires at least one resolved arc summary. On Profile B this runs automatically after each arc extraction pass. Canon is stored at the character level and survives across chats - it is cleared by Fresh Start and the Long-term Memory Clear button. The canon textarea in the Canon section is also editable directly
- **Generate Recap Now** - generates and shows a recap popup on demand
- **Check Last Response** - runs the continuity check against the last AI response
- **Regenerate Profiles Now** - regenerates character and world profiles immediately
- **Clear** buttons on each tier - remove all stored data for that tier

### Editing and Adding Memories Manually

Every entry in the long-term memory, session memory, and story arc lists has action buttons:

- **Pencil (edit)** - replaces the entry text with an inline textarea. Edit the content and click **Save**, or click **Cancel** to discard changes. Not shown on retired memories.
- **Trash / Checkmark (delete/resolve)** - removes the entry immediately. For story arcs the button is a checkmark to indicate resolving the thread rather than discarding it.
- **Pin (story arcs only)** - marks the arc as persistent so it carries into future chats with the same character. The pin icon turns gold and the arc gets a gold left border when pinned. Click again to unpin.

Below each list an **Add** form lets you insert a new entry manually:

- For long-term and session memories, a color-coded type picker lets you choose the entry type before adding. Each type is shown in its badge color so you can see at a glance what you are picking.
- For story arcs, just type the thread and click **Add**.

Manual edits take effect immediately and are injected into the prompt on the next message.

---

## Slash Commands

| Command              | Description                                                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sm-check`          | Check the last AI response for contradictions against established facts                                                                                                                                                                                                                             |
| `/sm-summarize`      | Force a short-term summary generation now                                                                                                                                                                                                                                                           |
| `/sm-extract`        | Run long-term, session, and arc extraction against the current chat now                                                                                                                                                                                                                             |
| `/sm-recap`          | Generate and show a "Previously on..." recap popup now                                                                                                                                                                                                                                              |
| `/sm-search <query>` | Search all memories by semantic similarity and show a results popup. Optional `k=N` sets the result count (default 10, max 50); `min=N` sets a minimum similarity threshold to filter weak matches (default 0.5, range 0-1). Falls back to keyword overlap when the embedding model is unavailable. |

---

## Memory Types

**Long-term** memories are tagged by type:

- `fact` - established truths about the character, world, or setting
- `relationship` - the current state and history of the relationship
- `preference` - what the user demonstrably enjoys (themes, tone, pacing)
- `event` - significant events that should be recalled in future sessions

**Session** memories are tagged by type:

- `scene` - current or recently completed scene details
- `revelation` - something discovered or revealed this session
- `development` - how the relationship or situation changed
- `detail` - specific facts, names, objects, or places mentioned

Extraction also assigns:

- **Importance (1-3)** - how impactful the memory is (`1` fluff, `2` context, `3` core)
- **Expiration** - expected durability:
  - `scene` (short-lived)
  - `session` (current chat scope)
  - `permanent` (durable, keep aggressively)

During trimming, Smart Memory scores each entry across multiple dimensions: expiration weight, importance, recency, how often the memory has been recalled, confidence, and keyword frequency. Higher-scoring entries survive; lower-scoring ones are trimmed first. Protected types (relationship, preference, fact for long-term; development, scene for session) are retained more aggressively to preserve continuity.

### Supersession

When the story changes a fact - a character moves, a relationship ends, a decision is reversed - Smart Memory detects this automatically. If a new memory candidate describes a state change on the same topic as an existing one, the old memory is retired and replaced rather than kept alongside as a contradiction. Retired memories remain in storage (visible with the "Show retired memories" toggle) but are excluded from injection and retrieval.

### Contradiction warnings

When two stored memories cannot both be true and neither clearly replaces the other, they are flagged with a yellow warning indicator. Use **Check Last Response** to surface and optionally repair these conflicts.

---

### Developer

| Setting                          | Default | Description                                                                                                                                                                                                                                                              |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verbose logging                  | Off     | Print extraction, consolidation, migration, and scene detection progress to the browser console. Errors are always logged regardless of this setting.                                                                                                                    |
| Unified injection (experimental) | Off     | Merges all active memory tiers into a single IN_PROMPT block. Ordered most-stable-first (canon, profiles, long-term) to most-immediate-last (session, arcs). Token bar still shows per-tier breakdowns.                                                                  |

---

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE).
