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
      } else if (options.compactBehavior === "throw") {
        throw new Error(options.compactErrorMessage || "mock compact throw");
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

  it("7. agent_settled 电平触发：高于阈值即触发，失败后不空转、增长后放行、回落后重新武装", () => {
    const pi = createMockPi();
    extensionFactory(pi);

    const onSettled = pi._getHandler("agent_settled");

    // 首次沉淀即高于阈值（扩展中途加载/恢复会话场景），必须触发
    const ctx1 = createMockCtx({ percent: 76, compactBehavior: "sync-error", compactErrorMessage: "boom" });
    onSettled({}, ctx1);
    assert.equal(ctx1._isCompactCalled(), true, "首次高于阈值必须触发");

    // 失败后同一水位不原地重试
    const ctx2 = createMockCtx({ percent: 76 });
    onSettled({}, ctx2);
    assert.equal(ctx2._isCompactCalled(), false, "同一水位失败后不得空转重试");

    // 用量增长后自动放行重试
    const ctx3 = createMockCtx({ percent: 78, compactBehavior: "sync-complete" });
    onSettled({}, ctx3);
    assert.equal(ctx3._isCompactCalled(), true, "用量增长后必须放行重试");

    // 回落到阈值以下后重新武装，再次超过阈值可触发
    const ctx4 = createMockCtx({ percent: 68 });
    onSettled({}, ctx4);
    assert.equal(ctx4._isCompactCalled(), false);

    const ctx5 = createMockCtx({ percent: 77 });
    onSettled({}, ctx5);
    assert.equal(ctx5._isCompactCalled(), true, "回落后再次超过阈值必须触发");
  });

  it("8. /auto-compact setup 命令在用户确认后安全优化原生安全网", async () => {
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

  it("9. ctx.compact 同步抛错时释放状态锁，不阻塞后续触发", () => {
    const pi = createMockPi();
    extensionFactory(pi);

    const onSettled = pi._getHandler("agent_settled");

    const ctx1 = createMockCtx({ percent: 76, compactBehavior: "throw", compactErrorMessage: "sync boom" });
    assert.doesNotThrow(() => onSettled({}, ctx1), "同步抛错应在扩展内部被捕获，不向运行时冒泡");
    assert.ok(
      ctx1._notifications.some((n) => n.msg.includes("压缩调用失败")),
      "同步抛错必须向用户发出告警"
    );

    // 若 isCompacting 未释放，此处会被开头守卫直接 return，永远不会再调用 compact
    const ctx2 = createMockCtx({ percent: 78, compactBehavior: "sync-complete" });
    onSettled({}, ctx2);
    assert.equal(ctx2._isCompactCalled(), true, "抛错后状态锁必须释放，用量增长后仍可触发");
  });

  it("10. isCompacting 陈旧时在 agent_settled 自愈，避免触发点被永久挡死", () => {
    const pi = createMockPi();
    extensionFactory(pi);

    const onSettled = pi._getHandler("agent_settled");

    // 模拟压缩既不回调也不发事件（SDK 成功路径跳过 session_compact 的情形）
    const ctx1 = createMockCtx({ percent: 76 });
    onSettled({}, ctx1);
    assert.equal(ctx1._isCompactCalled(), true);

    // 非空闲时不自愈，守卫继续挡住触发
    const ctx2 = createMockCtx({ percent: 80, compactBehavior: "sync-complete", isIdle: false });
    onSettled({}, ctx2);
    assert.equal(ctx2._isCompactCalled(), false, "非空闲时不得自愈或触发");

    // 空闲时陈旧状态锁被自愈释放，用量增长后重新触发
    const ctx3 = createMockCtx({ percent: 80, compactBehavior: "sync-complete", isIdle: true });
    onSettled({}, ctx3);
    assert.equal(ctx3._isCompactCalled(), true, "空闲时陈旧状态锁必须被自愈释放");
  });

  it("11. session_start 在原生安全网已最优时不重复改写 settings.json", () => {
    writeFileSync(
      join(piAgentDir, "auto-compact.json"),
      JSON.stringify({ threshold: 75, autoManageSettings: true })
    );
    const settingsPath = join(piAgentDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ compaction: { enabled: true, reserveTokens: 60000 } }));

    const pi = createMockPi();
    extensionFactory(pi);
    pi._getHandler("session_start")({}, createMockCtx());

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.compaction.reserveTokens, 60000, "已最优时不得被改写回 50000");
  });

  it("12. 紧急熔断续跑在非空闲时也投递（交由 sendMessage 排队）", async () => {
    const pi = createMockPi();
    extensionFactory(pi);

    const onTurnEnd = pi._getHandler("turn_end");
    const toolMsg = {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: "huge.log" } }],
    };
    const ctx = createMockCtx({ percent: 93, compactBehavior: "sync-complete", isIdle: false });

    onTurnEnd({ message: toolMsg }, ctx);
    await new Promise((resolve) => setImmediate(resolve));

    const sent = pi._getSentMessages();
    assert.ok(sent.some((s) => s.msg.customType === "auto-compact/resume"), "非空闲时不得静默丢弃续跑消息");
  });
});
