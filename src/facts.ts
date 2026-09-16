import { CUSTOM_INSTRUCTIONS } from "./config.ts";

export interface SessionFacts {
  modifiedFiles: string[];
  readFiles: string[];
  recentCommands: string[];
  goalText?: string;
}

/** 注入压缩提示词的各类事实上限，避免长会话反向放大待压缩上下文 */
export const MAX_MODIFIED_FILES = 30;
export const MAX_READ_FILES = 15;
export const MAX_RECENT_COMMANDS = 8;

/**
 * 确定性事实提取器：从会话历史中提取修改的文件、查阅的文件与关键执行命令
 * 避免总结模型因上下文过大而遗忘精确路径或产生幻觉。
 */
export function extractSessionFacts(sessionManager: { getEntries(): any[] }): SessionFacts {
  // 按触碰顺序记录修改文件，重复出现时移到末尾，保证截断后保留最近改动的文件
  const modifiedOrder: string[] = [];
  const modifiedSet = new Set<string>();
  const read = new Set<string>();
  const commands: string[] = [];
  let goalText: string | undefined;

  const trackModified = (path: string) => {
    if (modifiedSet.has(path)) {
      const index = modifiedOrder.indexOf(path);
      if (index !== -1) modifiedOrder.splice(index, 1);
    }
    modifiedSet.add(path);
    modifiedOrder.push(path);
  };

  const entries = sessionManager?.getEntries?.() || [];
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
              if (cmd && !commands.includes(cmd)) {
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
  };
}

/**
 * 组装携带确定性事实底座的压缩提示词
 */
export function buildCompactionInstructions(facts: SessionFacts, baseInstructions = CUSTOM_INSTRUCTIONS): string {
  const sections: string[] = [baseInstructions];
  const factsLines: string[] = [];

  if (facts.goalText) {
    factsLines.push(`- 当前任务核心目标: ${facts.goalText}`);
  }
  if (facts.modifiedFiles.length > 0) {
    factsLines.push(`- 确定已修改/新建的文件:\n  ${facts.modifiedFiles.map((f) => `* ${f}`).join("\n  ")}`);
  }
  if (facts.readFiles.length > 0) {
    factsLines.push(`- 确定已查阅的核心文件:\n  ${facts.readFiles.map((f) => `* ${f}`).join("\n  ")}`);
  }
  if (facts.recentCommands.length > 0) {
    factsLines.push(`- 最近执行的关键命令:\n  ${facts.recentCommands.map((c) => `* \`${c}\``).join("\n  ")}`);
  }

  if (factsLines.length > 0) {
    sections.push(
      "\n【确定性事实底座（必须无损保留进总结结构中，严禁遗漏或篡改路径）】:\n" + factsLines.join("\n")
    );
  }

  return sections.join("\n");
}
