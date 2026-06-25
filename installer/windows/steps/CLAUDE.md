# installer/windows/steps/ — Windows 安装步骤模块

> 面包屑：[根目录](../../../CLAUDE.md) › [installer/](../../CLAUDE.md) › windows/ › steps/
> 生成时间：2026-06-23 (Phase 8：Mcp.ps1 整体废弃删除，MCP 管理统一由 TUI 接管；install 仅装 Basic 三步；Advanced 步骤迁 Manage TUI)

---

## 步骤契约（HC-2）

每个步骤文件**必须**实现三个函数（函数名使用语义化命名，无数字前缀）：

```powershell
# 检测是否已安装/已完成
function Test-<StepId>Installed {
    return @{
        IsInstalled = [bool]
        Version     = [string]   # 版本号，不适用时为 ""
        Data        = @{}        # 传递给 StepResult.Data
        Message     = [string]   # 状态说明
    }
}

# 执行安装
function Install-<StepId> {
    return @{
        Success      = [bool]
        ErrorMessage = [string]
        Data         = @{}       # 版本号等写入此处
    }
}

# 验证安装结果（可选，不需要时返回 @{Success=$true}）
function Verify-<StepId> {
    return @{ Success = [bool]; ErrorMessage = [string] }
}
```

### Update 函数契约（可选）

可更新步骤额外实现 `Update-<StepId>` 函数，由 Registry 的 `UpdateFunction` 字段注册：

```powershell
# 执行更新（仅可更新步骤需要实现）
function Update-<StepId> {
    return @{
        Success      = [bool]
        ErrorMessage = [string]
        Data         = @{}
        UpdatedItems = @(        # 变更记录数组
            "<Scope>::<Target>::<Change>"
            # 示例: "npm::claude-code::1.2.3->1.3.0"
            # 示例: "config::env.KEY::added"
            # 示例: "noop::StepId::no-change"
        )
    }
}
```

> install 仅装 Basic 三步（NodeJS / Git / ClaudeCode）。原 Advanced 步骤（Ccline / ClaudeConfig / ClaudeMd / OpenSpec / CodexCli / AntigravityCli）已迁移 Manage TUI 并从 install 链删除（步骤文件、注册表条目、契约条目全部移除），其安装/更新/卸载由 `tui/` 工具管理与配置/提示词菜单承载。
> Windows Basic 步骤中 ClaudeCode 注册 Update 函数；NodeJS、Git 不参与统一更新（UpdateFunction 为空）。
> CcgWorkflow / Mcp / CcSwitch / ApiKey 步骤已删除，相关能力统一由 Manage TUI 接管（详见根 [CLAUDE.md](../../../CLAUDE.md) 的 Manage TUI 架构）。
> macOS 通过 `installer/contracts/steps.json` 复用 StepId。

> **注意**：Bootstrap.ps1 的 `Invoke-StepLifecycle` / `Invoke-UpdateLifecycle` 同时兼容 `bool` 和 `hashtable` 两种返回类型（向后兼容旧步骤）。

---

## 步骤总览

Windows 与 macOS 保持相同 StepId、分组、依赖和用户可见能力边界；跨平台元数据以 `installer/contracts/steps.json` 为契约，平台实现分别位于 `installer/windows/steps/*.ps1` 与 `installer/macos/steps/*.zsh`。

