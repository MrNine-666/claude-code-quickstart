#Requires -Version 5.1
# Install.ps1 - CCQ（安装入口）
# 功能: 首次安装入口（Onboarding），PS5.1 单运行时直跑——前置检测 + 基础环境直装
#       （NodeJS / Git）+ ccq 下载引导；Claude Code / Codex 由 ccq 工具管理安装

param(
    [switch]$ListSteps,
    [ValidateSet("Normal", "Developer")]
    [string]$OutputMode = "Normal",

    [string]$CcqReleaseTag = "__CCQ_RELEASE_TAG__"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 将 param 默认值显式提升到 script 作用域（HC-15 trampoline 兼容）。
# dist/install.ps1 经 irm|iex 走 ASCII trampoline：真实脚本由 [scriptblock]::Create 还原后
# 以 & $sb 执行，此链路下 param 变量不会自动绑定到 $script: 作用域；而
# Get-CcqReleaseDownloadBaseUrl 在 StrictMode 下读 $script:CcqReleaseTag 会抛"未设置"异常，
# 导致 ccq 下载阶段整个安装器崩溃。源码 -File 模式碰巧能跑通，release 模式必现。
$script:CcqReleaseTag = $CcqReleaseTag

# ─── 中文编码修复（必须在 PS 版本检查前执行，不能移入 core/ 模块）─────────────
# 注意：此块与 Manage.ps1 中的相同代码共用 _CcqKernel32Cp 类名。
#       因为必须在 dot-source core/ 之前运行，无法提取为共享模块。
try {
    if (-not ([System.Management.Automation.PSTypeName]'_CcqKernel32Cp').Type) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class _CcqKernel32Cp {
    [DllImport("kernel32.dll")] public static extern bool SetConsoleOutputCP(uint cp);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleCP(uint cp);
}
'@ -ErrorAction SilentlyContinue
    }
    [_CcqKernel32Cp]::SetConsoleOutputCP(65001) | Out-Null
    [_CcqKernel32Cp]::SetConsoleCP(65001) | Out-Null
} catch { }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$script:WindowsRoot = if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { "" } else { $PSScriptRoot }
$script:InstallerRoot = if ([string]::IsNullOrWhiteSpace($script:WindowsRoot)) { "" } else { Split-Path -Parent $script:WindowsRoot }

# ─── Dot-source 核心模块 ────────────────────────────────────────────────────

. "$script:WindowsRoot\core\Json.ps1"
. "$script:WindowsRoot\core\Ui.ps1"
. "$script:WindowsRoot\core\Process.ps1"
. "$script:WindowsRoot\core\Profile.ps1"
. "$script:WindowsRoot\core\Update.ps1"
. "$script:WindowsRoot\core\Admin.ps1"
. "$script:WindowsRoot\core\Net.ps1"
. "$script:WindowsRoot\core\Registry.ps1"
. "$script:WindowsRoot\core\Bootstrap.ps1"

# ─── Dot-source 所有步骤模块（从 Registry 动态加载）──────────────────────────

$stepFiles = Get-StepFiles
if (-not [string]::IsNullOrWhiteSpace($script:WindowsRoot)) {
    foreach ($stepFile in $stepFiles) {
        $normalizedStepFile = $stepFile -replace '\\', '/'
        $stepPath = if ($normalizedStepFile -like "windows/*") {
            Join-Path $script:InstallerRoot $stepFile
        } else {
            Join-Path $script:WindowsRoot $stepFile
        }
        . $stepPath
    }
}

# ─── 初始化输出模式（步骤加载之后，避免被重复 dot-source 覆盖）──────────────

Set-CcqOutputMode -Mode ([CcqOutputMode]$OutputMode)

# ─── 步骤注册表（从共享 Registry 获取，消除重复定义）─────────────────────────

$script:StepRegistry = Get-StepRegistry

# ─── 步骤分组定义（从共享 Registry 获取）─────────────────────────────────────

$script:StepGroups = Get-StepGroups

# ─── 核心函数 ───────────────────────────────────────────────────────────────

