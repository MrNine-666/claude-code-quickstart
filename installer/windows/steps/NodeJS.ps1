# NodeJS.ps1 - Node.js 安装和配置（主入口）
# 作者: 哈雷酱 (本小姐的 Node.js 管理杰作！)
# 功能: 优先复用现有 node/npm 运行时（版本达标即跳过）；不达标时优先用当前 provider 原地修复，无法修复时才用 nvm-windows / Node.js 直装兜底
#       不再执行跨 provider 迁移、卸载现有 provider、清理 PATH 或搬迁 npm 全局包

#Requires -Version 5.1
Set-StrictMode -Version Latest

# 导入依赖模块
$scriptRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. "$scriptRoot\core\Process.ps1"
. "$scriptRoot\core\Profile.ps1"
. "$scriptRoot\core\Ui.ps1"
. "$scriptRoot\core\Net.ps1"

# 全局配置
$script:RequiredNodeVersion = "20"  # Node.js LTS 最低版本要求

# 加载子模块（按依赖顺序）
$stepRoot = $PSScriptRoot
. "$stepRoot\NodeJS-Detect.ps1"   # 检测层
. "$stepRoot\NodeJS-Common.ps1"   # 通用层
. "$stepRoot\NodeJS-Nvm.ps1"      # nvm 专属层
. "$stepRoot\NodeJS-Direct.ps1"   # Node.js专属层

function Install-NodeJS {
    <#
    .SYNOPSIS
    执行步骤 01 安装（运行时优先 + 原地修复 + nvm/direct 兜底）
    .RETURNS
    安装结果对象
    #>
    param()

    $result = @{
        Success = $false
        Data = @{}
        ErrorMessage = ""
        Message = ""
    }

    try {
        Write-UiPrimary "📦 开始配置 Node.js..." -Level Detail

        $snapshot = Test-NodeJSInstalled
        if ($snapshot -and $snapshot.Data) {
            foreach ($key in $snapshot.Data.Keys) {
                $result.Data[$key] = $snapshot.Data[$key]
            }
        }

        $providerType = if ($result.Data.ContainsKey("ProviderType")) { [string]$result.Data["ProviderType"] } else { "none" }
        $activeProvider = if ($result.Data.ContainsKey("ActiveProvider")) { [string]$result.Data["ActiveProvider"] } else { $providerType }
        $nodeRuntimeSatisfied = if ($result.Data.ContainsKey("NodeRuntimeSatisfied")) { [bool]$result.Data["NodeRuntimeSatisfied"] } else { $false }
        $canRepairInPlace = if ($result.Data.ContainsKey("CanRepairInPlace")) { [bool]$result.Data["CanRepairInPlace"] } else { $false }
        $nodeAvailable = if ($result.Data.ContainsKey("NodeAvailable")) { [bool]$result.Data["NodeAvailable"] } else { $false }
        $npmAvailable = if ($result.Data.ContainsKey("NpmAvailable")) { [bool]$result.Data["NpmAvailable"] } else { $false }
        $nodeVersion = if ($result.Data.ContainsKey("NodeVersion")) { [string]$result.Data["NodeVersion"] } else { "" }

        # 新策略：当前 node/npm 可用且版本达标时直接跳过，不再因 provider 类型进入迁移菜单。
        # 这样可安全保留用户已有的 fnm/nvm/direct/portable/mixed 环境，不做迁移、卸载或 PATH 清理。
        if ($nodeRuntimeSatisfied) {
            $result.Success = $true
            $result.Message = "Node.js 与 npm 已就绪（provider: ${providerType}，active: ${activeProvider}），已跳过变更"
            $result.Data["SkippedProviderInstall"] = $true
            $result.Data["RepairMode"] = "KeepExistingRuntime"
            return $result
        }

        $providerTarget = ""
        if ($canRepairInPlace -and $activeProvider -in @("fnm", "nvm", "direct")) {
            $repairChoice = Show-NodeRuntimeRepairMenu -ActiveProvider $activeProvider `
                -NodeVersion $nodeVersion `
                -RequiredNodeVersion $script:RequiredNodeVersion `
                -NodeAvailable:$nodeAvailable `
                -NpmAvailable:$npmAvailable
            if ($repairChoice -eq "cancel") {
                throw "用户取消了 Node.js 原地修复"
            }

            $providerTarget = $activeProvider
            $result.Data["RepairMode"] = "InPlaceRepair"
        } else {
            $reason = if ($activeProvider -in @("portable", "unknown")) {
                "当前 Node.js 版本过低或不完整，但来源无法安全原地更新。"
            } elseif ($activeProvider -eq "none" -or $providerType -eq "none") {
                "未检测到可用的 Node.js。"
            } else {
                "当前 Node.js 运行时无法通过原 provider 安全修复。"
            }
            $providerTarget = Show-NodeFallbackInstallMenu -ActiveProvider $activeProvider -Reason $reason
            if ($providerTarget -eq "cancel") {
                throw "用户取消了 Node.js 兜底安装方式选择"
            }
            $result.Data["RepairMode"] = "FallbackInstall"
        }

        if ([string]::IsNullOrWhiteSpace($providerTarget)) {
            throw "未选择有效的 Node.js 安装/修复方式"
        }

        $result.Data["ProviderTarget"] = $providerTarget

        $providerResult = $null
        switch ($providerTarget) {
            "fnm" {
                $providerResult = Repair-NodeViaFnm
            }
            "nvm" {
                $providerResult = Install-NodeViaNvm
            }
            "direct" {
                $providerResult = Install-NodeViaDirect
            }
            default {
                throw "不支持的 provider: $providerTarget"
            }
        }

        if (-not $providerResult) {
            throw "Node.js 安装/修复未返回结果"
        }
        if ($providerResult.Data) {
            $mergedData = @{}
            foreach ($key in $result.Data.Keys) {
                $mergedData[$key] = $result.Data[$key]
            }
            foreach ($key in $providerResult.Data.Keys) {
                $mergedData[$key] = $providerResult.Data[$key]
            }
            $providerResult.Data = $mergedData
        }

        return $providerResult

    } catch {
        $result.ErrorMessage = "Node.js安装失败: $($_.Exception.Message)"
        Write-UiDanger "✗ $($result.ErrorMessage)"
    }

    return $result
}

