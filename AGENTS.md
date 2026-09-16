# pi-auto-compact 项目协作规范

## 仓库定位

- Pi Coding Agent 的自动上下文管理扩展（npm 包 `@betterlmy/pi-auto-compact`），负责双水位自动压缩、事实提取、压缩后守护、工具结果截断与会话统计。
- 本文件约束 Agent 在本仓库的开发协作；面向用户的功能介绍见 README，不在本文件重复。
- 上级规则：`~/AGENTS.md`；本文件只补充仓库特有事实，不重复上级内容。

## 技术栈

- TypeScript（ESM，`"type": "module"`，`src/index.ts` 为入口，经 `pi.extensions` 由 Pi 直接加载 TS）。
- 运行时 Node.js 24；测试用 `node:test`，通过 `jiti` 在测试中加载 TS 源码。
- 类型检查 `tsc --noEmit`；无 ESLint/Prettier 等其他工具链。

## 目录结构

- `src/`：全部扩展源码（12 个模块：index 注册钩子，compaction/guard 为核心流程，facts 为确定性事实提取，truncate/stats 为工具结果截断与会话统计，progress-color 为渐变进度配色，command/footer/status 为命令与显示）。
- `test/`：与源码同名的 `*.test.mjs` 测试文件。
- `.github/workflows/`：`ci.yml`（push/PR 跑 typecheck + test）；`publish.yml`（npm 发布）。

## 常用命令（均在仓库根目录执行）

- `npm test`：运行全部测试（当前 53 项）。
- `npm run typecheck`：类型检查。
- 两者均为只读检查，可放心运行；无 lint 脚本。

## 发布流程（必读）

- 发布完全由 tag 驱动：向远端推送 `v*` tag 会触发 `publish.yml` 自动执行 typecheck、test 后 `npm publish --provenance --access public`。
- 必须先修改 `package.json` 的 `version` 并提交，再打对应 tag；tag 指向的提交中 `package.json` 版本即发布版本。
- tag push 与 GitHub release 事件可能同时触发，workflow 内有版本存在性检查去重，无需手动干预。
- 发布属于对外副作用：执行 push tag 前必须取得用户明确授权。

## 编码规则

- 使用可判定措辞的最小实现；不增加未要求的功能、配置或历史兼容（遵循上级规则）。
- 用户可感知阈值：`DEFAULT_THRESHOLD = 75`、`EMERGENCY_THRESHOLD = 92`（`src/config.ts`，后者固定不可配置）；改动这两个值必须同步 README 与 README.zh-CN.md 的对应描述。
- 配置项新增/变更必须同步：`src/config.ts` 的类型与校验、README 双语的配置示例、`/auto-compact status` 输出（`src/command.ts`）。
- 测试用 jiti 加载 TS 源码的模式见 `test/truncate.test.mjs`；新测试沿用该模式。

## 文档索引

- `README.md` / `README.zh-CN.md`：双语用户文档；面向用户的功能与配置说明以它们为准，改动功能时同步。
- `.github/workflows/`：CI 与发布的权威定义，与发布相关的事实以 workflow 文件为准。

## Skill 索引

- `commit`（`~/.agents/skills/commit/SKILL.md`）：提交与 push 规则。
- `codegraph`（`~/.agents/skills/codegraph/SKILL.md`）：本仓库约 2000 行且无索引，按上级规则可直接读源码。

## 防漂移

- 项目结构、目录结构、技术栈、构建/测试命令、发布流程或开发约束变化时，在同一变更中同步更新本 AGENTS.md，不改写无关层级。
