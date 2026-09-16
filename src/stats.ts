import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 压缩事件统计（持久化进会话文件，跨 resume 保留） */
export interface CompactionStats {
  /** 自动压缩成功次数 */
  compactions: number;
  /** 预防性截断的工具结果数（不含免截断的快速路径） */
  truncations: number;
  /** 紧急熔断次数 */
  emergencies: number;
  /** 最近一次压缩时间（ISO 8601） */
  lastCompactionAt?: string;
}

export const STATS_CUSTOM_TYPE = "auto-compact/stats";

export function emptyStats(): CompactionStats {
  return { compactions: 0, truncations: 0, emergencies: 0 };
}

/**
 * 从会话条目中恢复统计（session_start/resume 时调用）。
 * 取最后一条 stats 条目；无则返回零值。
 */
export function restoreStats(entries: { type: string; customType?: string; data?: unknown }[]): CompactionStats {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === STATS_CUSTOM_TYPE) {
      const d = (entry.data ?? {}) as Partial<CompactionStats>;
      return {
        compactions: typeof d.compactions === "number" ? d.compactions : 0,
        truncations: typeof d.truncations === "number" ? d.truncations : 0,
        emergencies: typeof d.emergencies === "number" ? d.emergencies : 0,
        lastCompactionAt: typeof d.lastCompactionAt === "string" ? d.lastCompactionAt : undefined,
      };
    }
  }
  return emptyStats();
}

/**
 * 更新并持久化统计。appendEntry 失败不抛出：统计是尽力而为的旁路数据，
 * 不允许影响压缩主流程。
 */
export function recordStats(
  pi: Pick<ExtensionAPI, "appendEntry">,
  stats: CompactionStats,
  patch: Partial<Omit<CompactionStats, "lastCompactionAt">>,
  opts?: { markCompactionTime?: boolean }
): void {
  const next: CompactionStats = {
    ...stats,
    ...patch,
    ...(opts?.markCompactionTime ? { lastCompactionAt: new Date().toISOString() } : {}),
  };
  // 就地更新调用方持有的引用，调用方无需再取返回值
  Object.assign(stats, next);
  try {
    pi.appendEntry(STATS_CUSTOM_TYPE, { ...next });
  } catch {
    // 忽略持久化失败（如非持久会话），统计降级为进程内数据
  }
}

/**
 * 渲染人类可读的统计行（/auto-compact status 用）。
 */
export function formatStats(stats: CompactionStats): string {
  const parts = [
    `- 本次会话自动压缩: ${stats.compactions} 次`,
    `- 工具结果预防性截断: ${stats.truncations} 次`,
    `- 紧急熔断: ${stats.emergencies} 次`,
  ];
  if (stats.lastCompactionAt) {
    parts.push(`- 最近一次压缩: ${stats.lastCompactionAt}`);
  }
  return parts.join("\n");
}
