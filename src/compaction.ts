import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EMERGENCY_THRESHOLD } from "./config.ts";
import { buildCompactionInstructions, extractSessionFacts, type TriggerScenario } from "./facts.ts";
import { recordStats } from "./stats.ts";
import { updateStatusDisplay } from "./status.ts";
import type { ExtensionState } from "./state.ts";

export type TriggerReason = TriggerScenario;

/**
 * 统一压缩执行器（支持沉淀后静默压缩 与 中途暴涨紧急熔断并续跑）。
 * 负责状态锁的获取与释放，以及压缩完成后的续跑消息投递。
 */
export function executeCompaction(
  pi: ExtensionAPI,
  state: ExtensionState,
  ctx: ExtensionContext,
  currentPercent: number,
  resumeTask: boolean,
  triggerReason: TriggerReason
): void {
  if (state.isCompacting) return;
  state.isCompacting = true;
  const sessionEpoch = state.sessionEpoch;
  updateStatusDisplay(state, ctx);

  if (ctx.hasUI) {
    const prefix = triggerReason === "emergency" ? "【紧急熔断】" : "";
    const targetThreshold = triggerReason === "emergency" ? EMERGENCY_THRESHOLD : state.config.threshold;
    ctx.ui.notify(
      `[Auto Compact] ${prefix}上下文已达 ${currentPercent.toFixed(1)}% (阈值 ${targetThreshold}%)，正在自动压缩...`,
      "info"
    );
  }

  // ctx.compact 同步抛错时不会触发任何生命周期事件，必须在此释放状态锁；
  // 否则 isCompacting 永久为 true，后续所有触发点都会被开头的守卫挡死。
  try {
    const facts = extractSessionFacts(ctx.sessionManager);
    // 触发场景差异化：紧急熔断需额外保全断点信息才能无缝续跑
    const instructions = buildCompactionInstructions(facts, undefined, triggerReason);

    ctx.compact({
      customInstructions: instructions,
      onComplete: () => {
        if (state.sessionEpoch !== sessionEpoch) return;
        state.isCompacting = false;
        state.lastCheckedPercent = null;
        recordStats(pi, state.stats, {
          compactions: state.stats.compactions + 1,
          emergencies: triggerReason === "emergency" ? state.stats.emergencies + 1 : state.stats.emergencies,
        }, { markCompactionTime: true });
        updateStatusDisplay(state, ctx);
        if (ctx.hasUI) {
          ctx.ui.notify("[Auto Compact] 压缩完成。", "info");
        }

        if (resumeTask) {
          // 等待宿主刷新排队输入；已有新任务或自然续跑时不再额外唤醒。
          setImmediate(() => {
            if (state.sessionEpoch !== sessionEpoch || !ctx.isIdle() || ctx.hasPendingMessages()) return;
            try {
              pi.sendMessage(
                {
                  customType: "auto-compact/resume",
                  content: "Context compaction completed. Continue the current task based on the context summary.",
                  display: false,
                },
                { triggerTurn: true, deliverAs: "followUp" }
              );
            } catch (err) {
              if (ctx.hasUI) {
                ctx.ui.notify(`[Auto Compact] 压缩已完成，但续跑消息投递失败：${err instanceof Error ? err.message : String(err)}。请检查后手动继续。`, "warning");
              }
            }
          });
        }
      },
      onError: (err) => {
        if (state.sessionEpoch !== sessionEpoch) return;
        state.isCompacting = false;
        // 保留 lastCheckedPercent 为本次触发点：失败后不在同一水位原地重试，待用量增长后自动放行
        updateStatusDisplay(state, ctx);
        if (err.message.includes("Already compacted") || err.message.includes("Nothing to compact")) {
          return;
        }
        if (ctx.hasUI) {
          ctx.ui.notify(`[Auto Compact] 压缩跳过: ${err.message}`, "warning");
        }
      },
    });
  } catch (err) {
    state.isCompacting = false;
    updateStatusDisplay(state, ctx);
    if (ctx.hasUI) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[Auto Compact] 压缩调用失败: ${message}`, "warning");
    }
  }
}