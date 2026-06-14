# installer/macos

macOS 原生安装与管理实现目录。该目录使用 zsh + Homebrew + nvm 提供与 Windows 安装器等价的 Claude Code 环境安装、管理和更新体验。

---

## 入口

| 文件 | 职责 |
|------|------|
| `Install.zsh` | macOS 安装入口，合并 Bootstrap 前置检测，支持 Basic / Advanced 分组和 `ccq` 快捷函数注册 |
| `Manage.zsh` | macOS 管理入口，提供 Update / Provider / MCP / Skills 四类管理能力 |
| `core/*.zsh` | macOS runtime core：UI、Process、Profile、Platform、PackageManager、JSON、Registry、Bootstrap、McpManager、Provider |
| `steps/*.zsh` | macOS 13 个安装步骤 + Skills 管理模块，StepId 与 Windows 保持一致 |

**核心模块**：
- `Ui.zsh`：语义颜色系统、表格渲染、菜单交互、错误详情展开
- `Process.zsh`：命令执行、重试、超时、npm outdated 缓存、版本检测
- `Profile.zsh`：原子写入、备份管理、受管区块、Update Manifest、Snapshot
- `Platform.zsh`：平台检测、路径规范化
- `PackageManager.zsh`：Homebrew 封装
- `Json.zsh`：JSON 操作辅助
- `Registry.zsh`：步骤注册表、依赖拓扑排序、Legacy StepId 映射
- `Bootstrap.zsh`：步骤生命周期、Critical 失败策略、最终摘要
- `McpManager.zsh`：MCP 管理轻量 wrapper（175 行），调用 `~/.ccq/scripts/mcp-manager.js` 完成交互 TUI + CRUD
- `Provider.zsh`：供应商 CRUD、切换、Sync、模型环境键管理

**安装步骤**（13 个）：
- `NodeJS.zsh`：nvm 官方安装 + LTS Node.js
- `Git.zsh`：Homebrew 安装 Git
- `ClaudeCode.zsh`：npm global 安装 Claude Code CLI
- `ApiKey.zsh`：供应商配置（调用 Provider.zsh）
- `Ccline.zsh`：ccline 状态栏
- `ClaudeConfig.zsh`：Claude 基础配置（settings.json）
- `ClaudeMd.zsh`：全局 CLAUDE.md 工作规范
- `Mcp.zsh`：**MCP Server 安装**（416 行，完全自给自足）
- `CcgWorkflow.zsh`：CCG 工作流
- `Skills.zsh`：Skills 管理（Manage 专用）
- `OpenSpec.zsh`：OpenSpec CLI
- `CcSwitch.zsh`：cc-switch（Homebrew Cask，可选）
- `CodexCli.zsh`：Codex CLI（可选）
- `AntigravityCli.zsh`：Antigravity CLI（官方安装脚本，可选）

云端首次安装入口：

```sh
curl -fsSL "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.sh" | bash
```

`curl ... | bash` 入口只负责兼容常见远程执行形态；脚本主体会自动切换到 `/bin/zsh`。

---

## 关键约束

- 最低系统版本：macOS 12+。
- 包管理器：Homebrew。
- Node.js：通过 nvm 官方脚本安装 LTS，**只做 nvm（不支持 fnm / npm 全局包备份恢复）**；检测到当前 Node.js/npm 已满足最低版本时，安装生命周期最终状态应为 `Skipped`，不应标记为 `Success`。
- Profile 写入：
  - Homebrew 仅在 CCQ 执行官方安装成功后，按官方推荐追加 `eval "$(<brew路径> shellenv)"` 到 `~/.zprofile`。
  - `ccq` 快捷函数写入 `~/.zshrc`。
  - CCQ 自身写入优先使用 `# >>> Claude Code Quickstart >>>` 托管块；Homebrew 与 nvm 初始化遵循各自官方安装方式，不注入 CCQ 托管块。
