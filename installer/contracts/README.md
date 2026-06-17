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

## Manage JS 单文件 bundle（P10 方案 3）

Manage 管理面板用 **esbuild 单文件 bundle** 取代旧 base64 多文件内嵌。`manage.js` 与四子模块（provider/skills/update/mcp-manager）静态打包为 `dist/manage.js`（~150KB），wrapper 按需缓存到固定目录（1 小时 TTL）。

**架构三级解析**（ManageCore.{ps1,zsh}）：
1. **源码优先**（离线）→ `installer/contracts/scripts/manage.js`，require 同目录子模块
2. **缓存命中**（0 网络）→ `$TMPDIR/.ccq/manage.js`（修改时间 <1h 直接复用）
3. **过期下载**（远端最新）→ `curl /releases/latest/download/manage.js`，存固定路径；下载失败降级旧缓存

**同进程调用**（P10 任务 10.1.3）：`invokeManager` 改用 `require('./子模块').runInteractive()`，由 esbuild 静态内联，取代旧 spawn 独立进程 + `~/.ccq/scripts/` 部署。

**bundle 构建**（P10 任务 10.1.5）：
- `build.ps1` / `build.sh` 调用 `node installer/contracts/scripts/esbuild.config.js`
- 产物 `dist/manage.js` 与 3 个 .ps1 + 2 个 .sh 平级，GitHub Release 同时上传 6 个 artifact
- wrapper URL：`https://github.com/.../releases/latest/download/manage.js`（无版本号 / 无哈希）

**删除旧逻辑**（P10 任务 10.2.1-10.2.5）：
- ~~`Get-ManageScriptsBase64` / `getManageScriptsBase64`~~（多文件 base64 编码）
- ~~`$script:EmbeddedManageScriptsJson` / `CCQ_MANAGE_SCRIPTS_JSON`~~（注入变量）
- ~~`ManageScriptNames` / `CCQ_MANAGE_SCRIPT_NAMES`~~（部署清单）
- ~~`ManageCoreVersion` / `SCRIPT_VERSION` 版本检测~~（缓存仅按 TTL）
- ~~`Install-ManageScripts` / `ccq_manage_core_install_scripts`~~（部署函数）

**缓存清理**：系统重启自动清理 `$TMPDIR/.ccq/`（Windows `%TEMP%\.ccq\`），无需手动维护。1 小时内多次 `ccq` 零网络开销，过期自动重拉最新。

**contracts 内联**：`providers.json` / `skills.json` / `mcp-servers.json` / `claude-config.json` / `ui.json` 在各 `*-manager.js` 中以 JS 常量内联，bundle 自带全部业务契约，运行期无额外契约网络请求。任何 contract schema 变更需重新构建发布 bundle。
