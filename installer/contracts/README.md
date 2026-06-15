# installer/contracts

跨平台契约目录，保存 Windows PowerShell 与 macOS zsh 共同依赖的业务语义：步骤、供应商、MCP、ClaudeConfig 默认配置、模板索引、构建清单、Skills catalogue 与菜单文案策略。

## 目录职责

- `steps.json`：StepId、分组、依赖、可选项、更新函数、平台步骤文件映射与生命周期状态；平台差异字段（如 `MacOSSkipIfInstalled`）只覆盖对应平台运行时，不改变 Windows canonical 语义。
- `providers.json`：内置供应商模板、受管模型环境键、受管额外环境键与旧版迁移字段。
- `mcp-servers.json`：MCP Server 定义、凭据字段、vault schema 与状态语义。
- `claude-config.json`：ClaudeConfig 管辖的 settings.json 默认值、权限与所有权边界。
- `templates/index.json`：CLAUDE.md 与 MCP rules 等模板/渲染产物索引。
- `build.json`：Windows / macOS 分平台 artifact 名称、入口、core 顺序与参数提升来源；`installer/build.ps1` 只生成 Windows 三产物，`installer/build.sh` 只生成 macOS 两产物。
- `skills.json`：Skills catalogue 与 ignore policy 唯一业务源，定义 source、skillName、staticSkillName、skipDiscovery、default、排序，以及由其他步骤管理且应从 Skills 管理中过滤的 `IgnoredSkillNames`。
- `ui.json`：跨平台菜单文案与显示策略；Advanced Select 使用 `【已安装】` / `【未安装】`，禁止旧式 `[PASS]` / `[    ]` 出现在选择菜单。
- `scripts/mcp-manager.js`：**MCP 管理 Node.js 脚本**（完整 TUI + 业务逻辑），零外部依赖。双平台构建时内嵌为 base64 到 `install.ps1` / `manage.ps1` / `install.sh` / `manage.sh`，运行时部署到 `~/.ccq/scripts/mcp-manager.js`。平台层 wrapper（`McpManager.ps1` / `McpManager.zsh`）仅负责调用此脚本。同时由 `ManageCore.ps1` / `ManageCore.zsh` 共同部署，供 `manage.js` 子菜单调用。
- `scripts/manage.js`：**Manage 管理面板入口**（子菜单 + 路由），零外部依赖。运行时部署到 `~/.ccq/scripts/manage.js`，由平台层 wrapper（`windows/core/ManageCore.ps1` / `macos/core/ManageCore.zsh`）调用 `node manage.js` 启动交互式面板，再通过 `invokeManager` spawn 到各专项子管理器。共享工具（`atomicWrite`、`withProfileLock`、`ensureTmpCacheDir`）从此文件提取。
- `scripts/provider-manager.js` / `scripts/skills-manager.js` / `scripts/update-manager.js`：Provider / Skills / Update 三个专项管理器的 Node.js 实现，与 `manage.js` 平级，由 `manage.js` 子菜单分别 spawn 调用；MCP 管理复用 `mcp-manager.js`。
- `scripts/run-tests.js`：Manage JS 测试聚合入口（聚合 8 个 `*.test.js` 套件，支持 `--unit` / `--e2e` 过滤，纯 Node.js 双平台语义一致）。
- `scripts/claude-config-drift.js`：ClaudeConfig 偏移检测脚本（只读）。
- `scripts/skills-discovery.js`：Skills 自动发现与版本检测脚本。
- `Test-Contracts.ps1`：契约一致性检查脚本，验证 contracts 与 Windows canonical runtime fallback、macOS fallback、平台路径和构建清单一致。

## 目录约束

`installer/` 继续作为安装器领域根目录，不改名为 `src/`。平台运行时保持隔离：Windows 使用 `installer/windows/core/` 与 `installer/windows/steps/`，macOS 使用 `installer/macos/core/` 与 `installer/macos/steps/`。`contracts/` 只表达跨平台契约，不承载平台运行时实现。

Windows 步骤路径必须使用 `windows/steps/*.ps1`，macOS 步骤路径必须使用 `macos/steps/*.zsh`，禁止平台加载路径混用。构建入口固定为 `installer/build.ps1` 与 `installer/build.sh`，默认输出目录为 repo 根目录 `dist/`；前者只输出 `bootstrap.ps1`、`install.ps1`、`manage.ps1`，后者只输出 `install.sh`、`manage.sh`，CI Release job 负责汇总五个短 artifact。

## Manage JS 集合打包

Manage 管理面板的 Provider / Skills / Update 三个专项模块与入口 `manage.js` 统一迁移到 Node.js，MCP 复用既有 `mcp-manager.js`。所有受管 JS 共享同一套 base64 内嵌 + 版本检测部署机制（HC-JS-MODULE-LOADING，bundle 四源文件总和 <150KB）。

**部署划分**（5 个 JS 最终都落到 `~/.ccq/scripts/`，但部署者不同）：

| 部署者 | 受管 JS | base64 来源（构建注入） |
|--------|---------|----------------------|
| `ManageCore.{ps1,zsh}` | `manage.js`、`provider-manager.js`、`skills-manager.js`、`update-manager.js`（4 个） | `build.ps1` 的 `Get-ManageScriptsBase64` / `build.sh` 的 `getManageScriptsBase64` → `manage.ps1` / `manage.sh` 的 `$script:EmbeddedManageScriptsJson` / `CCQ_MANAGE_SCRIPTS_JSON` |
| `McpManager.{ps1,zsh}` | `mcp-manager.js`（1 个，独立） | `build.ps1` 的 `Get-McpManagerScriptBase64` / `build.sh` 的 `getMcpManagerBase64` → `install.ps1` / `install.sh` / `manage.ps1` / `manage.sh` |

`manage.js` 子菜单 [4] MCP 通过 `invokeManager('mcp-manager')` spawn 同目录下的共享 `mcp-manager.js`。Phase 8（任务 9.x）计划把 `mcp-manager.js` 纳入 ManageCore 5 文件统一部署并删除独立 McpManager wrapper，届时两个 base64 函数合并。

**base64 内嵌注入**：运行时 `ManageCore.ps1` / `ManageCore.zsh` 解码内嵌 JSON 写入 `~/.ccq/scripts/`，并按 `manage.js` 的 `SCRIPT_VERSION`（当前 `1.0.0`，与 `ManageCoreVersion` 同步）做版本检测——已部署且版本一致时跳过写入。

**降级链**：内嵌 base64（Release / `irm|iex`、`curl|bash`）→ 源码复制 `installer/contracts/scripts/*.js`（源码模式）→ 已部署版本（版本检测命中跳过）。三条路径任一成功即进入 `node manage.js`，避免 `curl | node -` 占用 stdin 破坏交互菜单（HC-TTY-INHERIT）。

**contracts 内联**：`providers.json` / `skills.json` / `mcp-servers.json` / `claude-config.json` / `ui.json` 在各 `*-manager.js` 中以 JS 常量内联（含内联 fallback），manage 集合一次下载即自带全部业务契约，运行期无额外契约网络请求。任何 contract schema 变更需重新构建发布 manage 集合。
