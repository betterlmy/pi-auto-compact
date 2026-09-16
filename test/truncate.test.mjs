import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { truncateToolResultContent } = jiti("../src/truncate.ts");

describe("truncate.ts: 工具结果预防性截断", () => {
  it("总长度未超限时返回 null（零拷贝路径，不重建数组）", () => {
    const content = [{ type: "text", text: "short output" }];
    assert.equal(truncateToolResultContent(content, 50000), null);
  });

  it("maxChars 为 0 或负数时完全禁用", () => {
    const big = [{ type: "text", text: "x".repeat(100000) }];
    assert.equal(truncateToolResultContent(big, 0), null);
    assert.equal(truncateToolResultContent(big, -1), null);
  });

  it("超限文本块保留首尾并插入省略标记", () => {
    const text = `HEAD${"x".repeat(100000)}TAIL`;
    const result = truncateToolResultContent([{ type: "text", text }], 1000);

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    const out = result[0].text;
    assert.ok(out.startsWith("HEAD"), "必须保留开头");
    assert.ok(out.endsWith("TAIL"), "必须保留结尾");
    assert.ok(out.includes("[...truncated"), "必须包含省略标记");
    assert.ok(out.length <= 1000, `截断后长度 ${out.length} 不得超过上限`);
  });

  it("截断后总长度不超过 maxChars", () => {
    const result = truncateToolResultContent([{ type: "text", text: "y".repeat(999999) }], 50000);
    assert.ok(result[0].text.length <= 50000);
  });

  it("多文本块超限时按块均摊预算", () => {
    const content = [
      { type: "text", text: "a".repeat(60000) },
      { type: "text", text: "b".repeat(60000) },
    ];
    const result = truncateToolResultContent(content, 50000);
    assert.equal(result.length, 2);
    for (const block of result) {
      assert.ok(block.text.length <= 25000, `每块预算 25000，实际 ${block.text.length}`);
      assert.ok(block.text.includes("[...truncated"));
    }
  });

  it("image 等非文本块原样保留不被破坏", () => {
    const imageBlock = { type: "image", data: "base64data", mimeType: "image/png" };
    const content = [imageBlock, { type: "text", text: "z".repeat(99999) }];
    const result = truncateToolResultContent(content, 50000);

    assert.equal(result[0], imageBlock, "image 块必须是同一引用");
    assert.ok(result[1].text.length <= 50000);
  });

  it("非数组或空内容返回 null", () => {
    assert.equal(truncateToolResultContent(null, 50000), null);
    assert.equal(truncateToolResultContent(undefined, 50000), null);
    assert.equal(truncateToolResultContent([], 50000), null);
    assert.equal(truncateToolResultContent("string content", 50000), null);
  });

  it("极小上限（低于标记宽度）时硬截不崩溃", () => {
    const result = truncateToolResultContent([{ type: "text", text: "w".repeat(1000) }], 10);
    assert.equal(result[0].text.length, 10);
    assert.ok(result[0].text.startsWith("w".repeat(10)));
  });
});
