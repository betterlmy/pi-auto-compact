import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleAutoCompactCommand } from "./command.ts";
import { executeCompaction } from "./compaction.ts";
import {
  applyNativeSafetyNet,
  checkNativeSafetyNet,
  EMERGENCY_THRESHOLD,
  loadConfig,
  restoreSessionThreshold,
} from "./config.ts";
import { runContextGuard } from "./guard.ts";
import { handleSafeCompaction } from "./safe-compaction.ts";
import { createExtensionState } from "./state.ts";
import { recordStats, restoreStats } from "./stats.ts";
import { updateStatusDisplay } from "./status.ts";
import { truncateToolResultContent } from "./truncate.ts";

export { extractSessionFacts, buildCompactionInstructions } from "./facts.ts";
export { loadConfig, saveConfig, checkNativeSafetyNet, applyNativeSafetyNet } from "./config.ts";
export { handleSafeCompaction } from "./safe-compaction.ts";

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

  // 1. 任意来源的压缩开始时刷新状态并进行安全防溢出拦截（剥离 thinking、预算截断、异常自愈兜底）
  pi.on("session_before_compact", async (event, ctx) => {
    state.isCompacting = true;
    state.requestRenderFn?.();

    if (state.config.safeCompaction !== false) {
      return await handleSafeCompaction(event, ctx, state);
    }
  });

  // 2. 工具结果入上下文前的预防性截断：超大输出首尾保留，避免单次工具调用
  //    直接把用量冲过熔断线（从源头降低紧急熔断发生概率）
  pi.on("tool_result", (event) => {
    const maxChars = state.config.maxToolResultChars ?? 0;
    const truncated = truncateToolResultContent(event.content, maxChars);
    if (truncated === null) return;
    recordStats(pi, state.stats, { truncations: state.stats.truncations + 1 });
    return { content: truncated as unknown as typeof event.content };
  });

  // 3. 压缩落地后守护检查：防止模型总结丢失重要文件或目标
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

  // 4. 会话启动：默认加载全局配置，恢复会话级设置与持久化统计，再处理安全网
  pi.on("session_start", (_event, ctx) => {
    // 默认加载最新全局配置
    const globalConfig = loadConfig();
    state.config = { ...globalConfig };
    state.isLocalThreshold = false;

    // 检查当前会话条目：恢复统计与当前会话级阈值覆写（跨 resume 保持生效）
    const entries = ctx.sessionManager?.getEntries?.() || [];
    state.stats = restoreStats(entries);
    const localThreshold = restoreSessionThreshold(entries);
    if (localThreshold !== null) {
      state.config.threshold = localThreshold;
      state.isLocalThreshold = true;
    }

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

  // 5. 常态压缩触发点：Agent 完全沉淀空闲后（agent_settled）
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
    executeCompaction(pi, state, ctx, currentPercent, true, "settled");
  });

  // 6. 强制压缩触发点：多轮工具调用中途（turn_end）达到阈值即强制压缩并自动续跑
  pi.on("turn_end", (event, ctx) => {
    if (state.isCompacting) return;
    if (!hasToolCall(event.message)) return;

    const currentPercent = contextPercent(ctx);
    if (currentPercent === null) return;

    // 达到设定的阈值即强制压缩并自动续跑；>= 92% 自动提升为紧急熔断保全
    if (currentPercent >= state.config.threshold) {
      if (state.lastCheckedPercent !== null && currentPercent <= state.lastCheckedPercent) return;
      state.lastCheckedPercent = currentPercent;

      const isEmergency = currentPercent >= EMERGENCY_THRESHOLD;
      executeCompaction(pi, state, ctx, currentPercent, true, isEmergency ? "emergency" : "settled");
    }
  });

  // 7. 注册 /auto-compact 命令
  pi.registerCommand("auto-compact", {
    description: "查看或配置自动压缩 (用法: /auto-compact [数值|global 数值|setup|footer|progress|status])",
    handler: (args, ctx) => handleAutoCompactCommand(state, args, ctx, pi),
  });
}