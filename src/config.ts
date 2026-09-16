import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-compact.json");
export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

export const DEFAULT_THRESHOLD = 75; // 默认 75%
export const MIN_THRESHOLD = 10;
export const MAX_THRESHOLD = 99;
export const EMERGENCY_THRESHOLD = 92; // 紧急熔断天花板：中途突发暴涨时就地压缩并续跑
export const NATIVE_RESERVE_TOKENS = 50000; // 原生安全网触发线（1M 窗口下约 95%）
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 50000; // 工具结果预防性截断默认上限（字符）

export const CUSTOM_INSTRUCTIONS =
  "总结上下文，重点保留关键任务目标、约束、已完成改动及当前进行中的步骤";

/**
 * 紧急熔断场景的附加指令：单次工具调用把上下文冲过熔断线后被拦腰截断，
 * 总结必须额外保全断点信息，续跑回合才能无缝接上。
 */
export const EMERGENCY_INSTRUCTIONS = [
  "【紧急熔断场景附加要求】本次压缩发生在工具执行中途，任务将被强制续跑，除基础事实外必须额外保留：",
  "- 被中断工具调用的名称、参数与已获得的部分结果（若可见），以及本次工具调用的未完成意图；",
  "- 中断前最后一步操作的精确状态：已完成的动作、正在进行的动作、下一步计划；",
  "- 触发本次工具调用的原始用户意图，确保续跑第一回合即可直接恢复执行。",
].join("\n");

export interface AutoCompactConfig {
  threshold: number;
  /**
   * 单个工具结果进入上下文前的字符上限（首尾保留、中部省略）。
   * 0 表示禁用截断；默认 50000。
   */
  maxToolResultChars?: number;
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
  /**
   * 内联 Footer 上下文用量进度渐变配色（绿→黄→红，按「用量/阈值」比值取色）
   * 默认 true；关闭后回退三档语义色（>90% 红 / >70% 黄 / 其余蓝）
   */
  progressColor?: boolean;
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
        progressColor: typeof parsed.progressColor === "boolean" ? parsed.progressColor : true,
        maxToolResultChars:
          typeof parsed.maxToolResultChars === "number" &&
          Number.isFinite(parsed.maxToolResultChars) &&
          parsed.maxToolResultChars >= 0
            ? parsed.maxToolResultChars
            : DEFAULT_MAX_TOOL_RESULT_CHARS,
      };
    }
  } catch {
    // 忽略读取错误，使用默认值
  }
  return {
    threshold: DEFAULT_THRESHOLD,
    customFooter: false,
    autoManageSettings: false,
    progressColor: true,
    maxToolResultChars: DEFAULT_MAX_TOOL_RESULT_CHARS,
  };
}

/**
 * 原子写入 JSON：先写同目录临时文件再 rename，避免进程崩溃留下写了一半的配置文件。
 * 同目录保证与目标文件处于同一文件系统，rename 具备原子性。
 */
function atomicWriteJson(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

export function saveConfig(config: AutoCompactConfig, customConfigPath = CONFIG_PATH): boolean {
  try {
    atomicWriteJson(customConfigPath, config);
    return true;
  } catch (error) {
    console.error("[Auto Compact] Failed to save config:", error);
    return false;
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
  // “未找到”与“无法解析”都不能当作“已最优”，否则会静默掩盖配置缺失或损坏。
  if (!existsSync(customSettingsPath)) {
    return {
      isOptimal: false,
      enabled: false,
      reserveTokens: 16384,
      message: `未找到 ${customSettingsPath}，原生安全网尚未配置。执行 /auto-compact setup 可创建并配置。`,
    };
  }
  try {
    const settings = JSON.parse(readFileSync(customSettingsPath, "utf-8"));
    const compaction = settings.compaction ?? {};
    const enabled = compaction.enabled ?? true;
    const reserveTokens = compaction.reserveTokens ?? 16384;

    // 推荐模式：原生 enabled: true 且 reserveTokens 不低于推荐值，充当 95% 极限熔断网
    const isOptimal = enabled === true && reserveTokens >= NATIVE_RESERVE_TOKENS;

    let message: string | undefined;
    if (!enabled) {
      message = "原生压缩处于关闭状态，单轮极端暴涨时无原生重试兜底。建议启用并设置 reserveTokens 为安全网。";
    } else if (reserveTokens < NATIVE_RESERVE_TOKENS) {
      message = `当前原生 reserveTokens 为 ${reserveTokens}，在大窗口模型下可能早于预期触发抢跑。推荐值：${NATIVE_RESERVE_TOKENS}。`;
    }

    return { isOptimal, enabled, reserveTokens, message };
  } catch {
    return {
      isOptimal: false,
      enabled: false,
      reserveTokens: 16384,
      message: `${customSettingsPath} 无法解析（JSON 格式损坏或权限不足），已跳过检测且不会覆盖该文件。`,
    };
  }
}

/**
 * 经用户授权或配置明确开启时，写入最佳安全网配置
 */
export function applyNativeSafetyNet(customSettingsPath = SETTINGS_PATH): boolean {
  try {
    // 文件不存在时按空配置创建（用户已在命令中确认），存在但损坏时由 JSON.parse 抛错拒绝覆盖
    const settings = existsSync(customSettingsPath)
      ? JSON.parse(readFileSync(customSettingsPath, "utf-8"))
      : {};
    const compaction = settings.compaction ?? {};
    settings.compaction = { ...compaction, enabled: true, reserveTokens: NATIVE_RESERVE_TOKENS };
    mkdirSync(dirname(customSettingsPath), { recursive: true });
    atomicWriteJson(customSettingsPath, settings);
    return true;
  } catch (error) {
    console.error("[Auto Compact] Failed to apply native safety net:", error);
    return false;
  }
}
