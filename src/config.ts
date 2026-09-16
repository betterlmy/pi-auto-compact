import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-compact.json");
export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

export const DEFAULT_THRESHOLD = 75; // 默认 75%
export const MIN_THRESHOLD = 10;
export const MAX_THRESHOLD = 99;
export const EMERGENCY_THRESHOLD = 92; // 紧急熔断天花板：中途突发暴涨时就地压缩并续跑
export const NATIVE_RESERVE_TOKENS = 50000; // 原生安全网触发线（1M 窗口下约 95%）

export const CUSTOM_INSTRUCTIONS =
  "总结上下文，重点保留关键任务目标、约束、已完成改动及当前进行中的步骤";

export interface AutoCompactConfig {
  threshold: number;
  /**
   * 是否启用接管式自定义 Footer（显示类似 14.1%/1.0M (auto:75%) 的内联效果）
   * 默认 false（使用非侵入式 setStatus，与其他 footer 插件兼容）
   */
  customFooter?: boolean;
  /**
   * 是否自动管理 settings.json 原生压缩参数作为 95% 兜底安全网
   * 默认 false（开源规范：未经用户明确许可不擅自改写主设置文件）
   */
  autoManageSettings?: boolean;
}

export function loadConfig(customConfigPath = CONFIG_PATH): AutoCompactConfig {
  try {
    if (existsSync(customConfigPath)) {
      const content = readFileSync(customConfigPath, "utf-8");
      const parsed = JSON.parse(content);
      const threshold =
        typeof parsed.threshold === "number" &&
        parsed.threshold >= MIN_THRESHOLD &&
        parsed.threshold <= MAX_THRESHOLD
          ? parsed.threshold
          : DEFAULT_THRESHOLD;

      return {
        threshold,
        customFooter: typeof parsed.customFooter === "boolean" ? parsed.customFooter : false,
        autoManageSettings: typeof parsed.autoManageSettings === "boolean" ? parsed.autoManageSettings : false,
      };
    }
  } catch {
    // 忽略读取错误，使用默认值
  }
  return { threshold: DEFAULT_THRESHOLD, customFooter: false, autoManageSettings: false };
}

export function saveConfig(config: AutoCompactConfig, customConfigPath = CONFIG_PATH): void {
  try {
    writeFileSync(customConfigPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (error) {
    console.error("[Auto Compact] Failed to save config:", error);
  }
}

export interface SafetyNetStatus {
  isOptimal: boolean;
  enabled: boolean;
  reserveTokens: number;
  message?: string;
}

/**
 * 只读检测原生 compaction 配置状态，不擅自改写文件（开源友好）
 */
export function checkNativeSafetyNet(customSettingsPath = SETTINGS_PATH): SafetyNetStatus {
  try {
    if (!existsSync(customSettingsPath)) {
      return { isOptimal: true, enabled: true, reserveTokens: 16384 };
    }
    const settings = JSON.parse(readFileSync(customSettingsPath, "utf-8"));
    const compaction = settings.compaction ?? {};
    const enabled = compaction.enabled ?? true;
    const reserveTokens = compaction.reserveTokens ?? 16384;

    // 推荐模式：原生 enabled: true 且 reserveTokens 足够大（如 50000），充当 95% 极限熔断网
    const isOptimal = enabled === true && reserveTokens === NATIVE_RESERVE_TOKENS;

    let message: string | undefined;
    if (!enabled) {
      message = "原生压缩处于关闭状态，单轮极端暴涨时无原生重试兜底。建议启用并设置 reserveTokens 为安全网。";
    } else if (reserveTokens < NATIVE_RESERVE_TOKENS) {
      message = `当前原生 reserveTokens 为 ${reserveTokens}，在大窗口模型下可能早于预期触发抢跑。推荐值：${NATIVE_RESERVE_TOKENS}。`;
    }

    return { isOptimal, enabled, reserveTokens, message };
  } catch {
    return { isOptimal: true, enabled: true, reserveTokens: 16384 };
  }
}

/**
 * 经用户授权或配置明确开启时，写入最佳安全网配置
 */
export function applyNativeSafetyNet(customSettingsPath = SETTINGS_PATH): boolean {
  try {
    if (!existsSync(customSettingsPath)) return false;
    const settings = JSON.parse(readFileSync(customSettingsPath, "utf-8"));
    const compaction = settings.compaction ?? {};
    settings.compaction = { ...compaction, enabled: true, reserveTokens: NATIVE_RESERVE_TOKENS };
    writeFileSync(customSettingsPath, JSON.stringify(settings, null, 2), "utf-8");
    return true;
  } catch (error) {
    console.error("[Auto Compact] Failed to apply native safety net:", error);
    return false;
  }
}
