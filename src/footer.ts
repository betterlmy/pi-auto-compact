import { getCapabilities, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AutoCompactConfig } from "./config.ts";
import { colorizeProgress, progressRatio } from "./progress-color.ts";

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home?: string): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function buildCustomFooterComponent(
  ctx: ExtensionContext,
  getConfig: () => AutoCompactConfig,
  getIsCompacting: () => boolean
) {
  return (tui: any, theme: any, footerData: any) => {
    const unsubBranch = footerData?.onBranchChange?.(() => tui.requestRender()) || (() => {});

    // 增量缓存：render 每帧都会调用，长会话下必须避免重复遍历全部 entries
    const usage = {
      count: 0,
      lastEntry: undefined as unknown,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      latestPromptTokens: 0,
      latestCacheRead: 0,
    };

    const addUsage = (u: any, trackLatest: boolean) => {
      if (!u) return;
      usage.input += u.input || 0;
      usage.output += u.output || 0;
      usage.cacheRead += u.cacheRead || 0;
      usage.cacheWrite += u.cacheWrite || 0;
      if (u.cost?.total) usage.cost += u.cost.total;
      if (trackLatest) {
        usage.latestPromptTokens = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
        usage.latestCacheRead = u.cacheRead || 0;
      }
    };

    return {
      dispose: () => {
        unsubBranch();
      },
      invalidate() {},
      render(width: number): string[] {
        const config = getConfig();
        const isCompacting = getIsCompacting();

        // 1. 统计累积 Token 和花费（仅在 entries 追加时增量累加；
        //    长度回退或末条变化（分支切换）时全量重算）
        const entries = ctx.sessionManager?.getEntries?.() || [];
        const canAppend =
          usage.count > 0 && entries.length >= usage.count && entries[usage.count - 1] === usage.lastEntry;
        if (!canAppend) {
          usage.input = 0;
          usage.output = 0;
          usage.cacheRead = 0;
          usage.cacheWrite = 0;
          usage.cost = 0;
          usage.latestPromptTokens = 0;
          usage.latestCacheRead = 0;
          usage.count = 0;
        }
        for (let i = usage.count; i < entries.length; i++) {
          const entry = entries[i];
          if (entry.type === "message" && entry.message?.role === "assistant") {
            addUsage(entry.message.usage, true);
          } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
            addUsage(entry.message.usage, false);
          } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
            addUsage(entry.usage, false);
          }
        }
        usage.count = entries.length;
        usage.lastEntry = entries.length > 0 ? entries[entries.length - 1] : undefined;

        const { input, output, cacheRead, cacheWrite, cost, latestPromptTokens, latestCacheRead } = usage;

        // 2. 第一行：路径、Git 分支、Session 名字
        let pwd = formatCwdForFooter(
          ctx.sessionManager?.getCwd?.() || process.cwd(),
          process.env.HOME || process.env.USERPROFILE
        );
        const branch = footerData?.getGitBranch?.();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = ctx.sessionManager?.getSessionName?.();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;
        const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

        // 3. 第二行左侧：Stats 与包含 (auto:XX%) 的上下文用量
        const statsParts: string[] = [];
        if (input) statsParts.push(`↑${formatTokens(input)}`);
        if (output) statsParts.push(`↓${formatTokens(output)}`);
        if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`);
        if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`);
        if ((cacheRead > 0 || cacheWrite > 0) && latestPromptTokens > 0) {
          const hitRate = (latestCacheRead / latestPromptTokens) * 100;
          statsParts.push(`CH${hitRate.toFixed(1)}%`);
        }
        if (cost > 0) {
          statsParts.push(`$${cost.toFixed(3)}`);
        }

        const contextUsage = ctx.getContextUsage?.();
        const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent =
          contextUsage?.percent !== null && contextUsage?.percent !== undefined
            ? contextPercentValue.toFixed(1)
            : "?";

        // 内联显示：压缩中显示 (auto:compacting...)，平时显示 (auto:XX%)
        const autoIndicator = isCompacting ? " (auto:compacting...)" : ` (auto:${config.threshold}%)`;
        const contextPercentDisplay =
          contextPercent === "?"
            ? `?/${formatTokens(contextWindow)}${autoIndicator}`
            : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

        // 渐变进度色（可配置关闭）：以「用量/阈值」比值在绿→琥珀→红间取色；
        // 关闭时回退三档语义色（与 pi 原生 footer 的 90/70 分界一致，低用量补 mdLink 蓝）。
        // contextPercentDisplay 是 statsLeft 的最后一段，彩色重置码不会破坏外层 dim 包装。
        let contextPercentStr: string;
        if (config.progressColor !== false) {
          const ratio = progressRatio(contextPercentValue, config.threshold);
          const trueColor = getCapabilities().trueColor;
          contextPercentStr = colorizeProgress(contextPercentDisplay, ratio, trueColor);
        } else if (contextPercentValue > 90) {
          contextPercentStr = theme.fg("error", contextPercentDisplay);
        } else if (contextPercentValue > 70) {
          contextPercentStr = theme.fg("warning", contextPercentDisplay);
        } else {
          contextPercentStr = theme.fg("mdLink", contextPercentDisplay);
        }
        statsParts.push(contextPercentStr);

        let statsLeft = statsParts.join(" ");
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }

        // 4. 第二行右侧：模型与 Thinking 等级
        const modelName = ctx.model?.id || "no-model";
        let rightSideWithoutProvider = modelName;
        if (ctx.model?.reasoning) {
          const thinkingLevel = ctx.thinkingLevel || "off";
          rightSideWithoutProvider =
            thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
        }
        let rightSide = rightSideWithoutProvider;
        if (footerData?.getAvailableProviderCount?.() > 1 && ctx.model) {
          rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
        }

        const minPadding = 2;
        if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
          rightSide = rightSideWithoutProvider;
        }
        const rightSideWidth = visibleWidth(rightSide);
        const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
        let statsLine: string;
        if (totalNeeded <= width) {
          const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
          statsLine = statsLeft + padding + rightSide;
        } else {
          const availableForRight = width - statsLeftWidth - minPadding;
          if (availableForRight > 0) {
            const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
            const truncatedRightWidth = visibleWidth(truncatedRight);
            const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
            statsLine = statsLeft + padding + truncatedRight;
          } else {
            statsLine = statsLeft;
          }
        }

        const dimStatsLeft = theme.fg("dim", statsLeft);
        const remainder = statsLine.slice(statsLeft.length);
        const dimRemainder = theme.fg("dim", remainder);
        const lines = [pwdLine, dimStatsLeft + dimRemainder];

        // 5. 第三行：其他插件的 status
        const extensionStatuses = footerData?.getExtensionStatuses?.();
        if (extensionStatuses && extensionStatuses.size > 0) {
          const otherStatuses: string[] = [];
          for (const [key, text] of extensionStatuses.entries()) {
            if (key !== "auto-compact" && text) {
              otherStatuses.push(text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
            }
          }
          if (otherStatuses.length > 0) {
            const statusLine = otherStatuses.sort().join(" ");
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }
        }

        return lines;
      },
    };
  };
}
