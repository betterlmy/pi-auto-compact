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

  it("gradientRgb 端点与中点符合绿→琥珀→红", () => {
    const start = gradientRgb(0);
    assert.deepEqual(start, { r: 34, g: 197, b: 94 });
    const mid = gradientRgb(0.5);
    assert.deepEqual(mid, { r: 234, g: 179, b: 8 });
    const end = gradientRgb(1);
    assert.deepEqual(end, { r: 239, g: 68, b: 68 });
    // 中点前 0.25 处应为绿与琥珀的中点
    const q = gradientRgb(0.25);
    assert.deepEqual(q, { r: 134, g: 188, b: 51 });
  });

  it("gradientRgb 超界值安全钳制", () => {
    assert.deepEqual(gradientRgb(-1), { r: 34, g: 197, b: 94 });
    assert.deepEqual(gradientRgb(2), { r: 239, g: 68, b: 68 });
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
