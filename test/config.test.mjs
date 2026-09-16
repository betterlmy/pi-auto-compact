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
  });

  it("应正确持久化与重新读取配置", () => {
    saveConfig({ threshold: 85, customFooter: true, autoManageSettings: true }, testConfigPath);
    const loaded = loadConfig(testConfigPath);
    assert.equal(loaded.threshold, 85);
    assert.equal(loaded.customFooter, true);
    assert.equal(loaded.autoManageSettings, true);
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
});
