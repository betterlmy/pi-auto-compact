import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyNativeSafetyNet,
  checkNativeSafetyNet,
  EMERGENCY_THRESHOLD,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  saveConfig,
} from "./config.ts";
import { formatStats } from "./stats.ts";
import { updateStatusDisplay } from "./status.ts";
import type { ExtensionState } from "./state.ts";

function isThresholdInRange(value: number): boolean {
  return !Number.isNaN(value) && value >= MIN_THRESHOLD && value <= MAX_THRESHOLD;
}

function applyThreshold(state: ExtensionState, value: number): void {
  state.config.threshold = value;
  saveConfig(state.config);
  state.lastCheckedPercent = null;
}

/** /auto-compact 命令：查看状态、切换 Footer、配置阈值或原生安全网。 */
export async function handleAutoCompactCommand(
  state: ExtensionState,
  args: string,
  ctx: ExtensionContext
): Promise<void> {
  const trimmed = (args ?? "").trim();

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
        state.config.autoManageSettings = true;
        saveConfig(state.config);
        ctx.ui.notify("已优化原生安全网配置并开启自动守护，重启或 /reload 后生效。", "info");
      } else {
        ctx.ui.notify("写入 settings.json 失败（文件格式损坏或权限不足），未做任何修改。", "error");
      }
    }
    return;
  }

  // 子命令：/auto-compact footer
  if (trimmed === "footer") {
    state.config.customFooter = !state.config.customFooter;
    saveConfig(state.config);
    if (state.config.customFooter) {
      ctx.ui.setStatus("auto-compact", undefined); // 清理 setStatus
    } else {
      ctx.ui.setFooter(undefined); // 恢复原生 footer
      state.footerRegistered = false;
    }
    updateStatusDisplay(state, ctx);
    ctx.ui.notify(
      state.config.customFooter
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
    const truncateLimit = state.config.maxToolResultChars ?? 0;
    ctx.ui.notify(
      `[Auto Compact 状态]\n- 当前阈值: ${state.config.threshold}%\n- 紧急熔断线: ${EMERGENCY_THRESHOLD}%\n- 当前上下文用量: ${cur}\n- 工具结果截断上限: ${truncateLimit > 0 ? `${truncateLimit} 字符` : "禁用"}\n- 内联 Footer: ${state.config.customFooter ? "开启" : "关闭"}\n- 自动守护设置: ${state.config.autoManageSettings ? "开启" : "关闭"}\n\n【会话统计】\n${formatStats(state.stats)}`,
      "info"
    );
    return;
  }

  // 带数值设置：/auto-compact 80
  if (trimmed) {
    const num = Number.parseInt(trimmed, 10);
    if (!isThresholdInRange(num)) {
      if (ctx.hasUI) {
        ctx.ui.notify(`阈值必须是 ${MIN_THRESHOLD} 到 ${MAX_THRESHOLD} 之间的整数百分比`, "error");
      }
      return;
    }
    applyThreshold(state, num);
    updateStatusDisplay(state, ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(`自动压缩阈值已设置为 ${num}%`, "info");
    }
    return;
  }

  // 无参数交互模式
  if (!ctx.hasUI) return;
  const input = await ctx.ui.input(
    `当前自动压缩阈值: ${state.config.threshold}%`,
    `输入新的百分比 (${MIN_THRESHOLD}-${MAX_THRESHOLD})`
  );

  if (input === undefined) return;
  const val = Number.parseInt(input.trim(), 10);
  if (!isThresholdInRange(val)) {
    ctx.ui.notify(`阈值必须是 ${MIN_THRESHOLD} 到 ${MAX_THRESHOLD} 之间的整数百分比`, "error");
    return;
  }

  applyThreshold(state, val);
  updateStatusDisplay(state, ctx);
  ctx.ui.notify(`自动压缩阈值已设置为 ${val}%`, "info");
}