function Get-DependencyClosure {
    <#
    .SYNOPSIS
    计算选定步骤的完整依赖闭包（保留完整依赖链，已安装步骤由生命周期自动跳过）
    .PARAMETER SelectedStepIds
    用户选择的步骤 ID 数组
    .RETURNS
    @{ OriginalSelection; AutoAdded; FinalPlan }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$SelectedStepIds
    )

    $dependencies = Get-StepDependencies
    $allRequired = [System.Collections.Generic.HashSet[string]]::new()

    # 递归收集传递依赖
    function Collect-Deps {
        param([string]$StepId)
        if ($allRequired.Contains($StepId)) { return }
        [void]$allRequired.Add($StepId)
        if ($dependencies.ContainsKey($StepId)) {
            foreach ($dep in $dependencies[$StepId]) {
                Collect-Deps -StepId $dep
            }
        }
    }

    foreach ($id in $SelectedStepIds) {
        Collect-Deps -StepId $id
    }

    # 不在此处过滤已安装步骤，避免与 Test-StepDependencies 的状态判定冲突
    # 已安装步骤由 Invoke-StepLifecycle 的跳过机制自动处理（SkipIfInstalled / AutoAdded skip）

    # 安全地将 HashSet 转换为数组
    $allRequiredArray = @()
    if ($allRequired.Count -gt 0) {
        $allRequiredArray = @($allRequired)
    }

    # 强制类型声明确保 $finalPlan 始终是数组
    [string[]]$finalPlan = if ($allRequiredArray.Count -gt 0) {
        @(Get-ExecutionOrder -StepIds $allRequiredArray)
    } else {
        @()
    }

    # 识别自动补齐的依赖
    [string[]]$autoAdded = @()
    if ($finalPlan -and $finalPlan.Count -gt 0) {
        $autoAdded = @($finalPlan | Where-Object { $_ -notin $SelectedStepIds })
    }

    return @{
        OriginalSelection = $SelectedStepIds
        AutoAdded         = $autoAdded
        FinalPlan         = $finalPlan
    }
}

function Show-ExecutionPlan {
    <#
    .SYNOPSIS
    显示执行计划并请求确认（无条件显示）
    .RETURNS
    $true = 用户确认执行，$false = 取消
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$OriginalSelection,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$AutoAdded,

        [Parameter(Mandatory = $true)]
        [string[]]$FinalPlan
    )

    Write-Host ""

    if ($AutoAdded -and $AutoAdded.Count -gt 0) {
        Write-UiWarning "以下依赖将自动纳入执行计划（已安装项会自动跳过）："
        foreach ($stepId in $AutoAdded) {
            $stepConfig = Get-StepConfigById -StepId $stepId
            $name = if ($stepConfig) { $stepConfig.StepName } else { $stepId }
            Write-UiInfo "  + $name（自动补齐）"
        }
        Write-Host ""
    }

    Write-UiPrimary "执行计划："

    $orderedPlan = @(Get-ExecutionOrder -StepIds $FinalPlan)
    $index = 0
    foreach ($stepId in $orderedPlan) {
        $index++
        $stepConfig = Get-StepConfigById -StepId $stepId
        $name = if ($stepConfig) { $stepConfig.StepName } else { $stepId }
        $tag = if ($AutoAdded -and $AutoAdded.Count -gt 0 -and $stepId -in $AutoAdded) { "(依赖补齐)" } else { "" }
        Write-UiInfo "  $index. $name $tag"
    }

    Write-Host ""
    $confirmIndex = Show-SingleSelectMenu `
        -Title "确认执行以上计划？" `
        -Options @("是，开始执行", "否，取消")

    return ($confirmIndex -eq 0)
}


