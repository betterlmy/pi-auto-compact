<div align="center">

# @betterlmy/pi-auto-compact

**Deterministic, context-guarded automatic compaction extension for the Pi Coding Agent with dual watermarks and inline status display.**

[![npm version](https://img.shields.io/npm/v/@betterlmy/pi-auto-compact.svg)](https://www.npmjs.com/package/@betterlmy/pi-auto-compact)
[![Pi Extension](https://img.shields.io/badge/Pi-Extension-blue.svg)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/betterlmy/pi-auto-compact/actions/workflows/ci.yml/badge.svg)](https://github.com/betterlmy/pi-auto-compact/actions)

**English** | [简体中文](./README.zh-CN.md)

</div>

---

## Why This Exists

Pi's built-in auto-compaction relies solely on a fixed absolute token reserve (`compaction.reserveTokens`, defaulting to 16,384 tokens). On modern models with 1M or 2M token windows, this triggers at an extreme **98.4%+**, leading to:
1. **Mid-task interruption**: Compaction arbitrarily interrupting long tool loops;
2. **Context degradation**: Summarization LLMs forgetting exact modified file paths, critical commands, and strict project constraints;
3. **Session amnesia**: Losing the initial task objective or safety redlines after multiple compaction cycles;
4. **Configuration complexity**: Existing community packages often require complex multi-file configurations and obscure parameters.

`pi-auto-compact` resolves these pain points with **one-command configuration** and **deterministic fact anchoring**.

---

## Key Features

### 1. Dual-Watermark Compaction Trigger

```text
               [100% Context Window]
                         ↑
        95% Native reserveTokens emergency fallback (safety net)
                         ↑
   ───▶ 92% Emergency Ceiling (instant compaction on sudden tool blowout + auto-resume)
                         ↑
   ───▶ 75% Gentle Compaction (runs only at agent_settled idle point)
```

- **Gentle Compaction (Default: 75%)**: Rising-edge triggered only when the agent run has fully settled (`agent_settled`) and the session is idle. Never cuts in the middle of active tool execution.
- **Emergency Ceiling (92%)**: If a single tool call (e.g. huge build log, massive diff) blows context usage past 92%, it halts on the spot, compacts with full fact preservation, and automatically resumes the turn.

### 2. Deterministic Fact Extraction (Inspired by `pi-smart-compact`)
Before delegating summarization to the LLM, the extension deterministically inspects the session history:
- **Modified files**: Extracts exact paths for all `edit` and `write` tool calls;
- **Inspected files**: Collects key files examined with `read` (deduplicating against modified files);
- **Executed commands**: Records recent `bash` command invocations;
- **Task Objective**: Identifies active `/goal <objective>` contracts.

These facts are injected directly into compaction instructions as a **ground-truth foundation**, eliminating hallucinations and forgotten file paths.

### 3. Context Guard: Post-Compaction Automatic Rescue (Inspired by `agent-context-guard-pi`)
Immediately after compaction finishes (`session_compact`):
- Verifies whether the resulting summary retained the active goal and modified file paths;
- If any critical fact was omitted by the LLM, it silently injects a recovery anchor message (`display: false`, no UI pollution):
  ```text
  [Context Guard: Restoring Critical Invariants]
  - Active goal: ...
  - Modified files: ...
  ```
- Ensures the next turn starts with an uncompromised state foundation.

### 4. Dual Footer Modes (Non-Invasive vs Inline Takeover)
- **Default Mode (Non-Invasive)**: Uses `ctx.ui.setStatus` to display `compact: 75%`, fully compatible with native footers, `pi-starship`, and `@henryqw/pi-footer`.
- **Inline Mode (Optional)**: Run `/auto-compact footer` to toggle inline footer rendering, seamlessly blending into the native token stats line:
  ```text
  ↑1.9M ↓15k R7.8M CH96.4% $2.574 14.1%/1.0M (auto:75%)
  ```
  Dynamically transitions to `(auto:compacting...)` while compaction is in progress.

---

## Installation

Install using Pi's built-in package manager:

```bash
# Recommended: install via npm
pi install npm:@betterlmy/pi-auto-compact

# Or install directly from GitHub repository
pi install git:github.com/betterlmy/pi-auto-compact
```

---

## Commands

| Command | Description |
| :--- | :--- |
| `/auto-compact <number>` | Set the compaction threshold percentage (10–99, e.g. `/auto-compact 80`) |
| `/auto-compact` | Open an interactive dialog to set the threshold |
| `/auto-compact footer` | Toggle between standard status line and inline takeover footer |
| `/auto-compact setup` | Safely verify and optimize Pi's native safety net (`reserveTokens=50000`) |
| `/auto-compact status` | Display current threshold, emergency ceiling, usage, and toggle states |

---

## Configuration

Stored at `~/.pi/agent/auto-compact.json`:

```json
{
  "threshold": 75,
  "customFooter": false,
  "autoManageSettings": false
}
```

- `threshold` (`number`): Gentle compaction trigger threshold (10–99, default `75`).
- `customFooter` (`boolean`): Whether to enable inline `(auto:XX%)` footer takeover (default `false`).
- `autoManageSettings` (`boolean`): Automatically enforce the native 95% safety net in `settings.json` on startup (default `false`).

---

## Testing

Run the test suite (powered by Node.js built-in `node:test`, 13 tests):

```bash
npm test
```

---

## License

[MIT](LICENSE) © betterlmy
Special thanks to the design inspirations from `pi-smart-compact` (alpertarhan) and `agent-context-guard-pi` (j1nn0).
