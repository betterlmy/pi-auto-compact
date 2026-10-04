# @betterlmy/pi-auto-compact

**Lightweight context preservation and recovery assistance for Pi Coding Agent.**

English | [简体中文](./README.zh-CN.md)

Pi already provides automatic compaction, between-tool-batch continuation, and overflow recovery. This extension adds protection around that workflow: bounded tool output, active-branch fact extraction, cleaned summary input, and limited post-compaction checks.

No separate summary model, Python runtime, or independent history archive is required. Summaries use the current session model. **Compaction remains lossy: these protections reduce risk, not guarantee permanent memory.**

## Installation

```bash
pi install npm:@betterlmy/pi-auto-compact

# Or install from source
pi install git:github.com/betterlmy/pi-auto-compact
```

Restart Pi or run `/reload`. The npm peer range is Pi `>=0.84.0`; native scheduling varies by version, and the declared range does not mean every later release has been tested.

## What the extension adds

### Bounded tool output before it enters context

By default, text in a single tool result is limited to **50,000 characters**, keeping the beginning and end with an omission marker. Images and other non-text blocks do not count toward this limit.

This reduces the risk of a large log filling the window. The extension does not separately archive the omitted middle. If you need the complete output, write it to a file first and read selected sections. Set `maxToolResultChars: 0` to disable trimming.

### Active-branch facts and the latest request

The extension extracts from raw records on the active session branch:

- Paths involved in `write` / `edit` calls, up to 30.
- Other paths involved in `read` calls, up to 15.
- Recent deduplicated `bash` commands, up to 8.
- Explicit goals from `/goal` or recognized goal messages.
- The latest ordinary user request, bounded to 2,000 characters with a truncation marker when necessary.

These are supplied as summary instructions. **A tool call is not proof of successful execution; the latest request is not proof that work remains unfinished.** This is not semantic understanding of every tool, constraint, or task.

### Clean summary input and a complete-request budget

With `safeCompaction` enabled by default, the extension handles `session_before_compact` for manual, native automatic, and extension-triggered compactions:

- Omit assistant thinking drafts from serialized summary input.
- Bound serialized tool results and tool-call arguments.
- Budget the system prompt, previous summary, facts, extra instructions, history text, and output allowance together.
- Keep head/tail excerpts when history is too long, with an explicit omission marker. If fixed instructions or the previous summary alone cannot fit, cancel rather than silently trim them.

The estimate uses **3 characters per token**, keeping estimated input plus output within 70% of the model window. Output is capped at the smaller of the model's output limit and 4,096 tokens. **This is not an exact tokenizer and cannot guarantee that every provider request fits.**

### Limited post-compaction checks

The guard checks keyword fragments of explicit goals and paths involved in modification calls. If the bounded latest user request does not appear verbatim in the summary, it is also restored.

Restoration messages enter model context without starting a turn or appearing in the transcript. Goal matching is heuristic. Commands, read paths, all constraints, and the summary's business correctness are not individually verified.

## Compaction and continuation behavior

The default threshold is **75%**, adjustable per session or globally:

| Situation | Behavior |
| --- | --- |
| The agent has fully settled and usage reaches the threshold | Request compaction; remain idle afterward, without restarting completed work |
| A tool turn finishes and usage reaches the threshold | Request compaction; after success, send one hidden continuation only if the host is idle and no input is queued |
| Usage at that tool boundary reaches **92%** | Add emergency preservation instructions for the last operation's state and next intended step |
| Summary failure, empty output, output-length truncation, or cancellation | Cancel compaction; do not commit a degraded snapshot or automatically resume through this extension |

92% is a fixed emergency classification, not a separate always-active trigger. Checks run after tool execution finishes, not halfway through a tool operation.

Native Pi compaction can still trigger first at `contextWindow - reserveTokens`, not a fixed 98%. Native retries and queue scheduling belong to Pi. The `ctx.compact()` path may stop the active agent run; a continuation starts a new model turn rather than seamlessly preserving the underlying run.

### Preserve information on failure

