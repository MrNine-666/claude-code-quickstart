#Requires -Version 7.0
# Manage.ps1 - CCQ（统一管理入口）
# 功能: 生命周期管理 — 更新已安装组件 + 供应商管理 + MCP 管理

param(
    # 管理动作（CLI 模式）
    [ValidateSet("Update", "Mcp", "Provider", "Skills", "")]
    [string]$Action = "",

    # Update 专用参数
    [switch]$ListUpdates,

    # Provider 专用参数
    [string]$Provider,
    [switch]$ListProviders,

    # 通用参数
    [ValidateSet("Normal", "Developer")]
    [string]$OutputMode = "Normal"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ─── 中文编码修复（必须在 PS 版本检查前执行，不能移入 core/ 模块）─────────────
# 注意：此块与 Install.ps1 中的相同代码共用 _CcqKernel32Cp 类名。
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

# ─── PS 版本运行时拦截（#Requires 对 irm|iex 无效，需运行时二次校验）────────

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host ""
    Write-Host "  [ERROR] Manage.ps1 需要 PowerShell 7.0 或更高版本" -ForegroundColor Red
    Write-Host "  当前版本: PowerShell $($PSVersionTable.PSVersion)" -ForegroundColor Red
    Write-Host ""
    Write-Host "  解决方案：" -ForegroundColor Yellow
    Write-Host "    1. 先运行引导脚本:" -ForegroundColor White
    Write-Host "       Set-ExecutionPolicy Bypass -Scope Process -Force" -ForegroundColor Gray
    Write-Host "       [Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/bootstrap.ps1')) | iex" -ForegroundColor Gray
    Write-Host "    2. 或在 Windows Terminal 中打开 PowerShell 7 后执行此脚本" -ForegroundColor White
    Write-Host ""
    exit 1
}

$script:WindowsRoot = if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { "" } else { $PSScriptRoot }
$script:InstallerRoot = if ([string]::IsNullOrWhiteSpace($script:WindowsRoot)) { "" } else { Split-Path -Parent $script:WindowsRoot }

# ─── Dot-source 核心模块 ────────────────────────────────────────────────────

. "$script:WindowsRoot\core\Ui.ps1"
. "$script:WindowsRoot\core\Process.ps1"
. "$script:WindowsRoot\core\Profile.ps1"
. "$script:WindowsRoot\core\Update.ps1"
. "$script:WindowsRoot\core\Admin.ps1"
. "$script:WindowsRoot\core\Net.ps1"
. "$script:WindowsRoot\core\Registry.ps1"
. "$script:WindowsRoot\core\Bootstrap.ps1"
. "$script:WindowsRoot\core\ManageCore.ps1"
. "$script:WindowsRoot\core\Provider.ps1"

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

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 更新管理（迁移自旧 Update 入口）
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# ─── 内容指纹管理（跳过模板未变更的步骤）─────────────────────────────────

$script:FingerprintManagedSteps = @("ClaudeMd", "CcgWorkflow")

function Get-StepDesiredFingerprint {
    <#
    .SYNOPSIS
    计算步骤的"期望"内容指纹（基于源模板 SHA256 或工具版本号）
    .DESCRIPTION
    采用约定优于配置：每个支持指纹的步骤定义 Get-<StepId>Fingerprint 函数，
    本函数自动发现并调度，无需硬编码步骤内部逻辑（开闭原则）。
    .PARAMETER StepId
    步骤 ID（仅支持 FingerprintManagedSteps 中的步骤）
    .RETURNS
    string - 指纹值；空字符串表示无法计算
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$StepId
    )

    $fnName = "Get-${StepId}Fingerprint"
    if (-not (Get-Command $fnName -ErrorAction SilentlyContinue)) {
        return ""
    }

    try {
        return & $fnName
    } catch {
        Write-UiWarning "指纹计算失败 (${StepId}): $($_.Exception.Message)"
        return ""
    }
}

# ─── 更新摘要显示 ─────────────────────────────────────────────────────────────

