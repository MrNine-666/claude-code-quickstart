# 步骤契约和状态模型 - CCQ
# 作者: 哈雷酱 (本小姐的架构设计杰作！)
# 功能: 定义统一步骤接口、状态模型、调度骨架（纯内存，实时检测）

#Requires -Version 5.1

# 严格模式
Set-StrictMode -Version Latest

# 导入依赖模块
. "$PSScriptRoot\Process.ps1"

# 全局配置
$script:StepTimeout = 300  # 步骤超时时间（秒）

# 步骤状态枚举
enum StepStatus {
    Pending = 0
    Running = 1
    Success = 2
    Failed = 3
    Skipped = 4
}

# 步骤结果类型
class StepResult {
    [string]$StepId
    [string]$StepName
    [StepStatus]$Status
    [string]$Message
    [hashtable]$Data
    [datetime]$StartTime
    [datetime]$EndTime
    [string]$ErrorDetails

    StepResult([string]$stepId, [string]$stepName) {
        $this.StepId = $stepId
        $this.StepName = $stepName
        $this.Status = [StepStatus]::Pending
        $this.Message = ""
        $this.Data = @{}
        $this.StartTime = [datetime]::MinValue
        $this.EndTime = [datetime]::MinValue
        $this.ErrorDetails = ""
    }
}

# 安装状态类型（纯内存，不持久化）
class InstallState {
    [datetime]$StartTime
    [string]$Mode  # "OneClick" 或 "Staged" 或 "Manage-Basic"
    [hashtable]$StepResults
    [hashtable]$GlobalData
    [string]$CurrentStep
    [bool]$IsCompleted

    InstallState() {
        $this.StartTime = Get-Date
        $this.Mode = ""
        $this.StepResults = @{}
        $this.GlobalData = @{}
        $this.CurrentStep = ""
        $this.IsCompleted = $false
    }
}

function Resolve-TestResultBool {
    <#
    .SYNOPSIS
    统一解析步骤函数返回值为布尔值（兼容 bool 和 hashtable 两种返回类型）
    .PARAMETER TestResult
    步骤函数的返回值（可能是 bool 或 hashtable）
    .PARAMETER PropertyName
    要提取的属性名（Test 函数用 "IsInstalled"，Install/Verify 函数用 "Success"）
    .RETURNS
    布尔值
    #>
    param(
        $TestResult,

        [string]$PropertyName = "IsInstalled"
    )

    if ($TestResult -is [bool]) { return $TestResult }
    elseif ($TestResult) { return [bool]$TestResult.$PropertyName }
    else { return $false }
}

function Get-StepStatusMessage {
    <#
    .SYNOPSIS
    生成统一的步骤状态文案（按需附带版本号）
    .PARAMETER StepName
    步骤显示名称
    .PARAMETER Status
    步骤状态：Success / Failed / Skipped
    .PARAMETER Result
    步骤结果对象
    .PARAMETER ActionLabel
    操作标签：安装 / 更新
    .RETURNS
    string
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$StepName,

        [Parameter(Mandatory = $true)]
        [ValidateSet('Success', 'Failed', 'Skipped')]
        [string]$Status,

        [Parameter(Mandatory = $true)]
        [StepResult]$Result,

        [string]$ActionLabel = '安装'
    )

    $version = ''
    if ($Result.Data -and $Result.Data.ContainsKey('Version') -and -not [string]::IsNullOrWhiteSpace([string]$Result.Data['Version'])) {
        $version = [string]$Result.Data['Version']
    }

    $versionSuffix = if ([string]::IsNullOrWhiteSpace($version)) { '' } else { " (版本: $version)" }

    switch ($Status) {
        'Success' {
            return "✅ $StepName 已${ActionLabel}$versionSuffix"
        }
        'Skipped' {
            if ($Result.Message -like '组件已安装*' -or $Result.Message -like '依赖已满足*') {
                return "✅ $StepName 已安装$versionSuffix"
            } else {
                return "⏭ $StepName 已跳过"
            }
        }
        'Failed' {
            $errorDetails = if (-not [string]::IsNullOrWhiteSpace($Result.ErrorDetails)) {
                " - $($Result.ErrorDetails)"
            } else {
                ''
            }
            return "❌ $StepName ${ActionLabel}失败$errorDetails"
        }
    }
}

