import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runContextGuard, extractGoalKeywords } = jiti("../src/guard.ts");

function createMockPi() {
  const sentMessages = [];
  return {
    sendMessage: (msg, opts) => sentMessages.push({ msg, opts }),
    _getSentMessages: () => sentMessages,
  };
}

function createMockCtx(entries = [], options = {}) {
  const notifications = [];
  return {
    hasUI: options.hasUI ?? true,
    sessionManager: {
      getEntries: () => entries,
    },
    ui: {
      theme: { fg: (_color, text) => text },
      notify: (msg, type) => notifications.push({ msg, type }),
    },
    _notifications: notifications,
  };
}

function makeEditEntry(path) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "edit", arguments: { path } }],
    },
  };
}

describe("guard.ts: Context Guard 独立测试", () => {
  describe("extractGoalKeywords", () => {
    it("应从目标文本中提取多个长度 >= 2 的关键词", () => {
      const kws = extractGoalKeywords("Fix Authentication Bug");
      assert.ok(kws.length > 0);
      assert.ok(kws.every((kw) => kw.length >= 2));
    });

    it("应过滤单字符词", () => {
      const kws = extractGoalKeywords("a 修复 b 测试");
      assert.deepEqual(kws, ["修复", "测试"]);
    });

    it("最多返回 5 个关键词（多词场景）", () => {
      const kws = extractGoalKeywords("修复 所有 测试 用例 并且 发布 到线上");
      assert.ok(kws.length <= 5);
    });

    it("中文无空格文本按滑动窗口生成片段", () => {
      const kws = extractGoalKeywords("研发自动压缩插件并发布");
      assert.ok(kws.length > 1, "应生成多个片段");
      assert.ok(kws.every((kw) => kw.length >= 2));
      // 片段应是原文的子串
      assert.ok(kws.every((kw) => "研发自动压缩插件并发布".includes(kw)));
    });

    it("短中文文本（< 窗口长度）作为整体返回", () => {
      const kws = extractGoalKeywords("修复");
      assert.deepEqual(kws, ["修复"]);
    });

    it("空文本返回空数组", () => {
      assert.deepEqual(extractGoalKeywords(""), []);
      assert.deepEqual(extractGoalKeywords("   "), []);
    });

    it("全部是单字符词时返回空数组", () => {
      assert.deepEqual(extractGoalKeywords("a b c d"), []);
    });
  });

  describe("runContextGuard 目标匹配", () => {
    it("总结包含任一关键词时不触发补齐", () => {
      const pi = createMockPi();
      const entries = [
        { type: "message", message: { role: "user", content: "/goal 研发自动压缩插件并发布" } },
      ];
      const ctx = createMockCtx(entries);
      runContextGuard(pi, ctx, "完成了自动压缩插件的基本框架搭建");
      assert.equal(pi._getSentMessages().length, 0, "命中关键词时不应补齐");
    });

    it("总结未包含任何关键词时触发补齐", () => {
      const pi = createMockPi();
      const entries = [
        { type: "message", message: { role: "user", content: "/goal 研发自动压缩插件并发布" } },
      ];
      const ctx = createMockCtx(entries);
      runContextGuard(pi, ctx, "讨论了一些技术细节，准备进入下一步。");
      const sent = pi._getSentMessages();
      assert.ok(sent.length > 0, "未命中任何关键词时必须补齐");
      assert.ok(sent[0].msg.content.includes("研发自动压缩插件并发布"));
    });

    it("关键词匹配不区分大小写", () => {
      const pi = createMockPi();
      const entries = [
        { type: "message", message: { role: "user", content: "/goal Fix Authentication Bug" } },
      ];
      const ctx = createMockCtx(entries);
      runContextGuard(pi, ctx, "resolved the authentication issue in login flow");
      assert.equal(pi._getSentMessages().length, 0, "大小写不敏感匹配应命中");
    });

    it("相似前缀但不同目标能区分", () => {
      const pi = createMockPi();
      const entries = [
        { type: "message", message: { role: "user", content: "/goal 修复数据库迁移脚本" } },
      ];
      const ctx = createMockCtx(entries);
      // 总结只提了样式，没有任何关于"数据库"、"迁移"、"脚本"的子串片段
      runContextGuard(pi, ctx, "修复了前端样式问题和布局");
      const sent = pi._getSentMessages();
      // 滑动窗口片段如 "数据库迁"、"库迁移脚" 等都不在总结中，应触发补齐
      assert.ok(sent.length > 0, "不同目标域的总结应被识别为遗漏");
    });

    it("无目标时不检查目标匹配", () => {
      const pi = createMockPi();
      const ctx = createMockCtx([]);
      runContextGuard(pi, ctx, "some summary without any context");
      assert.equal(pi._getSentMessages().length, 0);
    });
  });

  describe("runContextGuard 文件遗漏检测", () => {
    it("总结遗失修改文件时触发补齐", () => {
      const pi = createMockPi();
      const entries = [makeEditEntry("src/critical.ts"), makeEditEntry("src/other.ts")];
      const ctx = createMockCtx(entries);
      runContextGuard(pi, ctx, "修改了 src/other.ts 的逻辑");
      const sent = pi._getSentMessages();
      assert.equal(sent.length, 1);
      assert.ok(sent[0].msg.content.includes("src/critical.ts"));
      assert.ok(!sent[0].msg.content.includes("src/other.ts"), "已在总结中的文件不应出现在补齐里");
    });

    it("总结包含所有修改文件时不触发补齐", () => {
      const pi = createMockPi();
      const entries = [makeEditEntry("src/a.ts"), makeEditEntry("src/b.ts")];
      const ctx = createMockCtx(entries);
      runContextGuard(pi, ctx, "修改了 src/a.ts 和 src/b.ts");
      assert.equal(pi._getSentMessages().length, 0);
    });

    it("无修改文件时不触发文件遗漏检测", () => {
      const pi = createMockPi();
      const ctx = createMockCtx([]);
      runContextGuard(pi, ctx, "nothing happened");
      assert.equal(pi._getSentMessages().length, 0);
    });
  });

  describe("runContextGuard 补齐消息格式", () => {
    it("补齐消息 display=false 且 triggerTurn=false", () => {
      const pi = createMockPi();
      const entries = [makeEditEntry("src/lost.ts")];
      const ctx = createMockCtx(entries);
      runContextGuard(pi, ctx, "没提任何文件");
      const sent = pi._getSentMessages();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].msg.display, false);
      assert.equal(sent[0].opts.triggerTurn, false);
      assert.equal(sent[0].msg.customType, "auto-compact/context-guard");
    });

    it("同时遗漏目标和文件时一条消息包含所有缺失项", () => {
      const pi = createMockPi();
      const entries = [
        { type: "message", message: { role: "user", content: "/goal 重构认证模块" } },
        makeEditEntry("src/auth.ts"),
      ];
      const ctx = createMockCtx(entries);
      runContextGuard(pi, ctx, "做了一些工作。");
      const sent = pi._getSentMessages();
      assert.equal(sent.length, 1);
      assert.ok(sent[0].msg.content.includes("重构认证模块"));
      assert.ok(sent[0].msg.content.includes("src/auth.ts"));
    });

    it("hasUI=false 时补齐仍发送但不通知", () => {
      const pi = createMockPi();
      const entries = [makeEditEntry("src/lost.ts")];
      const ctx = createMockCtx(entries, { hasUI: false });
      runContextGuard(pi, ctx, "nothing");
      assert.equal(pi._getSentMessages().length, 1);
      assert.equal(ctx._notifications.length, 0);
    });
  });

  describe("runContextGuard 异常安全", () => {
    it("sessionManager 缺失时不抛错", () => {
      const pi = createMockPi();
      const ctx = {
        hasUI: false,
        sessionManager: undefined,
        ui: { theme: { fg: (_, t) => t }, notify: () => {} },
      };
      assert.doesNotThrow(() => runContextGuard(pi, ctx, "test"));
    });

    it("extractSessionFacts 抛错时不向外冒泡", () => {
      const pi = createMockPi();
      const ctx = {
        hasUI: true,
        sessionManager: {
          getEntries: () => {
            throw new Error("boom");
          },
        },
        ui: { theme: { fg: (_, t) => t }, notify: () => {} },
      };
      assert.doesNotThrow(() => runContextGuard(pi, ctx, "test"));
    });
  });
});
