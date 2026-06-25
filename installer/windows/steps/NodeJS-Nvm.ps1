# NodeJS-Nvm.ps1 - nvm-windows 专属安装层
# 职责：nvm-windows 安装、环境同步

#Requires -Version 5.1
Set-StrictMode -Version Latest

function Sync-NvmSessionEnvironment {
    <#
    .SYNOPSIS
    从注册表刷新 NVM_HOME/NVM_SYMLINK 到当前会话，并尝试将 nvm 注入 PATH
    .DESCRIPTION
    nvm-windows 安装后在注册表写入环境变量，但当前 PowerShell 会话未继承。
    此函数刷新这些变量并确保 nvm.exe 可被发现。
    #>
    param()

    foreach ($envVar in @("NVM_HOME", "NVM_SYMLINK")) {
        if (-not [Environment]::GetEnvironmentVariable($envVar, "Process")) {
            foreach ($scope in @("User", "Machine")) {
                $val = [Environment]::GetEnvironmentVariable($envVar, $scope)
                if ($val) {
                    [Environment]::SetEnvironmentVariable($envVar, $val, "Process")
                    Write-UiInfo "  已刷新 $envVar = $val" -Level Detail
                    break
                }
            }
        }
    }

    Refresh-SessionPath

    if (-not (Test-CommandAvailable -Command "nvm")) {
        $nvmFallbackPath = $env:NVM_HOME
        if (-not $nvmFallbackPath) { $nvmFallbackPath = Join-Path $env:APPDATA "nvm" }
        if (Test-Path (Join-Path $nvmFallbackPath "nvm.exe")) {
            $env:PATH = "$nvmFallbackPath;$env:PATH"
            Write-UiInfo "  已将 $nvmFallbackPath 注入 PATH" -Level Detail
        }
    }
}

function Install-NodeViaNvm {
    <#
    .SYNOPSIS
    使用 nvm-windows + Node.js LTS 安装
    .RETURNS
    安装结果对象
    #>
    param(
        [bool]$ShouldRestoreGlobalPackages = $false,
        [array]$GlobalPackagesBackup = @()
    )

    $result = @{
        Success = $false
        Data = @{}
        ErrorMessage = ""
        Message = ""
    }

    try {
        Write-UiPrimary "📦 通过 nvm-windows 安装 Node.js..." -Level Detail

        Sync-NvmSessionEnvironment

        if (Test-CommandAvailable -Command "nvm") {
            Write-UiSuccess "✓ nvm-windows 已安装，跳过安装步骤" -Level Detail
        } else {
            if (-not (Test-CommandAvailable -Command "winget")) {
                throw "winget 不可用，无法安装 nvm-windows"
            }

            $nvmInstall = Invoke-WingetInstall -PackageId "CoreyButler.NVMforWindows" -PackageName "nvm-windows" -Silent -AcceptLicense
            if (-not $nvmInstall.Success) {
                throw "winget 安装 nvm-windows 失败"
            }

            Sync-NvmSessionEnvironment
        }

        if (-not (Test-CommandAvailable -Command "nvm")) {
            throw "nvm-windows 安装后仍不可用（已尝试刷新 NVM_HOME 和 PATH）"
        }

        $nvmVersion = Get-CommandVersion -Command "nvm"
        $result.Data["NvmVersion"] = $nvmVersion
        Write-UiSuccess "✓ nvm-windows 验证成功 (版本: $nvmVersion)" -Level Detail

        Write-UiPrimary "🟢 正在安装 Node.js LTS..." -Level Detail
        $installResult = Invoke-ExternalCommand -Command "nvm" -Arguments @("install", "lts") -TimeoutSeconds 300 -RetryCount 0
        if (-not $installResult.Success) {
            throw "nvm 安装 Node.js LTS 失败: $($installResult.Error)"
        }

        $listResult = Invoke-ExternalCommand -Command "nvm" -Arguments @("list") -SuppressOutput -TimeoutSeconds 60 -RetryCount 0
        $installedVersions = @()
        if ($listResult.Output) {
            $installedVersions = @(
                $listResult.Output -split "[\r\n]+" | ForEach-Object {
                    if ($_ -match '(\d+\.\d+\.\d+)') {
                        try { [version]$matches[1] } catch { $null }
                    }
                } | Where-Object { $_ } | Sort-Object -Descending
            )
        }
        if (-not $installedVersions -or $installedVersions.Count -eq 0) {
            throw "nvm list 未返回已安装版本，无法激活 Node.js"
        }

        $targetVersion = $installedVersions[0].ToString()
        $useResult = Invoke-ExternalCommand -Command "nvm" -Arguments @("use", $targetVersion) -TimeoutSeconds 120 -RetryCount 0
        if (-not $useResult.Success) {
            throw "nvm use $targetVersion 失败: $($useResult.Error)"
        }

        Refresh-SessionPath

        $result.Success = $true
        $result.Data["NvmDetected"] = $true
        $result.Data["NvmSelectedVersion"] = $targetVersion
        $result.Data["MigrationTarget"] = "nvm"
        return (Complete-NodeRuntimeInstall -Result $result -ProviderType "nvm" -ShouldRestoreGlobalPackages:$ShouldRestoreGlobalPackages -GlobalPackagesBackup $GlobalPackagesBackup)
    } catch {
        $result.ErrorMessage = "通过 nvm-windows 安装 Node.js 失败: $($_.Exception.Message)"
        Write-UiDanger "✗ $($result.ErrorMessage)"
    }

    return $result
}