| StepId | 名称 | 文件 | 可选 | SkipIfInstalled | 可更新 | 主要依赖 | 分组 |
|--------|------|------|:----:|:---------------:|:------:|---------|------|
| NodeJS | Node.js (fnm) | `NodeJS.ps1` | — | ✓ | — | 无 | 基础 |
| Git | Git | `Git.ps1` | — | ✓ | — | 无 | 基础 |
| ClaudeCode | Claude Code | `ClaudeCode.ps1` | — | ✓ | ✓ | NodeJS | 基础 |
| Ccline | ccline | `Ccline.ps1` | — | ✓ | ✓ | ClaudeCode | 进阶 |
| ClaudeConfig | Claude 基础配置 | `ClaudeConfig.ps1` | — | ✓ | ✓ | ClaudeCode | 进阶 |
| ClaudeMd | CLAUDE.md 配置 | `ClaudeMd.ps1` | — | ✓ | ✓ | ClaudeConfig | 进阶 |
| OpenSpec | OpenSpec CLI | `OpenSpec.ps1` | — | ✓ | ✓ | NodeJS | 进阶 |
| CodexCli | Codex CLI | `CodexCli.ps1` | **✓** | ✓ | ✓ | NodeJS | 进阶 |
| AntigravityCli | Antigravity CLI | `AntigravityCli.ps1` | **✓** | ✓ | ✓ | 无 | 进阶 |

---

## NodeJS — Node.js (fnm)

**文件**：`NodeJS.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`, `Profile.ps1`

**安装流程**：
1. 检测 `fnm` / `node` 是否已安装
2. 用 `winget install Schniz.fnm` 安装 fnm
3. 写入 `$PROFILE` 标记块（`fnm env` 初始化）
4. `Refresh-SessionPath` + `fnm install --lts`
5. 验证 `node --version` / `npm --version`

---

## Git — Git

**文件**：`Git.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`

**安装流程**：`winget install Git.Git` → 配置 4 项 Git 推荐设置 → 写入 Git Bash UTF-8（Python + PowerShell wrapper）→ 验证 `git --version` / `git config --list --global`

---

## ClaudeCode — Claude Code

**文件**：`ClaudeCode.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`

**安装流程**：`npm install -g @anthropic-ai/claude-code` → 验证 `claude --version`

---

## Ccline — ccline

**文件**：`Ccline.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`

**包名**：`@cometix/ccline`（scoped package）

**安装流程**：
1. 前置检查（Claude Code + npm）
2. `npm install -g @cometix/ccline`
3. 配置 `statusLine`（官方 schema）写入 `~/.claude/settings.json`
4. 执行 `ccline --patch <cli.js>` 对 Claude Code 进行 patch

**statusLine 配置格式（Claude Code 官方 schema）**：
```json
{
  "statusLine": {
    "type": "command",
    "command": "ccline",
    "padding": 0
  }
}
```

**检测条件**：`$settings.statusLine.type -eq "command"`

**ccline patch**：安装后自动定位 `npm prefix/node_modules/@anthropic-ai/claude-code/cli.js`，执行 `ccline --patch` 注入状态栏支持。失败时仅警告不中断。

---

## ClaudeConfig — Claude 基础配置

**文件**：`ClaudeConfig.ps1`
**配置路径**：`$env:USERPROFILE\.claude\settings.json`（与供应商配置同一文件）

**写入策略**：声明式字段管理，读取 -> 补缺失 -> 原子写入。仅管理 ClaudeConfig 自有字段，不覆盖供应商配置（Provider TUI 写入的 Base URL/模型环境键）、Ccline（statusLine）或用户自定义配置。

**ClaudeConfig 管辖的 env 字段**：

| 字段 | 默认值 | 写入策略 |
|------|--------|----------|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `90` | 仅补缺失 |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | `0` | 仅补缺失 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | 仅补缺失 |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | 仅补缺失 |
| `DISABLE_INSTALLATION_CHECKS` | `1` | 仅补缺失 |
| `MAX_THINKING_TOKENS` | `31999` | 仅补缺失 |
| `CODEAGENT_POST_MESSAGE_DELAY` | `1` | 仅补缺失（ccg-workflow推荐配置） |
| `CODEX_TIMEOUT` | `7200` | 仅补缺失（ccg-workflow推荐配置） |
| `BASH_DEFAULT_TIMEOUT_MS` | `600000` | 仅补缺失（ccg-workflow推荐配置） |
| `BASH_MAX_TIMEOUT_MS` | `3600000` | 仅补缺失（ccg-workflow推荐配置） |

**其他 ClaudeConfig 管辖字段**：

