import { CUSTOM_INSTRUCTIONS, EMERGENCY_INSTRUCTIONS } from "./config.ts";

export interface SessionFacts {
  modifiedFiles: string[];
  readFiles: string[];
  recentCommands: string[];
  goalText?: string;
  /** 最近用户请求的有界原文，不推断其是否为未完成目标。 */
  recentUserRequest?: string;
}

/** 压缩触发场景：settled = Agent 空闲沉淀；emergency = 工具暴涨中途熔断并续跑 */
export type TriggerScenario = "settled" | "emergency";

/** 注入压缩提示词的各类事实上限，避免长会话反向放大待压缩上下文 */
export const MAX_MODIFIED_FILES = 30;
export const MAX_READ_FILES = 15;
export const MAX_RECENT_COMMANDS = 8;
export const MAX_USER_REQUEST_CHARS = 2000;

/**
 * 确定性事实提取器：从会话历史中提取修改的文件、查阅的文件与关键执行命令
 * 避免总结模型因上下文过大而遗忘精确路径或产生幻觉。
 */
export function extractSessionFacts(sessionManager?: { getBranch(): any[] } | null): SessionFacts {
  // 按触碰顺序记录修改文件，重复出现时移到末尾，保证截断后保留最近改动的文件
  const modifiedOrder: string[] = [];
  const modifiedSet = new Set<string>();
  const read = new Set<string>();
  const commands: string[] = [];
  const commandSet = new Set<string>();
  let goalText: string | undefined;
  let recentUserRequest: string | undefined;

  const trackModified = (path: string) => {
    if (modifiedSet.has(path)) {
      const index = modifiedOrder.indexOf(path);
      if (index !== -1) modifiedOrder.splice(index, 1);
    }
    modifiedSet.add(path);
    modifiedOrder.push(path);
  };

  const entries = sessionManager?.getBranch?.() || [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const msg = entry.message;

      // 提取目标 (从 user prompt 或 custom message 中识别 /goal)
      if (msg.role === "user") {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
                  .map((c: any) => c.text)
                  .join("")
              : "";
        if (text.trim()) {
          const request = text.trim();
          recentUserRequest = request.length <= MAX_USER_REQUEST_CHARS
            ? request
            : `${request.slice(0, MAX_USER_REQUEST_CHARS - "\n[最近用户请求已截断]".length)}\n[最近用户请求已截断]`;
        }
        const goalMatch = text.match(/\/goal(?:\s+\[[^\]]*\])?\s+([^\n]+)/i);
        if (goalMatch && goalMatch[1]) {
          goalText = goalMatch[1].trim();
        }
      }

      // 提取工具调用事实
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && block.type === "toolCall" && block.arguments) {
            const args = block.arguments as Record<string, any>;
            const rawPath =
              typeof args.path === "string"
                ? args.path
                : typeof args.file_path === "string"
                  ? args.file_path
                  : undefined;

            if (rawPath) {
              if (block.name === "write" || block.name === "edit") trackModified(rawPath);
              else if (block.name === "read") read.add(rawPath);
            }

            if (block.name === "bash" && typeof args.command === "string") {
              const cmd = args.command.trim();
              if (cmd && !commandSet.has(cmd)) {
                commandSet.add(cmd);
                commands.push(cmd);
              }
            }
          }
        }
      }
    } else if (entry.type === "custom_message") {
      if (entry.customType && entry.customType.includes("goal")) {
        const text = typeof entry.content === "string" ? entry.content : "";
        const goalMatch = text.match(/active goal[:\s]+([^\n]+)/i);
        if (goalMatch && goalMatch[1]) goalText = goalMatch[1].trim();
      }
    }
  }

  const modifiedFiles = modifiedOrder.slice(-MAX_MODIFIED_FILES).sort();
  const readOnlyFiles = Array.from(read)
    .filter((p) => !modifiedSet.has(p))
    .slice(-MAX_READ_FILES)
    .sort();
  const recentCommands = commands.slice(-MAX_RECENT_COMMANDS);

  return {
    modifiedFiles,
    readFiles: readOnlyFiles,
    recentCommands,
    goalText,
    recentUserRequest,
  };
}

/**
 * 组装携带确定性事实底座的压缩提示词
 */
export function buildCompactionInstructions(
  facts: SessionFacts,
  baseInstructions = CUSTOM_INSTRUCTIONS,
  triggerScenario?: TriggerScenario
): string {
  const sections: string[] = [baseInstructions];

  // 紧急熔断场景：工具暴涨把正常工作拦腰截断，必须额外保全断点上下文才能无缝续跑
  if (triggerScenario === "emergency") {
    sections.push(EMERGENCY_INSTRUCTIONS);
  }
  const factsLines: string[] = [];

  if (facts.goalText) {
    factsLines.push(`- 显式声明的任务目标: ${facts.goalText}`);
  }
  if (facts.recentUserRequest) {
    factsLines.push(`- 最近用户请求（历史原文，不代表仍需执行）:\n${facts.recentUserRequest}`);
  }
  if (facts.modifiedFiles.length > 0) {
    factsLines.push(`- write/edit 调用涉及的文件（不证明执行成功）:\n  ${facts.modifiedFiles.map((f) => `* ${f}`).join("\n  ")}`);
  }
  if (facts.readFiles.length > 0) {
    factsLines.push(`- read 调用涉及的文件（不证明执行成功）:\n  ${facts.readFiles.map((f) => `* ${f}`).join("\n  ")}`);
  }
  if (facts.recentCommands.length > 0) {
    factsLines.push(`- 最近调用的命令（不证明执行成功）:\n  ${facts.recentCommands.map((c) => `* \`${c}\``).join("\n  ")}`);
  }

  if (factsLines.length > 0) {
    sections.push(
      "\n【确定性事实底座（必须无损保留进总结结构中，严禁遗漏或篡改路径）】:\n" + factsLines.join("\n")
    );
  }

  return sections.join("\n");
}
