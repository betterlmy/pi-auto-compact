import { loadConfig, type AutoCompactConfig } from "./config.ts";
import { emptyStats, type CompactionStats } from "./stats.ts";

/**
 * 扩展运行期的可变状态。
 * 集中到单一对象，避免散落在各闭包中导致的生命周期与重置逻辑分散。
 */
export interface ExtensionState {
  config: AutoCompactConfig;
  /** 是否有压缩正在进行；陈旧值会让所有触发点被守卫永久挡死 */
  isCompacting: boolean;
  /** 上次触发点，或阈值以下的最近水位；null 表示待评估 */
  lastCheckedPercent: number | null;
  /** 自定义 Footer 触发的重绘回调 */
  requestRenderFn?: () => void;
  /** 是否已注册接管式自定义 Footer */
  footerRegistered: boolean;
  /** 会话内压缩/截断统计（appendEntry 持久化，resume 后恢复） */
  stats: CompactionStats;
}

export function createExtensionState(): ExtensionState {
  return {
    config: loadConfig(),
    isCompacting: false,
    lastCheckedPercent: null,
    footerRegistered: false,
    stats: emptyStats(),
  };
}