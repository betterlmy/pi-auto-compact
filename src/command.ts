import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyNativeSafetyNet,
  checkNativeSafetyNet,
  EMERGENCY_THRESHOLD,
  loadConfig,
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

export type ThresholdScope = "local" | "global";

export interface ParsedThresholdCommand {
  threshold: number;
  scope: ThresholdScope;
}

/**
 * 解析阈值与作用域：
 * - 纯数字（如 "60"）或 "local 60" / "60 local"：默认 local（仅当前会话）
 * - "global 60" 或 "60 global"：global（写入全局配置文件）
 */
export function parseThresholdWithScope(raw: string): ParsedThresholdCommand | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    if (!/^\d+$/.test(parts[0])) return null;
    const num = Number.parseInt(parts[0], 10);
    return isThresholdInRange(num) ? { threshold: num, scope: "local" } : null;
  }
  if (parts.length === 2) {
    let scope: ThresholdScope | null = null;
    let numStr: string | null = null;

    const first = parts[0].toLowerCase();
    const second = parts[1].toLowerCase();

    if (first === "global") {
      scope = "global";
      numStr = parts[1];
    } else if (first === "local") {
      scope = "local";
      numStr = parts[1];
    } else if (second === "global") {
      scope = "global";
      numStr = parts[0];
    } else if (second === "local") {
      scope = "local";
      numStr = parts[0];
    }

    if (!scope || !numStr || !/^\d+$/.test(numStr)) return null;
    const num = Number.parseInt(numStr, 10);
    return isThresholdInRange(num) ? { threshold: num, scope } : null;
  }
  return null;
}

/** 应用新阈值（区分 local 与 global 作用域） */
function applyThresholdWithScope(
  state: ExtensionState,
  parsed: ParsedThresholdCommand,
  pi?: ExtensionAPI
): { success: boolean; persisted: boolean } {
  state.config.threshold = parsed.threshold;
  state.lastCheckedPercent = null;

  if (parsed.scope === "global") {
    state.isLocalThreshold = false;
    try {
      pi?.appendEntry?.("auto-compact/session-config", { threshold: null });
    } catch {
      // 忽略 session entry 追加异常
    }
    const persisted = saveConfig(state.config);
    return { success: true, persisted };
  }

  // local 模式：仅在当前会话生效，持久化到 session entry，绝不污染全局配置文件
  state.isLocalThreshold = true;
  try {
    pi?.appendEntry?.("auto-compact/session-config", { threshold: parsed.threshold });
  } catch {
    // 忽略 session entry 追加异常
  }
  return { success: true, persisted: true };
}

/** /auto-compact 命令：查看状态、切换 Footer、配置阈值或原生安全网。 */
export async function handleAutoCompactCommand(
  state: ExtensionState,
  args: string,
  ctx: ExtensionContext,
  pi?: ExtensionAPI
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
    const globalThreshold = loadConfig().threshold;
    const thresholdDesc = state.isLocalThreshold
      ? `${state.config.threshold}% (仅当前会话 / 全局: ${globalThreshold}%)`
      : `${state.config.threshold}% (跟随全局)`;

    ctx.ui.notify(
      `[Auto Compact 状态]\n- 当前阈值: ${thresholdDesc}\n- 紧急熔断线: ${EMERGENCY_THRESHOLD}%\n- 当前上下文用量: ${cur}\n- 工具结果截断上限: ${truncateLimit > 0 ? `${truncateLimit} 字符` : "禁用"}\n- 安全压缩守护: ${state.config.safeCompaction === false ? "关闭" : "开启"}\n- 内联 Footer: ${state.config.customFooter ? "开启" : "关闭"}\n- 进度渐变配色: ${state.config.progressColor === false ? "关闭" : "开启"}\n- 自动守护设置: ${state.config.autoManageSettings ? "开启" : "关闭"}\n\n【会话统计】\n${formatStats(state.stats)}`,
      "info"
    );
    return;
  }

  // 带数值设置：/auto-compact 80 或 /auto-compact global 80 等
  if (trimmed) {
    const parsed = parseThresholdWithScope(trimmed);
    if (parsed === null) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `阈值格式错误。用法: /auto-compact [数值] (仅当前会话) 或 /auto-compact global [数值] (全局配置，${MIN_THRESHOLD}-${MAX_THRESHOLD})`,
          "error"
        );
      }
      return;
    }

    const { persisted } = applyThresholdWithScope(state, parsed, pi);
    updateStatusDisplay(state, ctx);
    if (ctx.hasUI) {
      if (parsed.scope === "global") {
        ctx.ui.notify(
          persisted
            ? `全局自动压缩阈值已设置为 ${parsed.threshold}%（已保存并全局生效）`
            : `全局自动压缩阈值已设置为 ${parsed.threshold}%，但写入配置文件失败`,
          persisted ? "info" : "warning"
        );
      } else {
        ctx.ui.notify(`自动压缩阈值已设置为 ${parsed.threshold}%（仅当前会话生效）`, "info");
      }
    }
    return;
  }

  // 无参数交互模式
  if (!ctx.hasUI) return;
  const currentScope = state.isLocalThreshold ? "当前会话自定义" : "跟随全局";
  const input = await ctx.ui.input(
    `当前自动压缩阈值: ${state.config.threshold}% (${currentScope})`,
    `输入新的百分比 (${MIN_THRESHOLD}-${MAX_THRESHOLD})，默认仅当前会话生效；输入 global 60 保存为全局`
  );

  if (input === undefined) return;
  const parsed = parseThresholdWithScope(input.trim());
  if (parsed === null) {
    ctx.ui.notify(
      `阈值格式错误。输入纯数字设置当前会话（如 60），加 global 设置全局（如 global 60）`,
      "error"
    );
    return;
  }

  const { persisted } = applyThresholdWithScope(state, parsed, pi);
  updateStatusDisplay(state, ctx);
  if (parsed.scope === "global") {
    ctx.ui.notify(
      persisted
        ? `全局自动压缩阈值已设置为 ${parsed.threshold}%（已保存并全局生效）`
        : `全局自动压缩阈值已设置为 ${parsed.threshold}%，但写入配置文件失败`,
      persisted ? "info" : "warning"
    );
  } else {
    ctx.ui.notify(`自动压缩阈值已设置为 ${parsed.threshold}%（仅当前会话生效）`, "info");
  }
}