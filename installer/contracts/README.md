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
- `scripts/mcp-manager.js`：**MCP 管理 Node.js 脚本**（完整 TUI + 业务逻辑），零外部依赖。双平台构建时内嵌为 base64 到 `install.ps1` / `manage.ps1` / `install.sh` / `manage.sh`，运行时部署到 `~/.ccq/scripts/mcp-manager.js`。平台层 wrapper（`McpManager.ps1` / `McpManager.zsh`）仅负责调用此脚本。
- `scripts/claude-config-drift.js`：ClaudeConfig 偏移检测脚本（只读）。
- `scripts/skills-discovery.js`：Skills 自动发现与版本检测脚本。
- `Test-Contracts.ps1`：契约一致性检查脚本，验证 contracts 与 Windows canonical runtime fallback、macOS fallback、平台路径和构建清单一致。

## 目录约束

`installer/` 继续作为安装器领域根目录，不改名为 `src/`。平台运行时保持隔离：Windows 使用 `installer/windows/core/` 与 `installer/windows/steps/`，macOS 使用 `installer/macos/core/` 与 `installer/macos/steps/`。`contracts/` 只表达跨平台契约，不承载平台运行时实现。

Windows 步骤路径必须使用 `windows/steps/*.ps1`，macOS 步骤路径必须使用 `macos/steps/*.zsh`，禁止平台加载路径混用。构建入口固定为 `installer/build.ps1` 与 `installer/build.sh`，默认输出目录为 repo 根目录 `dist/`；前者只输出 `bootstrap.ps1`、`install.ps1`、`manage.ps1`，后者只输出 `install.sh`、`manage.sh`，CI Release job 负责汇总五个短 artifact。
