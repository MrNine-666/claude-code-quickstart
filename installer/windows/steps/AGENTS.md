# installer/windows/steps/ — Windows 安装步骤模块

> 面包屑：[根目录](../../../AGENTS.md) › [installer/](../../AGENTS.md) › windows/ › steps/
> 生成时间：2026-07-03 (Phase：Windows/macOS NodeJS 均采用“现有 node/npm 版本达标即跳过”策略；Windows 不达标时优先在当前 provider 内安装/更新到 LTS，无法安全修复时才使用 nvm-windows / Node.js 直装兜底；废弃跨 provider 迁移)

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

> install 仅装 bootstrap Basic 两步（NodeJS / Git）；Claude Code / Codex 均由 `ccq` 的「工具管理」按需安装、更新与卸载。
> `ClaudeCode.ps1` 为历史步骤文件/待删参考，不再被 `installer/contracts/steps.json`、Registry fallback 或 install 入口消费；Claude Code 生命周期以 `tui/src/core/tools-install.ts` / `tools-manage.ts` 为单一真理源。
> CcgWorkflow / Mcp / CcSwitch / ApiKey 步骤已删除，相关能力统一由 Manage TUI 接管（详见根 [AGENTS.md](../../../AGENTS.md) 的 Manage TUI 架构）。
> macOS 通过 `installer/contracts/steps.json` 复用 StepId。

> **注意**：Bootstrap.ps1 的 `Invoke-StepLifecycle` / `Invoke-UpdateLifecycle` 同时兼容 `bool` 和 `hashtable` 两种返回类型（向后兼容旧步骤）。

---

## 步骤总览

Windows 与 macOS 保持相同 StepId、分组、依赖和用户可见能力边界；跨平台元数据以 `installer/contracts/steps.json` 为契约，平台实现分别位于 `installer/windows/steps/*.ps1` 与 `installer/macos/steps/*.zsh`。

| StepId | 名称 | 文件 | 可选 | SkipIfInstalled | 可更新 | 主要依赖 | 分组 |
|--------|------|------|:----:|:---------------:|:------:|---------|------|
| NodeJS | Node.js (runtime-first, nvm/direct fallback) | `NodeJS.ps1` | — | ✓ | — | 无 | 基础 |
| Git | Git | `Git.ps1` | — | ✓ | — | 无 | 基础 |
| ClaudeCode | Claude Code | `ClaudeCode.ps1` | 历史保留 | ✓ | ✓ | NodeJS | 不再由 install 消费 |

---

## NodeJS — Node.js (现有运行时优先 / nvm-windows 或直装兜底)

**文件**：`NodeJS.ps1`（子模块：`NodeJS-Detect.ps1` / `NodeJS-Common.ps1` / `NodeJS-Nvm.ps1` / `NodeJS-Direct.ps1`）
**依赖核心模块**：`Process.ps1`, `Ui.ps1`, `Net.ps1`

**支持 provider**：优先复用当前可用的 Node.js 运行时（无论来源是 fnm / nvm / direct / portable / mixed）；只要 `node`/`npm` 可用且 Node.js 版本满足要求即直接跳过，不弹迁移菜单、不清理环境。版本不达标时优先根据 active provider 原地安装/切换 LTS：fnm 使用现有 `fnm`，nvm 使用现有 nvm-windows，direct 使用 winget/MSI 更新；portable / unknown / none 无法安全原地修复时，才提供 nvm-windows（可切换版本，推荐）/ Node.js 直装（简单，不可切换）作为兜底。

**安装流程**：
1. 检测当前 `node` / `npm` 与 Node.js 版本；版本达标则直接跳过
2. 根据 `node`/`npm` 实际解析路径推断 active provider（fnm / nvm / direct / portable / unknown）
3. active provider 为 fnm / nvm / direct 且可修复时，提示是否通过当前工具安装/切换 Node.js LTS
4. active provider 为 portable / unknown / none，或当前工具不可用时，进入 nvm-windows / Node.js 直装兜底选择
5. 不卸载现有 provider，不清理 PATH，不迁移 npm 全局包
6. 验证 `node --version` / `npm --version`，配置 npm 镜像（国内网络）

---

## Git — Git

**文件**：`Git.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`

**安装流程**：`winget install Git.Git` → 配置 4 项 Git 推荐设置 → 写入 Git Bash UTF-8（Python + PowerShell wrapper）→ 验证 `git --version` / `git config --list --global`

---

## ClaudeCode — Claude Code（历史保留 / 不再由 install 消费）

**文件**：`ClaudeCode.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`

**状态**：该步骤文件仅作为历史兼容/待删参考保留，不再出现在 `installer/contracts/steps.json` 或 Registry fallback 的 Basic 分组中。Claude Code 安装、更新、卸载由 `ccq` →「工具管理」调用 TUI tools lifecycle 承担。

**历史安装流程**：`npm install -g @anthropic-ai/claude-code` → 验证 `claude --version`

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
