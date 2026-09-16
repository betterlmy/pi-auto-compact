<div align="center">

# @betterlmy/pi-auto-compact

**Automatic context management for the Pi coding agent: long conversations without interruptions or lost details.**

**English** | [简体中文](./README.zh-CN.md)

</div>

---

## What problem does this solve?

Two concepts first:

**Context**: everything the AI can "see" while working on a task — your requests, its replies, commands it ran, and their output. Context has a size limit; once it's full, nothing new fits.

**Compaction**: when the context nears its limit, earlier content is condensed into a shorter summary to free up space.

Pi has built-in compaction, but by default it triggers very late (around 98% usage), which causes two common problems:

1. **Interrupted work**: compaction often happens in the middle of a task;
2. **Lossy summaries**: the summary can drop file paths you edited, commands you ran, or the current task goal.

This plugin manages both when compaction happens and what it preserves, avoiding these problems.

## What changes after installing?

### 1. Compacts early, without interrupting work

- When context usage reaches **75%** (the default, adjustable), the plugin compacts during a natural pause — the moment the AI finishes its current step.
- If a single operation (say, reading a very large log file) pushes usage past **92%** instantly, the plugin compacts right away and automatically resumes the interrupted task afterward.

### 2. Extracts key facts before compacting, so summaries stay complete

Before compacting, the plugin pulls the following directly from the conversation history and hands it to the AI along with the summary request:

- Files modified (exact paths)
- Files read
- Commands executed
- The current task goal

This information comes from checking the raw history entry by entry — it does not rely on the AI's memory, so summaries are far less likely to get things wrong.

### 3. Verifies after compacting, restores what's missing

Once the summary is generated, the plugin checks whether all of the above made it in. If something was dropped, the plugin quietly adds the missing content back into the conversation — nothing shows up on screen. The next step starts from complete information.

### 4. Trims oversized outputs before they enter the context

If one command's output is hundreds of thousands of characters, the plugin trims the middle before it enters the context — keeping the beginning and end, with a note of how many characters were omitted. In most cases usage never reaches 92%, so emergency compaction rarely happens at all.

### 5. Session statistics

How many times this session compacted, trimmed outputs, or handled an emergency — all recorded. Quit Pi and resume later; the records survive. Check them anytime with `/auto-compact status`.

### 6. Two status bar styles

- **Default**: the status bar shows `compact: 75%`, staying out of the way and remaining compatible with UI-appearance plugins.
- **Takeover**: run `/auto-compact footer` and the usage info merges into the end of Pi's native stats line as `14.1%/1.0M (auto:75%)`; while compacting it shows `(auto:compacting...)`.

---

## Installation

Run either command in your terminal, then restart Pi (or run `/reload`):

```bash
# Install from npm (recommended)
pi install npm:@betterlmy/pi-auto-compact

# Or install from GitHub
pi install git:github.com/betterlmy/pi-auto-compact
```

Works with default settings — no configuration needed.

---

## Handy Commands

| Command | What it does |
| :--- | :--- |
| `/auto-compact 80` | Move the auto-compaction trigger line to 80% |
| `/auto-compact` | Open a dialog to adjust the trigger line |
| `/auto-compact footer` | Switch status bar style |
| `/auto-compact status` | View current settings and session statistics |
| `/auto-compact setup` | (Optional) Adjust Pi's built-in fallback compaction settings to recommended values |

---

## Configuration (Optional)

Settings live in `~/.pi/agent/auto-compact.json`:

```json
{
  "threshold": 75,
  "customFooter": false,
  "autoManageSettings": false,
  "maxToolResultChars": 50000
}
```

- `threshold`: the auto-compaction trigger line as a percentage of context usage (default 75). Lower = compacts more often, more relaxed; higher = fewer interruptions but more likely to hit emergency compaction.
- `customFooter`: whether to use the takeover status bar (default off).
- `autoManageSettings`: whether the plugin may adjust Pi's built-in fallback compaction settings for you (default off).
- `maxToolResultChars`: the character limit for a single output before it enters the context; anything beyond is trimmed (default 50000; set 0 to disable).

---

## FAQ

**Do I need to know how to code?**
No. Install and restart Pi — the defaults just work.

**Does it touch my files?**
No. The plugin only works with the conversation history itself; it never reads or writes your project files.

**When does it compact?**
Two situations: usage reaches 75% while the AI happens to be between steps, or a single operation pushes usage past 92% instantly. Otherwise it stays out of the way.

**Does compacting cost extra?**
Compaction is one AI call (reading the earlier content and writing a summary) — about the same cost as an ordinary chat. The default 75% trigger line exists precisely to pick a good moment for it.

---

## For Developers

```bash
npm test           # run tests
npm run typecheck  # type check
```

---

## License

[MIT](LICENSE) © betterlmy
Design inspiration from `pi-smart-compact` (alpertarhan) and `agent-context-guard-pi` (j1nn0).