function Invoke-GroupedInstall {
    <#
    .SYNOPSIS
    执行分组安装（依赖闭包 + 确认 + 拓扑排序 + 执行）
    .PARAMETER StepIds
    目标步骤 ID 数组
    .PARAMETER State
    安装状态对象
    .PARAMETER SkipConfirmation
    跳过分组执行计划二次确认（install 开头已统一确认时使用）
    .RETURNS
    执行结果统计
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$StepIds,

        [Parameter(Mandatory = $true)]
        [InstallState]$State,

        [switch]$SkipConfirmation
    )

    # 计算依赖闭包
    $closure = Get-DependencyClosure -SelectedStepIds $StepIds

    if (-not $closure.FinalPlan -or $closure.FinalPlan.Count -eq 0) {
        Write-Host ""
        Write-UiSuccess "所有选定步骤已安装，无需操作"
        return @{ Total = 0; Success = 0; Failed = 0; Skipped = 0 }
    }

    # install 开头已统一确认时，Basic 分组不再二次确认
    if (-not $SkipConfirmation) {
        $confirmed = Show-ExecutionPlan `
            -OriginalSelection $closure.OriginalSelection `
            -AutoAdded $closure.AutoAdded `
            -FinalPlan $closure.FinalPlan

        if (-not $confirmed) {
            Write-UiWarning "安装已取消"
            return @{ Total = 0; Success = 0; Failed = 0; Skipped = 0 }
        }
    }

    # 拓扑排序
    $orderedStepIds = @(Get-ExecutionOrder -StepIds $closure.FinalPlan)
    $autoAddedSet = @{}
    foreach ($sid in @($closure.AutoAdded)) {
        $autoAddedSet[$sid] = $true
    }

    $results = @{
        Total           = $orderedStepIds.Count
        Success         = 0
        Failed          = 0
        Skipped         = 0
        ExecutedStepIds = $orderedStepIds
    }

    $stepIndex = 0
    foreach ($stepId in $orderedStepIds) {
        $stepIndex++

        $stepConfig = Get-StepConfigById -StepId $stepId
        if (-not $stepConfig) {
            Write-UiWarning "未找到步骤配置: $stepId，跳过" -Level Debug
            $results.Skipped++
            continue
        }

        Write-Host ""
        Write-UiDim "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -Level Debug
        Write-UiPrimary "步骤 $stepIndex / $($results.Total)：$($stepConfig.StepName)"
        Write-UiDim "     $($stepConfig.Description)" -Level Detail
        Write-UiDim "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -Level Debug

        # 检查前置依赖
        $depCheck = Test-StepDependencies -StepId $stepId -State $State
        if (-not $depCheck.CanExecute) {
            if ($depCheck.FailedDependencies -and $depCheck.FailedDependencies.Count -gt 0) {
                $failedNames = $depCheck.FailedDependencies | ForEach-Object {
                    $cfg = Get-StepConfigById -StepId $_
                    if ($cfg) { $cfg.StepName } else { $_ }
                }
                Write-UiDanger "前置依赖失败，跳过此步骤: $($failedNames -join ', ')"
            } else {
                $missingNames = $depCheck.MissingDependencies | ForEach-Object {
                    $cfg = Get-StepConfigById -StepId $_
                    if ($cfg) { $cfg.StepName } else { $_ }
                }
                Write-UiWarning "前置依赖未完成，跳过此步骤: $($missingNames -join ', ')"
            }
            $results.Skipped++
            continue
        }

        # 构建步骤执行参数
        $stepParams = @{
            StepId          = $stepConfig.StepId
            StepName        = $stepConfig.StepName
            TestFunction    = $stepConfig.TestFunction
            InstallFunction = $stepConfig.InstallFunction
            State           = $State
        }

        if ($stepConfig.VerifyFunction) {
            $stepParams.VerifyFunction = $stepConfig.VerifyFunction
        }
        if ($stepConfig.SkipIfInstalled) {
            $stepParams.SkipIfInstalled = $true
        }
        if ($stepConfig.ContainsKey("SkipIfInstalledWhenAutoAdded") -and [bool]$stepConfig["SkipIfInstalledWhenAutoAdded"]) {
            $stepParams.SkipIfInstalledWhenAutoAdded = $true
        }
        if ([bool]$autoAddedSet[$stepId]) {
            $stepParams.IsAutoAddedDependency = $true
        }

        $stepResult = Invoke-StepLifecycle @stepParams

        switch ($stepResult.Status) {
            ([StepStatus]::Success) { $results.Success++ }
            ([StepStatus]::Skipped) { $results.Skipped++ }
            ([StepStatus]::Failed)  {
                $results.Failed++
                Write-UiDanger "步骤 [$($stepConfig.StepName)] 执行失败，错误已记录"
            }
        }
    }

    return $results
}

# ─── CCQ 可执行文件下载确认 ───────────────────────────────────────────────────

function Get-CcqReleaseTag {
    <#
    .SYNOPSIS
    返回当前安装器对应的 Release tag；源码模式通常为不可比较的占位值。
    #>
    param()

    $tag = [Environment]::GetEnvironmentVariable("CCQ_RELEASE_TAG", "Process")
    if ([string]::IsNullOrWhiteSpace($tag)) {
        $tag = $script:CcqReleaseTag
    }

    return $tag.Trim()
}

function Get-CcqReleaseTargetVersion {
    <#
    .SYNOPSIS
    从 Release tag 提取可与 ccq --version 比较的目标版本。
    #>
    param()

    $tag = Get-CcqReleaseTag
    if ($tag -notlike 'v*') {
        return ""
    }

    $version = ConvertTo-CcqComparableVersion -Version $tag
    if ($version -notmatch '^\d+\.\d+\.\d+') {
        return ""
    }

    return $version
}

function Get-CcqReleaseDownloadBaseUrl {
    <#
    .SYNOPSIS
    解析 ccq 可执行文件下载基址；tag 构建使用当前 Release，源码运行回退 latest。
    #>
    param()

    $overrideUrl = [Environment]::GetEnvironmentVariable("CCQ_RELEASE_DOWNLOAD_BASE_URL", "Process")
    if (-not [string]::IsNullOrWhiteSpace($overrideUrl)) {
        return $overrideUrl.TrimEnd('/')
    }

    $tag = Get-CcqReleaseTag

    # 哨兵判断改用"tag 是否以 v 开头"（与 build.ps1 的 GITHUB_REF_NAME -like 'v*' 约定一致）。
    # 不可比对占位符字面量：build 用全文 Replace 注入 tag，会把此处的 "__CCQ_RELEASE_TAG__" 一并
    # 替换成实际 tag，导致 `$tag -ne $tag` 恒为 false → 永远走 latest 兜底（已实测复现）。
    if ($tag -like 'v*') {
        return "https://github.com/MrNine-666/claude-code-quickstart/releases/download/$tag"
    }

    return "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download"
}

function Confirm-CcqExecutableDownload {
    <#
    .SYNOPSIS
    在 install 末尾弹出确认，询问用户是否下载 ccq 可执行文件到 PATH 目录
    .DESCRIPTION
    遵守 TDR-6：用户拒绝则跳过；确认则按平台架构下载到 %USERPROFILE%\.local\bin\ccq.exe
    并通过注册表 HKCU\Environment 加入用户 PATH（非 Profile）。
    #>
    param()

    Write-UiPrimary "ccq 管理工具安装"
    Write-Host ""
    Write-UiInfo "ccq 是 Claude Code Quickstart 的管理控制台，提供以下功能："
    Write-UiInfo "  • 供应商管理（Provider 配置）"
    Write-UiInfo "  • MCP Server 管理"
    Write-UiInfo "  • Skills 管理"
    Write-UiInfo "  • 提示词配置"
    Write-UiInfo "  • 配置文件管理"
    Write-UiInfo "  • 工具管理（安装/更新 Claude Code、Codex、CodeGraph、OpenSpec 等）"
    Write-Host ""

    # 1. 已安装时先比较当前版本与安装器 Release 版本。
    $installed = Test-CcqExecutableInstalled
    $targetVersion = Get-CcqReleaseTargetVersion
    if ($installed.IsInstalled) {
        Write-UiSuccess "✓ ccq 可执行文件已安装: $($installed.Path)"
        Write-UiInfo "  当前版本: $($installed.Version)"

        if ([string]::IsNullOrWhiteSpace($targetVersion)) {
            Write-UiWarning "无法确定安装器目标版本，已保留现有 ccq"
            Write-UiDim "  如需更新，请使用正式 Release 安装脚本或在 ccq 中执行更新"
            return
        }

        Write-UiInfo "  目标版本: $targetVersion"
        $currentVersion = ConvertTo-CcqComparableVersion -Version $installed.Version
        if ([string]::Equals($currentVersion, $targetVersion, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-UiSuccess "✓ 当前版本与目标版本一致，无需覆盖"
            return
        }

        Write-UiWarning "检测到 ccq 版本不一致"
        $overwriteDecision = Show-SingleSelectMenu `
            -Title "是否覆盖现有文件？" `
            -Options @("是，覆盖为 $targetVersion", "否，保留当前版本 $currentVersion") `
            -DefaultIndex 1

        if ($overwriteDecision -ne 0) {
            Write-UiInfo "已保留当前 ccq 版本: $currentVersion"
            return
        }

        Write-UiWarning "将使用目标版本 $targetVersion 覆盖当前版本 $currentVersion"
    } else {
        $decision = Show-SingleSelectMenu `
            -Title "是否现在下载 ccq 可执行文件到 PATH 目录？" `
            -Options @("是，下载 ccq", "否，稍后手动安装") `
            -DefaultIndex 0

        if ($decision -ne 0) {
            Write-Host ""
            Write-UiInfo "已跳过 ccq 可执行文件下载"
            Write-UiDim "  如需稍后安装，请访问: https://github.com/MrNine-666/claude-code-quickstart/releases"
            Write-Host ""
            Write-UiPrimary "后续安装 Claude Code / Codex："
            Write-UiInfo "  稍后安装 ccq 后运行 ccq，进入「工具管理」安装 Claude Code 或 Codex"
            Write-UiInfo "  API Key 与 profile 可在「供应商」菜单中可视化配置"
            return
        }
    }

    Write-Host ""
    Write-UiInfo "正在准备下载 ccq 可执行文件..."

    # 2. 检测平台架构
    $arch = Get-CcqArchitecture
    Write-UiInfo "检测到平台架构: $arch"

    # 3. 构建下载 URL
    $baseUrl = Get-CcqReleaseDownloadBaseUrl
    $exeName = "ccq-${arch}.exe"
    $downloadUrl = "${baseUrl}/${exeName}"

    Write-UiDim "  下载 URL: $downloadUrl"

    # 4. 执行下载与安装
    $installResult = Install-CcqExecutable -DownloadUrl $downloadUrl

    if ($installResult.Success) {
        Write-Host ""
        Write-UiSuccess " ccq 可执行文件安装成功！"
        Write-Host ""
        Write-UiPrimary "下一步："
        Write-UiInfo "  1. 打开 Windows Terminal，新建一个 PowerShell 7 标签页"
        Write-UiDim "     （Windows Terminal 中点击标签栏的 ∨ 下拉菜单选择 PowerShell）"
        Write-UiInfo "  2. 输入 ccq 进入管理控制台"
        Write-UiInfo "  3. 进入「工具管理」安装 Claude Code 或 Codex，再到「供应商」配置 API Key/profile"
        Write-Host ""
        Write-UiDim "（当前会话 PATH 尚未刷新，必须开启新终端 ccq 命令才生效）"
    } else {
        Write-Host ""
        Write-UiWarning "ccq 可执行文件下载失败"
        Write-UiDim "  错误: $($installResult.ErrorMessage)"
        Write-UiInfo "您可以稍后手动下载："
        Write-UiInfo "  1. 访问: https://github.com/MrNine-666/claude-code-quickstart/releases"
        Write-UiInfo "  2. 下载对应平台的可执行文件（$exeName）"
        Write-UiInfo "  3. 放置到任意 PATH 目录"
        Write-Host ""
        Write-UiPrimary "后续安装 Claude Code / Codex："
        Write-UiInfo "  等待 ccq 安装完成后运行 ccq，进入「工具管理」安装 Claude Code 或 Codex"
        Write-UiInfo "  API Key 与 profile 可在「供应商」菜单中可视化配置"
    }
}

# ─── 步骤列表输出 ────────────────────────────────────────────────────────────

function Show-StepList {
    <#
    .SYNOPSIS
    列出所有注册步骤（供 -ListSteps 使用）
    #>
    param()

    Write-UiPrimary "已注册的安装步骤："
    Write-Host ""

    $stepIndex = 0
    foreach ($groupName in @("Basic")) {
        $group = $script:StepGroups[$groupName]
        Write-UiPrimary "─── $($group.Label)（$($group.Description)）───"
        Write-Host ""

        foreach ($stepId in $group.StepIds) {
            $step = Get-StepConfigById -StepId $stepId
            if (-not $step) { continue }

            $stepIndex++
            $tag = if ($step.IsOptional) { "[可选]" } else { "[必选]" }
            Write-UiInfo "  $stepIndex. $tag $($step.StepName)"
            Write-UiDim "       $($step.Description)"
            $deps = (Get-StepDependencies)[$stepId]
            Write-UiDim "       依赖: $(if (-not $deps -or $deps.Count -eq 0) { '无' } else { $deps -join ', ' })" -Level Debug
            Write-Host ""
        }
    }
}

# ─── 最终摘要展示 ────────────────────────────────────────────────────────────

function Show-FinalSummary {
    param(
        [Parameter(Mandatory = $true)]
        [InstallState]$State,

        [Parameter(Mandatory = $true)]
        [hashtable]$Results
    )

    Write-Host ""

    # 仅展示本次执行计划中涉及的步骤
    $summaryItems = @()

    foreach ($stepId in $Results.ExecutedStepIds) {
        $stepConfig = Get-StepConfigById -StepId $stepId
        $stepName = if ($stepConfig) { $stepConfig.StepName } else { $stepId }

        if ($State.StepResults.ContainsKey($stepId)) {
            $stepResult = $State.StepResults[$stepId]
            $statusText = switch ($stepResult.Status) {
                ([StepStatus]::Success) { "成功" }
                ([StepStatus]::Skipped) { "跳过" }
                ([StepStatus]::Failed)  { "失败" }
                ([StepStatus]::Pending) { "未执行" }
                default                 { "未知" }
            }

            $version = if ($stepResult.Data -and $stepResult.Data.ContainsKey("Version") -and $stepResult.Data["Version"]) {
                [string]$stepResult.Data["Version"]
            } else {
                "-"
            }
        } else {
            # 在执行计划中但未进入生命周期（如依赖检查失败）
            $statusText = "跳过"
            $version = "-"
        }

        $summaryItems += [PSCustomObject]@{
            Name    = $stepName
            Status  = $statusText
            Version = $version
        }
    }

    if ($summaryItems -and $summaryItems.Count -gt 0) {
        Show-InstallSummary -Items $summaryItems
    }

    Write-Host ""
    Write-UiPrimary "安装统计："
    Write-UiSuccess "  成功: $($Results.Success)"
    if ($Results.Skipped -gt 0) {
        Write-UiWarning "  跳过: $($Results.Skipped)"
    }
    if ($Results.Failed -gt 0) {
        Write-UiDanger "  失败: $($Results.Failed)"
    }

    Write-Host ""

    if ($Results.Failed -eq 0) {
        Write-Host ""
        Write-UiPrimary "下一步：" -Level Detail
        Write-UiInfo "  1. 安装完成后打开新终端运行: ccq" -Level Detail
        Write-UiInfo "  2. 在右侧 Header 选择 Claude Code 或 Codex" -Level Detail
        Write-UiInfo "  3. 进入「工具管理」安装 Claude Code / Codex" -Level Detail
        Write-UiInfo "  4. 从 Release 手动下载 ccq-windows-{x64|arm64}.exe 到 PATH 目录也可补装 ccq" -Level Detail
    } else {
        Write-UiWarning "安装完成，但有 $($Results.Failed) 个步骤失败"
        Write-Host ""
        Write-UiPrimary "失败步骤列表："
        foreach ($stepId in $Results.ExecutedStepIds) {
            if ($State.StepResults.ContainsKey($stepId)) {
                $stepResult = $State.StepResults[$stepId]
                if ($stepResult.Status -eq [StepStatus]::Failed) {
                    Write-UiDanger "  $($stepResult.StepName): $($stepResult.ErrorDetails)"
                }
            }
        }
        Write-Host ""
        Write-UiInfo "重新运行安装器可重试失败步骤" -Level Detail
    }

    Write-Host ""

    $State.IsCompleted = ($Results.Failed -eq 0)
}

function Confirm-BasicInstallPlan {
    <#
    .SYNOPSIS
    在 install 开始时统一确认基础环境安装计划。
    .RETURNS
    $true = 用户确认执行；$false = 用户取消
    #>
    param()

    Write-UiPrimary "本次将检查/安装以下基础环境组件："
    Write-Host ""
    Write-UiInfo "  1. winget（缺失时尝试自动安装，用于后续组件安装）"
    Write-UiInfo "  2. PowerShell 7（推荐组件，非阻塞）"
    Write-UiInfo "  3. Windows Terminal（推荐组件，非阻塞）"
    Write-UiInfo "  4. Node.js（运行 ccq 工具管理所需）"
    Write-UiInfo "  5. Git（基础开发环境）"
    Write-UiInfo "  6. ccq 管理控制台（安装器末尾确认下载）"
    Write-UiDim "     Claude Code / Codex 将在 ccq「工具管理」中按需安装"
    Write-Host ""

    $choice = Show-SingleSelectMenu `
        -Title "确认开始安装基础环境？" `
        -Options @("是，开始安装", "否，取消") `
        -DefaultIndex 0

    return ($choice -eq 0)
}


