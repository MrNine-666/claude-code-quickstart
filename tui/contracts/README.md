# tui/contracts

TUI 链契约目录（TDR-10 拆分后归位），保存根级 **OpenTUI TUI 子项目** `tui/`（`src/` TypeScript → 4 平台单文件可执行）的业务语义：供应商、MCP、ClaudeConfig、CcgWorkflow 受管路径与模板。运行时消费项会以内联文本形式内嵌进 ccq 可执行文件；其余契约保留为磁盘源契约，供 CI、installer 合约测试或后续迁移使用。install 链契约（步骤 / 构建 / 清理策略）在 [`installer/contracts/`](../../installer/contracts/)，本目录不承载。

## 目录职责

- `claude-config.json`：ClaudeConfig 管辖的 `~/.claude/settings.json` 默认值（`TopLevelDefaults` / `ClaudeConfigEnvDefaults`）、权限基线（`ClaudeConfigBasePermissions`）与所有权边界（`DoNotManageTopLevelKeys` / `DoNotManageEnvKeys`）。每个 key 含 `description`（一行中文介绍）。fill-missing 导入只补缺失不覆盖，不写入 `model`（用户自选）。**TUI 运行时内嵌**。
- `mcp-servers.json`：内置 MCP Server 定义、凭据字段、vault schema（`~/.ccq/mcp-meta.json`）与状态语义。TUI MCP 视图据此列出可安装/可配置的内置 MCP，安装走 `saveMcpServer`（persistMcpServer + Vault）管道。MCP rules 同步已停管，本契约不再含 `McpRulesCategories`。**TUI 运行时内嵌**。
- `providers.json`：内置供应商模板（智谱GLM / MiniMax / Kimi Code / DeepSeek / 阿里云百炼 / 自定义）、受管模型环境键、受管额外环境键与旧版迁移字段。供应商 Profile 为 settings-compatible 单层 `{ env }` 结构，文件名 = 用户填英文名，落地 `~/.claude/providers/<文件名>.json`。**TUI 运行时内嵌**。
- `ccg-workflow.json`：CcgWorkflow 受管路径单一真理源——`verifyItems`（安装验证项：commands/agents/configToml/wrapper/pathAvailability/envConfig/mcpProtection）、`managedEnvDefaults`（4 个推荐 env 默认值）、`managedRuleFiles`（受管 rules 文件清单）。当前 TUI 工具管理仍以内联常量保持鲁棒，后续迁移时可读取本契约。**磁盘源契约，不作为运行时内嵌 entry**。
- `claude-config-drift.js`：ClaudeConfig 漂移检测算法（analyze / install / update），由 `installer/build.sh` 与 CI 引用做契约 drift 校验。**install 链算法**随 ClaudeConfig 归 TUI，Windows 侧不引用。**磁盘源契约，不作为运行时内嵌 entry**。
- `templates/`：CLAUDE.md 模板产物。
  - `claude-md.base.md`：跨平台通用章节（一~五，含输出设置）。**TUI 运行时内嵌**。
  - `claude-md.platform-windows.md`：Windows 专属环境章节（四-环境特定：PowerShell 分隔符 / 中文路径 / 管道传参），仅 Windows 拼接。**TUI 运行时内嵌**。
  - `index.json`：模板/渲染产物索引（SchemaVersion / Templates 数组，含 CLAUDE.md 模板段与历史 MCP rules 渲染项）。**磁盘源契约，installer 合约测试读取，不作为运行时内嵌 entry**。

旧 `profile/ccq-function.ps1.txt` / `ccq-function.zsh.txt` 模板已删除（ccq 改为单文件可执行直跑，不注入 Profile）。

## 目录约束

本目录只表达 TUI 链契约，不承载 install 运行时实现。运行时消费契约 **以内联文本形式内嵌进 ccq 可执行文件**，通过 `src/core/embedded-contracts.ts` 的 Bun `with { type: "text" }` import 写入 `EMBEDDED_CONTRACTS` Map：

- **打包后**（`ccq-*.exe` / `ccq-*`）：`providers.json` / `mcp-servers.json` / `claude-config.json` / `templates/claude-md.*.md` 从内嵌 Map 读取，不依赖 Bun 虚拟文件系统路径。
- **源码模式**（`bun run tui/src/index.tsx`）：`contracts.ts` 通过相对路径上溯读取 `tui/contracts/`，零网络。
- **磁盘源契约**：`ccg-workflow.json` / `templates/index.json` / `claude-config-drift.js` 保留在本目录，供 CI、installer 合约测试或后续迁移使用，不作为运行时内嵌 entry。
- 任何 runtime contract schema 变更对源码模式即时生效，Release 模式需重新构建 4 平台可执行文件。

**旧架构（已删除）**：
- Ink + Node 22 + 目录缓存（`manage-tui.tgz` + `ManageCore.{ps1,zsh}` + `CCQ_CONTRACTS_DIR` 注入 + `$TMPDIR/.ccq/manage-tui/` 1h TTL 缓存）全链已删除。
- 新架构无需 `CCQ_CONTRACTS_DIR` 环境变量注入，contracts 随可执行文件自包含。

## 与 installer/contracts/ 的边界

TDR-10「谁用归谁」拆分后，契约按消费方归位：

| 消费方 | 契约目录 | 内容 |
|--------|---------|------|
| TUI（OpenTUI 控制台，单文件可执行） | `tui/contracts/` | 运行时内嵌：`claude-config.json` / `mcp-servers.json` / `providers.json` / `templates/claude-md.*.md`；磁盘源契约：`ccg-workflow.json` / `claude-config-drift.js` / `templates/index.json` |
| install 链（Windows/macOS runtime） | [`installer/contracts/`](../../installer/contracts/) | `steps.json` / `build.json` / `cleanup-policy.json` / `Test-Contracts.ps1` |

`installer/contracts/Test-Contracts.ps1` 跨目录读本目录验证 TUI 契约与 runtime 一致。详见根 [CLAUDE.md](../../CLAUDE.md) 的 HC-MAC-03 约束与「Manage TUI 架构」小节。
