import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildCustomFooterComponent, formatTokens, formatCwdForFooter } = jiti("../src/footer.ts");

function assistantEntry(input) {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    },
  };
}

function createFooterHarness(entries) {
  const theme = { fg: (_color, text) => text };
  const tui = { requestRender: () => {} };
  const footerData = {
    onBranchChange: () => () => {},
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map(),
  };
  const ctx = {
    sessionManager: { getEntries: () => entries, getCwd: () => "/tmp", getSessionName: () => undefined },
    getContextUsage: () => ({ percent: 10, contextWindow: 1000 }),
    model: { id: "mock-model" },
  };
  const factory = buildCustomFooterComponent(ctx, () => ({ threshold: 75 }), () => false);
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