# ─── 前置环境检测（PS5.1 单运行时，合并自原 Bootstrap.ps1）────────────────────

function Install-RecommendedPowerShell7 {
    <#
    .SYNOPSIS
    为用户安装 PowerShell 7（推荐环境组件，非阻塞）
    .DESCRIPTION
    脚本运行时为 PS5.1，PS7 仅作推荐组件安装：装失败 / 用户跳过 SHALL NOT 中断基础
    安装，脚本始终在当前 PS5.1 进程继续，不 re-exec。
    #>
    param()

    $required = [Version]"7.0"

    if (Test-CommandAvailable -Command "pwsh") {
        $version = Get-CommandVersion -Command "pwsh"
        $versionString = if ($version) { $version -replace '[^\d\.].*$', '' } else { "" }
        if ($versionString) {
            try {
                if ([Version]$versionString -ge $required) {
                    Write-UiSuccess "PowerShell 7 已安装（版本 $version）"
                    return
                }
            } catch { }
        }
        Write-UiWarning "检测到 PowerShell 7 版本过低（$version），建议升级"
    } else {
        Write-UiInfo "未检测到 PowerShell 7（推荐组件，可提升后续开发体验）" -Level Detail
    }

    if (-not (Test-CommandAvailable -Command "winget")) {
        Write-UiWarning "winget 不可用，跳过 PowerShell 7 自动安装（可稍后手动安装：https://aka.ms/powershell）"
        return
    }

    try {
        # --installer-type wix：强制 MSI 真身（PS 7.6+ winget 默认发 MSIX，在无 Store /
        # 未就绪环境会留下 0 字节执行别名空壳存根，启动 pwsh 报 0xc0ea0001）。
        # MSI 装到 Program Files，不注册 WindowsApps 别名，虚拟机/无 Store 环境也稳。
        $installResult = Invoke-WingetInstall -PackageId "Microsoft.PowerShell" -PackageName "PowerShell 7" -Silent -AcceptLicense -InstallerType "wix"
        if ($installResult.Success) {
            Refresh-SessionPath
            Write-UiSuccess "PowerShell 7 安装成功（推荐组件）"
        } else {
            Write-UiWarning "PowerShell 7 自动安装未完成（不影响基础安装，可稍后手动安装：https://aka.ms/powershell）"
        }
    } catch {
        Write-UiWarning "PowerShell 7 自动安装出错（不影响基础安装）：$($_.Exception.Message)"
    }
}

