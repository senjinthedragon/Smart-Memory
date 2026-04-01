# Smart Memory

A SillyTavern extension that gives your AI a multi-tier memory system - keeping it oriented in long stories, aware of what happened this session, and grounded in facts it learned across all previous chats with a character.

## Features

### Short-term Memory - Context Summary

Automatically summarizes the conversation when it approaches your context limit. The summary is injected at the top of context so older messages that fall out of the window are still covered. Uses **progressive compaction**: after the first summary exists, only new messages are processed and the existing summary is extended rather than rewritten from scratch.

### Long-term Memory - Persistent Facts

Extracts facts, relationship history, preferences, and significant events from the conversation and stores them per character. These memories persist across all sessions and are injected at the start of every new chat with that character. A **Fresh Start** toggle lets you suppress injection for a specific chat when you want a clean slate.

### Session Memory - Within-Chat Details

Captures granular details from the current chat: scene descriptions, revelations, character developments, and specific named objects or places. More detailed than long-term memories, but doesn't carry over to future sessions. Complements vector storage - session memory is always-injected, vector storage retrieves on demand.

### Scene Detection & History

Detects scene breaks (time skips, location changes, explicit markers) using heuristics or optional AI confirmation. When a break is detected, a mini-summary of the completed scene is generated and stored. The last N scene summaries are injected into context so the AI stays oriented across scene transitions.

### Story Arcs - Open Threads

Extracts unresolved narrative threads: promises made, character goals, mysteries introduced, ongoing tensions. Marks arcs as resolved when the story closes them. Active arcs are injected into context so the AI stays oriented toward *where the story is going*, not just reacting to the last message.

### Away Recap

When you return to a chat after being away longer than a configurable threshold, a short "Previously on..." narrative summary is automatically generated and injected. It clears itself after the first AI response so it doesn't persist into the conversation.

### Continuity Checker

A manual tool that checks whether the last AI response contradicts any established facts in your summary, long-term memories, or session memories. Click **Check Last Response** after anything that feels off.

---

## Installation

Drop the `smart-memory` folder into your SillyTavern extensions directory:

```text
SillyTavern/public/scripts/extensions/third-party/smart-memory/
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

---

## Settings

All settings are per-profile and saved automatically.

### Short-term Memory

| Setting | Default | Description |
| --- | --- | --- |
| Enable auto-summarization | On | Trigger compaction automatically at threshold |
| Context threshold | 80% | Summarize when context reaches this % of the model's limit |
| Summary response length | 1500 tokens | Length budget for the generated summary |
| Injection template | `[Story so far:\n{{summary}}]` | Wrapper injected into the prompt |
| Injection position | In-prompt | Where in the prompt the summary appears |

### Long-term Memory

| Setting | Default | Description |
| --- | --- | --- |
| Enable long-term memory | On | Extract and inject persistent character facts |
| Carry over to new chats | On | Inject memories when starting a new chat with the same character |
| Fresh start (per-chat) | Off | Suppress memory injection for this specific chat |
| Extract every N messages | 3 | How often extraction runs |
| Max memories per character | 25 | Older/duplicate memories are pruned |

### Session Memory

| Setting | Default | Description |
| --- | --- | --- |
| Enable session memory | On | Extract and inject within-session details |
| Extract every N messages | 3 | How often extraction runs |
| Max session memories | 30 | Recommend lowering to ~15 on limited VRAM |

### Scene Detection

| Setting | Default | Description |
| --- | --- | --- |
| Enable scene detection | On | Detect breaks and store scene history |
| AI detection | Off | More accurate but costs an extra model call per message |
| Keep last N scenes | 5 | How many scene summaries to retain |

### Story Arcs

| Setting | Default | Description |
| --- | --- | --- |
| Enable arc tracking | On | Extract and inject open narrative threads |
| Max tracked arcs | 10 | Oldest arcs are dropped when the limit is exceeded |

### Recap

| Setting | Default | Description |
| --- | --- | --- |
| Enable recap | On | Generate a recap when returning after a gap |
| Threshold | 4 hours | Minimum away time before a recap is generated |

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
smart-memory/
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