function Invoke-StepActionLifecycle {
    <#
    .SYNOPSIS
    统一步骤生命周期引擎（Install / Update 共用）
    .PARAMETER StepConfig
    步骤配置 hashtable（来自 Registry）
    .PARAMETER Action
    操作类型："Install" 或 "Update"
    .PARAMETER State
    安装状态对象
    .PARAMETER OnMissing
    未安装时处理策略（仅 Update 模式有效）："Ask" / "Skip" / "Install" / "Fail"
    .PARAMETER IsAutoAddedDependency
    当前步骤是否为自动补齐的依赖（仅 Install 模式生效）
    .RETURNS
    StepResult 对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$StepConfig,

        [Parameter(Mandatory = $true)]
        [ValidateSet("Install", "Update")]
        [string]$Action,

        [Parameter(Mandatory = $true)]
        [InstallState]$State,

        [string]$OnMissing = "Ask",

        [switch]$IsAutoAddedDependency
    )

    $stepId = $StepConfig.StepId
    $stepName = $StepConfig.StepName
    $testFunction = $StepConfig.TestFunction
    $verifyFunction = $StepConfig.VerifyFunction

    # 确定操作函数
    $actionFunction = if ($Action -eq "Install") {
        $StepConfig.InstallFunction
    } else {
        $StepConfig.UpdateFunction
    }

    $actionLabel = if ($Action -eq "Install") { "安装" } else { "更新" }

    Write-UiOutput "🔄 执行步骤: $stepName ($actionLabel)" -Level Essential -Type Info

    # 创建或获取步骤结果
    if ($State.StepResults.ContainsKey($stepId)) {
        $stepResult = $State.StepResults[$stepId]
    } else {
        $stepResult = [StepResult]::new($stepId, $stepName)
        $State.StepResults[$stepId] = $stepResult
    }

    try {
        $stepResult.Status = [StepStatus]::Running
        $stepResult.StartTime = Get-Date
        $State.CurrentStep = $stepId

        # 1. 执行测试阶段（实时检测，抑制 UI 输出避免 [FAIL] 噪音）
        Write-UiOutput "  🔍 测试阶段: $testFunction" -Level Debug -Type Info
        $previousSuppressUnifiedCheckOutput = $false
        $hadSuppressUnifiedCheckOutput = [bool](Get-Variable -Scope Script -Name SuppressUnifiedCheckOutput -ErrorAction SilentlyContinue)
        if ($hadSuppressUnifiedCheckOutput) {
            $previousSuppressUnifiedCheckOutput = [bool]$script:SuppressUnifiedCheckOutput
        }
        $script:SuppressUnifiedCheckOutput = $true
        try {
            $testResult = & $testFunction 6>$null
        } finally {
            if ($hadSuppressUnifiedCheckOutput) {
                $script:SuppressUnifiedCheckOutput = $previousSuppressUnifiedCheckOutput
            } else {
                Remove-Variable -Scope Script -Name SuppressUnifiedCheckOutput -ErrorAction SilentlyContinue
            }
        }
        $isInstalled = Resolve-TestResultBool -TestResult $testResult -PropertyName "IsInstalled"

        if ($Action -eq "Install") {
            $skipBecauseInstalled = $isInstalled -and $StepConfig.SkipIfInstalled
            $skipBecauseSatisfiedAutoAddedDep = $isInstalled -and
                $IsAutoAddedDependency -and
                $StepConfig.ContainsKey("SkipIfInstalledWhenAutoAdded") -and
                [bool]$StepConfig["SkipIfInstalledWhenAutoAdded"]

            # Install 模式：已安装且满足跳过策略 → 跳过
            if ($skipBecauseInstalled -or $skipBecauseSatisfiedAutoAddedDep) {
                $stepResult.Status = [StepStatus]::Skipped
                $stepResult.Message = if ($skipBecauseSatisfiedAutoAddedDep) {
                    "依赖已满足，跳过交互式安装"
                } else {
                    "组件已安装，跳过安装"
                }
                $stepResult.EndTime = Get-Date

                # 合并 testResult 的版本和数据（跳过路径也需要版本信息）
                if ($testResult -and $testResult -isnot [bool]) {
                    if ($testResult -is [hashtable]) {
                        if ($testResult.ContainsKey("Version") -and $testResult["Version"]) {
                            $stepResult.Data["Version"] = $testResult["Version"]
                        }
                        if ($testResult.ContainsKey("Data") -and $testResult["Data"] -is [hashtable]) {
                            foreach ($key in $testResult["Data"].Keys) {
                                $stepResult.Data[$key] = $testResult["Data"][$key]
                            }
                        }
                    } elseif ($testResult.Version) {
                        $stepResult.Data["Version"] = $testResult.Version
                    }
                }

                if ($skipBecauseSatisfiedAutoAddedDep) {
                    Show-StepProgress -StepName $stepName -Status "Skipped" -Message (Get-StepStatusMessage -StepName $stepName -Status "Skipped" -Result $stepResult -ActionLabel $actionLabel)
                } else {
                    Show-StepProgress -StepName $stepName -Status "Skipped" -Message (Get-StepStatusMessage -StepName $stepName -Status "Skipped" -Result $stepResult -ActionLabel $actionLabel)
                }
                return $stepResult
            }
        } else {
            # Update 模式
            if (-not $isInstalled) {
                # 未安装 → 按 OnMissing 策略处理
                switch ($OnMissing) {
                    "Skip" {
                        $stepResult.Status = [StepStatus]::Skipped
                        $stepResult.Message = "组件未安装，跳过更新"
                        $stepResult.EndTime = Get-Date
                        Write-UiOutput "⏭ 组件未安装，跳过 (OnMissing=Skip)" -Level Essential -Type Warning
                        return $stepResult
                    }
                    "Fail" {
                        $stepResult.Status = [StepStatus]::Failed
                        $stepResult.Message = "组件未安装，更新失败"
                        $stepResult.ErrorDetails = "Not installed"
                        $stepResult.EndTime = Get-Date
                        Show-StepProgress -StepName $stepName -Status "Failed" -Message (Get-StepStatusMessage -StepName $stepName -Status "Failed" -Result $stepResult -ActionLabel $actionLabel)
                        return $stepResult
                    }
                    "Install" {
                        Write-UiOutput "📦 组件未安装，执行安装..." -Level Essential -Type Info
                        $actionFunction = $StepConfig.InstallFunction
                    }
                    "Ask" {
                        Write-UiOutput "❓ [$stepName] 未安装。" -Level Essential -Type Warning
                        $options = @("跳过此步骤", "直接安装")
                        $choice = Show-SingleSelectMenu -Title "[$stepName] 未安装，选择操作：" -Options $options
                        if ($choice -eq 0) {
                            $stepResult.Status = [StepStatus]::Skipped
                            $stepResult.Message = "用户选择跳过"
                            $stepResult.EndTime = Get-Date
                            return $stepResult
                        } else {
                            $actionFunction = $StepConfig.InstallFunction
                        }
                    }
                }
            }
        }

        # 2. 执行操作阶段（Install 或 Update）
        Write-UiOutput "  🔧 ${actionLabel}阶段: $actionFunction" -Level Debug -Type Info
        $actionResult = & $actionFunction

        $actionSuccess = Resolve-TestResultBool -TestResult $actionResult -PropertyName "Success"

        if (-not $actionSuccess) {
            $actionError = if ($actionResult -is [bool]) { "${actionLabel}函数返回失败" }
                            elseif ($actionResult -and $actionResult.ErrorMessage) { $actionResult.ErrorMessage }
                            else { "未知错误" }
            throw "${actionLabel}阶段失败: $actionError"
        }

        # 操作成功后立即清除缓存，确保验证阶段不命中旧结果
        Clear-TestResultCache -StepId $stepId

        # 3. 执行验证阶段（如果提供）
        if ($verifyFunction) {
            Write-UiOutput "  ✅ 验证阶段: $verifyFunction" -Level Debug -Type Info
            $verifyResult = & $verifyFunction

            $verifySuccess = Resolve-TestResultBool -TestResult $verifyResult -PropertyName "Success"

            if (-not $verifySuccess) {
                $verifyError = if ($verifyResult -is [bool]) { "验证函数返回失败" }
                               elseif ($verifyResult -and $verifyResult.ErrorMessage) { $verifyResult.ErrorMessage }
                               else { "未知错误" }
                throw "验证阶段失败: $verifyError"
            }
        }

        # 步骤成功完成
        $stepResult.Status = [StepStatus]::Success
        $stepResult.Message = "步骤${actionLabel}成功"
        $stepResult.EndTime = Get-Date

        # 合并结果数据
        foreach ($candidate in @($testResult, $actionResult)) {
            if (-not $candidate -or $candidate -is [bool]) {
                continue
            }

            $dataObject = $null

            if ($candidate -is [hashtable] -and $candidate.ContainsKey("Data")) {
                $dataObject = $candidate["Data"]
            }
            elseif ($candidate.PSObject.Properties.Name -contains "Data") {
                $dataObject = $candidate.Data
            }

            if (-not $dataObject) {
                continue
            }

            if ($dataObject -is [hashtable]) {
                foreach ($key in $dataObject.Keys) {
                    $stepResult.Data[$key] = $dataObject[$key]
                }
            }
            elseif ($dataObject -is [System.Collections.IDictionary]) {
                foreach ($key in $dataObject.Keys) {
                    $stepResult.Data[[string]$key] = $dataObject[$key]
                }
            }
            elseif ($dataObject -is [System.Management.Automation.PSCustomObject]) {
                foreach ($prop in $dataObject.PSObject.Properties) {
                    $stepResult.Data[$prop.Name] = $prop.Value
                }
            }
        }

        # 合并 UpdatedItems（Update 模式特有）
        if ($Action -eq "Update" -and $actionResult -is [hashtable] -and $actionResult.ContainsKey("UpdatedItems")) {
            $stepResult.Data["UpdatedItems"] = $actionResult["UpdatedItems"]
        }

        Show-StepProgress -StepName $stepName -Status "Success" -Message (Get-StepStatusMessage -StepName $stepName -Status "Success" -Result $stepResult -ActionLabel $actionLabel)

    } catch {
        $stepResult.Status = [StepStatus]::Failed
        $stepResult.Message = "步骤${actionLabel}失败"
        $stepResult.ErrorDetails = $_.Exception.Message
        $stepResult.EndTime = Get-Date

        Show-StepProgress -StepName $stepName -Status "Failed" -Message (Get-StepStatusMessage -StepName $stepName -Status "Failed" -Result $stepResult -ActionLabel $actionLabel)
    }

    return $stepResult
}
function Invoke-StepLifecycle {
    <#
    .SYNOPSIS
    执行步骤安装生命周期（Test -> Install -> Verify）— 统一引擎的薄包装
    .DESCRIPTION
    完全基于实时检测，不依赖缓存状态。每次都执行 Test 函数检测当前环境。
    .PARAMETER StepId
    步骤 ID
    .PARAMETER StepName
    步骤显示名称
    .PARAMETER TestFunction
    测试函数名
    .PARAMETER InstallFunction
    安装函数名
    .PARAMETER VerifyFunction
    验证函数名（可选）
    .PARAMETER State
    安装状态对象（仅用于本次会话内的结果记录）
    .PARAMETER SkipIfInstalled
    如果已安装是否跳过
    .PARAMETER SkipIfInstalledWhenAutoAdded
    自动补齐依赖且已满足时是否允许跳过交互式安装
    .PARAMETER IsAutoAddedDependency
    当前步骤是否为自动补齐的依赖
    .RETURNS
    步骤执行结果对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$StepId,

        [Parameter(Mandatory = $true)]
        [string]$StepName,

        [Parameter(Mandatory = $true)]
        [string]$TestFunction,

        [Parameter(Mandatory = $true)]
        [string]$InstallFunction,

        [string]$VerifyFunction,

        [Parameter(Mandatory = $true)]
        [InstallState]$State,

        [switch]$SkipIfInstalled,

        [switch]$SkipIfInstalledWhenAutoAdded,

        [switch]$IsAutoAddedDependency
    )

    # 构建步骤配置 hashtable
    $stepConfig = @{
        StepId                        = $StepId
        StepName                      = $StepName
        TestFunction                  = $TestFunction
        InstallFunction               = $InstallFunction
        VerifyFunction                = $VerifyFunction
        UpdateFunction                = ""
        SkipIfInstalled               = [bool]$SkipIfInstalled
        SkipIfInstalledWhenAutoAdded  = [bool]$SkipIfInstalledWhenAutoAdded
    }

    return Invoke-StepActionLifecycle -StepConfig $stepConfig -Action Install -State $State -IsAutoAddedDependency:$IsAutoAddedDependency
}

