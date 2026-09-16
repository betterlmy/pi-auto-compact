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

/** 只接受纯十进制整数字符串，拒绝 "80abc" 之类的宽松解析 */
function parseThresholdInput(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const num = Number.parseInt(raw, 10);
  return isThresholdInRange(num) ? num : null;
}

/** 应用新阈值并持久化；返回配置是否成功写入磁盘 */
function applyThreshold(state: ExtensionState, value: number): boolean {
  state.config.threshold = value;
  state.lastCheckedPercent = null;
  return saveConfig(state.config);
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
        if (saveConfig(state.config)) {
          ctx.ui.notify("已优化原生安全网配置并开启自动守护，重启或 /reload 后生效。", "info");
        } else {
          ctx.ui.notify(
            "原生安全网已配置，但自动守护开关写入配置失败，重启后需重新执行 /auto-compact setup。",
            "warning"
          );
        }
      } else {
        ctx.ui.notify("写入 settings.json 失败（文件格式损坏或权限不足），未做任何修改。", "error");
      }
    }
    return;
  }

  // 子命令：/auto-compact footer
  if (trimmed === "footer") {
    state.config.customFooter = !state.config.customFooter;
    const persisted = saveConfig(state.config);
    if (state.config.customFooter) {
      ctx.ui.setStatus("auto-compact", undefined); // 清理 setStatus
    } else {
      ctx.ui.setFooter(undefined); // 恢复原生 footer
      state.footerRegistered = false;
    }
    updateStatusDisplay(state, ctx);
    const base = state.config.customFooter
      ? "已开启接管式内联 Footer 样式 (auto:XX%)。"
      : "已切换为标准非侵入式 Footer 状态行。";
    ctx.ui.notify(
      persisted ? base : `${base}（写入配置失败，重启后将恢复原模式）`,
      persisted ? "info" : "warning"
    );
    return;
  }

  // 子命令：/auto-compact progress
  if (trimmed === "progress") {
    state.config.progressColor = !state.config.progressColor;
    const persisted = saveConfig(state.config);
    updateStatusDisplay(state, ctx);
    if (ctx.hasUI) {
      const base = state.config.progressColor
        ? "已开启进度渐变配色（绿→黄→红，按「用量/阈值」取色）。"
        : "已关闭进度渐变配色，回退三档语义色（>90% 红 / >70% 黄 / 其余蓝）。";
      ctx.ui.notify(
        persisted ? base : `${base}（写入配置失败，重启后将恢复原配色）`,
        persisted ? "info" : "warning"
      );
    }
    return;
  }

  // 子命令：/auto-compact status
  if (trimmed === "status") {
    const usage = ctx.getContextUsage?.();
    const cur = usage?.percent !== null && usage?.percent !== undefined ? `${usage.percent.toFixed(1)}%` : "未知";
    const truncateLimit = state.config.maxToolResultChars ?? 0;
    ctx.ui.notify(
      `[Auto Compact 状态]\n- 当前阈值: ${state.config.threshold}%\n- 紧急熔断线: ${EMERGENCY_THRESHOLD}%\n- 当前上下文用量: ${cur}\n- 工具结果截断上限: ${truncateLimit > 0 ? `${truncateLimit} 字符` : "禁用"}\n- 内联 Footer: ${state.config.customFooter ? "开启" : "关闭"}\n- 进度渐变配色: ${state.config.progressColor === false ? "关闭" : "开启"}\n- 自动守护设置: ${state.config.autoManageSettings ? "开启" : "关闭"}\n\n【会话统计】\n${formatStats(state.stats)}`,
      "info"
    );
    return;
  }

  // 带数值设置：/auto-compact 80
  if (trimmed) {
    const num = parseThresholdInput(trimmed);
    if (num === null) {
      if (ctx.hasUI) {
        ctx.ui.notify(`阈值必须是 ${MIN_THRESHOLD} 到 ${MAX_THRESHOLD} 之间的整数百分比`, "error");
      }
      return;
    }
    const persisted = applyThreshold(state, num);
    updateStatusDisplay(state, ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(
        persisted
          ? `自动压缩阈值已设置为 ${num}%`
          : `阈值已在当前会话生效（${num}%），但写入配置失败，重启后将恢复原阈值`,
        persisted ? "info" : "warning"
      );
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
  const val = parseThresholdInput(input.trim());
  if (val === null) {
    ctx.ui.notify(`阈值必须是 ${MIN_THRESHOLD} 到 ${MAX_THRESHOLD} 之间的整数百分比`, "error");
    return;
  }

  const persisted = applyThreshold(state, val);
  updateStatusDisplay(state, ctx);
  ctx.ui.notify(
    persisted
      ? `自动压缩阈值已设置为 ${val}%`
      : `阈值已在当前会话生效（${val}%），但写入配置失败，重启后将恢复原阈值`,
    persisted ? "info" : "warning"
  );
}