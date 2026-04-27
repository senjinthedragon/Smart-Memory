# Smart Memory

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://github.com/senjinthedragon/Smart-Memory/blob/main/LICENSE)
[![Author: Senjin the Dragon](https://img.shields.io/badge/Author-Senjin_the_Dragon-gold.svg)](https://github.com/senjinthedragon)

Give your AI a memory that lasts. Smart Memory is a SillyTavern extension that quietly works in the background, keeping your AI oriented in long stories, aware of what happened this session, and grounded in facts it has learned across every previous chat with a character - even after weeks away.

It runs automatically. You don't have to do anything special. Just chat, and it takes care of the rest.

Both 1:1 chats and group chats are supported. In group chats, each character gets their own independent memory store and receives their own memories before they respond. A character selector in the settings panel lets you switch between group members to view and manage each character's memories, profiles, and entity registry independently.

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

Smart Memory runs several memory systems in the background, each focused on a different slice of your story's history.

### Short-term Memory - Context Summary

When your conversation grows long enough that older messages start falling out of the AI's awareness, Smart Memory automatically writes a summary of everything so far and keeps it in context. The AI stays oriented in long stories even as older messages scroll away.

After the first summary is written, only new messages get folded in - the summary grows with your story rather than being rewritten from scratch every time. It also knows what is already captured in your long-term and session memories, so it focuses on narrative flow rather than repeating facts stored elsewhere.

The rolling summary sits alongside canon if you have it enabled - both can be active at the same time, covering different spans of your story's history.

### Long-term Memory - Persistent Facts

Facts, relationship history, preferences, and significant events are extracted from your chats and saved for each character. These memories survive across all sessions - when you open a new chat with a character, everything they have learned is already there waiting.

Over time, memories are automatically consolidated so the same information does not pile up in slightly different forms. Smart Memory is good at recognising when two differently-worded entries are saying the same thing, so you end up with a clean, rich picture of the character rather than a growing cluttered list.

When a new memory describes a change - "Alex no longer distrusts Finn", "she moved to the capital", "the guild was disbanded" - the old fact is automatically retired and replaced rather than left alongside the newer truth as a contradiction.

### Session Memory - Within-Chat Details

Granular details from the current session: scene descriptions, things that were revealed, how the relationship shifted, specific objects or places that came up. More detailed than long-term memory, and scoped to this chat only - it does not carry forward to future sessions, but it keeps the AI sharp on the specifics of what is happening right now.

Session memory is aware of what is already in long-term memory, so the two complement each other rather than duplicating information.

### Character and World Profiles

After each extraction pass, Smart Memory generates compact state snapshots from stored memories and adds them to context alongside the other tiers:

- **Character state** - current emotional state, active goals, relationship posture
- **World state** - active threads in the setting, recent developments, current scene context
- **Relationship matrix** - one-line directional summary per named entity with a confidence score

Profiles are regenerated after each extraction pass and on chat load if stale. On Profile B, an optional message-count schedule can keep them fresh between extraction passes. A manual regenerate button is available in the settings panel.

In group chats, each character has their own independent profile. Switching the character selector updates the profiles panel to show that character's snapshot, and each character's profile is added to context when they are about to respond.

### Scene Detection and History

Smart Memory watches for scene transitions - time skips, location changes, those little `---` dividers between scenes. When one is detected, a short summary of the completed scene is saved. The last few scene summaries are kept in context so the AI always knows where the story has been, not just where it is.

### Story Arcs - Open Threads

Unresolved narrative threads - promises made, character goals, mysteries introduced, tensions left hanging - are tracked and kept in context. When the story resolves one, it gets marked closed and a short narrative summary is generated for the record. This keeps the AI oriented toward where the story is going, not just reacting to the last message.

Story arcs normally start fresh with each new chat. If you are running a continuing story across multiple chats (new chats as chapters rather than fresh starts), you can **pin an arc** with the thumbtack button next to it. Pinned arcs are stored at the character level and appear automatically in every new chat with that character. Unpinning returns it to chat-local scope; resolving a pinned arc removes it from future chats automatically.

### Canon

Once you have at least one resolved arc summary, you can generate a **canon document** - a stable prose narrative synthesized from those arc summaries and high-importance long-term facts. Think of it as a "story bible" for the character: not a list of bullet points, but a composed history written by the model from everything it has learned.

Canon gets its own dedicated slot, separate from the rolling short-term summary. Both can be active at the same time: the summary covers recent events, canon covers the broader history. Canon is stored at the character level and carries forward to new chats with the same character. It is cleared by **Fresh Start** and by the **Clear** button in the Long-term Memory section.

### Away Recap

Come back after a long break and not quite remember where you left off? Smart Memory generates a short "Previously on..." recap and shows it as a dismissible popup before the AI responds. It disappears after the first response - just a gentle reminder, not a permanent fixture.

### Continuity Checker

A manual tool for when something feels off. Click **Check Last Response** (or use `/sm-check`) and Smart Memory asks the AI whether the last response contradicts anything in your established facts. Useful for catching drift in long stories - the AI suddenly forgetting a character detail, reversing a decision that was already made, that kind of thing.

Enable **Auto-repair contradictions** to go one step further: when contradictions are found, Smart Memory generates a brief corrective note and slips it into the next AI response. The note is cleared automatically after that response - it is a one-shot nudge, not a permanent change. This costs one extra model call per check, so it is disabled by default.

On **Profile B** (hosted models), the continuity check runs automatically after every AI response - no button click required. A small badge appears in the settings panel header: **clean** (fades after a few seconds) or **N conflicts** (stays visible until the next check). The **Auto-check after each response** checkbox lets you turn this off while staying on Profile B if you would rather check manually. On Profile A (local hardware) the check is manual-only.

> **Note:** The continuity checker is only as good as the model doing the checking, and it only knows what is stored in Smart Memory - not what is on the character card by heart. Think of it as a sanity check, not a guarantee.

### Token Usage Display

A small bar in the settings panel shows how many tokens each memory tier is currently using in the AI's context. It updates after every response so you can see at a glance whether Smart Memory is taking up a sensible amount of your context.

---

## Recommended Setup

Smart Memory is designed to work _alongside_ SillyTavern's built-in vector storage, not replace it. Think of them as complementary layers - vector storage retrieves specific details on demand when they seem relevant, while Smart Memory keeps a curated set of important facts and narrative context always present.

| Layer                         | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| **Message Limit** extension   | Hard cap on raw messages in context - your VRAM budget           |
| **Vector storage**            | Retrieves specific details on demand when they are relevant      |
| **Smart Memory - session**    | Always-present curated details from the current chat             |
| **Smart Memory - short-term** | Always-present narrative summary of everything before the window |
| **Smart Memory - long-term**  | Always-present character facts from all previous sessions        |

If you are on limited VRAM (8GB or less), keep the Message Limit extension enabled and consider lowering **Max session memories** to around 15 to keep prompt size comfortable.

### Recommended local models

For local Ollama setups with limited VRAM (8GB or less), three models have been tested against Smart Memory's full extraction harness and score 47-48/48 (98-100%):

**`huihui_ai/qwen3-vl-abliterated:8b-instruct`** (6.1 GB) - primary recommendation. Reliable, consistent, no thinking overhead. The abliterated variant handles explicit roleplay content without refusals.

**`mistral:7b`** (4.1 GB) - strong alternative when VRAM is tighter. Matches qwen3-vl quality. A good choice if you want to free up headroom for the embedding model alongside the roleplay model.

**`gemma3:4b`** (3.3 GB) - lightest recommended option. Matches qwen3-vl on most extractions; occasionally files some long-term-relevant details under session memory on very long chats. Use if 4 GB is your hard limit.

All three follow Smart Memory's structured output reliably. Smart Memory's prompts are longer than typical chat prompts - a model that works fine for roleplay may still struggle here if the combined prompt length exceeds its effective context window. If you get empty or garbled extraction output with a different model, context overflow is the most likely cause.

---

## Settings

All settings are saved automatically.

### Simple and Advanced Mode

The settings panel has two modes so you can keep things simple or go deep:

- **Simple mode** (default) - shows only the most commonly adjusted settings: hardware profile, extraction frequency (Low/Medium/High), and how much context Smart Memory is allowed to use. Everything else runs on sensible defaults.
- **Advanced mode** - reveals the full set of controls: per-tier context budgets, where each tier appears in the prompt, how deep, what role, the template text, summarization thresholds, response length budgets, and the Consolidation section. Toggle it with the **Advanced mode** checkbox at the top of the settings panel.

Switching from simple to advanced never overwrites your values - the advanced controls always show the current state.

### Hardware Profile

Smart Memory adjusts its behavior based on whether you are using a local model or a hosted service.

| Setting          | Default | Description                                                                                                                                                                                                                                                                                   |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardware profile | Auto    | Auto-detects from your memory source. Ollama or WebLLM selects Profile A (fewer model calls, lighter extraction). Main API or OpenAI Compatible selects Profile B (richer extraction, automatic continuity checks, auto-canon). Override manually if auto-detection does not match your setup |

### Memory LLM

Selects which AI model handles all Smart Memory work - summarization, extraction, and recap generation. Setting this to a lighter model leaves your main roleplay model free for the actual story.

Options: **Main API**, **Ollama**, **OpenAI Compatible**, or **WebLLM Extension**.

> **Note:** Some OpenAI Compatible providers (including Nvidia NIM) block direct browser connections due to CORS restrictions. If requests fail, run a local proxy such as LiteLLM and point the URL to that instead.

### Memory Deduplication

Smart Memory uses a small helper model to understand whether two memories are saying the same thing, even if the wording is completely different. For example, "Finn is Senjin's anchor" and "Finn serves as Senjin's emotional foundation" look nothing alike as text, but the helper model recognises them as the same fact and prevents the duplicate from being stored. The same helper model is also used to measure how relevant each stored memory is to the current moment in the story, which affects which memories get prioritised in context.

This helper model is tiny and runs on CPU - it does not compete with your main roleplay model for VRAM or slow anything down.

If you do not have an embedding model set up, Smart Memory falls back to keyword matching automatically. It works, but catches fewer paraphrased duplicates.

| Setting                 | Default                         | Description                                                                                                               |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Use semantic embeddings | On                              | Use the helper model to compare memories by meaning rather than by shared words                                           |
| Ollama URL              | _(blank, uses localhost:11434)_ | Only change if your embedding model is on a different port                                                                |
| Embedding model         | `nomic-embed-text`              | The Ollama model used for meaning comparison                                                                              |
| Keep model in memory    | Off                             | Keeps the helper model loaded between calls rather than unloading after each use - faster if Smart Memory runs frequently |

**Requirements:** The embedding model must be installed in Ollama before enabling this. If you already use SillyTavern's built-in Vector Storage extension with Ollama, you likely have `nomic-embed-text` installed already. If not:

```sh
ollama pull nomic-embed-text
```

### Short-term Memory

| Setting                   | Default                      | Description                                                                      |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| Enable auto-summarization | On                           | Automatically summarize when the threshold is reached                            |
| Context threshold         | 80%                          | Start summarizing when the context reaches this percentage of the model's limit  |
| Summary response length   | 2000 tokens                  | How long the summary can be - also acts as the cap on what gets added to context |
| Injection template        | `Story so far:\n{{summary}}` | The wrapper text around the summary                                              |
| Injection position        | In-prompt                    | Where in the prompt the summary appears                                          |

### Canon

| Setting            | Default                         | Description                                                                        |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------------------- |
| Enable canon       | On                              | Add canon to context and allow auto-regeneration. Turning this off suppresses both |
| Injection budget   | 800 tokens                      | Canon text is trimmed from the end if it would exceed this limit                   |
| Injection template | `Character history:\n{{canon}}` | The wrapper text around the canon document                                         |
| Injection position | In-prompt                       | Where in the prompt canon appears                                                  |

The **Generate Canon** button synthesizes a prose narrative from resolved arc summaries and high-importance long-term facts, stores it at the character level, and immediately adds it to context. At least one resolved arc summary is required. On Profile B this regenerates automatically after each arc closes. Canon is stored at the character level and survives across chats - it is cleared by Fresh Start and the Long-term Memory Clear button. The canon textarea in the Canon section is also editable directly if you want to adjust it by hand.

### Long-term Memory

| Setting                    | Default                                               | Description                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable long-term memory    | On                                                    | Extract and inject persistent character facts                                                                                                                                                      |
| Extract every N messages   | 3                                                     | How often automatic extraction runs                                                                                                                                                                |
| Max memories per character | 25                                                    | Hard cap on total stored memories. Storage is also balanced per type - no single type (fact, relationship, preference, event) can exceed `max / 4` entries so one category cannot crowd out others |
| Injection token budget     | 500                                                   | When memories would exceed this limit, the least important ones are trimmed first - based on importance, how permanent they are, how recently they were recalled, and confidence                   |
| Injection template         | `Memories from previous conversations:\n{{memories}}` | Wrapper text                                                                                                                                                                                       |
| Injection position         | In-prompt                                             | Where in the prompt memories appear                                                                                                                                                                |

The long-term list shows a **retired** badge on superseded entries. A "Show retired memories" toggle reveals them. Each retired entry has a "superseded by" link to the replacement. Memories with unresolved contradictions show a yellow warning indicator.

### Session Memory

| Setting                  | Default                                   | Description                                                                 |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------------------------- |
| Enable session memory    | On                                        | Extract and inject within-session details                                   |
| Extract every N messages | 3                                         | How often automatic extraction runs                                         |
| Max session memories     | 30                                        | Consider lowering to ~15 on limited VRAM                                    |
| Injection token budget   | 400                                       | When memories would exceed this, the least important ones are trimmed first |
| Injection template       | `Details from this session:\n{{session}}` | Wrapper text                                                                |
| Injection position       | In-chat @ depth 3                         | Sits just above ST's default vector depth                                   |

### Consolidation

Over time, the same information can accumulate in slightly different forms across multiple extraction passes. Consolidation runs quietly in the background after each extraction and asks the AI to merge near-identical or redundant entries into richer single items. You end up with fewer, better memories rather than a growing list of overlapping notes.

The Consolidation section is only visible in advanced mode. In simple mode it always runs on the defaults below.

| Setting                               | Default | Description                                                                                |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| Enable consolidation                  | On      | Master toggle - turning this off skips consolidation for both long-term and session memory |
| Long-term: consolidate [fact] after   | 4       | How many unprocessed entries of this type accumulate before a consolidation pass fires     |
| Long-term: consolidate [relationship] | 3       |                                                                                            |
| Long-term: consolidate [preference]   | 3       |                                                                                            |
| Long-term: consolidate [event]        | 4       |                                                                                            |
| Session: consolidate [scene] after    | 3       | Same logic, for session memory types                                                       |
| Session: consolidate [revelation]     | 3       |                                                                                            |
| Session: consolidate [development]    | 3       |                                                                                            |
| Session: consolidate [detail]         | 3       |                                                                                            |

### Character and World Profiles

| Setting                | Default    | Description                                                                                               |
| ---------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| Enable profiles        | On         | Generate and add state snapshots to context after each extraction pass                                    |
| Stale threshold        | 30 minutes | Regenerate on chat load if profiles are older than this                                                   |
| Also regenerate every  | Off (0)    | Profile B only. Regenerate every N messages even if extraction has not run. 0 = on extraction passes only |
| Response length        | 600 tokens | How long the profile generation response can be                                                           |
| Injection token budget | 400        | Trim profiles if they would exceed this many tokens                                                       |
| Injection position     | In-prompt  | Where in the prompt profiles appear                                                                       |

A live token count shows how much context the current profiles are using. A **Regenerate Profiles Now** button forces immediate regeneration. The current profiles are shown read-only below the controls.

### Scene Detection

| Setting                | Default           | Description                                             |
| ---------------------- | ----------------- | ------------------------------------------------------- |
| Enable scene detection | On                | Watch for scene breaks and keep a running scene history |
| AI detection           | Off               | More accurate but costs an extra model call per message |
| Keep last N scenes     | 5                 | How many scene summaries to retain                      |
| Injection token budget | 300               | Oldest scenes dropped first when the limit is exceeded  |
| Injection position     | In-chat @ depth 6 | Further back in context                                 |

### Story Arcs

| Setting                | Default           | Description                                        |
| ---------------------- | ----------------- | -------------------------------------------------- |
| Enable arc tracking    | On                | Extract and keep open narrative threads in context |
| Max tracked arcs       | 10                | Oldest arcs are dropped when the limit is hit      |
| Injection token budget | 700               | Oldest arcs trimmed first when exceeded            |
| Injection position     | In-chat @ depth 2 | Near current action, alongside chat vectors        |

### Away Recap

| Setting      | Default | Description                                          |
| ------------ | ------- | ---------------------------------------------------- |
| Enable recap | On      | Show a recap popup when returning after a long break |
| Threshold    | 4 hours | Minimum time away before a recap is generated        |

### Continuity Checker

| Setting                        | Default | Description                                                                                                                                                                                         |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto-check after each response | On      | Profile B only. Run the continuity check automatically after every AI response. Turn this off to check manually while staying on Profile B                                                          |
| Auto-repair contradictions     | Off     | Profile B only. When contradictions are found, generate a short corrective note and slip it into the next response. Cleared automatically after that response. Costs one extra model call per check |

---

## Entity Registry

As memories are extracted, Smart Memory tracks the named entities behind them - characters, places, objects, factions, and concepts. The AI classifies each entity by type from the context of the memory it appeared in, so invented names and made-up settings are handled just as well as real-world ones. The registry is built from both your long-term memories and your current session memories, and is updated after each extraction pass.

A collapsible **Entity Registry** panel in the settings shows all tracked entities with:

- Type badge (character / place / object / faction / concept) - click to edit if the classification is wrong
- Number of memories referencing the entity
- Last seen message index
- A **timeline button** that expands a vertical timeline of all memories involving that entity, ordered chronologically, with retired entries shown in muted style
- A **merge button** to combine two entities into one - useful when the model has created separate entries for the same person under different names, or when you want to collapse entries from different tiers together
- A **trash button** to remove an entity entirely, which also cleans up all references to it from stored memories

A **View Graph** button opens a full-screen, force-directed canvas of your character's entire memory network. Entity nodes (larger, coloured by type) are connected to the memories that reference them. Where one memory has replaced another, a directed arrow shows the supersession chain so you can see exactly what was retired and what replaced it. The graph supports pan, zoom, node dragging, click-to-highlight neighbours, and hover tooltips with full memory content. Filters for session memories and retired memories can be toggled on and off without closing the graph. The graph follows your active SillyTavern theme automatically.

---

## Manual Operations

All manual operations are in the **Configuration** section at the top of the panel, or inside their respective tier sections.

### Read-only Mode

The **Read-only mode - protect character memories** toggle sits just below the chat action buttons. When it is on, the character arrives with all their memories and behaves completely normally - but nothing from this chat gets written back to their permanent history. No new long-term memories, no new arcs, no canon or profile updates.

Use it to safely explore a risky scene before deciding whether to commit it to the character's history. Or for a completely consequence-free session where nothing changes permanently. When you turn it off, their memories are exactly as you left them before the session.

When you turn read-only off, a dialog asks what to do with the session:

- **Commit** - keeps everything. Session memories are preserved and Smart Memory runs full extraction on the window - long-term memories, arcs, and profiles are built as if read-only had never been active. The messages stay visible.
- **Discard** - throws everything away. Session memories are purged and the messages from the read-only window are hidden from the AI so they can never influence future extraction passes.

You can toggle read-only on and off multiple times in the same chat; each window is handled independently.

**Using read-only with checkpoints and branches:** SillyTavern's checkpoint and branch features save the chat up to a specific point as a new file. Smart Memory's long-term memories are shared across all chats with the same character - they do not roll back if you switch to an older checkpoint or branch. If you plan to explore alternative story paths this way, enable read-only mode first. Smart Memory will warn you with a notification if you create a checkpoint or branch without it active.

### Memorize Chat

Reads the full chat history and builds memories from it - long-term facts, session details, scene history, story arcs, summary, and profiles. Use this to bring Smart Memory up to speed on an existing chat, or to build up a character's long-term memories from older sessions.

In group chats, Memorize Chat processes all active group members - not just the one currently selected. Each character gets their own pass through the messages, their own memories, and their own profiles at the end.

A **Cancel** button appears during processing. Cancelling stops cleanly between chunks - anything processed so far is saved.

If memories already exist for one or more characters, a confirmation prompt appears before processing begins. Running Memorize Chat repeatedly on the same chat can introduce near-duplicate entries. Use **Forget This Chat** first if you want a clean re-run.

Only accepted messages are processed - swiped alternatives are ignored.

To build long-term memories from multiple older chats, open each one and run Memorize Chat. Memories accumulate and deduplicate automatically. Skip any chats you would rather not include.

### Forget This Chat

Clears all Smart Memory context for the current chat - summary, session memories, scene history, story arcs, profiles, and the session entity list. Long-term memories and the persistent entity registry are not touched. Useful before a Memorize Chat run to re-derive everything cleanly from scratch.

### Fresh Start

Clears everything for a clean slate - long-term memories, canon, and entity registry for the current character, plus all chat-scoped tiers (summary, session memories, scene history, arcs, profiles). The AI will begin building fresh memories from the next message onward. Asks for confirmation before proceeding - this cannot be undone.

To prevent a specific chat from contributing to long-term memory at all, use **Read-only mode** instead.

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
- **Generate Canon** - synthesizes a prose narrative from resolved arc summaries and high-importance facts. Requires at least one resolved arc summary. On Profile B this runs automatically after each arc closes. Canon is stored at the character level and survives across chats - cleared by Fresh Start and the Long-term Memory Clear button. The canon textarea is also editable directly
- **Generate Recap Now** - generates and shows a recap popup on demand
- **Check Last Response** - runs the continuity check against the last AI response
- **Regenerate Profiles Now** - regenerates character and world profiles immediately
- **Clear** buttons on each tier - remove all stored data for that tier

### Editing and Adding Memories Manually

Every entry in the long-term memory, session memory, and story arc lists has action buttons:

- **Pencil (edit)** - replaces the entry with an inline text editor. Edit the content and click **Save**, or **Cancel** to discard changes. Not shown on retired memories.
- **Trash / Checkmark (delete/resolve)** - removes the entry immediately. For story arcs the button is a checkmark to indicate resolving the thread rather than discarding it.
- **Pin (story arcs only)** - marks the arc as persistent so it carries into future chats. The pin icon turns gold and the arc gets a gold left border when pinned. Click again to unpin.

Below each list an **Add** form lets you insert a new entry manually:

- For long-term and session memories, a color-coded type picker lets you choose the type before adding. Each type is shown in its badge color so you can see what you are picking.
- For story arcs, just type the thread and click **Add**.

Manual edits take effect immediately and are added to the prompt on the next message.

---

## Slash Commands

| Command              | Description                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sm-check`          | Check the last AI response for contradictions against established facts                                                                                                                                                                                                          |
| `/sm-summarize`      | Force a short-term summary generation now                                                                                                                                                                                                                                        |
| `/sm-extract`        | Run long-term, session, and arc extraction against the current chat now                                                                                                                                                                                                          |
| `/sm-recap`          | Generate and show a "Previously on..." recap popup now                                                                                                                                                                                                                           |
| `/sm-search <query>` | Search all memories by meaning and show a results popup. Optional `k=N` sets the result count (default 10, max 50); `min=N` sets a minimum match quality to filter weak results (default 0.5, range 0-1). Falls back to keyword matching when the embedding model is unavailable |

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

When the memory budget is full and something needs to be trimmed, Smart Memory keeps the entries that matter most and quietly drops the ones that have become less relevant over time. See [Memory Prioritisation](#memory-prioritisation) in the Advanced section for details on how this works.

### Supersession

When the story changes a fact - a character moves, a relationship ends, a decision is reversed - Smart Memory detects this and retires the old memory automatically rather than leaving two contradictory versions sitting side by side. The old memory is kept in storage (visible with the "Show retired memories" toggle) but is no longer added to the AI's context.

See [How Supersession Works](#how-supersession-works) in the Advanced section if you are curious about the detection mechanism.

### Contradiction Warnings

When two stored memories cannot both be true and neither clearly replaces the other, they are flagged with a yellow warning indicator. Use **Check Last Response** to surface and optionally repair these conflicts.

---

## Advanced

This section covers the technical details behind Smart Memory's behaviour. You do not need to read it to use the extension - everything works out of the box. It is here for curious users and for anyone tuning Smart Memory alongside other extensions.

### Injection Depth Stacking Order

Smart Memory's defaults are designed to layer cleanly alongside SillyTavern's Vector Storage extension. "Depth" is how far a piece of context sits from the AI's response - depth 0 is right before the AI responds, higher numbers sit further back.

| Tier       | Position  | Depth | Notes                                           |
| ---------- | --------- | ----- | ----------------------------------------------- |
| Arcs       | In-chat   | 2     | Shares depth with ST chat vectors intentionally |
| Session    | In-chat   | 3     | Just above ST's default vector depth            |
| Scenes     | In-chat   | 6     | Further back - past scene context               |
| Long-term  | In-prompt | -     | Near character card                             |
| Short-term | In-prompt | -     | Rolling narrative summary                       |
| Canon      | In-prompt | -     | Stable character history, separate slot         |
| Profiles   | In-prompt | -     | State snapshots, near character card            |

The away recap is shown as a popup to the user, not added to the prompt.

If you change ST's vector storage depth, set session memory one higher so it still layers above vectors.

### Memory Prioritisation

When memories would exceed the token budget, Smart Memory scores each entry across several dimensions and trims the lowest-scoring ones first: how permanent the memory is, how important it was rated at extraction time, how recently it was recalled, how many times it has been used, and how confident the system is that it is still true. Relationship and fact entries for long-term memory, and development and scene entries for session memory, are held onto more aggressively since these tend to matter most for story continuity.

### How Supersession Works

Supersession detection runs in two passes. First, a quick pattern check looks for state-change language in the new memory - phrases like "no longer", "became", "healed", "left the", "was captured", and many others cover the most common ways a fact changes in natural language. Second, when two memories score as clearly being about the same topic but no pattern phrase was found (because the phrasing was unusual - "confiscated", "hijacked", etc.), Smart Memory asks the AI directly: does this new memory update or replace the old one, or are both still true at the same time? One short question, one word answer. Extra model calls only happen when a suspicious pair is found - quiet passes cost nothing extra.

### Developer Settings

| Setting                          | Default | Description                                                                                                                                                                                       |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verbose logging                  | Off     | Print detailed progress to the browser console for extraction, consolidation, and scene detection. Errors are always logged regardless                                                            |
| Unified injection (experimental) | Off     | Merges all active memory tiers into a single context block ordered from most stable (canon, profiles, long-term) to most immediate (session, arcs). The token bar still shows per-tier breakdowns |

---

## Known Limitations

**Editing past messages** - If a message is edited after Smart Memory has already extracted memories from it, those memories are not updated. The character may hold beliefs formed from the original text that no longer match the edited version. If you edit a message and the change is significant, review the relevant memory entries manually and correct or delete them as needed.

**Hiding past messages** - Hiding a message that Smart Memory has already processed does not remove the memories formed from it. The information stays in the character's memory even though the message is no longer in context.

**Checkpoints and branches** - See the [Read-only Mode](#read-only-mode) section.

---

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE).