function Install-WindowsTerminal {
    <#
    .SYNOPSIS
    安装 Windows Terminal（可选推荐组件，非阻塞）
    #>
    param()

    # 检测是否已安装（兼容不支持 Appx 的系统，如 Windows Server Core）
    try {
        $wtPackage = Get-AppxPackage -Name "Microsoft.WindowsTerminal" -ErrorAction Stop
        if ($wtPackage) {
            Write-UiSuccess "Windows Terminal 已安装"
            return
        }
    } catch {
        Write-UiInfo "无法检测 Windows Terminal（系统不支持 Appx），跳过" -Level Detail
        return
    }

    if (-not (Test-CommandAvailable -Command "winget")) {
        Write-UiWarning "winget 不可用，跳过 Windows Terminal 自动安装"
        return
    }

    try {
        $installResult = Invoke-WingetInstall -PackageId "Microsoft.WindowsTerminal" -PackageName "Windows Terminal" -Silent -AcceptLicense
        if ($installResult.Success) {
            Write-UiSuccess "Windows Terminal 安装成功"
        } else {
            Write-UiWarning "Windows Terminal 自动安装未完成（不影响基础安装）"
        }
    } catch {
        Write-UiWarning "Windows Terminal 自动安装出错（不影响基础安装）：$($_.Exception.Message)"
    }
}

