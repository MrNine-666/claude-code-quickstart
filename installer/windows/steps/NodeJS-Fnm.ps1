# NodeJS-Fnm.ps1 - fnm 专属安装层
# 职责：fnm 安装、卸载

#Requires -Version 5.1
Set-StrictMode -Version Latest

function Install-NodeViaFnm {
    <#
    .SYNOPSIS
    使用 fnm 安装或修复 Node.js
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
        Write-UiPrimary "📦 通过 fnm 安装 Node.js..." -Level Detail

        Write-UiPrimary "🔧 安装 fnm (Fast Node Manager)..." -Level Detail
        if (Test-CommandAvailable -Command "fnm") {
            Write-UiSuccess "✓ fnm 已安装，跳过安装步骤" -Level Detail
        } else {
            if (Test-CommandAvailable -Command "winget") {
                try {
                    $fnmInstall = Invoke-WingetInstall -PackageId "Schniz.fnm" -PackageName "fnm" -Silent -AcceptLicense
                    if (-not $fnmInstall.Success) {
                        throw "winget 安装 fnm 失败"
                    }
                    Write-UiSuccess "✓ fnm 通过 winget 安装成功" -Level Detail
                } catch {
                    Write-UiWarning "⚠ winget 安装失败，尝试手动下载安装..." -Level Detail

                    $fnmDir = "$env:LOCALAPPDATA\fnm"
                    if (-not (Test-Path $fnmDir)) {
                        New-Item -Path $fnmDir -ItemType Directory -Force | Out-Null
                    }

                    $fnmUrl = "https://github.com/Schniz/fnm/releases/latest/download/fnm-windows.zip"
                    $fnmZip = "$env:TEMP\fnm-windows.zip"

                    Write-UiPrimary "正在下载 fnm..." -Level Detail
                    $downloadResult = Invoke-FileDownload -Url $fnmUrl -OutputPath $fnmZip -Description "fnm (Fast Node Manager)"
                    if (-not $downloadResult.Success) {
                        throw "下载失败: $($downloadResult.ErrorMessage)"
                    }

                    Expand-Archive -Path $fnmZip -DestinationPath $fnmDir -Force
                    Remove-Item $fnmZip -Force
                    $env:PATH = "$fnmDir;$env:PATH"
                    Write-UiSuccess "✓ fnm 手动安装成功" -Level Detail
                }
            } else {
                throw "winget 不可用且无法手动安装 fnm"
            }
        }

        Refresh-SessionPath
        if (-not (Test-CommandAvailable -Command "fnm")) {
            throw "fnm 安装后仍不可用"
        }

        $fnmVersion = Get-CommandVersion -Command "fnm"
        $result.Data["FnmVersion"] = $fnmVersion
        Write-UiSuccess "✓ fnm 验证成功 (版本: $fnmVersion)" -Level Detail

        Write-UiPrimary "🔄 重新加载 PowerShell Profile 以刷新环境..." -Level Detail
        try {
            if (Test-Path $PROFILE) {
                . $PROFILE
                Write-UiSuccess "✓ PowerShell Profile 已重新加载" -Level Detail
            }
        } catch {
            Write-UiWarning "⚠ 重新加载 PowerShell Profile 时出错: $($_.Exception.Message)" -Level Debug
        }

        Refresh-SessionPath

        Write-UiPrimary "🟢 使用 fnm 安装 Node.js LTS..." -Level Detail
        $installResult = Invoke-ExternalCommand -Command "fnm" -Arguments @("install", "--lts") -TimeoutSeconds 300 -RetryCount 0
        if (-not $installResult.Success) {
            throw "fnm 安装 Node.js 失败: $($installResult.Error)"
        }
        Write-UiSuccess "✓ Node.js LTS 安装成功" -Level Detail

        Write-UiPrimary "🔄 初始化 fnm 环境变量..." -Level Detail
        try {
            $fnmEnvOutput = & fnm env --use-on-cd 2>&1 | Out-String
            if ($fnmEnvOutput) {
                Invoke-Expression $fnmEnvOutput
                Write-UiSuccess "✓ fnm 环境变量已注入当前会话" -Level Detail
            }
        } catch {
            Write-UiWarning "⚠ fnm env 执行异常: $($_.Exception.Message)" -Level Debug
        }

        $defaultResult = Invoke-ExternalCommand -Command "fnm" -Arguments @("default", "lts-latest") -TimeoutSeconds 60 -RetryCount 0
        if ($defaultResult.Success) {
            Write-UiSuccess "✓ Node.js LTS 已设为默认版本" -Level Detail
        } else {
            Write-UiWarning "⚠ fnm default 失败，尝试 fnm use..." -Level Debug
        }

        if (-not $env:FNM_MULTISHELL_PATH) {
            try {
                $fnmEnvRetry = & fnm env --use-on-cd 2>&1 | Out-String
                if ($fnmEnvRetry) { Invoke-Expression $fnmEnvRetry }
            } catch {
                Write-UiWarning "⚠ fnm env 重试失败: $($_.Exception.Message)" -Level Debug
            }
        }

        $useResult = Invoke-ExternalCommand -Command "fnm" -Arguments @("use", "--install-if-missing", "lts-latest") -TimeoutSeconds 60 -RetryCount 0
        if (-not $useResult.Success) {
            $friendlyMsg = "Node.js 版本激活失败。"
            $friendlyMsg += "`n  原因: fnm 环境变量未正确初始化"
            $friendlyMsg += "`n  建议: 关闭当前终端，打开新的 PowerShell 7 窗口后重新运行安装程序"
            $friendlyMsg += "`n  或手动执行: fnm env --use-on-cd | Out-String | Invoke-Expression; fnm use lts-latest"
            throw $friendlyMsg
        }
        Write-UiSuccess "✓ Node.js LTS 版本已激活" -Level Detail

        $result.Success = $true
        $result.Data["MigrationTarget"] = "fnm"
        return (Complete-NodeRuntimeInstall -Result $result -ProviderType "fnm" -ShouldRestoreGlobalPackages:$ShouldRestoreGlobalPackages -GlobalPackagesBackup $GlobalPackagesBackup)
    } catch {
        $result.ErrorMessage = "通过 fnm 安装 Node.js 失败: $($_.Exception.Message)"
        Write-UiDanger "✗ $($result.ErrorMessage)"
    }

    return $result
}

