# Smart Memory

A SillyTavern extension that gives your AI a multi-tier memory system - keeping it oriented in long stories, aware of what happened this session, and grounded in facts it learned across all previous chats with a character.

## Features

### Short-term Memory - Context Summary

Automatically summarizes the conversation when it approaches your context limit. The summary is injected at the top of context so older messages that fall out of the window are still covered. Uses **progressive compaction**: after the first summary exists, only new messages are processed and the existing summary is extended rather than rewritten from scratch.

### Long-term Memory - Persistent Facts

Extracts facts, relationship history, preferences, and significant events from the conversation and stores them per character. These memories persist across all sessions and are injected at the start of every new chat with that character.

**Auto-consolidation** periodically sends the full memory list to the LLM and asks it to merge near-duplicate or redundant entries into single richer ones. This prevents the same information accumulating in many slightly different forms over long histories.

Long-term memories accumulate across multiple chats. If you open an older chat and run **Catch Up**, any new memories found are merged into the existing set - so you can build up a character's memory by processing chats one at a time, skipping any you don't want to include.

### Session Memory - Within-Chat Details

Captures granular details from the current chat: scene descriptions, revelations, character developments, and specific named objects or places. More detailed than long-term memories but doesn't carry over to future sessions. Complements vector storage - session memory is always-injected, vector storage retrieves on demand.

### Scene Detection & History

Detects scene breaks (time skips, location changes, explicit markers) using heuristics or optional AI confirmation. When a break is detected, a mini-summary of the completed scene is generated and stored. The last N scene summaries are injected into context so the AI stays oriented across scene transitions.

### Story Arcs - Open Threads

Extracts unresolved narrative threads: promises made, character goals, mysteries introduced, ongoing tensions. Marks arcs as resolved when the story closes them. Active arcs are injected into context so the AI stays oriented toward *where the story is going*, not just reacting to the last message.

### Away Recap

When you return to a chat after being away longer than a configurable threshold, a short "Previously on..." narrative summary is automatically generated and injected. It clears itself after the first AI response so it doesn't persist into the conversation.

### Continuity Checker

A manual tool that checks whether the last AI response contradicts any established facts in your summary, long-term memories, or session memories. Click **Check Last Response** after anything that feels off. Also available as the `/sm-check` slash command.

### Token Usage Display

A live bar chart in the settings panel showing how many tokens each active tier is currently injecting. Updates after every generation. Uses a ~4 chars/token estimate - accurate enough for budget tuning, not for exact counts.

---

## Installation

Drop the `Smart-Memory` folder into your SillyTavern extensions directory:

```text
SillyTavern/public/scripts/extensions/third-party/Smart-Memory/
```

Restart SillyTavern. The extension will appear under **Extensions** in the settings panel.

---

## Recommended Setup

Smart Memory is designed to work **alongside** SillyTavern's vector storage, not replace it:

| Layer | What it does |
| --- | --- |
| **Message Limit** extension | Hard cap on how many raw messages are sent - your VRAM budget |
| **Vector storage** | Semantic retrieval of specific details on demand |
| **Smart Memory session** | Always-present curated details from this chat |
| **Smart Memory short-term** | Always-present narrative summary covering pre-window history |
| **Smart Memory long-term** | Always-present character facts from all previous sessions |

If you're on limited VRAM (e.g. 8GB), keep the Message Limit extension enabled and lower `session_max_memories` to around 15 to keep prompt size manageable.

### Injection stacking order

Smart Memory's default injection depths are set to stack cleanly alongside vector storage. Depth is distance from the user's last message - depth 0 is right before the model responds, higher numbers are further back.

| Tier | Position | Depth | Notes |
| --- | --- | --- | --- |
| Recap | In-chat | 0 | Temporary; cleared after first response |
| Arcs | In-chat | 2 | Shares depth with ST chat vectors intentionally |
| Session | In-chat | 3 | Just above ST's default vector depth |
| Scenes | In-chat | 6 | Further back - past scene context |
| Long-term | In-prompt | - | Near character card |
| Short-term | In-prompt | - | Narrative background |

If you change ST's vector storage depth, set session memory one higher so it still layers above vectors.

---

## Settings

All settings are per-profile and saved automatically.

### Memory LLM

Selects which LLM handles all Smart Memory work - extraction, summarization, and recap. Set this to a lighter model to save your main roleplay LLM for the actual story. Options: **Main API** or **WebLLM Extension**.

### Short-term Memory

| Setting | Default | Description |
| --- | --- | --- |
| Enable auto-summarization | On | Trigger compaction automatically at threshold |
| Context threshold | 80% | Summarize when context reaches this % of the model's limit |
| Summary response length | 1500 tokens | Length budget for the generated summary - also acts as the injection cap |
| Injection template | `[Story so far:\n{{summary}}]` | Wrapper injected into the prompt |
| Injection position | In-prompt | Where in the prompt the summary appears |

### Long-term Memory

