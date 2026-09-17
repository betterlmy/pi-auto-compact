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

### 1. Mandatory compaction at threshold with auto-resume

- When context usage reaches the configured threshold (default 75%, configurable per-session or globally), the plugin **triggers compaction immediately** (either mid-run after a tool execution or when settled), rather than waiting until the context is blown or idling out.
- **Seamless auto-resume**: Compaction completes and immediately dispatches an invisible continuation turn to resume the interrupted or ongoing task. No need to manually prompt "continue" — mirroring the fluid experience of Codex and Claude Code.
- If a single operation pushes usage past **92%** instantly, it escalates to emergency breakpoint preservation, capturing interrupted tool details alongside deterministic facts so the resumed turn picks up without missing a beat.

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

### 5. Safe compaction overflow defense (prevents 400 errors and deadlocks)

In long sessions with reasoning/thinking enabled, native compaction serializes hundreds of thousands of internal thinking characters directly into the summarization prompt, readily triggering `400 ContextWindowExceededError` and deadlocking the session. This extension prevents that:
- **Strips internal thinking**: Automatically omits reasoning drafts when creating summaries, saving massive token usage and API cost;
- **Hard token budgeting**: Restricts summarization prompt size to a safe fraction of the model's context window; trims middle turns while preserving initial goals and latest progress;
- **Deterministic self-healing fallback**: If model calls fail due to network errors or outages, it automatically writes a structured facts-backed checkpoint to land compaction safely and break the deadlock.

### 6. Session statistics

How many times this session compacted, trimmed outputs, or handled an emergency — all recorded. Quit Pi and resume later; the records survive. Check them anytime with `/auto-compact status`.

### 7. Two status bar styles

- **Default**: the status bar shows `compact: 75%`, staying out of the way and remaining compatible with UI-appearance plugins.
- **Takeover**: run `/auto-compact footer` and the usage info merges into the end of Pi's native stats line as `14.1%/1.0M (auto:75%)`; while compacting it shows `(auto:compacting...)`.

In takeover mode the usage numbers change color as usage grows: the closer to the trigger line, the redder. The color is picked by the ratio of current usage to the trigger line — green at the start, amber near the middle, red at the line (e.g. trigger line 60% and current usage 50% picks the color at 50/60 ≈ 83%). Not a fan? Run `/auto-compact progress` to switch back to the fixed red/yellow/blue tiers.

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
| `/auto-compact 80` | Move the auto-compaction trigger line to 80% (**current session only by default**) |
| `/auto-compact global 80` | Set the trigger line to 80% and **save globally** |
| `/auto-compact` | Open a dialog to adjust the trigger line (supports numbers or adding global) |
| `/auto-compact footer` | Switch status bar style |
| `/auto-compact progress` | Toggle gradient coloring of the usage numbers |
| `/auto-compact status` | View current effective settings (local vs global) and session statistics |
| `/auto-compact setup` | (Optional) Adjust Pi's built-in fallback compaction settings to recommended values |

---

## Configuration (Optional)

Settings live in `~/.pi/agent/auto-compact.json`:

```json
{
  "threshold": 75,
  "customFooter": false,
  "progressColor": true,
  "autoManageSettings": false,
  "safeCompaction": true,
  "maxToolResultChars": 50000
}
```

- `threshold`: global auto-compaction trigger line as a percentage of context usage (default 75). New sessions always load this global baseline. Running `/auto-compact 60` only affects the current session, while `/auto-compact global 60` updates this global setting.
- `customFooter`: whether to use the takeover status bar (default off).
- `progressColor`: whether the usage numbers shift color with usage (default on). When off, falls back to three fixed tiers: red above 90%, yellow above 70%, blue otherwise.
- `autoManageSettings`: whether the plugin may adjust Pi's built-in fallback compaction settings for you (default off).
- `safeCompaction`: whether to enable safe compaction overflow defense and thinking stripping (default true).
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