function Invoke-InstallPreflight {
    <#
    .SYNOPSIS
    install 前置环境检测（PS5.1 单运行时）：Windows 版本 / winget / PS7 / Windows Terminal
    .DESCRIPTION
    合并自原 Bootstrap.ps1。脚本始终在 PS5.1 进程直跑，不 re-exec。winget 缺失自动
    安装；PS7 与 Windows Terminal 为推荐组件，安装失败 / 用户跳过不中断基础安装。
    .RETURNS
    $true = 系统兼容可继续；$false = 系统不兼容（Windows 版本过低）须中止
    #>
    param()

    Write-Host ""
    Write-UiPrimary "前置环境检测"
    Write-Host ""

    # 1. Windows 版本（硬性：过低则中止）
    $minVersion = [Version]"10.0.18362"  # Windows 10 1903
    try {
        $osInfo = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $current = [Version]$osInfo.Version
        if ($current -ge $minVersion) {
            Write-UiSuccess "Windows 版本检查通过：$($osInfo.Caption)（$($osInfo.Version)）"
        } else {
            Write-UiDanger "Windows 版本过低：当前 $($osInfo.Version)，需要 Windows 10 1903 (10.0.18362) 或更高"
            return $false
        }
    } catch {
        # 检测失败保守放行，不阻断安装
        Write-UiWarning "无法检测 Windows 版本（已跳过该检查）：$($_.Exception.Message)"
    }

    # 2. winget（缺失则自动安装；失败不中断，依赖 winget 的步骤走手动兜底）
    if (Test-CommandAvailable -Command "winget") {
        Write-UiSuccess "winget 已可用"
    } else {
        Write-UiWarning "winget 不可用，尝试自动安装..."
        $wingetResult = Install-Winget
        if (-not $wingetResult.Success) {
            Write-UiWarning "winget 自动安装未完成，依赖 winget 的步骤可能需要手动安装（不影响后续流程）"
        }
    }

    # 3. PowerShell 7（推荐组件，非阻塞）
    Install-RecommendedPowerShell7

    # 4. Windows Terminal（可选推荐组件）
    Install-WindowsTerminal

    return $true
}