- 配置 schema 与 Windows 共享：`~/.claude/settings.json`、`~/.claude.json`、`~/.claude/providers/`、`~/.ccq/mcp-meta.json`。
- Skills catalogue 与 ignore policy 共享 `installer/contracts/skills.json`；`IgnoredSkillNames` 中的 CCG Workflow 受管 Skills 不进入 macOS Skills 状态、更新或卸载候选。
- 禁止调用 Windows 专属机制：winget、注册表、MSI/EXE、Windows Terminal、Windows `$PROFILE`。
- 可选工具无自动路径或失败时返回 `ManualRequired` / `Unsupported`，不得计入 Success。

---

## 调试命令

```sh
# 查看步骤列表
zsh installer/macos/Install.zsh --list-steps

# 安装基础环境
zsh installer/macos/Install.zsh --group Basic

# 一键安装进阶必选组件
zsh installer/macos/Install.zsh --group Advanced --mode OneClick

# 选择安装进阶组件
zsh installer/macos/Install.zsh --group Advanced --mode Select

# 查看可更新组件
zsh installer/macos/Manage.zsh --action Update --list-updates

# 管理供应商 / MCP / Skills
zsh installer/macos/Manage.zsh --action Provider
zsh installer/macos/Manage.zsh --action Mcp
zsh installer/macos/Manage.zsh --action Skills
```

构建 macOS 单文件产物：

```sh
sh installer/build.sh
```

Windows PowerShell 构建入口只生成 Windows 产物，不再生成 macOS artifact。

生成产物：

- `dist/install.sh`
- `dist/manage.sh`

---

## MCP 架构对比

macOS 与 Windows 的 MCP 实现采用一致的架构：**Install 在步骤，Manage 在 Manager**。

### 功能分层

| 职责 | macOS (Mcp.zsh) | Windows (Mcp.ps1) | 共享 |
|------|-----------------|-------------------|------|
| **行数** | 416 | 2000 | - |
| **契约加载** | ✅ 完整实现 | ✅ 完整实现 | contracts/mcp-servers.json |
| **安装管道** | ✅ 完整实现（7 个函数） | ✅ 完整实现（6 个函数） | - |
| **Vault 管理** | ✅ 完整实现（flock） | ✅ 完整实现（Mutex） | ~/.ccq/mcp-meta.json schema |
| **Rules 同步** | ✅ 调用 McpManager | ✅ 调用 McpManager | mcp-manager.js |
| **Test/Install/Verify** | ✅ 契约完整 | ✅ 契约完整 | contracts/steps.json |
| **Update 函数** | ❌ 无（契约未注册） | ⚠️ 有但未注册（冗余） | - |

### macOS Mcp.zsh 函数清单（19 个）

**基础工具**（8 个）：
- `ccq_mcp_claude_json_path` / `ccq_mcp_settings_path` / `ccq_mcp_meta_path`
- `ccq_mcp_contract_ready` - 检测 Node.js 和契约文件
- `ccq_mcp_result` / `ccq_mcp_install_result` - 返回值格式化
- `ccq_mcp_tty` - TTY 检测
- `ccq_mcp_prompt_text` / `ccq_mcp_prompt_secret` - 交互输入

**契约与选择**（3 个）：
- `ccq_mcp_recommended_ids` - 推荐的 MCP Server ID
- `ccq_mcp_all_lines` - 契约完整列表
- `ccq_mcp_select_servers` - 交互选择菜单

**安装管道**（7 个）：
- `ccq_mcp_collect_credentials_json` - 收集凭据（JSON 格式）
- `ccq_mcp_build_server_entry_json` - 构建配置条目
- `ccq_mcp_apply_server_json` - 写入 .claude.json
- `ccq_mcp_vault_credentials` - 从 Vault 读取历史凭据
- `ccq_mcp_apply_meta_locked` - 持久化凭据到 Vault（带锁）
- `ccq_mcp_with_lock` - Vault 并发保护（zsystem flock / flock(1)）
- `ccq_mcp_install_server` - 单个 MCP Server 完整安装流程

