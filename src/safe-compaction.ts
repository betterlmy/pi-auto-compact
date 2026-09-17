import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractSessionFacts } from "./facts.ts";
import type { ExtensionState } from "./state.ts";

/**
 * 字符到 Token 的保守估算比例（中文和代码符号密集场景下，1 token 约 3 字符）。
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
 * 保留前部（初始任务背景）与后部（最新关键进展），截断中间历史，
 * 确保送入模型的总字符数绝对在预算内，物理上杜绝 400 ContextWindowExceededError。
 */
export function serializeMessagesWithBudget(messages: any[], maxCharsBudget: number): string {
  const formatted: string[] = [];
  for (const msg of messages) {
    const s = sanitizeAndFormatMessage(msg);
    if (s) formatted.push(s);
  }

  if (formatted.length === 0) return "No conversation history to summarize.";

  const totalLen = formatted.reduce((acc, str) => acc + str.length + 2, 0);
  if (totalLen <= maxCharsBudget) {
    return formatted.join("\n\n");
  }

  // 超限截断策略：保留前部（约 20% 预算）+ 保留后部（约 80% 预算）
  const headBudget = Math.floor(maxCharsBudget * 0.2);
  const tailBudget = maxCharsBudget - headBudget;

  const headParts: string[] = [];
  let headChars = 0;
  let headIndex = 0;
  while (headIndex < formatted.length) {
    const item = formatted[headIndex];
    if (headChars + item.length > headBudget && headParts.length > 0) break;
    headParts.push(item);
    headChars += item.length + 2;
    headIndex++;
  }

  const tailParts: string[] = [];
  let tailChars = 0;
  let tailIndex = formatted.length - 1;
  while (tailIndex >= headIndex) {
    const item = formatted[tailIndex];
    if (tailChars + item.length > tailBudget && tailParts.length > 0) break;
    tailParts.unshift(item);
    tailChars += item.length + 2;
    tailIndex--;
  }

  const omittedCount = tailIndex - headIndex + 1;
  const omittedNote =
    omittedCount > 0
      ? `\n\n[... 因会话历史过长，此处省略了中间 ${omittedCount} 条早期消息以适配模型窗口 ...]\n\n`
      : "\n\n";

  return `${headParts.join("\n\n")}${omittedNote}${tailParts.join("\n\n")}`;
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

/**
 * 确定性降级快照（Deterministic Fallback Summary）：
 * 当模型摘要调用因不可抗力（网络断开、服务端 500、超长拒识等）完全失败时，
 * 基于已提取的确定性事实生成结构化检查点，确保 firstKeptEntryId 正常落地推进，
 * 释放旧上下文空间并彻底打破死锁。
 */
export function buildDeterministicFallbackSummary(
  facts: { goalText?: string; modifiedFiles: string[]; recentCommands: string[] },
  previousSummary?: string
): string {
  const goal = facts.goalText || "(未显式声明)";
  const files =
    facts.modifiedFiles.length > 0
      ? facts.modifiedFiles.map((f) => `- ${f}`).join("\n")
      : "- (无记录修改文件)";
  const cmds =
    facts.recentCommands.length > 0
      ? facts.recentCommands.map((c) => `- \`${c}\``).join("\n")
      : "- (无)";

  let base = `## Goal\n${goal}\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- [x] 上下文自愈压缩（模型摘要异常，已采用确定性事实快照兜底释放空间）\n\n## Key Decisions\n- **Context Recovery**: 基于已提取的代码修改与操作事实落地上下文检查点。\n\n## Next Steps\n1. 继续执行未完成的任务目标\n\n## Critical Context\n### Recent Commands\n${cmds}\n### Modified Files\n${files}`;

  if (previousSummary) {
    base = `[前置会话检查点]\n${previousSummary}\n\n---\n\n${base}`;
  }
  return base;
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
 * 执行 thinking 剥离、预算硬截断、以及模型异常降级自愈。
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
  if (!preparation || !preparation.firstKeptEntryId) return;

  const {
    firstKeptEntryId,
    messagesToSummarize = [],
    turnPrefixMessages = [],
    previousSummary,
    tokensBefore = 0,
    fileOps,
  } = preparation;

  // 提取确定性事实
  const facts = extractSessionFacts(ctx.sessionManager);

  // 合并提取修改文件和读取文件
  const readSet = new Set<string>([
    ...toIterableArray(fileOps?.read),
    ...(facts.readFiles || []),
  ]);
  const modifiedSet = new Set<string>([
    ...toIterableArray(fileOps?.written),
    ...toIterableArray(fileOps?.edited),
    ...(facts.modifiedFiles || []),
  ]);
  const readFiles = Array.from(readSet).filter((f) => !modifiedSet.has(f)).sort();
  const modifiedFiles = Array.from(modifiedSet).sort();

  // 计算当前模型上下文窗口与安全字符预算
  const model = ctx.model;
  const contextWindow = model?.contextWindow && model.contextWindow > 0 ? model.contextWindow : 204800;
  // 安全输入 Token 预算：占窗口的 70%（保守按 CHARS_PER_TOKEN 换算字符），绝不逼近模型天花板
  const safeTokensBudget = Math.max(8000, Math.floor(contextWindow * 0.7));
  const maxCharsBudget = safeTokensBudget * CHARS_PER_TOKEN;

  // 合并待总结消息并序列化（彻底去除 thinking，必要时首尾截断）
  const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
  const conversationText = serializeMessagesWithBudget(allMessages, maxCharsBudget);

  // 构建 Prompt
  const basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;
  if (customInstructions) {
    promptText += `\n\nAdditional focus: ${customInstructions}`;
  }

  let summary = "";
  let usage: any = undefined;

  // 尝试调用模型生成总结
  try {
    if (signal?.aborted) {
      return { cancel: true };
    }

    if (ctx.modelRegistry && model) {
      const response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: promptText }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          maxTokens: Math.min(4096, model.maxTokens > 0 ? model.maxTokens : 4096),
          signal,
          cacheRetention: "none",
          sessionId: randomUUID(),
        }
      );

      summary = Array.isArray(response.content)
        ? response.content
            .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("\n")
        : "";

      usage = response.usage;
    }
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") {
      return { cancel: true };
    }
    if (ctx.hasUI) {
      ctx.ui.notify(
        `[Auto Compact] 模型总结异常 (${err?.message || err})，已自动切换确定性事实快照兜底自愈`,
        "warning"
      );
    }
    // 降级自愈：使用确定性事实快照
    summary = buildDeterministicFallbackSummary(facts, previousSummary);
  }

  // 若总结结果为空（例如模型无输出或无可用 modelRegistry），使用兜底
  if (!summary.trim()) {
    summary = buildDeterministicFallbackSummary(facts, previousSummary);
  }

  // 追加标准文件操作标签
  summary += formatFileOperationsXml(readFiles, modifiedFiles);

  return {
    compaction: {
      summary,
      firstKeptEntryId,
      tokensBefore,
      usage,
      details: { readFiles, modifiedFiles },
    },
  };
}