# ─── 旧 Profile 标记块迁移清理 ─────────────────────────────────────────────────

function Invoke-ProfileLegacyCleanup {
    <#
    .SYNOPSIS
    清理 $PROFILE 中历史遗留的 CCQ 标记块（旧 ccq 快捷函数注入残留）
    .DESCRIPTION
    旧 ClaudeConfig 步骤曾把 function ccq {...} 包在 HC-4 标记块里注入 $PROFILE
    （commit 429637c），迁移到 ccq.exe + PATH 后注入逻辑已删，但用户机器残留未清。
    旧 ccq 函数会 curl 旧 install.sh，与新 ccq.exe 冲突，故在前置检测后清理。
    仅清标记块包裹内容，块外用户自定义不动；清理函数幂等，无块则 no-op。
    失败仅告警，不阻断主安装流程（迁移兜底，非关键路径）。
    #>
    param()

    # 历史注入目标：PS5.1 与 PS7 的 CurrentUserCurrentHost profile。
    # 关键：不能用 $env:USERPROFILE\Documents 硬拼——Documents 可能被重定向到其他盘符
    # （如 E:\Administrator\Documents）或 OneDrive，硬拼会命中不到真身。改用 .NET
    # MyDocuments 解析真实 Documents 根，并纳入当前进程的 $PROFILE 作为最权威来源。
    $candidateProfiles = [System.Collections.Generic.List[string]]::new()

    # 1. 当前 PS5.1 进程的真实 $PROFILE（已正确解析重定向）
    $currentProfile = $PROFILE.CurrentUserCurrentHost
    if (-not [string]::IsNullOrWhiteSpace($currentProfile)) {
        $candidateProfiles.Add($currentProfile)
    }

    # 2. 从真实 Documents 根构造 PS5.1 / PS7 两个 host 的 profile 路径
    $docsRoot = ""
    try {
        $docsRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
    } catch { }
    if (-not [string]::IsNullOrWhiteSpace($docsRoot)) {
        $candidateProfiles.Add((Join-Path $docsRoot "WindowsPowerShell\Microsoft.PowerShell_profile.ps1"))
        $candidateProfiles.Add((Join-Path $docsRoot "PowerShell\Microsoft.PowerShell_profile.ps1"))
    }

    # 去重（$PROFILE 与构造路径可能重合），保留唯一路径
    $seen = @{}
    $uniqueProfiles = [System.Collections.Generic.List[string]]::new()
    foreach ($p in $candidateProfiles) {
        $key = $p.ToLowerInvariant()
        if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            $uniqueProfiles.Add($p)
        }
    }

    foreach ($profilePath in $uniqueProfiles) {
        if (-not (Test-Path $profilePath)) {
            continue
        }

        try {
            if (-not (Test-ManagedBlockExists -FilePath $profilePath)) {
                continue
            }

            # 通用标记块历史上也承载 fnm 初始化；只有确认命中旧 ccq 函数时才做最小删除。
            $cleanupResult = Remove-LegacyCcqFunctionFromFile -FilePath $profilePath
            if ($cleanupResult.Success -and $cleanupResult.Changed) {
                Write-UiSuccess "✓ 已清理旧 ccq 快捷函数残留: $profilePath"
            } elseif (-not $cleanupResult.Success) {
                Write-UiWarning "清理旧 CCQ 标记块失败: $profilePath"
            }
        } catch {
            Write-UiWarning "清理旧 CCQ 标记块出错（已跳过）: $($_.Exception.Message)"
        }
    }
}


