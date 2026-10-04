import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCompactionInstructions, extractSessionFacts } from "./facts.ts";
import type { ExtensionState } from "./state.ts";

/**
 * 字符到 Token 的启发式估算比例；不是 tokenizer，不保证对所有文本保守。
 */
export const CHARS_PER_TOKEN = 3;

/**
 * 单条工具结果在摘要序列化中的最大字符数。
 */
export const TOOL_RESULT_MAX_CHARS = 1500;

/**
 * 单次工具调用参数字符串的最大字符数。
 */
export const TOOL_CALL_MAX_CHARS = 500;

/**
 * 摘要请求的系统提示词。
 */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 提取文本内容。
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * 截断长文本并附加省略标记。
 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... ${text.length - maxChars} chars truncated]`;
}

/**
 * 清洗并单条序列化消息：
 * 1. 彻底过滤 assistant 的 thinking block（杜绝长推理思考泄露到摘要输入中）；
 * 2. 截断超大 toolResult；
 * 3. 截断超长 toolCall 参数；
 */
export function sanitizeAndFormatMessage(msg: any): string | null {
  if (!msg || typeof msg !== "object") return null;

  switch (msg.role) {
    case "user": {
      const text = extractText(msg.content);
      return text ? `[User]: ${text}` : null;
    }
    case "assistant": {
      const parts: string[] = [];
      if (Array.isArray(msg.content)) {
        // 核心防御点：彻底忽略 block.type === "thinking"，不向 Prompt 拼入任何内部思考草稿
        const textParts: string[] = [];
        const toolCalls: string[] = [];

        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "toolCall") {
            const name = block.name || "unknown";
            let argsStr = "";
            if (block.arguments && typeof block.arguments === "object") {
              try {
                argsStr = JSON.stringify(block.arguments);
                if (argsStr.length > TOOL_CALL_MAX_CHARS) {
                  argsStr = `${argsStr.slice(0, TOOL_CALL_MAX_CHARS)}...}`;
                }
              } catch {
                argsStr = "...";
              }
            }
            toolCalls.push(`${name}(${argsStr})`);
          }
        }

        if (textParts.length > 0) {
          parts.push(`[Assistant]: ${textParts.join("\n")}`);
        }
        if (toolCalls.length > 0) {
          parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
        }
      }
      return parts.length > 0 ? parts.join("\n") : null;
    }
    case "toolResult": {
      const text = extractText(msg.content);
      if (!text) return null;
      return `[Tool result]: ${truncateText(text, TOOL_RESULT_MAX_CHARS)}`;
    }
    case "bashExecution": {
      const cmd = typeof msg.command === "string" ? msg.command : "";
      const out = typeof msg.output === "string" ? truncateText(msg.output, TOOL_RESULT_MAX_CHARS) : "";
      return `[Bash]: ${cmd}\n${out}`;
    }
    case "custom": {
      const text = extractText(msg.content);
      return text ? `[Custom message]: ${text}` : null;
    }
    default:
      return null;
  }
}

/**
 * 带预算硬约束的安全序列化：
 * 若清洗后的消息总长度超出字符预算（maxCharsBudget），
 * 保留前部（初始任务背景）与后部（最新关键进展），截断中间历史。
 * 字符数严格受控，但字符/token 换算仅为估算，不能保证提供商永不超限。
 */
export function serializeMessagesWithBudget(messages: any[], maxCharsBudget: number): string {
  if (!Number.isFinite(maxCharsBudget) || maxCharsBudget <= 0) return "";
  const budget = Math.floor(maxCharsBudget);
  const text = messages.map(sanitizeAndFormatMessage).filter(Boolean).join("\n\n")
    || "No conversation history to summarize.";
  if (text.length <= budget) return text;

  const marker = "\n\n[... 历史中部已省略，首尾片段可能被截断 ...]\n\n";
  if (budget <= marker.length) return marker.slice(0, budget);
  const available = budget - marker.length;
  const head = Math.floor(available * 0.2);
  const tail = available - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

/**
 * 格式化标准文件操作 XML 标签。
 */
export function formatFileOperationsXml(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

function toIterableArray(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter((x) => typeof x === "string");
  if (val instanceof Set || typeof (val as any)?.[Symbol.iterator] === "function") {
    return Array.from(val as Iterable<string>).filter((x) => typeof x === "string");
  }
  return [];
}

/**
 * 安全压缩拦截处理器：
 * 在 session_before_compact 拦截默认的 _runDefaultCompaction，
 * 执行 thinking 剥离、完整请求的估算预算控制；失败时取消压缩。
 */
export async function handleSafeCompaction(
  event: any,
  ctx: ExtensionContext,
  state: ExtensionState
): Promise<{ cancel?: boolean; compaction?: any } | void> {
  if (state.config.safeCompaction === false) {
    return;
  }

  const { preparation, customInstructions, signal } = event;
  const sessionEpoch = state.sessionEpoch;
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const leafId = ctx.sessionManager?.getLeafId?.();
  const cancelled = () => signal?.aborted || state.sessionEpoch !== sessionEpoch
    || ctx.sessionManager?.getSessionId?.() !== sessionId
    || ctx.sessionManager?.getLeafId?.() !== leafId;
  const fail = (message: string) => {
    if (ctx.hasUI && !cancelled()) {
      ctx.ui.notify(`[Auto Compact] 摘要失败：${message}。已取消压缩并保留原上下文；请检查后手动重试，不会自动续跑。`, "warning");
    }
    return { cancel: true };
  };
  if (cancelled()) return { cancel: true };
  if (!preparation || !preparation.firstKeptEntryId) return fail("缺少有效压缩边界");

  try {
    const {
      firstKeptEntryId,
      messagesToSummarize = [],
      turnPrefixMessages = [],
      previousSummary,
      tokensBefore = 0,
      fileOps,
    } = preparation;

    const facts = extractSessionFacts(ctx.sessionManager);
    const readSet = new Set<string>([
      ...toIterableArray(fileOps?.read),
      ...facts.readFiles,
    ]);
    const modifiedSet = new Set<string>([
      ...toIterableArray(fileOps?.written),
      ...toIterableArray(fileOps?.edited),
      ...facts.modifiedFiles,
    ]);
    const readFiles = Array.from(readSet).filter((f) => !modifiedSet.has(f)).sort();
    const modifiedFiles = Array.from(modifiedSet).sort();

    const model = ctx.model;
    if (!model || !ctx.modelRegistry || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
      return fail("缺少可用模型或有效上下文窗口");
    }
    const outputTokens = Math.min(4096, model.maxTokens > 0 ? model.maxTokens : 4096);
    // 同时预留模型输出及 30% 窗口余量，不用固定最低预算突破小窗口。
    const inputTokens = Math.floor(model.contextWindow * 0.7) - outputTokens;
    const maxCharsBudget = Math.max(0, inputTokens * CHARS_PER_TOKEN);
    const basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
    const prefix = "<conversation>\n";
    let suffix = "\n</conversation>\n\n";
    if (previousSummary) suffix += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    suffix += `${basePrompt}\n\n${buildCompactionInstructions(facts)}`;
    if (customInstructions) suffix += `\n\nAdditional focus: ${customInstructions}`;
    const historyBudget = maxCharsBudget - SUMMARIZATION_SYSTEM_PROMPT.length - prefix.length - suffix.length;
    // 旧摘要、事实与用户附加要求不静默删改；它们放不下时拒绝生成检查点。
    if (historyBudget <= 0) return fail("固定提示、旧摘要或附加要求已超过估算输入预算");
    const conversationText = serializeMessagesWithBudget([...messagesToSummarize, ...turnPrefixMessages], historyBudget);
    const promptText = `${prefix}${conversationText}${suffix}`;

    const response = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: promptText }],
          timestamp: Date.now(),
        }],
      },
      {
        maxTokens: outputTokens,
        signal,
        cacheRetention: "none",
        sessionId: randomUUID(),
      }
    );

    if (cancelled()) return { cancel: true };
    if (response.stopReason !== "stop") {
      return fail(`模型未完整结束（${response.stopReason || "未知状态"}）${response.errorMessage ? `：${response.errorMessage}` : ""}`);
    }
    let summary = Array.isArray(response.content)
      ? response.content
          .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
          .map((c: any) => c.text)
          .join("\n")
      : "";
    if (!summary.trim()) return fail("模型返回空摘要");

    summary += formatFileOperationsXml(readFiles, modifiedFiles);
    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        usage: response.usage,
        details: { readFiles, modifiedFiles },
      },
    };
  } catch (err: any) {
    if (cancelled() || err?.name === "AbortError") return { cancel: true };
    return fail(err?.message || String(err));
  }
}
