# Antigravity CLI 安装步骤 - CCQ
# 作者: 哈雷酱 (本小姐的专业 CLI 管理！)
# 功能: Antigravity CLI 官方安装脚本安装

#Requires -Version 5.1

# 严格模式
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 依赖: Ui.ps1, Process.ps1（由入口脚本 dot-source 加载）

function Get-AntigravityCliVersion {
    <#
    .SYNOPSIS
    通过 agy --version 获取 Antigravity CLI 版本
    .DESCRIPTION
    Antigravity CLI 不是 npm 包，官方安装脚本安装 agy 二进制。
    版本检测直接调用 agy --version，失败时返回空字符串。
    .RETURNS
    版本字符串，未安装或无法获取时返回空字符串
    #>
    try {
        if (-not (Test-CommandAvailable -Command "agy")) {
            return ""
        }

        $cmdResult = Invoke-ExternalCommand -Command "agy" `
            -Arguments @("--version") `
            -SuppressOutput -TimeoutSeconds 30 -RetryCount 0
        if ($cmdResult.Success -and $cmdResult.Output -match '(\d+\.[\d\.]+[\w\-]*)') {
            return $matches[1]
        }
        if ($cmdResult.Success -and -not [string]::IsNullOrWhiteSpace($cmdResult.Output)) {
            return ($cmdResult.Output -split "`n")[0].Trim()
        }
    } catch {
        # agy --version 失败，静默返回空
    }
    return ""
}

function Invoke-AntigravityCliInstaller {
    <#
    .SYNOPSIS
    执行 Antigravity CLI 官方 Windows 安装脚本
    .DESCRIPTION
    官方未提供 npm 包，Windows 安装方式为远程 PowerShell 安装脚本。
    脚本 URL: https://antigravity.google/cli/install.ps1
    安装方式: 使用 Invoke-RestMethod 下载脚本后通过 Invoke-Expression 执行。
    #>
    $scriptUrl = "https://antigravity.google/cli/install.ps1"

    # 先下载脚本内容，检查是否为空，避免传空字符串给 iex
    $scriptBlock = @"
try {
    `$script = Invoke-RestMethod -Uri '$scriptUrl' -TimeoutSec 60 -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace(`$script)) {
        throw '下载的安装脚本内容为空'
    }
    Invoke-Expression `$script
} catch {
    Write-Error "Antigravity CLI 安装脚本下载或执行失败: `$_"
    exit 1
}
"@

    return Invoke-ExternalCommand -Command "pwsh" `
        -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $scriptBlock) `
        -TimeoutSeconds 600 -SuppressOutput -RetryCount 0
}

function Test-AntigravityCliInstalled {
    <#
    .SYNOPSIS
    检测 Antigravity CLI 是否已安装
    .RETURNS
    标准检测结果 hashtable（IsInstalled, Version, Data, Message）
    #>

    return Invoke-UnifiedCheck -StepId "AntigravityCli" -DisplayName "Antigravity CLI" -CustomVerify {
        $ver = Get-AntigravityCliVersion
        if (-not [string]::IsNullOrWhiteSpace($ver)) {
            return $ver
        }
        return $false
    } -UseCache
}

function Install-AntigravityCli {
    <#
    .SYNOPSIS
    安装 Antigravity CLI
    .RETURNS
    包含 Success 字段的结果对象
    #>

    $result = @{
        Success      = $false
        ErrorMessage = ""
        Data         = @{}
    }

    try {
        Write-UiPrimary "安装 Antigravity CLI..." -Level Detail
        Write-UiPrimary "正在通过官方 PowerShell 脚本安装 Antigravity CLI..." -Level Detail
        Write-UiInfo "来源: https://antigravity.google/cli/install.ps1" -Level Detail

        $installOut = Invoke-AntigravityCliInstaller
        if (-not $installOut.Success) {
            throw "安装脚本执行失败: $($installOut.Error)"
        }

        # 刷新 PATH
        Write-UiPrimary "刷新环境变量..." -Level Detail
        Refresh-SessionPath

        # 验证安装
        Start-Sleep -Seconds 2
        $version = Get-AntigravityCliVersion
        if ([string]::IsNullOrWhiteSpace($version)) {
            throw "安装后未检测到 Antigravity CLI，请重新启动 PowerShell 后重试"
        }

        Write-UiSuccess "✓ Antigravity CLI 安装成功" -Level Detail
        Write-UiInfo "版本: $version" -Level Detail
        Write-UiInfo "命令: agy --help" -Level Detail

        $result.Success         = $true
        $result.Data["Version"] = $version
    }
    catch {
        $result.ErrorMessage = "安装 Antigravity CLI 失败: $($_.Exception.Message)"
        Write-UiDanger $result.ErrorMessage
    }

    return $result
}

