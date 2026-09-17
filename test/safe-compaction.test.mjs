import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  sanitizeAndFormatMessage,
  serializeMessagesWithBudget,
  buildDeterministicFallbackSummary,
  formatFileOperationsXml,
  handleSafeCompaction,
} = jiti("../src/safe-compaction.ts");

describe("safe-compaction.ts: 安全压缩与防溢出守护", () => {
  it("sanitizeAndFormatMessage 彻底过滤 assistant thinking 块，保留文本和工具调用", () => {
    const assistantMsg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "这是长达十万字符的机密思考过程..." },
        { type: "text", text: "已为您创建文件 index.ts。" },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "src/index.ts", content: "export default {}" },
        },
      ],
    };

    const formatted = sanitizeAndFormatMessage(assistantMsg);
    assert.ok(formatted);
    assert.ok(!formatted.includes("机密思考过程"), "绝不能包含 thinking 内容");
    assert.ok(formatted.includes("[Assistant]: 已为您创建文件 index.ts。"));
    assert.ok(formatted.includes("[Assistant tool calls]: write("));
  });

  it("sanitizeAndFormatMessage 对超大 toolResult 实施合理截断", () => {
    const hugeResult = {
      role: "toolResult",
      content: [{ type: "text", text: "A".repeat(10000) }],
    };

    const formatted = sanitizeAndFormatMessage(hugeResult);
    assert.ok(formatted);
    assert.ok(formatted.startsWith("[Tool result]: AAAAA"));
    assert.ok(formatted.includes("chars truncated]"));
    assert.ok(formatted.length < 2000, `格式化长度 ${formatted.length} 必须远小于原 10000 字符`);
  });

  it("sanitizeAndFormatMessage 对超长 toolCall 参数字符串截断", () => {
    const msg = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "edit",
          arguments: { path: "big.ts", patch: "Z".repeat(2000) },
        },
      ],
    };

    const formatted = sanitizeAndFormatMessage(msg);
    assert.ok(formatted);
    assert.ok(formatted.includes("edit("));
    assert.ok(formatted.length < 800, "超大参数字符串必须被截断");
  });

  it("serializeMessagesWithBudget 在消息量小时完整保留", () => {
    const messages = [
      { role: "user", content: "请实现登录接口" },
      {
        role: "assistant",
        content: [{ type: "text", text: "正在为您编写 auth.ts" }],
      },
    ];

    const result = serializeMessagesWithBudget(messages, 50000);
    assert.ok(result.includes("[User]: 请实现登录接口"));
    assert.ok(result.includes("[Assistant]: 正在为您编写 auth.ts"));
    assert.ok(!result.includes("省略了中间"));
  });

  it("serializeMessagesWithBudget 在消息量严重超标时实施首尾保留截断", () => {
    const messages = [];
    // 头部：初始任务
    messages.push({ role: "user", content: "初始关键任务：重构数据库层" });
    // 中部：大量无用长历史（50 条）
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `中间轮次 ${i}: ${"X".repeat(500)}` }],
      });
    }
    // 尾部：最新关键状态
    messages.push({ role: "user", content: "当前最新指示：补充单元测试" });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "正在运行测试验证..." }],
    });

    const maxBudget = 2000; // 预算极小
    const result = serializeMessagesWithBudget(messages, maxBudget);

    assert.ok(result.includes("初始关键任务"), "必须保留头部任务背景");
    assert.ok(result.includes("当前最新指示") || result.includes("正在运行测试验证"), "必须保留尾部最新状态");
    assert.ok(result.includes("此处省略了中间"), "必须包含省略中间历史标记");
    assert.ok(result.length <= maxBudget + 200, `总长度 ${result.length} 必须受控在预算附近`);
  });

  it("buildDeterministicFallbackSummary 能正确生成结构化快照", () => {
    const facts = {
      goalText: "修复压缩死锁 bug",
      modifiedFiles: ["src/index.ts", "src/safe-compaction.ts"],
      recentCommands: ["npm test", "npm run typecheck"],
    };

    const summary = buildDeterministicFallbackSummary(facts, "上一轮摘要检查点");
    assert.ok(summary.includes("上一轮摘要检查点"));
    assert.ok(summary.includes("## Goal\n修复压缩死锁 bug"));
    assert.ok(summary.includes("src/safe-compaction.ts"));
    assert.ok(summary.includes("`npm test`"));
  });

  it("formatFileOperationsXml 输出标准 XML 标签", () => {
    const xml = formatFileOperationsXml(["read1.ts", "read2.ts"], ["mod1.ts"]);
    assert.ok(xml.includes("<read-files>\nread1.ts\nread2.ts\n</read-files>"));
    assert.ok(xml.includes("<modified-files>\nmod1.ts\n</modified-files>"));
  });

  it("handleSafeCompaction 成功调用模型完成安全压缩", async () => {
    let completedModel = null;
    let completedPrompt = "";

    const mockCtx = {
      model: { id: "claude-3-5-sonnet", contextWindow: 204800, maxTokens: 8192 },
      modelRegistry: {
        complete: async (model, context) => {
          completedModel = model;
          completedPrompt = context.messages[0].content[0].text;
          return {
            content: [{ type: "text", text: "## Goal\n用户要求优化性能\n\n## Progress\n### Done\n- [x] 优化完成" }],
            usage: { totalTokens: 120, input: 100, output: 20 },
          };
        },
      },
      sessionManager: {
        getEntries: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  name: "write",
                  arguments: { path: "src/perf.ts" },
                },
              ],
            },
          },
        ],
      },
      hasUI: false,
    };

    const mockState = {
      config: { safeCompaction: true },
    };

    const event = {
      preparation: {
        firstKeptEntryId: "entry-12345",
        messagesToSummarize: [
          {
            role: "user",
            content: "请帮我优化代码性能",
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "思考了 50000 字..." },
              { type: "text", text: "好的，我已经定位了瓶颈。" },
            ],
          },
        ],
        fileOps: {
          read: new Set(["src/utils.ts"]),
          written: new Set(["src/perf.ts"]),
        },
        tokensBefore: 150000,
      },
    };

    const result = await handleSafeCompaction(event, mockCtx, mockState);
    assert.ok(result && result.compaction);
    assert.equal(result.compaction.firstKeptEntryId, "entry-12345");
    assert.equal(result.compaction.tokensBefore, 150000);
    assert.ok(result.compaction.summary.includes("## Goal\n用户要求优化性能"));
    assert.ok(result.compaction.summary.includes("<modified-files>\nsrc/perf.ts\n</modified-files>"));
    assert.ok(result.compaction.details.modifiedFiles.includes("src/perf.ts"));
    assert.equal(completedModel.id, "claude-3-5-sonnet");
    assert.ok(!completedPrompt.includes("思考了 50000 字"), "发给模型的 Prompt 绝不包含 thinking");
  });

  it("handleSafeCompaction 在模型抛错（如 400 ContextWindowExceeded）时自动切换确定性快照兜底自愈", async () => {
    const notifications = [];
    const mockCtx = {
      model: { id: "claude-3-5-sonnet", contextWindow: 204800 },
      modelRegistry: {
        complete: async () => {
          throw new Error("400: ContextWindowExceededError - The input is longer than context length");
        },
      },
      sessionManager: {
        getEntries: () => [
          {
            type: "message",
            message: {
              role: "user",
              content: "/goal 彻底修复生产死锁",
            },
          },
        ],
      },
      hasUI: true,
      ui: {
        notify: (msg, type) => notifications.push({ msg, type }),
      },
    };

    const mockState = {
      config: { safeCompaction: true },
    };

    const event = {
      preparation: {
        firstKeptEntryId: "entry-emergency-999",
        messagesToSummarize: [{ role: "user", content: "紧急任务" }],
        tokensBefore: 215000,
      },
    };

    const result = await handleSafeCompaction(event, mockCtx, mockState);
    // 不得向外抛错，必须安全返回 compaction，使 firstKeptEntryId 落地并释放空间
    assert.ok(result && result.compaction);
    assert.equal(result.compaction.firstKeptEntryId, "entry-emergency-999");
    assert.ok(result.compaction.summary.includes("彻底修复生产死锁"));
    assert.ok(result.compaction.summary.includes("上下文自愈压缩"));
    assert.ok(notifications.some((n) => n.msg.includes("已自动切换确定性事实快照兜底自愈")));
  });

  it("handleSafeCompaction 在 signal 已取消时返回 cancel: true", async () => {
    const mockCtx = {
      model: { id: "claude-3-5-sonnet", contextWindow: 204800 },
      modelRegistry: {},
      sessionManager: { getEntries: () => [] },
      hasUI: false,
    };

    const mockState = { config: { safeCompaction: true } };
    const abortController = new AbortController();
    abortController.abort();

    const event = {
      preparation: {
        firstKeptEntryId: "entry-1",
        messagesToSummarize: [],
      },
      signal: abortController.signal,
    };

    const result = await handleSafeCompaction(event, mockCtx, mockState);
    assert.deepEqual(result, { cancel: true });
  });

  it("handleSafeCompaction 在 safeCompaction = false 时返回 undefined 放行原生", async () => {
    const mockCtx = {};
    const mockState = { config: { safeCompaction: false } };
    const event = { preparation: { firstKeptEntryId: "entry-1" } };

    const result = await handleSafeCompaction(event, mockCtx, mockState);
    assert.equal(result, undefined);
  });
});