function Invoke-UpdateLifecycle {
    <#
    .SYNOPSIS
    执行步骤更新生命周期（Test -> Update -> Verify）— 统一引擎的薄包装
    .PARAMETER StepConfig
    步骤配置 hashtable（来自 Registry）
    .PARAMETER State
    安装状态对象
    .PARAMETER OnMissing
    未安装时处理策略："Ask" / "Skip" / "Install" / "Fail"
    .RETURNS
    StepResult 对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$StepConfig,

        [Parameter(Mandatory = $true)]
        [InstallState]$State,

        [string]$OnMissing = "Ask"
    )

    # 更新前清除检测缓存，确保 Test 阶段重新检测
    Clear-TestResultCache

    return Invoke-StepActionLifecycle -StepConfig $StepConfig -Action Update -State $State -OnMissing $OnMissing
}

function Test-StepDependencies {
    <#
    .SYNOPSIS
    检查步骤依赖是否满足（实时检测 + 会话状态）
    .DESCRIPTION
    优先检查本次会话内的失败状态（阻止执行），然后实时检测依赖是否真的已安装。
    .PARAMETER StepId
    要检查的步骤 ID
    .PARAMETER State
    安装状态对象（仅用于本次会话内的结果记录）
    .RETURNS
    依赖检查结果对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$StepId,

        [Parameter(Mandatory = $true)]
        [InstallState]$State
    )

    $result = @{
        CanExecute = $true
        MissingDependencies = @()
        FailedDependencies = @()
    }

    $dependencies = Get-StepDependencies
    if ($dependencies.ContainsKey($StepId)) {
        foreach ($depStepId in $dependencies[$StepId]) {
            # 优先检查本次会话内的状态
            if ($State.StepResults.ContainsKey($depStepId)) {
                $depResult = $State.StepResults[$depStepId]
                if ($depResult.Status -eq [StepStatus]::Failed) {
                    # 本次会话内失败 → 阻止执行
                    $result.CanExecute = $false
                    $result.FailedDependencies += $depStepId
                    continue
                } elseif ($depResult.Status -eq [StepStatus]::Success -or
                          $depResult.Status -eq [StepStatus]::Skipped) {
                    # 本次会话内成功 → 通过
                    continue
                }
            }

            # 实时检测依赖是否真的已安装
            $depStepConfig = Get-StepConfigById -StepId $depStepId
            if ($depStepConfig) {
                try {
                    # 静默调用 TestFunction，抑制所有输出流（移除 *>&1 避免 WarningRecord/ErrorRecord 污染）
                    $depTestResult = & $depStepConfig.TestFunction 2>$null 3>$null 4>$null 5>$null 6>$null

                    $depInstalled = Resolve-TestResultBool -TestResult $depTestResult -PropertyName "IsInstalled"

                    if (-not $depInstalled) {
                        $result.CanExecute = $false
                        $result.MissingDependencies += $depStepId
                    }
                } catch {
                    # 检测失败视为未安装
                    $result.CanExecute = $false
                    $result.MissingDependencies += $depStepId
                }
            } else {
                # 找不到依赖配置 → 视为未满足
                $result.CanExecute = $false
                $result.MissingDependencies += $depStepId
            }
        }
    }

    return $result
}