function Verify-AntigravityCli {
    <#
    .SYNOPSIS
    验证 Antigravity CLI 安装
    .RETURNS
    包含 Success 字段的结果对象
    #>

    $result = @{
        Success      = $false
        ErrorMessage = ""
        Data         = @{}
    }

    try {
        # 验证版本信息可获取
        $version = Get-AntigravityCliVersion
        if ([string]::IsNullOrWhiteSpace($version)) {
            throw "未检测到 Antigravity CLI 版本信息"
        }

        # 验证命令可解析（仅检查路径，不执行）
        $cmdInfo = Get-Command "agy" -ErrorAction SilentlyContinue
        $cmdResolved = if ($cmdInfo) { "✓ ($($cmdInfo.Source))" } else { "- (PATH 未就绪，重启 Shell 后可用)" }

        Write-UiSuccess "✓ Antigravity CLI 验证通过" -Level Detail
        Write-UiInfo "  - 版本信息: $version" -Level Detail
        Write-UiInfo "  - 命令解析: $cmdResolved" -Level Detail

        $result.Success = $true
    }
    catch {
        $result.ErrorMessage = "验证 Antigravity CLI 失败: $($_.Exception.Message)"
        Write-UiDanger $result.ErrorMessage
    }

    return $result
}

function Update-AntigravityCli {
    <#
    .SYNOPSIS
    更新 Antigravity CLI 到最新版本
    .RETURNS
    @{ Success; ErrorMessage; Data; UpdatedItems }
    #>

    $result = @{
        Success      = $false
        ErrorMessage = ""
        Data         = @{}
        UpdatedItems = @()
    }

    try {
        Write-UiPrimary "更新 Antigravity CLI..." -Level Detail

        $oldVersion = Get-AntigravityCliVersion
        if ([string]::IsNullOrWhiteSpace($oldVersion)) {
            throw "无法获取当前 Antigravity CLI 版本，请确认已安装"
        }
        Write-UiInfo "当前版本: $oldVersion" -Level Detail

        # 官方 CLI 支持 agy update；若命令不可用或失败，则回退到官方安装脚本覆盖安装
        $updateResult = $null
        $usedInstallerFallback = $false
        try {
            $updateResult = Invoke-ExternalCommand -Command "agy" `
                -Arguments @("update") `
                -TimeoutSeconds 600 -SuppressOutput -RetryCount 0
        } catch {
            Write-UiWarning "agy update 执行失败，尝试通过官方安装脚本覆盖更新..."
            $usedInstallerFallback = $true
            $updateResult = Invoke-AntigravityCliInstaller
        }

        # StrictMode 防御：$updateResult 可能为 $null（异常路径下安装器也失败时）
        if ($null -eq $updateResult -or -not $updateResult.Success) {
            if (-not $usedInstallerFallback) {
                Write-UiWarning "agy update 未成功，尝试通过官方安装脚本覆盖更新..."
                $updateResult = Invoke-AntigravityCliInstaller
            }
            if ($null -eq $updateResult -or -not $updateResult.Success) {
                $errDetail = if ($updateResult) { $updateResult.Error } else { "安装脚本未返回结果" }
                throw "更新失败: $errDetail"
            }
        }

        Refresh-SessionPath

        $newVersion = Get-AntigravityCliVersion
        $result.Data["OldVersion"] = $oldVersion
        $result.Data["NewVersion"] = $newVersion

        if ([string]::IsNullOrWhiteSpace($newVersion)) {
            throw "更新后无法获取 Antigravity CLI 版本"
        }

        if ($oldVersion -eq $newVersion) {
            $result.UpdatedItems = @("noop::AntigravityCli::no-change")
            Write-UiDim "Antigravity CLI 已是最新版本 ($newVersion)" -Level Debug
        } else {
            $result.UpdatedItems = @("agy::antigravity-cli::${oldVersion}->${newVersion}")
            Write-UiSuccess "✓ Antigravity CLI 已更新: $oldVersion -> $newVersion" -Level Detail
        }

        $result.Success = $true
    }
    catch {
        $result.ErrorMessage = "更新 Antigravity CLI 失败: $($_.Exception.Message)"
        Write-UiDanger $result.ErrorMessage
    }

    return $result
}

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 所有函数在 dot-source 后自动可用
