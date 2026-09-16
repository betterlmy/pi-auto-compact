import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleAutoCompactCommand } from "./command.ts";
import { executeCompaction } from "./compaction.ts";
import { applyNativeSafetyNet, checkNativeSafetyNet, EMERGENCY_THRESHOLD } from "./config.ts";
import { runContextGuard } from "./guard.ts";
import { createExtensionState } from "./state.ts";
import { updateStatusDisplay } from "./status.ts";

export { extractSessionFacts, buildCompactionInstructions } from "./facts.ts";
export { loadConfig, saveConfig, checkNativeSafetyNet, applyNativeSafetyNet } from "./config.ts";

function hasToolCall(message: any): boolean {
  return (
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((part: any) => part && typeof part === "object" && part.type === "toolCall")
  );
}

function contextPercent(ctx: ExtensionContext): number | null {
  const usage = ctx.getContextUsage?.();
  if (!usage || !usage.contextWindow || usage.contextWindow <= 0) return null;
  return usage.percent ?? ((usage.tokens ?? 0) / usage.contextWindow) * 100;
}

export default function (pi: ExtensionAPI) {
  const state = createExtensionState();

  // 1. 任意来源的压缩开始时刷新状态
  pi.on("session_before_compact", () => {
    state.isCompacting = true;
    state.requestRenderFn?.();
  });

  // 2. 压缩落地后守护检查：防止模型总结丢失重要文件或目标
  pi.on("session_compact", (event, ctx) => {
    state.isCompacting = false;
    state.lastCheckedPercent = null;
    updateStatusDisplay(state, ctx);

    if (!ctx || !ctx.sessionManager) return;
    runContextGuard(pi, ctx, event.compactionEntry?.summary || "");
  });

  pi.on("session_compact_failed", (_event, ctx) => {
    state.isCompacting = false;
    updateStatusDisplay(state, ctx);
  });

  // 3. 会话启动
  pi.on("session_start", (_event, ctx) => {
    // 自动或非侵入检测原生安全网
    if (state.config.autoManageSettings) {
      // 已处于最优时不再重复改写 settings.json
      if (!checkNativeSafetyNet().isOptimal) applyNativeSafetyNet();
    } else {
      const status = checkNativeSafetyNet();
      if (!status.isOptimal && ctx.hasUI) {
        const detail = status.message ? ` ${status.message}` : "";
        ctx.ui.notify(
          `[Auto Compact] 提示：建议设置原生 reserveTokens=50000 作为 95% 兜底安全网。可执行 /auto-compact setup 自动配置。${detail}`,
          "info"
        );
      }
    }

    updateStatusDisplay(state, ctx);
  });

  // 4. 常态压缩触发点：Agent 完全沉淀空闲后（agent_settled）
  pi.on("agent_settled", (_event, ctx) => {
    // 自愈：agent_settled 的语义保证此刻没有压缩/重试/续跑待执行，
    // 若本地仍标记压缩中，说明是陈旧状态（例如 SDK 成功路径未发出 session_compact），
    // 必须复位，否则后续所有触发点会被永久挡死。
    if (state.isCompacting && ctx.isIdle()) state.isCompacting = false;
    if (state.isCompacting) return;

    const currentPercent = contextPercent(ctx);
    if (currentPercent === null) return;

    // 电平触发：沉淀时用量达到阈值即压缩，不依赖“从阈值以下跨越上来”的边沿
    // （边沿检测在“已高于阈值但未压缩”的卡死状态下会永久失效）。
    // lastCheckedPercent 记录上次触发点或阈值以下的最近水位：
    // 低于阈值时重新武装；达到阈值但自上次触发点后用量未增长时不重复空转，失败重试随用量增长自动放行。
    if (currentPercent < state.config.threshold) {
      state.lastCheckedPercent = currentPercent;
      return;
    }
    if (state.lastCheckedPercent !== null && currentPercent <= state.lastCheckedPercent) return;

    state.lastCheckedPercent = currentPercent;
    executeCompaction(pi, state, ctx, currentPercent, false, "settled");
  });

  // 5. 紧急熔断触发点：多轮工具中途暴涨保护（>= 92%）
  pi.on("turn_end", (event, ctx) => {
    if (state.isCompacting) return;
    if (!hasToolCall(event.message)) return;

    const currentPercent = contextPercent(ctx);
    if (currentPercent === null) return;

    if (currentPercent >= EMERGENCY_THRESHOLD) {
      executeCompaction(pi, state, ctx, currentPercent, true, "emergency");
    }
  });

  // 6. 注册 /auto-compact 命令
  pi.registerCommand("auto-compact", {
    description: "查看或配置自动压缩 (用法: /auto-compact [数值|setup|footer|status])",
    handler: (args, ctx) => handleAutoCompactCommand(state, args, ctx),
  });
}