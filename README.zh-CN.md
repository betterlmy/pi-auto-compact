<div align="center">

# @betterlmy/pi-auto-compact

**面向 Pi Coding Agent 的工业级双水位自动压缩与事实守护扩展**

[![npm version](https://img.shields.io/npm/v/@betterlmy/pi-auto-compact.svg)](https://www.npmjs.com/package/@betterlmy/pi-auto-compact)
[![Pi Extension](https://img.shields.io/badge/Pi-Extension-blue.svg)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/betterlmy/pi-auto-compact/actions/workflows/ci.yml/badge.svg)](https://github.com/betterlmy/pi-auto-compact/actions)

[English](./README.md) | **简体中文**

</div>

---

## 为什么需要它？

Pi 内置的 auto-compact 采用固定绝对剩余 Token（`compaction.reserveTokens`，默认 16384）作为唯一的触发标准。在 100 万甚至 200 万 Token 的现代大上下文模型下，固定绝对值意味着要用到 **98.4%** 才会触发，且原生在压缩时容易发生：
1. **多轮工具中途打断**：在长循环中途强行暂停；
2. **大模型总结失真**：大模型概括时经常遗忘具体修改过的文件路径、关键命令和特定约束；
3. **压缩后失忆**：会话历经多次压缩后，丢弃了最初设定的全局红线或任务目标；
4. **配置繁琐**：社区方案往往需要复杂的双配置文件与参数开关。

`pi-auto-compact` 专为解决上述痛点而生，提供**极简的一键配置**与**确定性事实硬核守护**。

---

## 核心架构与特性

### 1. 双水位线触发机制（平缓沉淀 + 极限熔断）

```text
               [100% Context Window]
                         ↑
        95% 原生 reserveTokens 最终兜底防爆网（备用）
                         ↑
   ───▶ 92% 紧急熔断天花板（中途检测到工具结果突发暴涨时就地熔断并自动续跑）
                         ↑
   ───▶ 75% 常态优雅压缩点（仅在 agent_settled 空闲沉淀点触发，不打扰任务）
```

- **常态静默压缩（默认 75%）**：采用上升沿判定，当且仅当任务彻底沉淀（`agent_settled`）且会话空闲时才触发压缩，杜绝在工具交互中间切断上下文。
- **突发紧急熔断（92% 天花板）**：若单个工具调用（如读取大日志、巨型 diff）导致用量从中途瞬间飙升至 92% 以上，立即就地熔断压缩，并在压缩后自动发送静默续跑消息恢复未完任务。

### 2. 确定性事实提取（参考 `pi-smart-compact`）
在调用大模型总结前，纯代码自动遍历提取会话事实：
- **修改文件**：精准提取所有通过 `write` / `edit` 改动的文件绝对与相对路径；
- **核心已读**：提取通过 `read` 查阅的核心文件，自动剔除已修改文件；
- **关键命令**：提取执行过的 `bash` 命令历史；
- **任务目标**：自动识别会话中的 `/goal <目标>`。

这些确定性事实作为**硬底座**直接注入压缩指令，彻底终结模型概括时的路径模糊化与幻觉。

### 3. Context Guard 压缩后硬核守护（参考 `agent-context-guard-pi`）
在压缩落地（`session_compact`）后执行自动断言检查：
- 核对新生成的 Summary 是否遗漏了活跃目标或修改过的文件路径；
- 一旦发现被大模型丢弃，自动通过底层消息静默补回：
  ```text
  [Context Guard: 关键约束与上下文恢复]
  - 当前未完成任务目标: ...
  - 关键修改文件清单: ...
  ```
- 终端界面零污染（`display: false`），但下一轮模型调用底座坚如磐石。

### 4. 双模式状态栏（非侵入 vs 接管内联）
- **默认模式（非侵入）**：通过 `ctx.ui.setStatus` 输出 `compact: 75%`，与原生 footer、`pi-starship`、`@henryqw/pi-footer` 完美兼容。
- **内联模式（可选）**：执行 `/auto-compact footer` 即可一键切换为接管式内联 Footer，在原生用量后无缝呈现：
  ```text
  ↑1.9M ↓15k R7.8M CH96.4% $2.574 14.1%/1.0M (auto:75%)
  ```
  压缩进行中动态切换为 `(auto:compacting...)`。

---

## 安装方式

使用 Pi 官方扩展包管理器直接安装：

```bash
# 推荐方式：从 npm 源安装
pi install npm:@betterlmy/pi-auto-compact

# 或者直接从 GitHub 仓库安装
pi install git:github.com/betterlmy/pi-auto-compact
```

---

## 命令用法

| 命令 | 说明 |
| :--- | :--- |
| `/auto-compact <数值>` | 一键设置自动压缩百分比阈值（10–99，例如 `/auto-compact 80`） |
| `/auto-compact` | 弹出交互式输入框设置阈值 |
| `/auto-compact footer` | 在**标准状态行**与**接管式内联 Footer**之间无缝切换 |
| `/auto-compact setup` | 安全检查并引导优化 Pi 原生安全网（设置 `reserveTokens=50000`） |
| `/auto-compact status` | 查看当前阈值、熔断线、上下文用量与各开关状态 |

---

## 配置文件说明

全局配置文件位于 `~/.pi/agent/auto-compact.json`（通常使用命令直接调整，无需手动编辑）：

```json
{
  "threshold": 75,
  "customFooter": false,
  "autoManageSettings": false
}
```

- `threshold`（`number`）：常态压缩触发百分比（10–99，默认 75）。
- `customFooter`（`boolean`）：是否开启接管式内联 `(auto:XX%)` Footer 渲染（默认 `false`）。
- `autoManageSettings`（`boolean`）：是否在会话启动时自动守护原生 `reserveTokens=50000` 安全网（默认 `false`，执行 `/auto-compact setup` 确认后开启）。

---

## 开发与测试

运行完整自动化测试套件（基于 Node.js 原生 `node:test`，13 项测试）：

```bash
npm test
```

---

## 开源协议

本项目采用 [MIT 许可证](LICENSE)。
部分设计思路参考了 `pi-smart-compact` (alpertarhan) 与 `agent-context-guard-pi` (j1nn0)，特此致谢。