If safe summarization fails, the extension cancels instead of substituting a facts-only snapshot or committing an incomplete checkpoint. **That compaction does not replace the old context, but it also does not free space.** Tool trimming that already occurred earlier is not undone.

Fix model, network, or input-size problems and retry with `/compact`. An already overflowing session may still need manual intervention; this is not a guarantee of automatic recovery from every stuck session. Setting `safeCompaction: false` delegates summary generation and failure handling to Pi.

## Commands

| Command | Purpose |
| --- | --- |
| `/auto-compact` | Open the threshold input dialog |
| `/auto-compact 80` | Set a session-only threshold, restored when that session resumes |
| `/auto-compact global 80` | Save a global threshold and make the current session follow it |
| `/auto-compact status` | Show effective settings, failure policy, and session statistics |
| `/auto-compact footer` | Toggle the default status line and takeover footer |
| `/auto-compact progress` | Toggle gradient and fixed-tier colors |
| `/auto-compact setup` | After confirmation, enable native compaction, set a 50,000-token response reserve, and enable settings management |

Threshold commands accept integers from 10 to 99. Very low thresholds may leave Pi without enough old history to compact; summarization itself also requires a model call and window headroom.

`setup` is not universally optimal: a 50,000-token reserve corresponds to about 95% usage on a 1M window, but about 75% on a 200K window. Assess smaller windows carefully. Pi's main settings are not modified by default.

## Configuration

File: `~/.pi/agent/auto-compact.json`.

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

| Field | Default | Meaning |
| --- | --- | --- |
| `threshold` | `75` | Global trigger line; session overrides take precedence |
| `customFooter` | `false` | Use `setStatus` by default; replace the footer when enabled |
| `progressColor` | `true` | Color takeover-footer usage by usage divided by threshold |
| `autoManageSettings` | `false` | Allow automatic changes to native compaction settings in Pi's main settings file |
| `safeCompaction` | `true` | Clean summary input, budget the complete estimated request, and cancel on failure |
| `maxToolResultChars` | `50000` | Text limit per tool result; `0` disables trimming |

Compaction, trimming, and emergency counts are saved in session entries and restored on resume. Configuration and statistics are not an independent full-history backup.

## Status display

The default `compact: 75%` status does not replace another extension's footer. After `/auto-compact footer`, the stats line can show `14.1%/1.0M (auto:75%)`, or `(auto:compacting...)` during compaction.

The gradient represents usage relative to the trigger line, not an independent risk assessment. When disabled, fixed tiers are red above 90%, yellow above 70%, and blue otherwise.

<p align="center">
  <img src="./assets/progress-green.png" alt="Green progress at low usage" width="85%" />
</p>
<p align="center"><em>Low usage</em></p>

<p align="center">
  <img src="./assets/progress-yellow.png" alt="Amber progress near half of the trigger line" width="85%" />
</p>
<p align="center"><em>Near half of the trigger line</em></p>

<p align="center">
  <img src="./assets/progress-red.png" alt="Red progress approaching the trigger line" width="85%" />
</p>
<p align="center"><em>Approaching the trigger line</em></p>

## Scope and compatibility

- **For:** lightweight output limits, branch-specific fact assistance, and complete-summary checks on top of Pi.
- **Not:** lossless memory, an independent raw archive, a background reviewer, or a prefix-cache accelerator.
- Avoid multiple extensions that take over `session_before_compact`. Similarly named packages can also collide on commands or configuration paths.
- The default status line can coexist with UI extensions; takeover-footer ownership needs coordination.
- This extension changes model-visible tool output and session content, and reads/writes its configuration and session statistics. It changes Pi's main settings only after explicit settings-management opt-in or `setup` confirmation. It does not modify project business files.
- Summarization uses the current model and consumes time and tokens. Lower thresholds can increase compaction frequency and reduce prefix-cache reuse. There is no universal cost-saving guarantee.

## Development

```bash
npm test
npm run typecheck
```

## License

[MIT](./LICENSE). Design inspiration from `pi-smart-compact` (alpertarhan) and `agent-context-guard-pi` (j1nn0).