| 字段 | 默认值 | 写入策略 |
|------|--------|----------|
| `language` | `简体中文` | 仅补缺失 |
| `plansDirectory` | `.claude/plan` | Install 补缺失 / Update 对齐 |
| `permissions.allow` | 14 项基础权限 | 合并（只添加缺失项，不删除已有项） |
| `attribution` | `{ commit: "", pr: "" }` | 仅补缺失 |

**ClaudeConfig 不触碰的字段**：`model`（用户自行选择）、`statusLine`（Ccline）、`hooks`（用户/插件）、`outputStyle`（用户自定义）、`mcpServers`（Mcp）、`env.ANTHROPIC_AUTH_TOKEN`/`env.ANTHROPIC_BASE_URL`/`env.ANTHROPIC_DEFAULT_HAIKU_MODEL`/`env.ANTHROPIC_DEFAULT_OPUS_MODEL`/`env.ANTHROPIC_DEFAULT_SONNET_MODEL`/`env.ANTHROPIC_MODEL`/`env.CLAUDE_CODE_SUBAGENT_MODEL`/`env.CLAUDE_CODE_EFFORT_LEVEL`/`env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK`/`env.API_TIMEOUT_MS`/`env.ENABLE_TOOL_SEARCH`（供应商配置）

> **注意**：原 CcgWorkflow 管辖的 4 个 env（`CODEAGENT_POST_MESSAGE_DELAY` / `CODEX_TIMEOUT` / `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`）已迁移为 ClaudeConfig 推荐配置项，现由 ClaudeConfig fill-missing 管理（见上方 env 字段表），不再属于不触碰字段。

> **注意**：statusLine 配置完全由 Ccline 步骤负责，ClaudeConfig 不触碰 statusLine 字段。

---

## ClaudeMd — CLAUDE.md 配置

**文件**：`ClaudeMd.ps1`
**目标**：`$env:USERPROFILE\.claude\CLAUDE.md`
**依赖**：无（不依赖 Claude 基础配置）

**功能**：生成全局 Claude Code 工作规范主文件。~100 行（确保在 token 截断限制内完整可见）。通用工作流原则已并入主 `CLAUDE.md`；MCP rules 已停管（Phase 8），不再生成 `rules/ccq-mcp-*.md`。

**命名约定**：CCQ 管理的 rules 文件统一使用 `ccq-` 前缀，与用户自定义 rules 隔离。

**写入方式**：`Write-FileAtomically -FilePath`（**注意参数名**）。主文件采用原子覆写（直接替换，无备份）。

**检测条件**：`Test-ClaudeMdInstalled` 检查主文件 3 个关键标识。

---

## Mcp — MCP Server 配置（已废弃）

Mcp.ps1 已于 Phase 8 整体废弃删除，MCP 管理统一由 Manage TUI 接管：安装/凭据/配置/Vault/权限/CRUD 全走 TUI MCP 视图（`i` 键选装内置 MCP，复用 `saveMcpServer` + Vault 管道）。install 链不再含 Mcp 步骤，MCP rules 同步（`Sync-McpRules`）已停管删除。详见根 [CLAUDE.md](../../../CLAUDE.md) 的 Manage TUI 架构。

---

## CcgWorkflow — CCG 工作流（已迁移至 Manage TUI）

CcgWorkflow 已从安装步骤降级为 **Manage TUI 工具项**，不再作为 `CcgWorkflow.ps1` / `CcgWorkflow.zsh` 安装步骤存在。其检测、安装、更新统一由 manage TUI 维护（`tui/src/core/tools-install.ts` 安装、`tui/src/core/update.ts` 版本检测，经 `npx ccg-workflow@latest init` + mcpServers 快照保护）。