function Get-ExecutionOrder {
    <#
    .SYNOPSIS
    根据依赖关系计算步骤执行顺序（优先级拓扑排序：每轮取 Order 最小的可执行步骤）
    .PARAMETER StepIds
    要排序的步骤 ID 数组
    .RETURNS
    按依赖关系排序的步骤 ID 数组
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$StepIds
    )

    $dependencies = Get-StepDependencies
    $ordered = @()
    $remaining = $StepIds.Clone()

    # 预加载 Order 映射（避免循环内重复调用）
    $registry = Get-StepRegistry
    $orderMap = @{}
    foreach ($step in $registry) {
        $orderMap[$step.StepId] = $step.Order
    }

    # 优先级拓扑排序：每轮仅取 Order 最小的可执行步骤，保证全局 Order 顺序
    while ($remaining.Count -gt 0) {
        $canExecute = @()

        foreach ($stepId in $remaining) {
            $deps = if ($dependencies.ContainsKey($stepId)) { $dependencies[$stepId] } else { @() }
            $allDepsSatisfied = $true

            foreach ($dep in $deps) {
                if ($dep -in $remaining) {
                    $allDepsSatisfied = $false
                    break
                }
            }

            if ($allDepsSatisfied) {
                $canExecute += $stepId
            }
        }

        if ($canExecute.Count -eq 0) {
            # 检测到循环依赖
            Write-UiWarning "⚠ 检测到循环依赖，剩余步骤: $($remaining -join ', ')"
            $ordered += $remaining
            break
        }

        # 取 Order 最小的单个步骤，确保全局按 Order 递增输出
        $next = $canExecute | Sort-Object { if ($orderMap.ContainsKey($_)) { $orderMap[$_] } else { [int]::MaxValue } } | Select-Object -First 1
        $ordered += $next

        # 从剩余列表中移除（@() 确保 StrictMode 下结果始终为数组）
        $remaining = @($remaining | Where-Object { $_ -ne $next })
    }

    # HC-13 策略 A：调用方使用 @() 包裹确保数组安全
    return $ordered
}