function Show-UpdateSummary {
    <#
    .SYNOPSIS
    显示更新结果摘要（分四类：已更新/已最新/失败/跳过）
    #>
    param(
        [InstallState]$State,
        [string[]]$ExecutedStepIds,
        [string[]]$SkippedStepIds = @(),
        [string]$SnapshotDir = ""
    )

    $updated = @()
    $upToDate = @()
    $failed = @()

    foreach ($stepId in $ExecutedStepIds) {
        $stepConfig = Get-StepConfigById -StepId $stepId
        $stepName = if ($stepConfig) { $stepConfig.StepName } else { $stepId }

        if ($State.StepResults.ContainsKey($stepId)) {
            $stepResult = $State.StepResults[$stepId]
            $items = @()
            if ($stepResult.Data -and $stepResult.Data.ContainsKey("UpdatedItems")) {
                $items = @($stepResult.Data["UpdatedItems"])
            }

            if ($stepResult.Status -eq [StepStatus]::Failed) {
                $failed += @{ Name = $stepName; Detail = $stepResult.ErrorDetails }
            } elseif ($items.Count -gt 0 -and @($items | Where-Object { $_ -match "^noop::" }).Count -eq $items.Count) {
                $upToDate += @{ Name = $stepName; Items = ($items -join ", ") }
            } elseif ($stepResult.Status -eq [StepStatus]::Skipped) {
                # Skipped 由生命周期标记
            } else {
                $realChanges = @($items | Where-Object { $_ -notmatch "^noop::" })
                if ($realChanges.Count -gt 0) {
                    $updated += @{ Name = $stepName; Items = ($realChanges -join ", ") }
                } else {
                    $upToDate += @{ Name = $stepName; Items = "no-change" }
                }
            }
        }
    }

    Write-Host ""
    Write-UiPrimary "══════════════════════════════════════════"
    Write-UiPrimary "  更新结果摘要"
    Write-UiPrimary "══════════════════════════════════════════"

    Write-Host ""
    if ($updated.Count -gt 0) {
        Write-UiSuccess "  已更新 ($($updated.Count)):"
        foreach ($item in $updated) {
            Write-UiInfo "    $($item.Name)" -NoNewline
            Write-UiDim "  $($item.Items)"
        }
    } else {
        Write-UiSuccess "  已更新 (0)"
    }

    if ($upToDate.Count -gt 0) {
        Write-Host ""
        Write-UiDim "  已是最新 ($($upToDate.Count)):"
        foreach ($item in $upToDate) {
            Write-UiDim "    $($item.Name)" -NoNewline
            if ($item.Items -match "fingerprint-match") {
                Write-UiDim "  (内容一致)"
            } else {
                Write-UiDim "  (内容无变更)"
            }
        }
    }

    if ($failed.Count -gt 0) {
        Write-Host ""
        Write-UiDanger "  失败 ($($failed.Count)):"
        foreach ($item in $failed) {
            Write-UiDanger "    $($item.Name)" -NoNewline
            Write-UiDanger "  $($item.Detail)"
        }
    }

    if ($SkippedStepIds.Count -gt 0) {
        Write-Host ""
        Write-UiWarning "  已跳过 ($($SkippedStepIds.Count)):"
        foreach ($stepId in $SkippedStepIds) {
            $stepConfig = Get-StepConfigById -StepId $stepId
            $stepName = if ($stepConfig) { $stepConfig.StepName } else { $stepId }
            Write-UiWarning "    $stepName" -NoNewline
            Write-UiWarning "  (未安装)"
        }
    }

    if ($SnapshotDir -and (Test-Path $SnapshotDir)) {
        Write-Host ""
        Write-UiDim "  备份路径: $SnapshotDir"
    }

    Write-Host ""
    Write-UiPrimary "══════════════════════════════════════════"
}

# ─── 更新状态检测（统一入口，一次性完成）────────────────────────────────────

$script:NpmPackageMap = @{
    "ClaudeCode"  = "@anthropic-ai/claude-code"
    "Ccline"      = "@cometix/ccline"
    "CodexCli"    = "@openai/codex"
    "OpenSpec"    = "@fission-ai/openspec"
}

