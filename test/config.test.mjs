import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadConfig, saveConfig, checkNativeSafetyNet, applyNativeSafetyNet } = jiti("../src/config.ts");

describe("config.ts: 配置与原生安全网管理", () => {
  let tempDir;
  let testConfigPath;
  let testSettingsPath;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pac-config-test-"));
    testConfigPath = join(tempDir, "auto-compact.json");
    testSettingsPath = join(tempDir, "settings.json");
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("当配置文件不存在时，应加载默认配置", () => {
    const config = loadConfig(join(tempDir, "non-existent.json"));
    assert.equal(config.threshold, 75);
    assert.equal(config.customFooter, false);
    assert.equal(config.autoManageSettings, false);
    assert.equal(config.progressColor, true);
    assert.equal(config.maxToolResultChars, 50000);
  });

  it("应正确持久化与重新读取配置", () => {
    saveConfig(
      { threshold: 85, customFooter: true, autoManageSettings: true, progressColor: false },
      testConfigPath
    );
    const loaded = loadConfig(testConfigPath);
    assert.equal(loaded.threshold, 85);
    assert.equal(loaded.customFooter, true);
    assert.equal(loaded.autoManageSettings, true);
    assert.equal(loaded.progressColor, false);
  });

  it("saveConfig 写入失败时返回 false，不静默吞掉", () => {
    // 以目录作为目标路径触发 EISDIR，模拟磁盘/权限类写入失败
    assert.equal(saveConfig({ threshold: 80 }, tempDir), false);
  });

  it("checkNativeSafetyNet 能正确识别非最优的原生配置状态", () => {
    writeFileSync(testSettingsPath, JSON.stringify({ compaction: { enabled: false } }, null, 2));
    const status = checkNativeSafetyNet(testSettingsPath);
    assert.equal(status.isOptimal, false);
    assert.equal(status.enabled, false);
    assert.ok(status.message?.includes("处于关闭状态"));
  });

  it("applyNativeSafetyNet 能正确写入 reserveTokens=50000 最佳配置", () => {
    writeFileSync(testSettingsPath, JSON.stringify({ compaction: { enabled: false } }, null, 2));
    const ok = applyNativeSafetyNet(testSettingsPath);
    assert.equal(ok, true);

    const fixed = JSON.parse(readFileSync(testSettingsPath, "utf-8"));
    assert.equal(fixed.compaction.enabled, true);
    assert.equal(fixed.compaction.reserveTokens, 50000);

    const status = checkNativeSafetyNet(testSettingsPath);
    assert.equal(status.isOptimal, true);
  });

  it("checkNativeSafetyNet 对缺失或损坏的 settings.json 不应误判为已最优", () => {
    const missing = checkNativeSafetyNet(join(tempDir, "missing-settings.json"));
    assert.equal(missing.isOptimal, false);
    assert.ok(missing.message?.includes("未找到"));

    const corruptPath = join(tempDir, "corrupt-settings.json");
    writeFileSync(corruptPath, "{ not valid json");
    const corrupt = checkNativeSafetyNet(corruptPath);
    assert.equal(corrupt.isOptimal, false);
    assert.ok(corrupt.message?.includes("无法解析"));
  });

  it("applyNativeSafetyNet 在 settings.json 缺失时应创建并写入最佳配置", () => {
    const newPath = join(tempDir, "nested", "settings.json");
    const ok = applyNativeSafetyNet(newPath);
    assert.equal(ok, true);

    const created = JSON.parse(readFileSync(newPath, "utf-8"));
    assert.equal(created.compaction.enabled, true);
    assert.equal(created.compaction.reserveTokens, 50000);
    assert.equal(checkNativeSafetyNet(newPath).isOptimal, true);
  });

  it("applyNativeSafetyNet 遇到损坏 JSON 时应拒绝覆盖并返回 false", () => {
    const corruptPath = join(tempDir, "corrupt-keep.json");
    writeFileSync(corruptPath, "{ broken");
    assert.equal(applyNativeSafetyNet(corruptPath), false);
    assert.equal(readFileSync(corruptPath, "utf-8"), "{ broken");
  });
});