function Build-UpdatePlan {
    <#
    .SYNOPSIS
    构建更新执行计划（过滤可更新步骤 → 依赖闭包补齐 → 后置联动 → 拓扑排序）
    .PARAMETER RequestedSteps
    指定更新的步骤 ID（为空时 = 全部可更新步骤）
    .PARAMETER All
    更新全部已安装的可更新步骤
    .RETURNS
    排序后的步骤配置数组
    #>
    param(
        [string[]]$RequestedSteps = @(),
        [switch]$All
    )

    $registry = Get-StepRegistry

    # 过滤有 UpdateFunction 的步骤
    $updatableSteps = @($registry | Where-Object { $_.UpdateFunction -ne "" })

    if ($All -or $RequestedSteps.Count -eq 0) {
        # 全部可更新步骤
        $planStepIds = @($updatableSteps | ForEach-Object { $_.StepId })
    } else {
        # 验证指定的步骤
        foreach ($stepId in $RequestedSteps) {
            $found = $updatableSteps | Where-Object { $_.StepId -eq $stepId }
            if (-not $found) {
                $exists = Get-StepConfigById -StepId $stepId
                if ($exists) {
                    throw "步骤 '$stepId' 不支持更新（无 UpdateFunction）"
                } else {
                    throw "未知的步骤 ID: '$stepId'"
                }
            }
        }
        $planStepIds = @($RequestedSteps)
    }

    # 更新计划不做前置依赖闭包补齐：
    # 更新场景下依赖已安装，无需连带更新（安装场景由 Install 侧的 Get-DependencyClosure 处理）
    $closureIds = [System.Collections.ArrayList]::new()
    foreach ($id in $planStepIds) {
        if ($closureIds -notcontains $id) {
            [void]$closureIds.Add($id)
        }
    }

    # 拓扑排序
    $orderedIds = @(Get-ExecutionOrder -StepIds @($closureIds))

    # 返回排序后的步骤配置数组
    $plan = @()
    foreach ($stepId in $orderedIds) {
        $stepConfig = Get-StepConfigById -StepId $stepId
        if ($stepConfig) {
            $plan += $stepConfig
        }
    }

    return $plan
}

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 所有函数在 dot-source 后自动可用