变更要点：
- **env**：原 CcgWorkflow 管辖的 4 个 env（`CODEAGENT_POST_MESSAGE_DELAY` / `CODEX_TIMEOUT` / `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`）已迁移为 **ClaudeConfig 推荐配置项**（`tui/contracts/claude-config.json` 的 `ClaudeConfigEnvDefaults`，描述标注「ccg-workflow推荐配置」，fill-missing 写入）。详见 ClaudeConfig 章节。
- **历史 rules 清理**：不再处理（`managedRuleFiles` 逻辑随步骤文件删除）。
- **版本源**：本地版本取自 `~/.claude/.ccg/config.toml` 的 `version`（非 codeagent-wrapper 二进制版本），远程版本经 `npm view ccg-workflow version`。

---

## CodexCli — Codex CLI（可选）

**文件**：`CodexCli.ps1`

```powershell
# 正确调用方式（无 -DisplayName 参数）
$installOut = Invoke-NpmGlobalInstall -PackageName "codex-cli"
```

---

## AntigravityCli — Antigravity CLI（可选）

**文件**：`AntigravityCli.ps1`
**依赖**：无（独立二进制 CLI，不依赖 Node.js）

**命令名**：`agy`

**Windows 安装方式**：官方未提供 npm 包，Windows 通过远程 PowerShell 安装脚本安装：

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

封装在 `Invoke-AntigravityCliInstaller`，通过 `pwsh -NoProfile -ExecutionPolicy Bypass -Command` 执行。官方脚本将 `agy.exe` 安装到 `%LOCALAPPDATA%\Antigravity\` 并更新用户 PATH。

**macOS 安装方式**：`installer/macos/steps/AntigravityCli.zsh` 使用官方 macOS/Linux 安装脚本：

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

安装后检测 `agy --version`，并补充当前会话 PATH 的 `~/.local/bin`。安装或更新失败时返回 `ManualRequired` 与手动指引，不伪报 Success。

**版本检测**：统一通过 `agy --version` 完成（`Get-AntigravityCliVersion`），无 npm list 路径。

**更新策略**：Windows 优先执行 `agy update`（官方自更新），命令不可用或失败时回退到官方安装脚本覆盖安装；macOS 同样优先尝试 `agy update`，随后通过 `install.sh` 刷新。`UpdatedItems` 使用 `agy::antigravity-cli::<old>-><new>`、`agy::antigravity-cli::installed` 或 `noop::AntigravityCli::no-change`。

**更新检测**：非 npm 包，无法获取远程最新版本、无法判断是否有更新，`Get-UpdateStatus` 将其 `HasUpdate` 置为 `$null`（语义为"无法获取更新状态"，默认勾选），执行 `agy update` 由官方 CLI 自行判断是否有新版本。

---

## OpenSpec — OpenSpec CLI（可选）

**文件**：`OpenSpec.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`

**安装流程**：`npm install -g @fission-ai/openspec` → PATH 刷新 → 验证 `openspec --version` / `openspec --help`

---

## 新增步骤模板

添加新步骤时遵循此模板：

```powershell
#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\core\Ui.ps1"
. "$PSScriptRoot\..\core\Process.ps1"

function Test-<StepId>Installed {
    $result = @{ IsInstalled = $false; Version = ""; Data = @{}; Message = "" }
    try {
        # 检测逻辑
        $result.IsInstalled = $true
    } catch {
        $result.Message = $_.Exception.Message
    }
    return $result
}

function Install-<StepId> {
    $result = @{ Success = $false; ErrorMessage = ""; Data = @{} }
    try {
        # 安装逻辑
        $result.Success = $true
    } catch {
        $result.ErrorMessage = $_.Exception.Message
        Write-UiDanger $result.ErrorMessage
    }
    return $result
}

function Verify-<StepId> {
    $result = @{ Success = $false; ErrorMessage = "" }
    try {
        # 验证逻辑
        $result.Success = $true
    } catch {
        $result.ErrorMessage = $_.Exception.Message
    }
    return $result
}
```

在 `core/Registry.ps1` 的 `Get-StepRegistry` 中注册新步骤条目（含 StepId、函数名、依赖、分组、Order 等），依赖关系和分组信息均从 Registry 自动派生，无需额外维护。
