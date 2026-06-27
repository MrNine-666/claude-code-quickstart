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
