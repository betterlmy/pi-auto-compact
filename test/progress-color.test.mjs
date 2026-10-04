import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { progressRatio, gradientRgb, rgbToAnsi256, colorizeProgress } = jiti("../src/progress-color.ts");

describe("progress-color.ts: 进度渐变配色", () => {
  it("progressRatio 按用量/阈值取比值并钳制到 [0,1]", () => {
    assert.equal(progressRatio(50, 60), 50 / 60);
    assert.equal(progressRatio(60, 60), 1);
    assert.equal(progressRatio(90, 60), 1, "超过阈值钳制为 1");
    assert.equal(progressRatio(0, 60), 0);
    assert.equal(progressRatio(-5, 60), 0, "负值钳制为 0");
    assert.equal(progressRatio(50, 0), 0, "非法阈值按 0 处理");
    assert.equal(progressRatio(Number.NaN, 60), 0);
  });

  it("gradientRgb 端点不变，琥珀延后到约 76% 阈值处", () => {
    const start = gradientRgb(0);
    assert.deepEqual(start, { r: 34, g: 197, b: 94 });
    const amberRatio = (1 - 1 / Math.sqrt(10)) / 0.9;
    assert.deepEqual(gradientRgb(amberRatio), { r: 234, g: 179, b: 8 });
    assert.ok(amberRatio > 0.75 && amberRatio < 0.77);
    const end = gradientRgb(1);
    assert.deepEqual(end, { r: 239, g: 68, b: 68 });
    assert.deepEqual(gradientRgb(0.25), { r: 78, g: 193, b: 75 });
    assert.deepEqual(gradientRgb(0.5), { r: 138, g: 188, b: 49 });
    assert.deepEqual(gradientRgb(0.75), { r: 229, g: 179, b: 10 });
    assert.deepEqual(gradientRgb(0.9), { r: 236, g: 130, b: 35 });
  });

  it("gradientRgb 超界值安全钳制", () => {
    assert.deepEqual(gradientRgb(-1), { r: 34, g: 197, b: 94 });
    assert.deepEqual(gradientRgb(2), { r: 239, g: 68, b: 68 });
    for (const invalid of [Number.NaN, Infinity, -Infinity]) {
      assert.deepEqual(gradientRgb(invalid), { r: 34, g: 197, b: 94 });
    }
  });

  it("前段保持偏绿，后段向红色加速且阈值处连续", () => {
    const low = gradientRgb(0.25);
    assert.ok(low.r < 134 && low.g > 188, "比原线性四分之一处更偏绿");
    const half = gradientRgb(0.5);
    assert.ok(half.g > 179, "半程尚未到琥珀端点");
    const lateDrop = gradientRgb(0.8).g - gradientRgb(0.9).g;
    const earlyDrop = gradientRgb(0.1).g - gradientRgb(0.2).g;
    assert.ok(lateDrop > earlyDrop, "临近阈值变色更快");
    assert.deepEqual(gradientRgb(1 - 1e-10), gradientRgb(1));
  });

  it("rgbToAnsi256 灰阶与彩色量化", () => {
    assert.equal(rgbToAnsi256({ r: 0, g: 0, b: 0 }), 16);
    assert.equal(rgbToAnsi256({ r: 255, g: 255, b: 255 }), 231);
    // 灰阶 128 → round((128-8)/247*24)+232 = 244
    assert.equal(rgbToAnsi256({ r: 128, g: 128, b: 128 }), 244);
    // (239,68,68) 量化到 16+36*5+6*1+1 = 203 (#ff5f5f，比 #ff0000 更近)
    assert.equal(rgbToAnsi256({ r: 239, g: 68, b: 68 }), 203);
  });

  it("colorizeProgress 输出可嵌套的 ANSI 转义", () => {
    const tc = colorizeProgress("50.0%/1.0M", 50 / 60, true);
    assert.match(tc, /^\x1b\[38;2;(\d+);(\d+);(\d+)m50\.0%\/1\.0M\x1b\[39m$/);
    const c256 = colorizeProgress("x", 0, false);
    assert.match(c256, /^\x1b\[38;5;\d+mx\x1b\[39m$/);
  });

  it("渐变单调性：比值越大红色分量越增、绿色分量越降（各段内）", () => {
    let prev = gradientRgb(0);
    for (let i = 1; i <= 10; i++) {
      const cur = gradientRgb(i / 10);
      assert.ok(cur.r >= prev.r, `r 应单调不减 @${i / 10}`);
      assert.ok(cur.g <= prev.g, `g 应单调不增 @${i / 10}`);
      prev = cur;
    }
  });
});