function Get-UpdateStatus {
    <#
    .SYNOPSIS
    一次性检测所有可更新步骤的安装状态 + 远程版本
    .RETURNS
    hashtable[] — 每项包含 StepId/StepName/IsOptional/IsInstalled/CurrentVersion/LatestVersion/HasUpdate/StatusHint/Data
    #>

    $registry = Get-StepRegistry
    $updatableSteps = @($registry | Where-Object { $_.UpdateFunction -ne "" })

    Write-Host ""
    Write-UiDim "正在检测组件状态与远程版本..."

    $outdated = Get-NpmOutdatedGlobal -Force

    $ccgLatest = ""
    try {
        $ccgViewResult = Invoke-ExternalCommand `
            -Command "npm" `
            -Arguments @("view", "ccg-workflow", "version") `
            -TimeoutSeconds 30 -RetryCount 0 -SuppressOutput
        if ($ccgViewResult.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($ccgViewResult.Output)) {
            $ccgLatest = $ccgViewResult.Output.Trim()
        }
    } catch { }

    $fpManifest = Read-UpdateManifest

    $statusList = @()

    foreach ($step in $updatableSteps) {
        $entry = @{
            StepId         = $step.StepId
            StepName       = $step.StepName
            IsOptional     = $step.IsOptional
            IsInstalled    = $false
            CurrentVersion = ""
            LatestVersion  = ""
            HasUpdate      = $null
            StatusHint     = ""
            Data           = @{}
        }

        try {
            $testResult = & $step.TestFunction
            if ($testResult -is [hashtable] -and $testResult.IsInstalled) {
                $entry.IsInstalled = $true
                $entry.CurrentVersion = if ($testResult.Version) { $testResult.Version } else { "" }
            } elseif ($testResult -is [bool] -and $testResult) {
                $entry.IsInstalled = $true
            }
            # ClaudeConfig 孤岛修复：settings.json 存在但字段不完整时，强制视为 IsInstalled
            # 使 Update 列表能发现并修复部分安装状态
            if (-not $entry.IsInstalled -and $step.StepId -eq "ClaudeConfig") {
                $settingsPath = Get-ClaudeSettingsPath
                if (Test-Path $settingsPath) {
                    $entry.IsInstalled = $true
                    $entry.CurrentVersion = ""
                }
            }
        } catch { }

        if ($entry.IsInstalled) {
            $npmPkg = $script:NpmPackageMap[$step.StepId]
            if ($npmPkg) {
                if ($outdated.ContainsKey($npmPkg)) {
                    $entry.LatestVersion = $outdated[$npmPkg].Latest
                    $entry.HasUpdate = $true
                }
                else {
                    $entry.LatestVersion = $entry.CurrentVersion
                    $entry.HasUpdate = $false
                }
            }
            elseif ($step.StepId -eq "CcgWorkflow") {
                # 分量检测：引擎版本 + 历史规则清理 + env 独立判定
                $ccgComponents = Get-CcgWorkflowUpdateComponents -LatestVersion $ccgLatest
                $entry.LatestVersion = $ccgComponents.LatestVersion
                $entry.HasUpdate = ($ccgComponents.EngineNeedUpdate -or $ccgComponents.RulesNeedUpdate -or $ccgComponents.EnvNeedUpdate)
                $entry.StatusHint = $ccgComponents.StatusHint
                $entry.Data = @{
                    UpdateKind       = $ccgComponents.UpdateKind
                    EngineNeedUpdate = $ccgComponents.EngineNeedUpdate
                    RulesNeedUpdate  = $ccgComponents.RulesNeedUpdate
                    EnvNeedUpdate    = $ccgComponents.EnvNeedUpdate
                }
            }
            elseif ($step.StepId -eq "ClaudeConfig") {
                # 声明式逐项对比（替代纯指纹比对）
                $drift = Compare-ClaudeConfigDrift
                if ($drift.HasDrift) {
                    $entry.HasUpdate = $true
                    $hints = @()
                    if (@($drift.Details.MissingEnvKeys).Count -gt 0) {
                        $hints += "缺失 $(@($drift.Details.MissingEnvKeys).Count) 个 env 键"
                    }
                    if (@($drift.Details.DriftedEnvKeys).Count -gt 0) {
                        $hints += "$(@($drift.Details.DriftedEnvKeys).Count) 个 env 值偏移"
                    }
                    if (@($drift.Details.MissingPermissions).Count -gt 0) {
                        $hints += "缺失 $(@($drift.Details.MissingPermissions).Count) 个 permissions"
                    }
                    if (@($drift.Details.DeprecatedEnvKeys).Count -gt 0) {
                        $hints += "$(@($drift.Details.DeprecatedEnvKeys).Count) 个废弃 env 键"
                    }
                    if ($drift.Details.MissingLanguage) { $hints += "language 缺失" }
                    $entry.StatusHint = $hints -join "; "
                } else {
                    $entry.HasUpdate = $false
                }
            }
            elseif ($step.StepId -in $script:FingerprintManagedSteps) {
                $desiredFp = Get-StepDesiredFingerprint -StepId $step.StepId
                if ($desiredFp) {
                    $storedEntry = $fpManifest["steps"][$step.StepId]
                    if ($storedEntry -and $storedEntry["fingerprint"] -eq $desiredFp) {
                        $entry.HasUpdate = $false
                    } else {
                        $entry.HasUpdate = $true
                    }
                }
            }
            elseif ($step.StepId -eq "AntigravityCli") {
                # 非 npm 包：无法获取远程最新版本，无法判断是否有更新，执行 agy update 由官方 CLI 自行判断
                $entry.HasUpdate = $null
                $entry.StatusHint = "无法获取更新状态，执行 agy update 更新"
            }
        }

        $statusList += $entry
    }

    return $statusList
}


# ─── 交互式步骤选择 ───────────────────────────────────────────────────────────

function Select-UpdateSteps {
    <#
    .SYNOPSIS
    交互式多选可更新步骤（使用预计算的状态数据）
    .RETURNS
    选中的 StepId 数组
    #>
    param(
        [Parameter(Mandatory = $true)]
        [array]$StatusList
    )

    $installedList = @($StatusList | Where-Object { $_.IsInstalled })

    if ($installedList.Count -eq 0) {
        Write-UiWarning "没有已安装的可更新步骤"
        return @()
    }

    $options = @()
    $hints = @()
    $defaultSelected = @()

    for ($i = 0; $i -lt $installedList.Count; $i++) {
        $entry = $installedList[$i]
        $label = "$($entry.StepName)"
        $hint = $null

        if ($entry.HasUpdate -eq $true) {
            # 优先使用 StatusHint 进行分级展示
            if (-not [string]::IsNullOrWhiteSpace($entry.StatusHint)) {
                $hint = @{ Text = "($($entry.StatusHint))"; Color = "Yellow" }
            } elseif ($entry.LatestVersion -and $entry.CurrentVersion) {
                $hint = @{ Text = "($($entry.CurrentVersion) -> $($entry.LatestVersion))"; Color = "Yellow" }
            } elseif ($entry.LatestVersion) {
                $hint = @{ Text = "(有更新 -> $($entry.LatestVersion))"; Color = "Yellow" }
            } else {
                $hint = @{ Text = "(模板已变更)"; Color = "Yellow" }
            }
            $defaultSelected += $i
        }
        elseif ($entry.HasUpdate -eq $false) {
            $versionText = if ($entry.CurrentVersion) { "(已是最新 $($entry.CurrentVersion))" } else { "(已是最新)" }
            $hint = @{ Text = $versionText; Color = "DarkGray" }
        }
        else {
            $hintText = if (-not [string]::IsNullOrWhiteSpace($entry.StatusHint)) { "($($entry.StatusHint))" } else { "(已安装)" }
            $hint = @{ Text = $hintText; Color = "DarkGray" }
            $defaultSelected += $i
        }
        $options += $label
        $hints += $hint
    }
    Write-Host ""
    $selectedIndices = Show-MultiSelectMenu -Title "可更新组件" -Options $options -DefaultSelected $defaultSelected -OptionHints $hints

    if ($null -eq $selectedIndices -or @($selectedIndices).Count -eq 0) {
        Write-UiInfo "未选择任何步骤，退出更新"
        return @()
    }

    $selectedStepIds = @()
    foreach ($idx in @($selectedIndices)) {
        $selectedStepIds += $installedList[$idx].StepId
    }

    return $selectedStepIds
}

# ─── 更新核心执行 ─────────────────────────────────────────────────────────────

function Invoke-UpdateAction {
    <#
    .SYNOPSIS
    执行更新动作（统一入口，含 Mutex/快照/指纹预检）
    .PARAMETER ListOnly
    仅显示状态，不执行更新
    #>
    param([switch]$ListOnly)

    # HC-13: @() 包裹防止单元素/空结果下 .Count 异常
    $updateStatus = @(Get-UpdateStatus)

    if ($ListOnly) {
        $hasUpdates = @($updateStatus | Where-Object { $_.HasUpdate -eq $true }).Count -gt 0
        if ($hasUpdates) {
            Write-UiDim "提示: 运行 " -NoNewline
            Write-UiPrimary "pwsh -File installer/windows/Manage.ps1 -Action Update" -NoNewline
            Write-UiDim " 选择并更新组件"
            Write-Host ""
        }
        return 0
    }

    # Mutex 获取
    $mutex = $null
    $acquired = $false

    try {
        $mutex = [System.Threading.Mutex]::new($false, "Global\CCQ.Update.Lock")
        $acquired = $mutex.WaitOne(0)

        if (-not $acquired) {
            Write-Host ""
            Write-UiDanger "[ERROR] 另一个更新实例正在运行，请等待其完成后再试"
            Write-Host ""
            return -1
        }

        # 构建执行计划
        $selectedIds = @(Select-UpdateSteps -StatusList $updateStatus)
        if ($selectedIds.Count -eq 0) { return 0 }

        $plan = @(Build-UpdatePlan -RequestedSteps $selectedIds)
        if ($plan.Count -eq 0) {
            Write-UiInfo "没有需要更新的步骤"
            return 0
        }

        # 指纹预检（CcgWorkflow 排除：由其内部分量逻辑决定是否 noop）
        $manifest = Read-UpdateManifest
        $fingerprintSkips = @{}

        foreach ($stepConfig in $plan) {
            $sid = $stepConfig.StepId
            if ($sid -notin $script:FingerprintManagedSteps) { continue }
            # CcgWorkflow/ClaudeConfig 不走通用指纹预检
            if ($sid -eq "CcgWorkflow" -or $sid -eq "ClaudeConfig") { continue }

            $desiredFp = Get-StepDesiredFingerprint -StepId $sid
            if (-not $desiredFp) { continue }

            $storedEntry = $manifest["steps"][$sid]
            if ($storedEntry -and $storedEntry["fingerprint"] -eq $desiredFp) {
                $testFn = $stepConfig.TestFunction
                $isHealthy = $false
                try {
                    $testResult = & $testFn
                    if ($testResult -is [hashtable]) {
                        $isHealthy = [bool]$testResult.IsInstalled
                    } elseif ($testResult -is [bool]) {
                        $isHealthy = $testResult
                    }
                } catch { }

                if ($isHealthy) {
                    $fingerprintSkips[$sid] = $desiredFp
                }
            }
        }

        # 显示执行计划
        Write-Host ""
        Write-UiPrimary "更新执行计划:"
        for ($i = 0; $i -lt $plan.Count; $i++) {
            $sid = $plan[$i].StepId
            if ($fingerprintSkips.ContainsKey($sid)) {
                Write-UiDim "  $($i + 1). $($plan[$i].StepName) ($sid)" -NoNewline
                Write-UiDim "  [内容无变更, 跳过]"
            } else {
                Write-UiInfo "  $($i + 1). $($plan[$i].StepName) ($sid)"
            }
        }
        if ($fingerprintSkips.Count -gt 0) {
            Write-Host ""
            Write-UiInfo "预检: $($fingerprintSkips.Count) 个步骤内容无变更，将跳过"
        }
        Write-Host ""

        # 条件快照
        $stepsNeedingExecution = @($plan | Where-Object { -not $fingerprintSkips.ContainsKey($_.StepId) })
        $snapshotDir = ""

        if ($stepsNeedingExecution.Count -gt 0) {
            $filesToBackup = @(
                "$(Get-UserHome)\.claude\settings.json",
                "$(Get-UserHome)\.claude.json",
                "$(Get-UserHome)\.claude\CLAUDE.md",
                (Get-McpMetaPath)
            )
            $rulesDir = "$(Get-UserHome)\.claude\rules"
            if (Test-Path $rulesDir) {
                $ruleFiles = Get-ChildItem $rulesDir -Include "ccq-*.md", "ccg-*.md" -ErrorAction SilentlyContinue
                if ($ruleFiles) {
                    foreach ($rf in $ruleFiles) {
                        $filesToBackup += $rf.FullName
                    }
                }
            }
            $existingFiles = @($filesToBackup | Where-Object { Test-Path $_ })

            if ($existingFiles.Count -gt 0) {
                $snapshotDir = New-UpdateSnapshot -FilePaths $existingFiles
                Write-UiInfo "备份快照已创建: $snapshotDir"
            } else {
                Write-UiWarning "没有找到需要备份的文件，跳过快照"
            }
        } else {
            Write-UiInfo "所有步骤内容无变更，跳过备份快照"
        }

        # 创建安装状态
        $state = [InstallState]::new()
        $state.Mode = "Update"

        $executedStepIds = @()
        $skippedStepIds = @()
        $successCount = 0
        $failCount = 0

        # 遍历执行计划
        foreach ($stepConfig in $plan) {
            $stepId = $stepConfig.StepId

            # 指纹命中 → noop
            if ($fingerprintSkips.ContainsKey($stepId)) {
                Write-Host ""
                Write-UiDim "─── 更新: $($stepConfig.StepName) ───"
                Write-UiDim "内容无变更，跳过"

                $skipResult = [StepResult]::new($stepId, $stepConfig.StepName)
                $skipResult.Status = [StepStatus]::Success
                $skipResult.Message = "fingerprint-match"
                $skipResult.Data = @{ UpdatedItems = @("noop::${stepId}::fingerprint-match") }
                $skipResult.StartTime = Get-Date
                $skipResult.EndTime = Get-Date
                $state.StepResults[$stepId] = $skipResult

                $executedStepIds += $stepId
                $successCount++
                continue
            }

            Write-Host ""
            Write-UiPrimary "─── 更新: $($stepConfig.StepName) ───"

            $onMissing = if ($stepId -eq "ClaudeConfig") { "Install" } else { "Ask" }
            $stepResult = Invoke-UpdateLifecycle -StepConfig $stepConfig -State $state -OnMissing $onMissing

            $executedStepIds += $stepId

            if ($stepResult.Status -eq [StepStatus]::Success) {
                $successCount++

                # 指纹管理步骤更新成功 → 回写清单
                if ($stepId -in $script:FingerprintManagedSteps) {
                    $newFp = Get-StepDesiredFingerprint -StepId $stepId
                    if ($newFp) {
                        $manifestEntry = @{
                            fingerprint = $newFp
                            appliedAt   = (Get-Date).ToUniversalTime().ToString("o")
                        }
                        # CcgWorkflow 增加 components 子字段以记录分量状态
                        if ($stepId -eq "CcgWorkflow") {
                            $configToml = "$(Get-UserHome)\.claude\.ccg\config.toml"
                            $engineVer = ""
                            if (Test-Path $configToml) {
                                $tomlContent = Get-Content $configToml -Raw -ErrorAction SilentlyContinue
                                if ($tomlContent -match 'version\s*=\s*"([^"]+)"') {
                                    $engineVer = $matches[1]
                                }
                            }
                            $manifestEntry["components"] = @{
                                engineVersion           = $engineVer
                                managedRuleFilesCleanup = ($script:CcgWorkflowManagedRuleFiles -join ",")
                            }
                        }
                        $manifest["steps"][$stepId] = $manifestEntry
                        try {
                            Write-UpdateManifest -Manifest $manifest
                        } catch {
                            Write-UiWarning "清单回写失败: $($_.Exception.Message)"
                        }
                    }
                }
            } elseif ($stepResult.Status -eq [StepStatus]::Failed) {
                $failCount++
            } elseif ($stepResult.Status -eq [StepStatus]::Skipped) {
                $skippedStepIds += $stepId
            }
        }

        # 清理旧快照
        try {
            Clear-OldUpdateSnapshots -CurrentSnapshotDir $snapshotDir
        } catch {
            Write-UiWarning "旧快照清理失败: $($_.Exception.Message)"
        }

        # 显示结果摘要
        Show-UpdateSummary -State $state -ExecutedStepIds $executedStepIds `
            -SkippedStepIds $skippedStepIds -SnapshotDir $snapshotDir

        if ($failCount -gt 0) {
            Write-UiDanger "有 $failCount 个步骤更新失败"
        }

        return $failCount

    } finally {
        if ($acquired -and $mutex) {
            try {
                $mutex.ReleaseMutex()
            } catch { }
        }
        if ($mutex) {
            $mutex.Dispose()
        }
    }
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 顶层菜单
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function Select-ManageAction {
    <#
    .SYNOPSIS
    显示管理动作选择菜单
    .RETURNS
    选中的索引（0=更新, 1=供应商, 2=MCP, -1=Esc）
    #>
    param()

    $options = @(
        "更新管理   - 检测并更新已安装组件"
        "供应商管理  - 管理 AI 供应商配置"
        "MCP 管理   - 管理 MCP Server 配置"
        "Skills 管理 - 安装/更新/卸载 Skills"
    )

    return Show-SingleSelectMenu -Title "CCQ 环境管理" -Options $options -DefaultIndex 0
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 主函数
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function Main {
    param()

    try {
        # 欢迎横幅
        Show-CcqLogo -Subtitle "CCQ 环境管理"

        Write-UiInfo "管理已安装组件的更新、供应商、MCP 和 Skills 配置"
        Write-Host ""

        # ── CLI 参数模式
        if ($Action -ne "") {
            $exitCode = 0
            switch ($Action) {
                "Update" {
                    $updateResult = Invoke-UpdateAction -ListOnly:$ListUpdates
                    if ($updateResult -ne 0) { $exitCode = 1 }
                }
                "Provider" {
                    if ($ListProviders) {
                        # CLI 查看供应商列表
                        try { Sync-ProviderFromSettings } catch { }
                        Show-ProviderStatus
                    }
                    elseif (-not [string]::IsNullOrWhiteSpace($Provider)) {
                        # CLI 直接切换供应商
                        try { Sync-ProviderFromSettings } catch { }
                        Switch-Provider -Key $Provider
                    }
                    else {
                        # 交互式供应商管理
                        Show-ProviderDashboard
                    }
                }
                "Mcp" {
                    # MCP 管理统一路由到 JS 面板（manage.js 子菜单 [4] MCP → mcp-manager.js）
                    Show-ManagePanel
                }
                "Skills" {
                    Show-SkillsManageMenu
                }
            }
            if ($exitCode -ne 0) { exit $exitCode }
            return
        }

        # ── 交互模式：JS 统一管理面板（manage.js 子菜单路由 Update/Provider/MCP/Skills）
        # CLI 模式（-Action）仍走上方原生 PS 分支；manage.js 为纯交互面板（无 CLI 参数）
        Show-ManagePanel

    } catch {
        Write-UiDanger "CCQ 管理运行中发生严重错误: $($_.Exception.Message)"
        Write-Host ""
        Show-ErrorDetails `
            -FriendlyMessage "CCQ 遇到未预期的错误，请查看技术详情" `
            -TechnicalDetails "$($_.Exception.Message)`n$($_.ScriptStackTrace)"
        exit 1
    }
}

# ─── 异常保护 ──────────────────────────────────────────────────────────────
trap {
    Write-Host ""
    if ($_.Exception -is [System.Management.Automation.PipelineStoppedException] -or
        $_.Exception -is [System.OperationCanceledException]) {
        Write-UiWarning "操作被用户中断 (Ctrl+C)"
    } else {
        Write-UiDanger "异常中断: $($_.Exception.Message)"
    }
    Write-UiDim "已完成的操作将保留，未完成的可重新运行"
    break
}

# ─── 脚本入口点 ──────────────────────────────────────────────────────────────

Main
