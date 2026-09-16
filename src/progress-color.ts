/**
 * 上下文用量进度渐变配色：以「当前用量 / 阈值」的比值取色，
 * 0 → 绿色起步，0.5 → 琥珀，1 → 红色（达到或超过阈值后保持全红）。
 * 纯计算模块，不依赖运行时环境，便于独立测试。
 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 渐变端点：绿 → 琥珀 → 红（分段线性插值） */
const STOPS: Array<{ at: number; rgb: Rgb }> = [
  { at: 0, rgb: { r: 34, g: 197, b: 94 } }, // green
  { at: 0.5, rgb: { r: 234, g: 179, b: 8 } }, // amber
  { at: 1, rgb: { r: 239, g: 68, b: 68 } }, // red
];

/** 用量相对阈值的进度比值，钳制到 [0, 1]；非法输入按 0 处理 */
export function progressRatio(percent: number, threshold: number): number {
  if (!Number.isFinite(percent) || !Number.isFinite(threshold) || threshold <= 0) return 0;
  return Math.min(1, Math.max(0, percent / threshold));
}

/** 按比值在 STOPS 间分段线性插值出 RGB */
export function gradientRgb(ratio: number): Rgb {
  const t = Math.min(1, Math.max(0, ratio));
  for (let i = 1; i < STOPS.length; i++) {
    const prev = STOPS[i - 1]!;
    const next = STOPS[i]!;
    if (t <= next.at) {
      const span = next.at - prev.at;
      const f = span <= 0 ? 0 : (t - prev.at) / span;
      return {
        r: Math.round(prev.rgb.r + (next.rgb.r - prev.rgb.r) * f),
        g: Math.round(prev.rgb.g + (next.rgb.g - prev.rgb.g) * f),
        b: Math.round(prev.rgb.b + (next.rgb.b - prev.rgb.b) * f),
      };
    }
  }
  return STOPS[STOPS.length - 1]!.rgb;
}

/** RGB → xterm 256 色号：灰阶走 232-255，其余量化到 6x6x6 立方体 */
export function rgbToAnsi256({ r, g, b }: Rgb): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const toCube = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
  return 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b);
}

/**
 * 用渐变色包装文本。
 * trueColor 为 true 时输出 24-bit RGB 转义，否则量化为 256 色。
 * 终止符 \x1b[39m 只重置前景色，可安全嵌套进外层样式包装。
 */
export function colorizeProgress(text: string, ratio: number, trueColor: boolean): string {
  const rgb = gradientRgb(ratio);
  if (trueColor) {
    return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[39m`;
  }
  return `\x1b[38;5;${rgbToAnsi256(rgb)}m${text}\x1b[39m`;
}
