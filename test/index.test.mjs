import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

function createMockPi() {
  const handlers = new Map();
  const commands = new Map();
  const sentMessages = [];

  const pi = {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerCommand: (name, def) => {
      commands.set(name, def);
    },
    sendMessage: (msg, opts) => {
      sentMessages.push({ msg, opts });
    },
    _getHandler: (event) => handlers.get(event)?.[0],
    _getCommand: (name) => commands.get(name),
    _getSentMessages: () => sentMessages,
  };
  return pi;
}

function createMockCtx(options = {}) {
  const notifications = [];
  const statusEntries = new Map();
  let compactCalled = false;
  let compactOptions = null;

  const ctx = {
    hasUI: options.hasUI ?? true,
    isIdle: () => options.isIdle ?? true,
    ui: {
      theme: {
        fg: (color, text) => `[${color}]${text}[/${color}]`,
      },
      notify: (msg, type) => {
        notifications.push({ msg, type });
      },
      setStatus: (key, text) => {
        statusEntries.set(key, text);
      },
      setFooter: (factory) => {
        ctx._footerFactory = factory;
      },
      confirm: async () => options.mockConfirm ?? true,
      input: async () => options.mockInput,
    },
    sessionManager: {
      getCwd: () => "/mock/cwd",
      getSessionName: () => "mock-session",
      getEntries: () => options.entries || [],
    },
    model: {
      id: "mock-model",
      contextWindow: options.contextWindow || 1000000,
    },
    getContextUsage: () => ({
      tokens: options.tokens ?? 100000,
      contextWindow: options.contextWindow || 1000000,
      percent: options.percent ?? ((options.tokens ?? 100000) / (options.contextWindow || 1000000)) * 100,
    }),
    compact: (opts) => {
      compactCalled = true;
      compactOptions = opts;
      if (options.compactBehavior === "sync-complete") {
        opts?.onComplete?.();
      } else if (options.compactBehavior === "sync-error") {
        opts?.onError?.(new Error(options.compactErrorMessage || "mock compact failure"));
      }
    },
    _notifications: notifications,
    _statusEntries: statusEntries,
    _isCompactCalled: () => compactCalled,
    _getCompactOptions: () => compactOptions,
  };
  return ctx;
}

