#Requires -Version 7.0
# Install.ps1 - CCQ（安装入口）
# 功能: 首次安装入口（Onboarding），两级分组安装（基础环境 / 进阶扩展）

param(
    [switch]$ListSteps,
    [ValidateSet("Basic", "Advanced", "")]
    [string]$Group = "",
    [ValidateSet("OneClick", "Select", "")]
    [string]$Mode = "",
    [switch]$Staged,
    [ValidateSet("Normal", "Developer")]
    [string]$OutputMode = "Normal"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

# ─── PS 版本运行时拦截（#Requires 对 irm|iex 无效，需运行时二次校验）────────

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host ""
    Write-Host "  [ERROR] Install.ps1 需要 PowerShell 7.0 或更高版本" -ForegroundColor Red
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

# ─── 步骤分组定义（从共享 Registry 获取）─────────────────────────────────────

$script:StepGroups = Get-StepGroups

# ─── 进程级幂等标志 ──────────────────────────────────────────────────────────

$script:CcqShortcutRegistered = $false

# ─── 核心函数 ───────────────────────────────────────────────────────────────

function Invoke-SilentStepTest {
    <#
    .SYNOPSIS
    静默执行步骤 TestFunction，抑制所有输出流，返回布尔安装状态
    .DESCRIPTION
    统一封装 Preference 保存/恢复 + 输出流抑制，使用 finally 确保恢复。
    消除 Get-GroupStatus 和 Show-AdvancedSelectMenu 中的重复逻辑（DRY）。
    .PARAMETER TestFunction
    步骤的 Test 函数名
    .RETURNS
    $true/$false — 是否已安装
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$TestFunction
    )

    $testResult = $null
    $originalVerbose = $VerbosePreference
    $originalDebug = $DebugPreference
    $originalInfo = $InformationPreference
    $originalWarning = $WarningPreference

    try {
        # 设置为静默模式
        $VerbosePreference = 'SilentlyContinue'
        $DebugPreference = 'SilentlyContinue'
        $InformationPreference = 'SilentlyContinue'
        $WarningPreference = 'SilentlyContinue'

        # 调用 TestFunction 并抑制所有输出流（移除 *>&1 避免 WarningRecord/ErrorRecord 污染）
        $testResult = & $TestFunction 2>$null 3>$null 4>$null 5>$null 6>$null
    } catch {
        # 忽略检测错误，视为未安装
        $testResult = $null
    } finally {
        # 确保恢复原始 Preference 设置（即使异常也不泄漏）
        $VerbosePreference = $originalVerbose
        $DebugPreference = $originalDebug
        $InformationPreference = $originalInfo
        $WarningPreference = $originalWarning
    }

    if ($testResult -is [bool]) { return $testResult }
    elseif ($testResult) { return [bool]$testResult.IsInstalled }
    else { return $false }
}

function Get-GroupStatus {
    <#
    .SYNOPSIS
    获取分组的安装状态统计
    .PARAMETER GroupName
    分组名称（Basic / Advanced）
    .RETURNS
    @{ Total; Installed; StepStatuses }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$GroupName
    )

    $group = $script:StepGroups[$GroupName]
    $total = $group.StepIds.Count
    $installed = 0
    $stepStatuses = @{}

    foreach ($stepId in $group.StepIds) {
        $stepConfig = Get-StepConfigById -StepId $stepId
        if (-not $stepConfig) { continue }

        $isInstalled = Invoke-SilentStepTest -TestFunction $stepConfig.TestFunction

        $stepStatuses[$stepId] = $isInstalled
        if ($isInstalled) { $installed++ }
    }

    return @{
        Total        = $total
        Installed    = $installed
        StepStatuses = $stepStatuses
    }
}

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

