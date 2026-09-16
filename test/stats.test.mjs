import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { restoreStats, recordStats, formatStats, emptyStats, STATS_CUSTOM_TYPE } = jiti("../src/stats.ts");

describe("stats.ts: 会话统计持久化", () => {
  it("restoreStats 从条目中取最后一条 stats 条目", () => {
    const entries = [
      { type: "message" },
      { type: "custom", customType: STATS_CUSTOM_TYPE, data: { compactions: 2, truncations: 5, emergencies: 1 } },
      { type: "message" },
      { type: "custom", customType: STATS_CUSTOM_TYPE, data: { compactions: 3, truncations: 7, emergencies: 1 } },
    ];
    const stats = restoreStats(entries);
    assert.equal(stats.compactions, 3);
    assert.equal(stats.truncations, 7);
    assert.equal(stats.emergencies, 1);
  });

  it("restoreStats 容忍缺失或类型错误的字段", () => {
    const stats = restoreStats([{ type: "custom", customType: STATS_CUSTOM_TYPE, data: { compactions: "x" } }]);
    assert.equal(stats.compactions, 0);
    assert.equal(stats.truncations, 0);
    assert.equal(stats.emergencies, 0);

    const noEntry = restoreStats([{ type: "message" }]);
    assert.deepEqual(noEntry, emptyStats());
  });

  it("recordStats 就地更新引用并调用 appendEntry 持久化", () => {
    const appended = [];
    const pi = { appendEntry: (type, data) => appended.push({ type, data }) };
    const stats = emptyStats();

    recordStats(pi, stats, { truncations: 1 });
    assert.equal(stats.truncations, 1, "必须就地更新调用方引用");
    assert.equal(appended.length, 1);
    assert.equal(appended[0].type, STATS_CUSTOM_TYPE);
    assert.equal(appended[0].data.truncations, 1);
  });

  it("recordStats markCompactionTime 写入 ISO 时间戳", () => {
    const stats = emptyStats();
    recordStats({ appendEntry: () => {} }, stats, { compactions: 1 }, { markCompactionTime: true });
    assert.ok(stats.lastCompactionAt);
    assert.ok(!Number.isNaN(Date.parse(stats.lastCompactionAt)));
  });

  it("appendEntry 抛错时静默降级，不影响主流程", () => {
    const pi = { appendEntry: () => { throw new Error("readonly session"); } };
    const stats = emptyStats();
    assert.doesNotThrow(() => recordStats(pi, stats, { compactions: 1 }));
    assert.equal(stats.compactions, 1, "内存统计仍需更新");
  });

  it("formatStats 输出可读统计行", () => {
    const line = formatStats({ compactions: 2, truncations: 3, emergencies: 1 });
    assert.ok(line.includes("自动压缩: 2 次"));
    assert.ok(line.includes("截断: 3 次"));
    assert.ok(line.includes("紧急熔断: 1 次"));
  });
});
