# NodeJS-Direct.ps1 - Node.js 专属安装层
# 职责：直接安装 Node.js（通过 winget 或 MSI）

#Requires -Version 5.1
Set-StrictMode -Version Latest

function Install-NodeViaDirect {
    <#
    .SYNOPSIS
    直接安装 Node.js LTS（通过 winget 或 MSI）
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
        Write-UiPrimary "📦 直接安装 Node.js LTS..." -Level Detail

        $wingetSuccess = $false

        # 阶段 1：尝试 winget 安装
        if (Test-CommandAvailable -Command "winget") {
            try {
                $nodeInstall = Invoke-WingetInstall -PackageId "OpenJS.NodeJS.LTS" -PackageName "Node.js LTS" -Silent -AcceptLicense
                if ($nodeInstall.Success) {
                    Write-UiSuccess "✓ Node.js LTS 通过 winget 安装成功" -Level Detail
                    $wingetSuccess = $true
                } else {
                    Write-UiWarning "⚠ winget 安装失败，回退到 MSI 下载..." -Level Detail
                }
            } catch {
                Write-UiWarning "⚠ winget 安装异常: $($_.Exception.Message)，回退到 MSI 下载..." -Level Detail
            }
        } else {
            Write-UiWarning "⚠ winget 不可用，尝试 MSI 直接下载安装..." -Level Detail
        }

        # 阶段 2：winget 不可用或失败时，回退到 MSI 直接下载
        if (-not $wingetSuccess) {
            $latestLtsUrl = "https://nodejs.org/dist/latest-v$($script:RequiredNodeVersion).x/"
            $msiPattern = "node-v\d+\.\d+\.\d+-x64\.msi"

            Write-UiPrimary "正在获取最新 LTS 版本信息..." -Level Detail
            $htmlContent = ""
            try {
                $htmlContent = Invoke-RestMethod -Uri $latestLtsUrl -TimeoutSec 30 -UseBasicParsing
            } catch {
                throw "无法访问 Node.js 官网: $($_.Exception.Message)"
            }

            $msiFileName = ""
            if ($htmlContent -match $msiPattern) {
                $msiFileName = $matches[0]
            } else {
                throw "无法从 Node.js 官网解析 MSI 文件名"
            }

            $msiUrl = "$latestLtsUrl$msiFileName"
            $msiPath = Join-Path $env:TEMP $msiFileName

            Write-UiPrimary "正在下载 Node.js LTS MSI 安装包..." -Level Detail
            $downloadResult = Invoke-FileDownload -Url $msiUrl -OutputPath $msiPath -Description "Node.js LTS MSI"
            if (-not $downloadResult.Success) {
                throw "下载 Node.js MSI 失败: $($downloadResult.ErrorMessage)"
            }

            Write-UiPrimary "正在执行 MSI 静默安装..." -Level Detail
            $msiArgs = @("/i", $msiPath, "/quiet", "/norestart", "ADDLOCAL=ALL")
            $msiResult = Invoke-ExternalCommand -Command "msiexec" -Arguments $msiArgs -TimeoutSeconds 300 -RetryCount 0

            try { Remove-Item $msiPath -Force -ErrorAction SilentlyContinue } catch { }

            if (-not $msiResult.Success -or $msiResult.ExitCode -ne 0) {
                throw "MSI 安装失败 (退出码: $($msiResult.ExitCode))"
            }

            Write-UiSuccess "✓ Node.js LTS 通过 MSI 安装成功" -Level Detail
        }

        Refresh-SessionPath
        $directNodePath = Join-Path $env:ProgramFiles "nodejs"
        if (Test-Path $directNodePath) {
            $env:PATH = "$directNodePath;$env:PATH"
        }

        $result.Success = $true
        $result.Data["DirectNodeDetected"] = $true
        $result.Data["DirectNodePath"] = $directNodePath
        $result.Data["MigrationTarget"] = "direct"
        return (Complete-NodeRuntimeInstall -Result $result -ProviderType "direct" -ShouldRestoreGlobalPackages:$ShouldRestoreGlobalPackages -GlobalPackagesBackup $GlobalPackagesBackup)
    } catch {
        $result.ErrorMessage = "安装阶段失败: $($_.Exception.Message)"
        Write-UiDanger "✗ $($result.ErrorMessage)"
    }

    return $result
}
