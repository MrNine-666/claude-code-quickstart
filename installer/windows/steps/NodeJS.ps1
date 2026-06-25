# NodeJS.ps1 - Node.js 安装和配置（主入口）
# 作者: 哈雷酱 (本小姐的 Node.js 管理杰作！)
# 功能: 支持 fnm / nvm-windows / Node.js 直装，统一 Node.js 安装与迁移

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
. "$stepRoot\NodeJS-Fnm.ps1"      # fnm 专属层
. "$stepRoot\NodeJS-Nvm.ps1"      # nvm 专属层
. "$stepRoot\NodeJS-Direct.ps1"   # Node.js专属层

function Install-NodeJS {
    <#
    .SYNOPSIS
    执行步骤 01 安装（Node.js provider 选择 + 安装/迁移）
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

        $shouldRestoreGlobalPackages = $false
        $globalPackagesBackup = @()
        $providerTarget = ""

        $snapshot = Test-NodeJSInstalled
        if ($snapshot -and $snapshot.Data) {
            foreach ($key in $snapshot.Data.Keys) {
                $result.Data[$key] = $snapshot.Data[$key]
            }
        }

        $providerType = if ($result.Data.ContainsKey("ProviderType")) { [string]$result.Data["ProviderType"] } else { "none" }
        $providerHealthy = if ($result.Data.ContainsKey("ProviderHealthy")) { [bool]$result.Data["ProviderHealthy"] } else { $false }

        switch ($providerType) {
            "none" {
                $providerTarget = Show-NodeProviderMenu
                if ($providerTarget -eq "cancel") {
                    throw "用户取消了 Node.js 安装方式选择"
                }
                $result.Data["MigrationMode"] = "FreshInstall"
            }
            default {
                if ($providerType -eq "mixed") {
                    Write-UiWarning "⚠ 检测到混合 Node.js 环境" -Level Detail
                }
                $migrationChoice = Show-NodeMigrationMenu -CurrentProviderType $providerType -ProviderHealthy:$providerHealthy
                if ($migrationChoice -eq "cancel") {
                    throw "用户取消了迁移操作"
                }
                if ($migrationChoice -eq "keep") {
                    if ($providerHealthy -or $providerType -eq "mixed") {
                        $result.Success = $true
                        $result.Message = "保留现有 $providerType 环境，已跳过变更"
                        $result.Data["SkippedProviderInstall"] = $true
                        $result.Data["MigrationMode"] = "KeepExisting"
                        return $result
                    }
                    $providerTarget = $providerType
                    $result.Data["MigrationMode"] = "RepairExisting"
                } else {
                    $providerTarget = $migrationChoice
                }
            }
        }

        if ([string]::IsNullOrWhiteSpace($providerTarget)) {
            throw "未选择有效的 Node.js provider"
        }

        $result.Data["MigrationTarget"] = $providerTarget

        $requiresMigration = ($providerType -ne "none") -and ($providerType -eq "mixed" -or $providerTarget -ne $providerType)
        if ($requiresMigration) {
            $globalPkgChoice = Show-SingleSelectMenu -Title "迁移时如何处理 npm 全局包？" -Options @(
                "迁移并恢复 npm 全局包（推荐）",
                "迁移但不恢复 npm 全局包"
            ) -DefaultIndex 0
            if ($globalPkgChoice -eq -1) {
                throw "用户取消了迁移设置"
            }
            $shouldRestoreGlobalPackages = ($globalPkgChoice -eq 0)
            $result.Data["MigrationMode"] = if ($shouldRestoreGlobalPackages) { "MigrateWithRestore" } else { "FreshInstall" }

            $currentProviderLabel = switch ($providerType) { "fnm" { "fnm" } "nvm" { "nvm-windows" } "direct" { "Node.js" } "portable" { "绿色版 Node.js" } default { $providerType } }
            $targetProviderLabel = switch ($providerTarget) { "fnm" { "fnm" } "nvm" { "nvm-windows" } "direct" { "Node.js" } default { $providerTarget } }
            if ($providerType -eq "portable") {
                $confirmTitle = "⚠ 将清理当前绿色版 Node.js 的 PATH 并安装 [$targetProviderLabel]。"
            } else {
                $confirmTitle = "⚠ 将卸载当前的 [$currentProviderLabel] 并安装 [$targetProviderLabel]。"
            }
            if ($shouldRestoreGlobalPackages) {
                $confirmTitle += "`n  您的全局 npm 包将自动备份并恢复。"
            }
            $confirmTitle += "`n  是否继续？"
            $confirm = Show-SingleSelectMenu -Title $confirmTitle -Options @("继续执行", "取消") -DefaultIndex 0
            if ($confirm -ne 0) {
                throw "用户取消了卸载操作"
            }

            if ($shouldRestoreGlobalPackages) {
                $npmResolve = Resolve-NpmForBackup -EnvSnapshot $snapshot.Data
                if ($npmResolve.Available) {
                    Write-UiInfo "npm 已就绪（方式: $($npmResolve.Method)），开始备份..." -Level Detail
                } else {
                    Write-UiWarning "$($npmResolve.ErrorMessage)" -Level Detail
                    Write-UiWarning "  无法备份 npm 全局包，您可以选择：" -Level Detail
                    $failChoice = Show-SingleSelectMenu -Title "npm 定位失败，请选择处理方式：" -Options @(
                        "继续迁移（跳过全局包恢复，后续可手动安装）",
                        "中止迁移（保留现有环境不做任何更改）"
                    ) -DefaultIndex 0
                    if ($failChoice -eq 1 -or $failChoice -eq -1) {
                        $result.Success = $true
                        $result.Message = "用户选择中止迁移，保留现有环境"
                        $result.Data["MigrationMode"] = "AbortedByUser"
                        Write-UiWarning "已中止迁移，保留现有环境"
                        return $result
                    }
                    $shouldRestoreGlobalPackages = $false
                    $result.Data["BackupSkipped"] = $true
                    $result.Data["BackupSkipReason"] = $npmResolve.ErrorMessage
                }

                if ($shouldRestoreGlobalPackages) {
                    $backupResult = Backup-NpmGlobalPackages
                    if (-not $backupResult.Success) {
                        Write-UiWarning "npm 全局包备份失败: $($backupResult.ErrorMessage)" -Level Detail
                        Write-UiWarning "  将继续迁移但跳过全局包恢复" -Level Detail
                        $shouldRestoreGlobalPackages = $false
                        $result.Data["BackupSkipped"] = $true
                        $result.Data["BackupSkipReason"] = $backupResult.ErrorMessage
                    } else {
                        $globalPackagesBackup = @($backupResult.Packages)
                        $result.Data["GlobalPackagesBackupCount"] = $globalPackagesBackup.Count
                        $result.Data["GlobalPackagesBackup"] = $globalPackagesBackup
                    }
                }
            }

            $hasFnmSignal = [bool]$snapshot.Data["FnmAvailable"]
            $hasPortableSignal = [bool]$snapshot.Data["PortableNodeDetected"]
            $hasOtherProviderSignal = [bool]$snapshot.Data["NvmDetected"] -or [bool]$snapshot.Data["DirectNodeDetected"]

            if ($hasFnmSignal -and $providerTarget -ne "fnm") {
                $fnmUninstallResult = Uninstall-Fnm -EnvSnapshot $snapshot.Data
                if (-not $fnmUninstallResult.Success) {
                    throw "卸载 fnm 失败: $($fnmUninstallResult.ErrorMessage)"
                }
                $result.Data["FnmUninstallCompleted"] = $true
                $result.Data["FnmUninstallCleanedPaths"] = @($fnmUninstallResult.CleanedPaths)
            }

            if ($hasOtherProviderSignal) {
                $skipDirectFlag = ($providerTarget -eq "direct")
                $skipNvmFlag   = ($providerTarget -eq "nvm")
                $uninstallResult = Uninstall-ExistingNode -EnvSnapshot $snapshot.Data `
                    -SkipDirect:$skipDirectFlag -SkipNvm:$skipNvmFlag
                if (-not $uninstallResult.Success) {
                    throw "卸载现有 Node 环境失败: $($uninstallResult.ErrorMessage)"
                }
                $result.Data["UninstallCompleted"] = $true
                $result.Data["UninstallCleanedPaths"] = @($uninstallResult.CleanedPaths)
            }

            if ($hasPortableSignal) {
                $portableCleanResult = Remove-PortableNodeFromPath -EnvSnapshot $snapshot.Data
                if (-not $portableCleanResult.Success) {
                    throw "清理绿色版 Node.js PATH 失败: $($portableCleanResult.ErrorMessage)"
                }
                $result.Data["PortablePathCleaned"] = ($portableCleanResult.CleanedPaths.Count -gt 0)
                $result.Data["PortableCleanedPaths"] = @($portableCleanResult.CleanedPaths)
            }

            Refresh-SessionPath
            Write-UiSuccess "✓ 迁移前清理完成，继续安装目标 provider" -Level Detail
        } elseif (-not $result.Data.ContainsKey("MigrationMode")) {
            $result.Data["MigrationMode"] = "NoConflict"
        }

        $providerResult = $null
        switch ($providerTarget) {
            "fnm" {
                $providerResult = Install-NodeViaFnm -ShouldRestoreGlobalPackages:$shouldRestoreGlobalPackages -GlobalPackagesBackup $globalPackagesBackup
            }
            "nvm" {
                $nvmAlreadyPresent = [bool]$snapshot.Data["NvmDetected"] -and ($providerType -eq "mixed")
                if ($nvmAlreadyPresent) {
                    Write-UiSuccess "✓ nvm-windows 已存在，无需重新安装" -Level Detail
                    Refresh-SessionPath
                    Get-Command -All node, npm -ErrorAction SilentlyContinue | Out-Null
                    $baseResult = @{ Success = $true; ErrorMessage = ""; Data = @{ SkippedReinstall = $true; MigrationTarget = "nvm" } }
                    $providerResult = Complete-NodeRuntimeInstall -Result $baseResult -ProviderType "nvm" -ShouldRestoreGlobalPackages:$shouldRestoreGlobalPackages -GlobalPackagesBackup $globalPackagesBackup
                } else {
                    $providerResult = Install-NodeViaNvm -ShouldRestoreGlobalPackages:$shouldRestoreGlobalPackages -GlobalPackagesBackup $globalPackagesBackup
                }
            }
            "direct" {
                $directAlreadyPresent = [bool]$snapshot.Data["DirectNodeDetected"] -and ($providerType -eq "mixed")
                if ($directAlreadyPresent) {
                    Write-UiSuccess "✓  Node.js 已存在，无需重新安装" -Level Detail
                    Refresh-SessionPath
                    Get-Command -All node, npm -ErrorAction SilentlyContinue | Out-Null
                    $baseResult = @{ Success = $true; ErrorMessage = ""; Data = @{ SkippedReinstall = $true; MigrationTarget = "direct" } }
                    $providerResult = Complete-NodeRuntimeInstall -Result $baseResult -ProviderType "direct" -ShouldRestoreGlobalPackages:$shouldRestoreGlobalPackages -GlobalPackagesBackup $globalPackagesBackup
                } else {
                    $providerResult = Install-NodeViaDirect -ShouldRestoreGlobalPackages:$shouldRestoreGlobalPackages -GlobalPackagesBackup $globalPackagesBackup
                }
            }
            default {
                throw "不支持的 provider: $providerTarget"
            }
        }

        if (-not $providerResult) {
            throw "provider 安装未返回结果"
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
