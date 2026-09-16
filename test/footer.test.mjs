import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildCustomFooterComponent, formatTokens, formatCwdForFooter } = jiti("../src/footer.ts");

// CI 终端无真彩能力，getCapabilities().trueColor 会返回 false 导致降级到 256 色。
// 用 pi-tui 官方覆盖变量钉住能力，使渐变断言确定性命中 24-bit 路径；
// getCapabilities 在首次调用时读取该变量并缓存，早于任何 render() 执行即可。
process.env.PI_TRUE_COLOR = "1";

function assistantEntry(input) {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    },
  };
}

function createFooterHarness(entries, { percent = 10, isCompacting = false, threshold = 75, progressColor } = {}) {
  const theme = { fg: (color, text) => `[${color}]${text}` };
  const tui = { requestRender: () => {} };
  const footerData = {
    onBranchChange: () => () => {},
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map(),
  };
  const ctx = {
    sessionManager: { getEntries: () => entries, getCwd: () => "/tmp", getSessionName: () => undefined },
    getContextUsage: () => ({ percent, contextWindow: 1000 }),
    model: { id: "mock-model" },
  };
  const factory = buildCustomFooterComponent(ctx, () => ({ threshold, progressColor }), () => isCompacting);
  return factory(tui, theme, footerData);
}

describe("footer.ts: 统计聚合与格式化", () => {
  it("render 在 entries 追加时增量累加，分支切换或长度回退后重算，不返回陈旧数据", () => {
    const entries = [assistantEntry(1000)];
    const comp = createFooterHarness(entries);

    assert.ok(comp.render(100).join(" ").includes("↑1.0k"));

    entries.push(assistantEntry(1000));
    assert.ok(comp.render(100).join(" ").includes("↑2.0k"), "追加后应累加");

    // 同一数组、同长度但末条替换（模拟分支切换）必须重算
    entries[1] = assistantEntry(5000);
    const afterSwitch = comp.render(100).join(" ");
    assert.ok(afterSwitch.includes("↑6.0k"), "末条变化后必须全量重算");
    assert.ok(!afterSwitch.includes("↑2.0k"), "不得返回陈旧聚合值");

    // 长度回退也必须重算
    entries.length = 1;
    assert.ok(comp.render(100).join(" ").includes("↑1.0k"), "长度回退后必须全量重算");
  });

  it("progressColor 开启（默认）时按用量/阈值渐变着色", () => {
    // 默认开启：50% 用量、60 阈值 → 渐变色转义（非语义色包装）
    const defaultOn = createFooterHarness([], { percent: 50, threshold: 60 }).render(100).join(" ");
    assert.ok(/50\.0%\/1\.0k \(auto:60%\)/.test(defaultOn), `应包含用量文本：${defaultOn}`);
    assert.ok(defaultOn.includes("\x1b[38;2;"), `默认应输出真彩渐变转义：${defaultOn}`);

    // 接近阈值 → 红端
    const near = createFooterHarness([], { percent: 74, threshold: 75 }).render(100).join(" ");
    assert.ok(near.includes("\x1b[38;2;239;"), `接近阈值应为红端：${near}`);

    // 显式开启同样生效：10/75 ≈ 0.133，落在绿→琥珀段（f≈0.267），插值色 (87,192,71)
    const on = createFooterHarness([], { percent: 10, threshold: 75, progressColor: true }).render(100).join(" ");
    assert.ok(on.includes("\x1b[38;2;87;192;71m"), `低用量应为绿色插值：${on}`);
  });

  it("progressColor 关闭时回退三档语义色：>90 红 / >70 黄 / 低用量蓝", () => {
    // 低用量：整段（百分比+窗口+auto指示）用 mdLink（蓝色）
    const low = createFooterHarness([], { percent: 10, progressColor: false }).render(100).join(" ");
    assert.ok(low.includes("[mdLink]10.0%/1.0k (auto:75%)"), `低用量应为 mdLink：${low}`);

    // 中档：warning
    const mid = createFooterHarness([], { percent: 75, progressColor: false }).render(100).join(" ");
    assert.ok(mid.includes("[warning]75.0%/1.0k (auto:75%)"), `>70 应为 warning：${mid}`);

    // 高档：error
    const high = createFooterHarness([], { percent: 95, progressColor: false }).render(100).join(" ");
    assert.ok(high.includes("[error]95.0%/1.0k (auto:75%)"), `>90 应为 error：${high}`);
  });

  it("formatTokens 与 formatCwdForFooter 基础格式化", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1000), "1.0k");
    assert.equal(formatTokens(15000), "15k");
    assert.equal(formatTokens(1500000), "1.5M");
    assert.equal(formatCwdForFooter("/home/u/proj", "/home/u"), "~/proj");
    assert.equal(formatCwdForFooter("/home/u", "/home/u"), "~");
    assert.equal(formatCwdForFooter("/var/log", "/home/u"), "/var/log");
  });
});