function Verify-NodeJS {
    <#
    .SYNOPSIS
    验证步骤 01 执行结果
    .RETURNS
    验证结果对象
    #>
    param()

    $result = @{
        Success = $false
        Message = ""
        ErrorMessage = ""
    }

    try {
        Write-UiPrimary "✅ 验证 Node.js..." -Level Detail

        $verificationPassed = $true
        $issues = @()

        if (Test-CommandAvailable -Command "node") {
            $nodeVersion = Get-CommandVersion -Command "node"
            Write-UiInfo "  Node.js 当前版本: $nodeVersion" -Level Detail

            if ($nodeVersion -match '^v?\d+\.\d+') {
                $versionNumber = $nodeVersion -replace '^v?(\d+)\..*$', '$1'

                if ($versionNumber -match '^\d+$') {
                    if ([int]$versionNumber -ge [int]$script:RequiredNodeVersion) {
                        Write-UiSuccess "✓ Node.js 验证通过 (版本: $nodeVersion)" -Level Detail
                    } else {
                        $verificationPassed = $false
                        $issues += "Node.js 版本过低 (当前: $nodeVersion, 需要: v$script:RequiredNodeVersion+)"
                    }
                } else {
                    $verificationPassed = $false
                    $issues += "无法解析 Node.js 版本号: $nodeVersion"
                }
            } else {
                $verificationPassed = $false
                $issues += "无法获取有效的 Node.js 版本号 (返回: $nodeVersion)"
            }
        } else {
            $verificationPassed = $false
            $issues += "Node.js 命令不可用"
        }

        if (Test-CommandAvailable -Command "npm") {
            $npmVersion = Get-CommandVersion -Command "npm"
            Write-UiSuccess "✓ npm 验证通过 (版本: $npmVersion)" -Level Detail
        } else {
            $verificationPassed = $false
            $issues += "npm 命令不可用"
        }

        try {
            $npmTestResult = Invoke-ExternalCommand -Command "npm" -Arguments @("--version") -SuppressOutput -TimeoutSeconds 10
            if ($npmTestResult.Success) {
                Write-UiSuccess "✓ npm 功能验证通过" -Level Detail
            } else {
                $issues += "npm 功能测试失败"
            }
        } catch {
            $issues += "npm 功能测试异常: $($_.Exception.Message)"
        }

        if ($verificationPassed -and $issues.Count -eq 0) {
            $result.Success = $true
            $result.Message = "Node.js验证通过"
        } else {
            $result.Success = $false
            $result.ErrorMessage = "验证失败: $($issues -join '; ')"
            Write-UiDanger "✗ $($result.ErrorMessage)"
        }

    } catch {
        $result.ErrorMessage = "Node.js验证过程失败: $($_.Exception.Message)"
        Write-UiDanger "✗ $($result.ErrorMessage)"
    }

    return $result
}