describe("index.ts: 扩展核心集成测试", () => {
  let tempHome;
  let piAgentDir;
  let originalHome;
  let extensionFactory;

  before(() => {
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "pac-ext-test-"));
    piAgentDir = join(tempHome, ".pi", "agent");
    mkdirSync(piAgentDir, { recursive: true });
    process.env.HOME = tempHome;

    extensionFactory = jiti("../src/index.ts").default;
  });

  after(() => {
    process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    const settingsPath = join(piAgentDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ compaction: { enabled: true, reserveTokens: 50000 } }, null, 2)
    );

    const configPath = join(piAgentDir, "auto-compact.json");
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  it("1. 成功注册所有生命周期钩子和命令", () => {
    const pi = createMockPi();
    extensionFactory(pi);

    assert.ok(pi._getCommand("auto-compact"));
    assert.ok(pi._getHandler("session_start"));
    assert.ok(pi._getHandler("agent_settled"));
    assert.ok(pi._getHandler("turn_end"));
    assert.ok(pi._getHandler("session_before_compact"));
    assert.ok(pi._getHandler("session_compact"));
    assert.ok(pi._getHandler("session_compact_failed"));
  });

  it("2. 默认模式下使用非侵入式 setStatus 输出，不主动霸占 setFooter", () => {
    const pi = createMockPi();
    extensionFactory(pi);

    const ctx = createMockCtx();
    const onSessionStart = pi._getHandler("session_start");
    onSessionStart({}, ctx);

    assert.equal(ctx._footerFactory, undefined, "默认情况下不得调用 setFooter");
    assert.ok(ctx._statusEntries.has("auto-compact"), "应调用 setStatus 输出状态");
    assert.ok(ctx._statusEntries.get("auto-compact").includes("75%"));
  });

  it("3. /auto-compact footer 命令支持无缝切换内联与非侵入展示模式", async () => {
    const pi = createMockPi();
    extensionFactory(pi);

    const cmd = pi._getCommand("auto-compact");
    const ctx = createMockCtx();

    // 切换到接管式内联 footer
    await cmd.handler("footer", ctx);
    assert.ok(ctx._notifications.some((n) => n.msg.includes("已开启接管式内联 Footer")));
    assert.ok(ctx._footerFactory, "开启后必须注册 setFooter");

    // 再次切换回默认非侵入模式
    await cmd.handler("footer", ctx);
    assert.ok(ctx._notifications.some((n) => n.msg.includes("已切换为标准非侵入式")));
    assert.ok(ctx._statusEntries.has("auto-compact"));
  });

  it("4. agent_settled 常态触发与确定性事实注入测试", () => {
    const pi = createMockPi();
    extensionFactory(pi);

    const onSettled = pi._getHandler("agent_settled");
    const ctx = createMockCtx({
      percent: 76,
      entries: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "edit", arguments: { path: "src/auth.ts" } }],
          },
        },
      ],
    });

    onSettled({}, ctx);
    assert.equal(ctx._isCompactCalled(), true);
    const opts = ctx._getCompactOptions();
    assert.ok(opts.customInstructions.includes("src/auth.ts"), "必须在提示词中附带修改文件");
  });

  it("5. turn_end 紧急熔断：>= 92% 突发暴涨就地熔断并恢复任务", async () => {
    const pi = createMockPi();
    extensionFactory(pi);

    const onTurnEnd = pi._getHandler("turn_end");
    const toolMsg = {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: "huge.log" } }],
    };

    const ctx = createMockCtx({
      percent: 93,
      compactBehavior: "sync-complete",
    });

    onTurnEnd({ message: toolMsg }, ctx);
    assert.equal(ctx._isCompactCalled(), true);
    assert.ok(ctx._notifications.some((n) => n.msg.includes("【紧急熔断】")));

    await new Promise((resolve) => setImmediate(resolve));
    const sent = pi._getSentMessages();
    assert.ok(sent.some((s) => s.msg.customType === "auto-compact/resume" && s.opts.triggerTurn === true));
  });

  it("6. Context Guard 防遗忘补齐：总结遗失核心修改文件时自动发送补齐消息", () => {
    const pi = createMockPi();
    extensionFactory(pi);

    const onSessionCompact = pi._getHandler("session_compact");
    const ctx = createMockCtx({
      entries: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "edit", arguments: { path: "src/critical.ts" } }],
          },
        },
      ],
    });

    // 模拟 LLM 总结遗失了 src/critical.ts
    onSessionCompact(
      {
        compactionEntry: {
          id: "c-1",
          summary: "讨论了一些开发细节，未提及任何文件。",
        },
      },
      ctx
    );

    const sent = pi._getSentMessages();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg.display, false);
    assert.equal(sent[0].opts.triggerTurn, false);
    assert.ok(sent[0].msg.content.includes("src/critical.ts"));
  });

  it("7. /auto-compact setup 命令在用户确认后安全优化原生安全网", async () => {
    const pi = createMockPi();
    extensionFactory(pi);

    // 模拟破坏原生配置
    const settingsPath = join(piAgentDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ compaction: { enabled: false } }, null, 2));

    const cmd = pi._getCommand("auto-compact");
    const ctx = createMockCtx({ mockConfirm: true });

    await cmd.handler("setup", ctx);
    assert.ok(ctx._notifications.some((n) => n.msg.includes("已优化原生安全网配置")));

    const updated = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(updated.compaction.enabled, true);
    assert.equal(updated.compaction.reserveTokens, 50000);
  });
});