**主要函数**（3 个）：
- `Test-McpInstalled` - 检测已安装的 MCP Server 数量
- `Install-Mcp` - MCP 安装主流程（选择 → 安装 → Rules 同步）
- `Verify-Mcp` - 验证安装结果

**实现特点**：
- 精简实现（416 行），大量使用 `node -e` 单行脚本处理 JSON
- 完全自给自足，不依赖 `core/McpManager.zsh` 的安装函数
- 已集成 Rules 同步调用（第 354-357 行）
- Vault 锁保护：优先使用 `zsystem flock`，兜底 `flock(1)`

### Windows Mcp.ps1 函数清单（26 个）

详见 [installer/windows/steps/CLAUDE.md](../windows/steps/CLAUDE.md) Mcp 章节。

**实现特点**：
- 完整实现（2000 行），PowerShell 原生 JSON 操作
- 7 个 Vault 管理函数（包括腐败恢复、原子写入、Mutex 锁）
- 6 个安装管道函数（RuntimeDeps、凭据收集、软件安装、.env 写入）
- `Update-Mcp` 函数存在但未在契约中注册（冗余，可选保留）

### 跨平台共享

**mcp-manager.js**（1180 行，零平台依赖）：
- 完整的 TUI 渲染（CJK-aware padding、箭头键菜单、确认对话框）
- CRUD 操作（computeStatus、disableServer、enableServer、removeServer）
- 凭据同步（syncCredentials）
- Rules 同步（syncRules，动态渲染 `~/.claude/rules/ccq-mcp-*.md`）
- Vault 管理（读写、锁保护、腐败恢复）

**contracts/mcp-servers.json**：
- MCP Server 定义（Name、Description、McpType、Command、Args、CredentialType）
- RuntimeDeps 定义（Node.js、npm 最低版本）
- 4 个核心 MCP：context7、deepwiki、exa、playwright

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│ macOS Install                                           │
├─────────────────────────────────────────────────────────┤
│ steps/Mcp.zsh (416 行)                                  │
│ ├── Test-McpInstalled                                   │
│ ├── Install-Mcp (调用 ccq_mcp_sync_rules)              │
│ ├── Verify-Mcp                                          │
│ └── 19 个内部函数（自给自足）                           │
└─────────────────────────────────────────────────────────┘
           ↓ Rules 同步
┌─────────────────────────────────────────────────────────┐
│ macOS Manage                                            │
├─────────────────────────────────────────────────────────┤
│ core/McpManager.zsh (175 行，轻量 wrapper)              │
│ ├── ccq_mcp_ensure_manager_script (部署 JS)            │
│ ├── ccq_mcp_manage_menu (调用 node mcp-manager.js)     │
│ ├── ccq_mcp_sync_rules (调用 node mcp-manager.js)      │
│ └── ccq_mcp_show_status (调用 node mcp-manager.js)     │
└─────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────┐
│ 跨平台共享                                              │
├─────────────────────────────────────────────────────────┤
│ ~/.ccq/scripts/mcp-manager.js (1180 行)                │
│ ├── 完整 TUI + CRUD                                     │
│ ├── Vault 管理 + Rules 渲染                            │
│ └── 零平台依赖（纯 Node.js）                           │
└─────────────────────────────────────────────────────────┘
```

### 对齐验证

✅ **功能等价**：macOS 和 Windows 都实现了 Test / Install / Verify 契约
✅ **架构一致**：Install 在步骤（自给自足），Manage 在 Manager（wrapper + JS）
✅ **共享组件**：mcp-manager.js、contracts、Vault schema
✅ **职责分离**：安装步骤不依赖 Manager 的安装函数

**结论**：macOS Mcp.zsh 无需修改，已完全对齐。