function Uninstall-Fnm {
    <#
    .SYNOPSIS
    清理 fnm 及其 PATH/Profile 残留
    .PARAMETER EnvSnapshot
    Test-NodeJSInstalled 返回的 Data 哈希表
    .RETURNS
    @{ Success; ErrorMessage; CleanedPaths }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$EnvSnapshot
    )

    $result = @{
        Success = $false
        ErrorMessage = ""
        CleanedPaths = @()
    }

    try {
        Write-UiWarning "⚠ 开始清理 fnm 环境..." -Level Detail

        $candidatePaths = @(
            "$env:LOCALAPPDATA\fnm",
            "$env:USERPROFILE\.fnm"
        )

        $fnmPath = [string]$EnvSnapshot["FnmPath"]
        if ($fnmPath -and (Test-Path $fnmPath -PathType Leaf)) {
            $candidatePaths += (Split-Path -Parent $fnmPath)
        }

        $cleanedPathMap = @{}
        foreach ($pathItem in $candidatePaths) {
            if ([string]::IsNullOrWhiteSpace($pathItem)) { continue }
            $normalized = $pathItem.Replace("/", "\").Trim().TrimEnd("\")
            if (-not [string]::IsNullOrWhiteSpace($normalized)) {
                $cleanedPathMap[$normalized.ToLower()] = $normalized
            }
        }
        $cleanPaths = @($cleanedPathMap.Values)

        if (Test-CommandAvailable -Command "winget") {
            try {
                $fnmUninstall = Invoke-ExternalCommand -Command "winget" -Arguments @("uninstall", "--id", "Schniz.fnm", "-e", "--disable-interactivity", "--accept-source-agreements") -SuppressOutput -TimeoutSeconds 240 -RetryCount 0
                if ($fnmUninstall.Success) {
                    Write-UiSuccess "✓ winget 卸载 fnm 成功" -Level Debug
                } else {
                    Write-UiWarning "⚠ winget 卸载 fnm 失败: $($fnmUninstall.Error)" -Level Debug
                }
            } catch {
                Write-UiWarning "⚠ winget 卸载 fnm 异常: $($_.Exception.Message)" -Level Debug
            }
        }

        foreach ($folderPath in $cleanPaths) {
            if (Test-Path $folderPath) {
                try {
                    $oldProgressPreference = $ProgressPreference
                    $ProgressPreference = 'SilentlyContinue'
                    Remove-Item -Path $folderPath -Recurse -Force -ErrorAction Stop
                    $ProgressPreference = $oldProgressPreference
                    Write-UiSuccess "✓ 已清理目录: $folderPath" -Level Debug
                } catch {
                    $ProgressPreference = $oldProgressPreference
                    Write-UiWarning "⚠ 清理目录失败: $folderPath，原因: $($_.Exception.Message)" -Level Debug
                }
            }
        }

        foreach ($scope in @("Process", "User")) {
            [Environment]::SetEnvironmentVariable("FNM_DIR", $null, $scope)
            [Environment]::SetEnvironmentVariable("FNM_MULTISHELL_PATH", $null, $scope)
        }
        Remove-Item Env:FNM_DIR -ErrorAction SilentlyContinue
        Remove-Item Env:FNM_MULTISHELL_PATH -ErrorAction SilentlyContinue

        if (Test-Path $PROFILE) {
            $null = Remove-CcqSubsectionFromFile -FilePath $PROFILE -SectionName "FNM"
        }

        $targetMap = @{}
        foreach ($target in $cleanPaths) {
            $normalizedTarget = $target.Replace("/", "\").Trim().Trim('"').TrimEnd("\").ToLower()
            if (-not [string]::IsNullOrWhiteSpace($normalizedTarget)) {
                $targetMap[$normalizedTarget] = $true
            }
        }

        if ($targetMap.Keys.Count -gt 0) {
            $sessionKept = @()
            $sessionRemoved = @()
            foreach ($entry in ($env:PATH -split ";")) {
                $trimmed = $entry.Trim().Trim('"')
                if (-not $trimmed) { continue }
                $normalized = $trimmed.Replace("/", "\").TrimEnd("\").ToLower()
                if ($targetMap.ContainsKey($normalized)) {
                    $sessionRemoved += $trimmed
                } else {
                    $sessionKept += $trimmed
                }
            }
            if ($sessionRemoved.Count -gt 0) {
                $env:PATH = $sessionKept -join ";"
                $result.CleanedPaths += $sessionRemoved
            }

            $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
            if ($userPath) {
                $userKept = @()
                $userRemoved = @()
                foreach ($entry in ($userPath -split ";")) {
                    $trimmed = $entry.Trim().Trim('"')
                    if (-not $trimmed) { continue }
                    $normalized = $trimmed.Replace("/", "\").TrimEnd("\").ToLower()
                    if ($targetMap.ContainsKey($normalized)) {
                        $userRemoved += $trimmed
                    } else {
                        $userKept += $trimmed
                    }
                }
                if ($userRemoved.Count -gt 0) {
                    [Environment]::SetEnvironmentVariable("PATH", ($userKept -join ";"), "User")
                    $result.CleanedPaths += $userRemoved
                }
            }
        }

        Refresh-SessionPath

        $result.Success = $true
        Write-UiSuccess "✓ fnm 清理完成" -Level Detail
    } catch {
        $result.ErrorMessage = "清理 fnm 失败: $($_.Exception.Message)"
        Write-UiDanger "✗ $($result.ErrorMessage)"
    }

    return $result
}