function Register-CcqShortcut {
    <#
    .SYNOPSIS
    注册 ccq 快捷命令（当前会话 + Profile 持久化）
    .DESCRIPTION
    非阻塞设计：失败仅输出 Debug 级警告，不影响安装主流程。
    进程级幂等：同一进程内仅持久化一次，避免重复写入 Profile。
    #>
    param()

    # 进程级幂等 guard：同一进程内仅持久化一次
    if ($script:CcqShortcutRegistered) {
        return
    }

    $installScriptUrl = "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.ps1"
    $manageScriptUrl = "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/manage.ps1"

    $shortcutTemplate = @'
function ccq {
    param(
        [ValidateSet('安装面板', '管理面板', 'Install', 'Manage', '')]
        [string]$Panel = ''
    )

    $installScriptUrl = '__INSTALL_SCRIPT_URL__'
    $manageScriptUrl = '__MANAGE_SCRIPT_URL__'

    function Show-CcqPanelMenu {
        param(
            [int]$DefaultIndex = 1
        )

        $options = @(
            @{ Label = '安装面板'; Value = 'Install' },
            @{ Label = '管理面板'; Value = 'Manage' }
        )
        $selectedIndex = [Math]::Max(0, [Math]::Min($DefaultIndex, $options.Count - 1))

        try {
            if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
                return $options[$selectedIndex].Value
            }
        } catch {
            return $options[$selectedIndex].Value
        }

        $renderMenu = {
            param([int]$Index)

            Write-Host ''
            Write-Host 'CCQ 面板选择'
            Write-Host '使用 ↑/↓ 选择，Enter 确认，Esc 取消'
            Write-Host ''

            for ($i = 0; $i -lt $options.Count; $i++) {
                $prefix = if ($i -eq $Index) { '> ' } else { '  ' }
                Write-Host ($prefix + $options[$i].Label)
            }
        }

        $menuLineCount = 4 + $options.Count
        $redrawMenu = {
            param([int]$Index)

            try {
                $top = [Math]::Max(0, [Console]::CursorTop - $menuLineCount)
                [Console]::SetCursorPosition(0, $top)

                $blank = ' ' * [Math]::Max(1, [Console]::WindowWidth - 1)
                for ($i = 0; $i -lt $menuLineCount; $i++) {
                    Write-Host $blank
                }

                [Console]::SetCursorPosition(0, $top)
            } catch {
                Write-Host ''
            }

            & $renderMenu $Index
        }

        $cursorVisible = $true
        $cursorVisibilityCaptured = $false

        try {
            try {
                $cursorVisible = [Console]::CursorVisible
                $cursorVisibilityCaptured = $true
                [Console]::CursorVisible = $false
            } catch { }

            & $renderMenu $selectedIndex

            while ($true) {
                $key = [Console]::ReadKey($true)
                switch ($key.Key) {
                    'UpArrow' {
                        $selectedIndex = ($selectedIndex - 1 + $options.Count) % $options.Count
                        & $redrawMenu $selectedIndex
                    }
                    'DownArrow' {
                        $selectedIndex = ($selectedIndex + 1) % $options.Count
                        & $redrawMenu $selectedIndex
                    }
                    'Enter' {
                        return $options[$selectedIndex].Value
                    }
                    'Escape' {
                        Write-Host ''
                        return ''
                    }
                }
            }
        } catch {
            Write-Host ''
            return $options[$selectedIndex].Value
        } finally {
            if ($cursorVisibilityCaptured) {
                try { [Console]::CursorVisible = $cursorVisible } catch { }
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($Panel)) {
        $Panel = Show-CcqPanelMenu -DefaultIndex 1
        if ([string]::IsNullOrWhiteSpace($Panel)) {
            Write-Host '已取消'
            return
        }
    }

    switch ($Panel) {
        { $_ -in @('Install', '安装面板') } { irm $installScriptUrl | iex }
        { $_ -in @('Manage', '管理面板') } { irm $manageScriptUrl | iex }
        default { Write-Host ('未知面板: ' + $Panel) }
    }
}
'@

    $shortcutContentText = $shortcutTemplate.Replace('__INSTALL_SCRIPT_URL__', $installScriptUrl).Replace('__MANAGE_SCRIPT_URL__', $manageScriptUrl)
    $shortcutContent = @($shortcutContentText -split "`r?`n")

    try {
        # 1) 当前会话立即可用
        $ccqScript = [ScriptBlock]::Create(($shortcutContent -join "`n"))
        Set-Item -Path Function:\global:ccq -Value $ccqScript

        # 2) Profile 持久化（仅写 SHORTCUTS 子段）
        $profilePath = $PROFILE
        if ([string]::IsNullOrWhiteSpace($profilePath)) {
            return
        }

        # 先迁移旧结构（幂等）
        if (Test-Path $profilePath) {
            $null = Migrate-ManagedBlockToSubsections -FilePath $profilePath
        }

        # 规范化写入 SHORTCUTS 子段（收敛历史重复 + 裸 ccq 函数清理）
        $saved = Set-CcqShortcutSubsectionInFile -FilePath $profilePath -ShortcutContent $shortcutContent

        # 降级：托管块不存在时创建新块
        if (-not $saved) {
            $saved = Write-ProfileSubsection -FilePath $profilePath -SectionName "SHORTCUTS" -SectionContent $shortcutContent
        }


        if (-not $saved) {
            Write-UiWarning "⚠ ccq 快捷命令持久化失败（不影响安装流程）" -Level Debug
        } else {
            # 成功后置位，确保同一进程内不会重复写盘
            $script:CcqShortcutRegistered = $true

            try {
                # 在当前进程中刷新 Profile，让 irm|iex 这类同进程安装场景无需新开终端。
                # 注意：若用户通过 pwsh -File 启动安装器，父进程作用域无法被子进程修改。
                if (Test-Path $profilePath) { . $profilePath }
            } catch {
                Write-UiWarning "⚠ 当前会话加载 Profile 失败（不影响安装流程）: $($_.Exception.Message)" -Level Debug
            }
        }

    } catch {
        Write-UiWarning "⚠ 注册 ccq 快捷命令失败（不影响安装流程）: $($_.Exception.Message)" -Level Debug
    }
}

function Invoke-GroupedInstall {
    <#
    .SYNOPSIS
    执行分组安装（依赖闭包 + 确认 + 拓扑排序 + 执行）
    .PARAMETER StepIds
    目标步骤 ID 数组
    .PARAMETER State
    安装状态对象
    .RETURNS
    执行结果统计
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$StepIds,

        [Parameter(Mandatory = $true)]
        [InstallState]$State
    )

    # 计算依赖闭包
    $closure = Get-DependencyClosure -SelectedStepIds $StepIds

    if (-not $closure.FinalPlan -or $closure.FinalPlan.Count -eq 0) {
        Write-Host ""
        Write-UiSuccess "所有选定步骤已安装，无需操作"
        # 即使无需安装，也执行 Profile 规范化（清理历史污染）
        Register-CcqShortcut
        return @{ Total = 0; Success = 0; Failed = 0; Skipped = 0 }
    }

    # 无条件显示执行计划并确认
    $confirmed = Show-ExecutionPlan `
        -OriginalSelection $closure.OriginalSelection `
        -AutoAdded $closure.AutoAdded `
        -FinalPlan $closure.FinalPlan

    if (-not $confirmed) {
        Write-UiWarning "安装已取消"
        return @{ Total = 0; Success = 0; Failed = 0; Skipped = 0 }
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

    # 指纹管理步骤 → 种子写入清单（Success + Skipped）
    # Success: CCQ 刚安装/更新了此步骤，记录指纹
    # Skipped: 步骤已安装但被跳过，同样需要种子，否则 Update 会因无指纹而误报"有更新"
    try {
        $fpManagedSteps = @("ClaudeMd", "ClaudeConfig", "CcgWorkflow")
        $manifest = Read-UpdateManifest
        $seeded = $false

        foreach ($sid in $orderedStepIds) {
            if ($sid -notin $fpManagedSteps) { continue }
            $sr = $State.StepResults[$sid]
            if (-not $sr -or ($sr.Status -ne [StepStatus]::Success -and $sr.Status -ne [StepStatus]::Skipped)) { continue }

            $fnName = "Get-${sid}Fingerprint"
            if (-not (Get-Command $fnName -ErrorAction SilentlyContinue)) { continue }

            $fp = & $fnName
            if (-not [string]::IsNullOrWhiteSpace($fp)) {
                $manifest["steps"][$sid] = @{
                    fingerprint = $fp
                    appliedAt   = (Get-Date).ToUniversalTime().ToString("o")
                }
                $seeded = $true
            }
        }

        if ($seeded) {
            Write-UpdateManifest -Manifest $manifest
        }
    } catch {
        # 指纹种子写入失败不阻塞安装流程
    }

    Register-CcqShortcut

    return $results
}

function Show-AdvancedSelectMenu {
    <#
    .SYNOPSIS
    显示进阶步骤的多选菜单（带状态标签）
    .RETURNS
    用户选择的 StepId 数组
    #>
    param()

    Write-Host ""
    Write-UiPrimary "正在检测进阶扩展组件状态..." -Level Detail
    Write-Host ""

    $advancedGroup = $script:StepGroups["Advanced"]
    $options = @()
    $stepIdMap = @()
    $defaultSelected = @()

    for ($i = 0; $i -lt $advancedGroup.StepIds.Count; $i++) {
        $stepId = $advancedGroup.StepIds[$i]
        $stepConfig = Get-StepConfigById -StepId $stepId
        if (-not $stepConfig) { continue }

        $stepNum = $i + 1

        # 静默获取安装状态（委托 Invoke-SilentStepTest）
        $isInstalled = Invoke-SilentStepTest -TestFunction $stepConfig.TestFunction

        $statusBadge = if ($isInstalled) { "【已安装】" } else { "【未安装】" }
        $displayText = "$($stepNum). $($stepConfig.StepName)$statusBadge - $($stepConfig.Description)"

        $options += $displayText
        $stepIdMap += $stepId

        # 默认勾选策略：未安装 + 非可选 → 勾选
        if (-not $isInstalled -and -not $stepConfig.IsOptional) {
            $defaultSelected += $i
        }
    }

    $selectedIndices = @(Show-MultiSelectMenu `
        -Title "进阶扩展 - 选择要安装的组件：" `
        -Options $options `
        -DefaultSelected $defaultSelected)

    # 安全的空值检查：处理 $null 或空数组
    if (-not $selectedIndices -or $selectedIndices.Count -eq 0) {
        return @()
    }

    $selectedStepIds = @()
    foreach ($idx in $selectedIndices) {
        $selectedStepIds += $stepIdMap[$idx]
    }

    return $selectedStepIds
}

