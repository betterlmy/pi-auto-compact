import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { extractSessionFacts, buildCompactionInstructions } = jiti("../src/facts.ts");

describe("facts.ts: 确定性事实提取器", () => {
  it("应准确提取 write / edit 修改的文件，剔除 read 重复项，并提取 bash 命令与目标", () => {
    const mockEntries = [
      {
        type: "message",
        message: {
          role: "user",
          content: "/goal 研发自动压缩插件并发布",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "检查文件..." },
            { type: "toolCall", name: "read", arguments: { path: "package.json" } },
            { type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
            { type: "toolCall", name: "edit", arguments: { path: "src/index.ts" } },
            { type: "toolCall", name: "write", arguments: { file_path: "src/new-feature.ts" } },
            { type: "toolCall", name: "bash", arguments: { command: "pnpm test" } },
          ],
        },
      },
    ];

    const sessionManager = {
      getEntries: () => mockEntries,
    };

    const facts = extractSessionFacts(sessionManager);

    assert.equal(facts.goalText, "研发自动压缩插件并发布");
    assert.deepEqual(facts.modifiedFiles, ["src/index.ts", "src/new-feature.ts"]);
    assert.deepEqual(facts.readFiles, ["package.json"], "src/index.ts 已被修改，不应出现在 readFiles 中");
    assert.deepEqual(facts.recentCommands, ["pnpm test"]);

    const prompt = buildCompactionInstructions(facts);
    assert.ok(prompt.includes("【确定性事实底座"));
    assert.ok(prompt.includes("src/index.ts"));
    assert.ok(prompt.includes("src/new-feature.ts"));
    assert.ok(prompt.includes("`pnpm test`"));
    assert.ok(prompt.includes("研发自动压缩插件并发布"));
  });

  it("当会话没有工具调用时，应优雅返回空列表", () => {
    const facts = extractSessionFacts({ getEntries: () => [] });
    assert.deepEqual(facts.modifiedFiles, []);
    assert.deepEqual(facts.readFiles, []);
    assert.deepEqual(facts.recentCommands, []);
    assert.equal(facts.goalText, undefined);

    const prompt = buildCompactionInstructions(facts);
    assert.ok(!prompt.includes("【确定性事实底座"), "无事实时不应添加事实块");
  });
});
