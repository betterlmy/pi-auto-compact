import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyNativeSafetyNet,
  checkNativeSafetyNet,
  DEFAULT_THRESHOLD,
  EMERGENCY_THRESHOLD,
  loadConfig,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  saveConfig,
  type AutoCompactConfig,
} from "./config.ts";
import { buildCompactionInstructions, extractSessionFacts } from "./facts.ts";
import { buildCustomFooterComponent } from "./footer.ts";

export { extractSessionFacts, buildCompactionInstructions } from "./facts.ts";
export { loadConfig, saveConfig, checkNativeSafetyNet, applyNativeSafetyNet } from "./config.ts";

export default function (pi: ExtensionAPI) {
  let config: AutoCompactConfig = loadConfig();
  let isCompacting = false;
  let lastCheckedPercent: number | null = null;
  let requestRenderFn: (() => void) | undefined;
  let footerRegistered = false;

  const updateStatusDisplay = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    // 模式 A：用户开启了接管式自定义 Footer（内联 14.1%/1.0M (auto:75%) 风格）
    if (config.customFooter) {
      if (!footerRegistered) {
        footerRegistered = true;
        ctx.ui.setFooter((tui, theme, footerData) => {
          requestRenderFn = () => tui.requestRender();
          const factory = buildCustomFooterComponent(
            ctx,
            () => config,
            () => isCompacting
          );
          const comp = factory(tui, theme, footerData);
          return {
            ...comp,
            dispose: () => {
              comp.dispose();
              footerRegistered = false;
              requestRenderFn = undefined;
            },
          };
        });
      } else {
        requestRenderFn?.();
      }
      return;
    }

    // 模式 B：标准非侵入式 setStatus（默认模式，不破坏原生或其他第三方 footer）
    const statusText = isCompacting
      ? ctx.ui.theme
        ? ctx.ui.theme.fg("warning", "compacting...")
        : "compacting..."
      : ctx.ui.theme
        ? `${ctx.ui.theme.fg("dim", "compact:")} ${ctx.ui.theme.fg("accent", `${config.threshold}%`)}`
        : `compact: ${config.threshold}%`;

    ctx.ui.setStatus("auto-compact", statusText);
    requestRenderFn?.();
  };

  // 统一压缩执行器（支持沉淀后静默压缩 与 中途暴涨紧急熔断并续跑）
  const executeCompaction = (
    ctx: ExtensionContext,
    currentPercent: number,
    resumeTask: boolean,
    triggerReason: "settled" | "emergency"
  ) => {
    if (isCompacting) return;
    isCompacting = true;
    updateStatusDisplay(ctx);

    if (ctx.hasUI) {
      const prefix = triggerReason === "emergency" ? "【紧急熔断】" : "";
      const targetThreshold = triggerReason === "emergency" ? EMERGENCY_THRESHOLD : config.threshold;
      ctx.ui.notify(
        `[Auto Compact] ${prefix}上下文已达 ${currentPercent.toFixed(1)}% (阈值 ${targetThreshold}%)，正在自动压缩...`,
        "info"
      );
    }

    const facts = extractSessionFacts(ctx.sessionManager);
    const instructions = buildCompactionInstructions(facts);

    ctx.compact({
      customInstructions: instructions,
      onComplete: () => {
        isCompacting = false;
        lastCheckedPercent = null;
        updateStatusDisplay(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify("[Auto Compact] 压缩完成，已释放上下文空间", "info");
        }

        if (resumeTask) {
          // 中途紧急熔断后，等待空闲并自动发送续跑消息继续未完成的任务循环
          setImmediate(() => {
            if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
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
        isCompacting = false;
        lastCheckedPercent = null; // 失败后重置边沿检测，允许重试
        updateStatusDisplay(ctx);
        if (err.message.includes("Already compacted") || err.message.includes("Nothing to compact")) {
          return;
        }
        if (ctx.hasUI) {
          ctx.ui.notify(`[Auto Compact] 压缩跳过: ${err.message}`, "warning");
        }
      },
    });
  };

  function hasToolCall(message: any): boolean {
    return (
      message?.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((part: any) => part && typeof part === "object" && part.type === "toolCall")
    );
  }

  // 1. 任意来源的压缩开始时刷新状态
  pi.on("session_before_compact", () => {
    isCompacting = true;
    requestRenderFn?.();
  });

  // 2. 压缩落地后守护检查：防止模型总结丢失重要文件或目标
  pi.on("session_compact", (event, ctx) => {
    isCompacting = false;
    lastCheckedPercent = null; // 重置边沿检测
    updateStatusDisplay(ctx);

    if (!ctx || !ctx.sessionManager) return;

    // Context Guard：硬性事实与未完目标守护与挽救（参考 agent-context-guard-pi）
    try {
      const summary = event.compactionEntry?.summary || "";
      const facts = extractSessionFacts(ctx.sessionManager);
      const missingItems: string[] = [];

      // 检查任务目标
      if (facts.goalText) {
        const shortGoal = facts.goalText.slice(0, 15);
        if (!summary.includes(shortGoal) && !summary.toLowerCase().includes(shortGoal.toLowerCase())) {
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

      // 发生遗漏时静默注入底座锚点
      if (missingItems.length > 0) {
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
      }
    } catch (err) {
      console.error("[Auto Compact] Context Guard error:", err);
    }
  });

  pi.on("session_compact_failed", (_event, ctx) => {
    isCompacting = false;
    updateStatusDisplay(ctx);
  });

  // 3. 会话启动
  pi.on("session_start", (_event, ctx) => {
    // 自动或非侵入检测原生安全网
    if (config.autoManageSettings) {
      applyNativeSafetyNet();
    } else {
      const status = checkNativeSafetyNet();
      if (!status.isOptimal && ctx.hasUI) {
        ctx.ui.notify(
          `[Auto Compact] 提示：建议设置原生 reserveTokens=50000 作为 95% 兜底安全网。可执行 /auto-compact setup 自动配置。`,
          "info"
        );
      }
    }

    updateStatusDisplay(ctx);
  });

  // 4. 常态压缩触发点：Agent 完全沉淀空闲后（agent_settled）
  pi.on("agent_settled", (_event, ctx) => {
    if (isCompacting) return;

    const usage = ctx.getContextUsage?.();
    if (!usage || !usage.contextWindow || usage.contextWindow <= 0) return;

    const currentPercent = usage.percent ?? ((usage.tokens ?? 0) / usage.contextWindow) * 100;

    const crossedThreshold =
      lastCheckedPercent !== null &&
      lastCheckedPercent < config.threshold &&
      currentPercent >= config.threshold;

    const shouldTrigger = crossedThreshold || (lastCheckedPercent === null && currentPercent >= config.threshold);
    lastCheckedPercent = currentPercent;

    if (!shouldTrigger) return;

    executeCompaction(ctx, currentPercent, false, "settled");
  });

  // 5. 紧急熔断触发点：多轮工具中途暴涨保护（>= 92%）
  pi.on("turn_end", (event, ctx) => {
    if (isCompacting) return;
    if (!hasToolCall(event.message)) return;

    const usage = ctx.getContextUsage?.();
    if (!usage || !usage.contextWindow || usage.contextWindow <= 0) return;

    const currentPercent = usage.percent ?? ((usage.tokens ?? 0) / usage.contextWindow) * 100;
    if (currentPercent >= EMERGENCY_THRESHOLD) {
      executeCompaction(ctx, currentPercent, true, "emergency");
    }
  });

  // 6. 注册 /auto-compact 命令
  pi.registerCommand("auto-compact", {
    description: "查看或配置自动压缩 (用法: /auto-compact [数值|setup|footer|status])",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // 子命令：/auto-compact setup
      if (trimmed === "setup") {
        if (!ctx.hasUI) return;
        const status = checkNativeSafetyNet();
        if (status.isOptimal) {
          ctx.ui.notify("原生安全网已处于最优状态 (enabled=true, reserveTokens=50000)。", "info");
          return;
        }

        const confirm = await ctx.ui.confirm(
          "配置原生安全网",
          `是否将 settings.json 中的原生压缩配置为 reserveTokens=50000 作为 95% 极端暴涨兜底？\n(当前: enabled=${status.enabled}, reserveTokens=${status.reserveTokens})`
        );

        if (confirm) {
          const ok = applyNativeSafetyNet();
          if (ok) {
            config.autoManageSettings = true;
            saveConfig(config);
            ctx.ui.notify("已优化原生安全网配置并开启自动守护，重启或 /reload 后生效。", "info");
          } else {
            ctx.ui.notify("写入 settings.json 失败，请检查文件权限。", "error");
          }
        }
        return;
      }

      // 子命令：/auto-compact footer
      if (trimmed === "footer") {
        config.customFooter = !config.customFooter;
        saveConfig(config);
        if (config.customFooter) {
          ctx.ui.setStatus("auto-compact", undefined); // 清理 setStatus
        } else {
          ctx.ui.setFooter(undefined); // 恢复原生 footer
          footerRegistered = false;
        }
        updateStatusDisplay(ctx);
        ctx.ui.notify(
          config.customFooter
            ? "已开启接管式内联 Footer 样式 (auto:XX%)。"
            : "已切换为标准非侵入式 Footer 状态行。",
          "info"
        );
        return;
      }

      // 子命令：/auto-compact status
      if (trimmed === "status") {
        const usage = ctx.getContextUsage?.();
        const cur = usage?.percent !== null && usage?.percent !== undefined ? `${usage.percent.toFixed(1)}%` : "未知";
        ctx.ui.notify(
          `[Auto Compact 状态]\n- 当前阈值: ${config.threshold}%\n- 紧急熔断线: ${EMERGENCY_THRESHOLD}%\n- 当前上下文用量: ${cur}\n- 内联 Footer: ${config.customFooter ? "开启" : "关闭"}\n- 自动守护设置: ${config.autoManageSettings ? "开启" : "关闭"}`,
          "info"
        );
        return;
      }

      // 带数值设置：/auto-compact 80
      if (trimmed) {
        const num = Number.parseInt(trimmed, 10);
        if (Number.isNaN(num) || num < MIN_THRESHOLD || num > MAX_THRESHOLD) {
          if (ctx.hasUI) {
            ctx.ui.notify(`阈值必须是 ${MIN_THRESHOLD} 到 ${MAX_THRESHOLD} 之间的整数百分比`, "error");
          }
          return;
        }
        config.threshold = num;
        saveConfig(config);
        lastCheckedPercent = null;
        updateStatusDisplay(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(`自动压缩阈值已设置为 ${num}%`, "info");
        }
        return;
      }

      // 无参数交互模式
      if (!ctx.hasUI) return;
      const input = await ctx.ui.input(
        `当前自动压缩阈值: ${config.threshold}%`,
        `输入新的百分比 (${MIN_THRESHOLD}-${MAX_THRESHOLD})`
      );

      if (input === undefined) return;
      const val = Number.parseInt(input.trim(), 10);
      if (Number.isNaN(val) || val < MIN_THRESHOLD || val > MAX_THRESHOLD) {
        ctx.ui.notify(`阈值必须是 ${MIN_THRESHOLD} 到 ${MAX_THRESHOLD} 之间的整数百分比`, "error");
        return;
      }

      config.threshold = val;
      saveConfig(config);
      lastCheckedPercent = null;
      updateStatusDisplay(ctx);
      ctx.ui.notify(`自动压缩阈值已设置为 ${val}%`, "info");
    },
  });
}