| Setting | Default | Description |
| --- | --- | --- |
| Enable long-term memory | On | Extract and inject persistent character facts |
| Carry over to new chats | On | Inject memories when starting a new chat with the same character |
| Auto-consolidate redundant memories | On | After extraction, ask the LLM to merge near-duplicate entries |
| Fresh start (per-chat) | Off | Suppress memory injection for this specific chat |
| Extract every N messages | 3 | How often automatic extraction runs |
| Max memories per character | 25 | Hard cap - oldest entries dropped when exceeded |
| Injection token budget | 500 | Oldest memories are dropped first if the total would exceed this |
| Injection template | `[Memories from previous conversations:\n{{memories}}]` | Wrapper injected into the prompt |
| Injection position | In-prompt | Where in the prompt memories appear |

### Session Memory

| Setting | Default | Description |
| --- | --- | --- |
| Enable session memory | On | Extract and inject within-session details |
| Extract every N messages | 3 | How often automatic extraction runs |
| Max session memories | 30 | Recommend lowering to ~15 on limited VRAM |
| Injection token budget | 400 | Oldest memories dropped first if exceeded |
| Injection template | `[Details from this session:\n{{session}}]` | Wrapper injected into the prompt |
| Injection position | In-chat @ depth 3 | Sits just above ST's default vector depth |

### Scene Detection

| Setting | Default | Description |
| --- | --- | --- |
| Enable scene detection | On | Detect breaks and store scene history |
| AI detection | Off | More accurate but costs an extra model call per message |
| Keep last N scenes | 5 | How many scene summaries to retain |
| Injection token budget | 300 | Oldest scenes dropped first if exceeded |
| Injection position | In-chat @ depth 6 | Further back in context |

### Story Arcs

| Setting | Default | Description |
| --- | --- | --- |
| Enable arc tracking | On | Extract and inject open narrative threads |
| Max tracked arcs | 10 | Oldest arcs dropped when limit is exceeded |
| Injection token budget | 200 | Oldest arcs dropped first if exceeded |
| Injection position | In-chat @ depth 2 | Near current action, alongside chat vectors |

### Recap

| Setting | Default | Description |
| --- | --- | --- |
| Enable recap | On | Generate a recap when returning after a gap |
| Threshold | 4 hours | Minimum away time before a recap is generated |
| Injection position | In-chat @ depth 0 | Right before the model responds; cleared after first response |

---

## Manual Operations

All manual operations are in the **Configuration** section at the top of the panel or inside the relevant tier section.

### Catch Up - Extract All from Full Chat

Processes the entire current chat history in chunks of 20 messages, running every enabled extraction tier across the backlog. Use this to onboard an existing chat that Smart Memory has not processed yet, or after loading an older chat to add its contents to long-term memory.

Because the run can take a while on long chats, a **Cancel** button appears in place of Catch Up during processing. Cancelling stops the loop between chunks - partial results are saved and injected.

To build long-term memory from multiple older chats: open each chat you want to include and run Catch Up. Long-term memories accumulate and deduplicate automatically across runs. Skip any chats you don't want to contribute.

### Clear Chat Context

Clears Smart Memory's extracted state for the current chat - summary, session memories, scene history, and story arcs. Long-term memories are not affected. Use this before running Catch Up to re-derive everything cleanly from scratch.

### Fresh Start

Clears everything including long-term memories for the current character, then suppresses future memory injection for this chat. Use this after throwaway or test sessions to ensure nothing carries over to future chats. Shows a named confirmation dialog before proceeding - this cannot be undone.

### Per-tier Extract buttons

Each memory tier has its own **Extract Now** or **Extract** button that runs extraction against a bounded recent window - not the full chat. These are for pulling in the latest exchanges outside of the automatic extraction schedule.

| Button | Window | Notes |
| --- | --- | --- |
| Long-term Extract Now | Last 20 messages | Accumulates into existing memories |
| Session Extract Now | Last 40 messages | Merges into current session |
| Extract Arcs Now | Last 100 messages | Wider window needed for arc resolution |
| Extract Scene | Scene buffer or last 40 messages | Adds one entry to scene history |

For the full chat backlog, use **Catch Up** instead.

### Other per-tier buttons

- **Summarize Now** (short-term) - forces a summary generation immediately, ignoring the threshold
- **Generate Recap Now** (away recap) - generates and injects a recap on demand
- **Check Last Response** (continuity) - checks the last AI response against known facts
- **Clear** buttons on each tier - remove all stored data for that tier

---

## Slash Commands

| Command | Description |
| --- | --- |
| `/sm-check` | Check the last AI response for contradictions against established facts |
| `/sm-summarize` | Force a short-term summary generation now |
| `/sm-extract` | Run long-term, session, and arc extraction against the current chat now |
| `/sm-recap` | Generate and inject a "Previously on..." recap now |

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

---

## Files

```text
Smart-Memory/
├── index.js          Main entry point, event wiring, UI
├── compaction.js     Short-term summary & progressive compaction
├── longterm.js       Long-term per-character memory
├── session.js        Within-session detail extraction
├── scenes.js         Scene break detection & scene history
├── arcs.js           Story arc tracking
├── recap.js          Away recap generation
├── continuity.js     Continuity contradiction checker
├── prompts.js        All prompt strings
├── constants.js      Shared constants
├── settings.html     Settings panel UI
├── style.css         Styles
└── manifest.json     Extension manifest
```
