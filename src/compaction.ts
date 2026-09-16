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
        state.isCompacting = false;
        state.lastCheckedPercent = null;
        recordStats(pi, state.stats, {
          compactions: state.stats.compactions + 1,
          emergencies: triggerReason === "emergency" ? state.stats.emergencies + 1 : state.stats.emergencies,
        }, { markCompactionTime: true });
        updateStatusDisplay(state, ctx);
        if (ctx.hasUI) {
          ctx.ui.notify("[Auto Compact] 压缩完成，已释放上下文空间", "info");
        }

        if (resumeTask) {
          // 中途紧急熔断后自动发送续跑消息继续未完成的任务循环。
          // 不自行判断空闲：sendMessage 在流式进行时会自动转为 steer 排队，
          // 空闲时触发新回合；自行判空闲返回会静默丢弃续跑消息。
          setImmediate(() => {
            pi.sendMessage(
              {
                customType: "auto-compact/resume",
                content: "Auto-compact emergency compaction completed. Continue the current task.",
                display: false,
              },
              { triggerTurn: true }
            );
          });
        }
      },
      onError: (err) => {
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