# ─── 菜单函数 ───────────────────────────────────────────────────────────────

function Select-TopLevelAction {
    <#
    .SYNOPSIS
    显示顶层分组选择菜单
    .RETURNS
    选中的索引（0=基础, 1=进阶, -1=Esc）
    #>
    param()

    $options = @(
        "基础环境 - Node.js, Git, Claude Code, 第三方供应商配置"
        "进阶扩展 - 增强配置，MCP，Workflow"
    )

    return Show-SingleSelectMenu -Title "请选择操作：" -Options $options -DefaultIndex 0
}

function Select-AdvancedAction {
    <#
    .SYNOPSIS
    显示进阶扩展的子菜单
    .RETURNS
    选中的索引（0=一键, 1=可选, -1=Esc）
    #>
    param()

    $options = @(
        "一键安装 - 安装全部必选进阶组件（不含可选的 cc-switch/Codex/Antigravity CLI）"
        "可选安装 - 选择要安装的组件"
    )

    return Show-SingleSelectMenu -Title "进阶扩展 - 请选择安装模式：" -Options $options -DefaultIndex 0
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
    foreach ($groupName in @("Basic", "Advanced")) {
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
        Write-UiPrimary "快速开始：" -Level Detail
        Write-UiInfo "  ccq             - CCQ 面板入口（安装面板/管理面板）" -Level Detail
        Write-UiInfo "  claude          - 启动 Claude Code" -Level Detail
        Write-UiInfo "  claude --help   - 查看帮助信息" -Level Detail
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

        Write-UiInfo "支持一键搭建 Claude Code 的开发环境及进阶功能" -Level Detail
        Write-Host ""

        # 创建新的安装状态（纯内存，不持久化）
        $state = [InstallState]::new()

        # ── 参数组合校验
        if ($Mode -ne "" -and $Group -eq "") {
            Write-UiDanger "参数错误：-Mode 必须与 -Group 一起使用"
            return
        }
        if ($Group -eq "Basic" -and $Mode -eq "Select") {
            Write-UiDanger "参数错误：基础环境仅支持一键安装（-Group Basic），不支持 -Mode Select"
            return
        }

        # ── CLI 参数模式
        if ($Group -ne "") {
            $state.Mode = "Manage-$Group"

            if ($Group -eq "Basic") {
                # 基础环境：直接一键安装
                Write-UiPrimary "基础环境一键安装模式" -Level Detail
                Write-Host ""
                $basicStepIds = $script:StepGroups["Basic"].StepIds
                $results = Invoke-GroupedInstall -StepIds $basicStepIds -State $state
                if ($results.Total -gt 0) {
                    Show-FinalSummary -State $state -Results $results
                }
            }
            elseif ($Group -eq "Advanced") {
                if ($Mode -eq "Select") {
                    # 进阶：多选模式
                    Write-UiPrimary "进阶扩展可选安装模式" -Level Detail
                    Write-Host ""
                    $selectedIds = @(Show-AdvancedSelectMenu)
                    if ($selectedIds -and $selectedIds.Count -gt 0) {
                        $results = Invoke-GroupedInstall -StepIds $selectedIds -State $state
                        if ($results.Total -gt 0) {
                            Show-FinalSummary -State $state -Results $results
                        }
                    } else {
                        Write-UiWarning "未选择任何步骤"
                    }
                }
                else {
                    # 进阶：一键安装（默认，排除可选步骤）
                    Write-UiPrimary "进阶扩展一键安装模式" -Level Detail
                    Write-Host ""
                    $advancedStepIds = @($script:StepGroups["Advanced"].StepIds | ForEach-Object {
                        $sid = $_
                        $stepCfg = Get-StepConfigById -StepId $sid
                        if (-not $stepCfg.IsOptional) { $sid }
                    })
                    $results = Invoke-GroupedInstall -StepIds $advancedStepIds -State $state
                    if ($results.Total -gt 0) {
                        Show-FinalSummary -State $state -Results $results
                    }
                }
            }

            return
        }

        # ── -Staged 参数：进入交互菜单
        # ── 无参数：也进入交互菜单

        $state.Mode = "Manage-Interactive"

        while ($true) {
            $topChoice = Select-TopLevelAction

            if ($topChoice -eq -1) {
                Write-Host ""
                Write-UiPrimary "退出 CCQ" -Level Detail
                break
            }

            if ($topChoice -eq 0) {
                # 基础环境：直接一键安装
                Write-Host ""
                Write-UiPrimary "基础环境一键安装" -Level Detail
                Write-Host ""

                $basicStepIds = $script:StepGroups["Basic"].StepIds
                $results = Invoke-GroupedInstall -StepIds $basicStepIds -State $state

                if ($results.Total -gt 0) {
                    Show-FinalSummary -State $state -Results $results
                }

                Write-Host ""
                Write-UiDim "按任意键返回主菜单..."
                $null = [Console]::ReadKey($true)
            }
            elseif ($topChoice -eq 1) {
                # 进阶扩展：显示子菜单
                $advChoice = Select-AdvancedAction

                if ($advChoice -eq -1) {
                    continue
                }

                if ($advChoice -eq 0) {
                    # 一键安装（排除可选步骤）
                    Write-Host ""
                    Write-UiPrimary "进阶扩展一键安装" -Level Detail
                    Write-Host ""

                    $advancedStepIds = @($script:StepGroups["Advanced"].StepIds | ForEach-Object {
                        $sid = $_
                        $stepCfg = Get-StepConfigById -StepId $sid
                        if (-not $stepCfg.IsOptional) { $sid }
                    })
                    $results = Invoke-GroupedInstall -StepIds $advancedStepIds -State $state

                    if ($results.Total -gt 0) {
                        Show-FinalSummary -State $state -Results $results
                    }

                    Write-Host ""
                    Write-UiDim "按任意键返回主菜单..."
                    $null = [Console]::ReadKey($true)
                }
                elseif ($advChoice -eq 1) {
                    # 可选安装
                    Write-Host ""
                    $selectedIds = @(Show-AdvancedSelectMenu)

                    if ($selectedIds -and $selectedIds.Count -gt 0) {
                        $results = Invoke-GroupedInstall -StepIds $selectedIds -State $state

                        if ($results.Total -gt 0) {
                            Show-FinalSummary -State $state -Results $results
                        }
                    } else {
                        Write-UiWarning "未选择任何步骤"
                    }

                    Write-Host ""
                    Write-UiDim "按任意键返回主菜单..."
                    $null = [Console]::ReadKey($true)
                }
            }
        }

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
