import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractSessionFacts } from "./facts.ts";

/** 滑窗片段长度（字符数）：对无空格分隔的文本（如中文）生成多个重叠子串 */
const SLIDING_WINDOW_LEN = 4;
/** 滑窗步长 */
const SLIDING_WINDOW_STEP = 2;

/**
 * 从目标文本中提取多个关键片段用于匹配检测。
 * 策略：
 * - 有空格分隔时按空白拆词，取长度 >= 2 的词，最多 5 个；
 * - 无空格分隔的连续文本（如中文）按固定窗口滑动生成多个子串；
 * - 任何一个片段在总结中命中即视为目标已被保留。
 * 导出以供独立测试。
 */
export function extractGoalKeywords(goalText: string): string[] {
  const words = goalText
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);

  // 多词场景（英文或空格分隔的中文）：最多取 5 个关键词
  if (words.length >= 2) {
    return words.slice(0, 5);
  }

  // 单词场景（无空格的连续文本，如中文）：用滑动窗口生成多个重叠子串
  const text = words[0];
  if (!text || text.length < SLIDING_WINDOW_LEN) {
    return text ? [text] : [];
  }

  const fragments: string[] = [];
  for (let i = 0; i <= text.length - SLIDING_WINDOW_LEN; i += SLIDING_WINDOW_STEP) {
    fragments.push(text.slice(i, i + SLIDING_WINDOW_LEN));
  }
  // 取尾部片段确保全覆盖
  const lastFragment = text.slice(-SLIDING_WINDOW_LEN);
  if (!fragments.includes(lastFragment)) {
    fragments.push(lastFragment);
  }
  return fragments;
}

/**
 * Context Guard：压缩落地后核对总结是否丢失硬性事实与未完目标。
 * 一旦发现遗漏，静默注入恢复锚点（display: false，不污染界面）。
 */
export function runContextGuard(pi: ExtensionAPI, ctx: ExtensionContext, summary: string): void {
  try {
    const facts = extractSessionFacts(ctx.sessionManager);
    const missingItems: string[] = [];

    // 检查任务目标：提取多个关键词，全部未命中才视为遗漏
    if (facts.goalText) {
      const keywords = extractGoalKeywords(facts.goalText);
      const lowerSummary = summary.toLowerCase();
      const anyHit = keywords.length === 0 || keywords.some((kw) => lowerSummary.includes(kw.toLowerCase()));
      if (!anyHit) {
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