import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  sanitizeAndFormatMessage,
  serializeMessagesWithBudget,
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
    assert.ok(result.includes("历史中部已省略"), "必须包含省略中间历史标记");
    assert.ok(result.length <= maxBudget, `总长度 ${result.length} 必须严格受控`);
  });

  it("首尾单条超长消息和极小预算都不能突破字符上限", () => {
    const messages = [
      { role: "user", content: "头".repeat(10000) },
      { role: "assistant", content: [{ type: "text", text: "尾".repeat(10000) }] },
    ];
    for (const budget of [0, 1, 10, 100, 2000]) {
      const text = serializeMessagesWithBudget(messages, budget);
      assert.ok(text.length <= budget);
      if (budget >= 100) {
        assert.ok(text.startsWith("[User]:"));
        assert.ok(text.endsWith("尾"));
      }
    }
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
            stopReason: "stop",
            content: [{ type: "text", text: "## Goal\n用户要求优化性能\n\n## Progress\n### Done\n- [x] 优化完成" }],
            usage: { totalTokens: 120, input: 100, output: 20 },
          };
        },
      },
      sessionManager: {
        getBranch: () => [
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

  it("handleSafeCompaction 在模型抛错时取消压缩，不生成快照", async () => {
    const notifications = [];
    const mockCtx = {
      model: { id: "claude-3-5-sonnet", contextWindow: 204800 },
      modelRegistry: {
        complete: async () => {
          throw new Error("400: ContextWindowExceededError - The input is longer than context length");
        },
      },
      sessionManager: {
        getBranch: () => [
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
    assert.deepEqual(result, { cancel: true });
    assert.ok(notifications.some((n) => n.msg.includes("保留原上下文")));
  });

  it("handleSafeCompaction 在 signal 已取消时返回 cancel: true", async () => {
    const mockCtx = {
      model: { id: "claude-3-5-sonnet", contextWindow: 204800 },
      modelRegistry: {},
      sessionManager: { getBranch: () => [] },
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

  it("完整请求预算包含系统提示、旧摘要、附加要求和输出预留", async () => {
    let captured;
    const ctx = {
      model: { contextWindow: 16000, maxTokens: 2048 },
      modelRegistry: { complete: async (_model, context, options) => {
        captured = { context, options };
        return { stopReason: "stop", content: [{ type: "text", text: "完整摘要" }] };
      } },
      sessionManager: { getBranch: () => [] },
      hasUI: false,
    };
    const event = { preparation: {
      firstKeptEntryId: "kept", previousSummary: "旧摘要".repeat(500),
      messagesToSummarize: [{ role: "user", content: "请求".repeat(50000) }],
    }, customInstructions: "附加要求".repeat(200) };
    const result = await handleSafeCompaction(event, ctx, { config: { safeCompaction: true } });
    assert.ok(result.compaction);
    const chars = captured.context.systemPrompt.length + captured.context.messages[0].content[0].text.length;
    assert.ok(Math.ceil(chars / 3) + captured.options.maxTokens <= Math.floor(ctx.model.contextWindow * 0.7));
    assert.ok(captured.context.messages[0].content[0].text.includes(event.preparation.previousSummary));
    assert.ok(captured.context.messages[0].content[0].text.includes(event.customInstructions));
  });

  it("固定提示放不下、小窗口或模型不可用时取消，不调用模型", async () => {
    let calls = 0;
    const ctx = {
      model: { contextWindow: 4096, maxTokens: 4096 },
      modelRegistry: { complete: async () => { calls++; } },
      sessionManager: { getBranch: () => [] }, hasUI: false,
    };
    const event = { preparation: { firstKeptEntryId: "kept", previousSummary: "旧".repeat(100000) } };
    for (const model of [ctx.model, undefined, { contextWindow: NaN }, { contextWindow: 16000, maxTokens: 2048 }]) {
      assert.deepEqual(await handleSafeCompaction(event, { ...ctx, model }, { config: { safeCompaction: true } }), { cancel: true });
    }
    assert.equal(calls, 0);
  });

  it("输出截断、错误、取消、工具调用及空摘要都不能落地", async () => {
    const event = { preparation: { firstKeptEntryId: "kept", messagesToSummarize: [] } };
    for (const stopReason of ["length", "error", "aborted", "toolUse", undefined, "stop"]) {
      const ctx = {
        model: { contextWindow: 100000, maxTokens: 4096 },
        modelRegistry: { complete: async () => ({ stopReason,
          content: [{ type: "text", text: stopReason === "stop" ? "  " : "半份摘要" }] }) },
        sessionManager: { getBranch: () => [] }, hasUI: false,
      };
      assert.deepEqual(await handleSafeCompaction(event, ctx, { config: { safeCompaction: true } }), { cancel: true });
    }
  });

  it("事实读取异常也取消压缩，不能放行原生摘要绕过失败策略", async () => {
    const ctx = { hasUI: false, sessionManager: { getBranch: () => { throw new Error("事实读取失败"); } } };
    assert.deepEqual(await handleSafeCompaction({ preparation: { firstKeptEntryId: "kept" } }, ctx, { config: { safeCompaction: true } }), { cancel: true });
  });

  it("模型请求期间取消或切换会话分支时丢弃旧摘要", async () => {
    for (const change of ["abort", "epoch", "leaf"]) {
      const controller = new AbortController();
      const state = { config: { safeCompaction: true }, sessionEpoch: 0 };
      let leaf = "initial";
      const ctx = {
        model: { contextWindow: 100000, maxTokens: 4096 }, hasUI: false,
        sessionManager: { getBranch: () => [], getSessionId: () => "session", getLeafId: () => leaf },
        modelRegistry: { complete: async () => {
          if (change === "abort") controller.abort();
          if (change === "epoch") state.sessionEpoch++;
          if (change === "leaf") leaf = "another";
          return { stopReason: "stop", content: [{ type: "text", text: "旧摘要" }] };
        } },
      };
      assert.deepEqual(await handleSafeCompaction({ preparation: { firstKeptEntryId: "kept" }, signal: controller.signal }, ctx, state), { cancel: true });
    }
  });

  it("handleSafeCompaction 在 safeCompaction = false 时返回 undefined 放行原生", async () => {
    const mockCtx = {};
    const mockState = { config: { safeCompaction: false } };
    const event = { preparation: { firstKeptEntryId: "entry-1" } };

    const result = await handleSafeCompaction(event, mockCtx, mockState);
    assert.equal(result, undefined);
  });
});
