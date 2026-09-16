import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractSessionFacts } from "./facts.ts";

/**
 * Context Guard：压缩落地后核对总结是否丢失硬性事实与未完目标。
 * 一旦发现遗漏，静默注入恢复锚点（display: false，不污染界面）。
 */
export function runContextGuard(pi: ExtensionAPI, ctx: ExtensionContext, summary: string): void {
  try {
    const facts = extractSessionFacts(ctx.sessionManager);
    const missingItems: string[] = [];

    // 检查任务目标
    if (facts.goalText) {
      const shortGoal = facts.goalText.slice(0, 15);
      if (!summary.toLowerCase().includes(shortGoal.toLowerCase())) {
        missingItems.push(`当前未完成任务目标: ${facts.goalText}`);
      }
    }

    // 检查变更文件清单
    if (facts.modifiedFiles.length > 0) {
      const omittedFiles = facts.modifiedFiles.filter((f) => !summary.includes(f));
      if (omittedFiles.length > 0) {
        missingItems.push(`关键修改文件清单: ${omittedFiles.join(", ")}`);
      }
    }

    if (missingItems.length === 0) return;

    pi.sendMessage(
      {
        customType: "auto-compact/context-guard",
        content: `[Context Guard: 关键约束与上下文恢复]\n${missingItems.map((item) => `- ${item}`).join("\n")}`,
        display: false,
      },
      { triggerTurn: false }
    );
    if (ctx.hasUI) {
      ctx.ui.notify(
        `[Auto Compact] Context Guard 发现并已静默补回 ${missingItems.length} 项遗漏的关键上下文`,
        "info"
      );
    }
  } catch (err) {
    console.error("[Auto Compact] Context Guard error:", err);
  }
}