# ─── 主函数 ──────────────────────────────────────────────────────────────────

function Main {
    param()

    try {
        # 仅列出步骤时快速退出
        if ($ListSteps) {
            Show-StepList
            return
        }

        # 欢迎横幅
        Show-CcqLogo -Subtitle "Claude Code Quickstart"

        Write-UiInfo "一键搭建 ccq 运行基础环境（Node.js / Git），Claude Code / Codex 由工具管理按需安装" -Level Detail
        Write-Host ""

        if (-not (Confirm-BasicInstallPlan)) {
            Write-UiInfo "安装已取消"
            return
        }

        # ── 前置环境检测（PS5.1 单运行时；PS7 / Windows Terminal 为非阻塞推荐组件）
        if (-not (Invoke-InstallPreflight)) {
            Write-UiDanger "系统不兼容，安装中止"
            return
        }

        # ── 旧 Profile 标记块迁移清理（幂等，无残留则 no-op）
        Invoke-ProfileLegacyCleanup

        # ── 基础环境直装（NodeJS / Git），Claude Code / Codex 交由 ccq 工具管理安装
        $state = [InstallState]::new()
        $state.Mode = "Install-Basic"

        Write-Host ""
        Write-UiPrimary "开始安装基础环境"
        Write-Host ""

        $basicStepIds = @($script:StepGroups["Basic"].StepIds)
        $results = Invoke-GroupedInstall -StepIds $basicStepIds -State $state -SkipConfirmation

        if ($results.Total -gt 0) {
            Show-FinalSummary -State $state -Results $results
        }

        # ── ccq 可执行文件下载确认（TDR-6）
        Write-Host ""
        Confirm-CcqExecutableDownload

    } catch {
        Write-UiDanger "CCQ 运行中发生严重错误: $($_.Exception.Message)"
        Write-Host ""
        Show-ErrorDetails `
            -FriendlyMessage "CCQ 遇到未预期的错误，请查看技术详情" `
            -TechnicalDetails "$($_.Exception.Message)`n$($_.ScriptStackTrace)"
        exit 1
    }
}

# ─── 脚本入口点 ──────────────────────────────────────────────────────────────

Main
