import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AutoCompactConfig } from "./config.ts";

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

    return {
      dispose: () => {
        unsubBranch();
      },
      invalidate() {},
      render(width: number): string[] {
        const config = getConfig();
        const isCompacting = getIsCompacting();

        // 1. 统计累积 Token 和花费
        let input = 0;
        let output = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        let cost = 0;
        let latestPromptTokens = 0;
        let latestCacheRead = 0;

        const entries = ctx.sessionManager?.getEntries?.() || [];
        for (const entry of entries) {
          if (entry.type === "message" && entry.message?.role === "assistant") {
            const u = entry.message.usage;
            if (u) {
              input += u.input || 0;
              output += u.output || 0;
              cacheRead += u.cacheRead || 0;
              cacheWrite += u.cacheWrite || 0;
              if (u.cost?.total) cost += u.cost.total;
              latestPromptTokens = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
              latestCacheRead = u.cacheRead || 0;
            }
          } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
            const u = entry.message.usage;
            if (u) {
              input += u.input || 0;
              output += u.output || 0;
              cacheRead += u.cacheRead || 0;
              cacheWrite += u.cacheWrite || 0;
              if (u.cost?.total) cost += u.cost.total;
            }
          } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
            const u = entry.usage;
            if (u) {
              input += u.input || 0;
              output += u.output || 0;
              cacheRead += u.cacheRead || 0;
              cacheWrite += u.cacheWrite || 0;
              if (u.cost?.total) cost += u.cost.total;
            }
          }
        }

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

        let contextPercentStr: string;
        if (contextPercentValue > 90) {
          contextPercentStr = theme.fg("error", contextPercentDisplay);
        } else if (contextPercentValue > 70) {
          contextPercentStr = theme.fg("warning", contextPercentDisplay);
        } else {
          contextPercentStr = contextPercentDisplay;
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
