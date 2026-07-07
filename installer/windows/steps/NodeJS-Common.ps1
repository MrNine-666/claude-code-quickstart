# NodeJS-Common.ps1 - Node.js 通用工具层
# 职责：运行时修复/兜底菜单、fnm 原地修复、安装后配置

#Requires -Version 5.1
Set-StrictMode -Version Latest

function Get-NodeProviderDisplayName {
    <#
    .SYNOPSIS
    返回 provider 的用户可见名称。
    #>
    param(
        [string]$ProviderType
    )

    switch ($ProviderType) {
        "fnm"      { return "fnm" }
        "nvm"      { return "nvm-windows" }
        "direct"   { return "Node.js 直装" }
        "portable" { return "绿色版 Node.js" }
        "mixed"    { return "混合 Node.js 环境" }
        "none"     { return "未安装 Node.js" }
        default     { return "未知来源 Node.js" }
    }
}

function Show-NodeFallbackInstallMenu {
    <#
    .SYNOPSIS
    无法安全原地修复时的兜底安装菜单。
    .RETURNS
    "nvm" / "direct" / "cancel"
    #>
    param(
        [string]$ActiveProvider = "none",
        [string]$Reason = ""
    )

    $providerLabel = Get-NodeProviderDisplayName -ProviderType $ActiveProvider
    $title = if ([string]::IsNullOrWhiteSpace($Reason)) {
        "当前 Node.js 运行时不可用或无法安全原地更新（来源: $providerLabel），请选择兜底安装方式："
    } else {
        "$Reason`n当前来源: $providerLabel`n请选择兜底安装方式："
    }

    $choice = Show-SingleSelectMenu -Title $title -Options @(
        "nvm-windows（推荐 - 可切换版本）",
        "Node.js 直装（简单，不能切换版本）"
    ) -DefaultIndex 0

    switch ($choice) {
        0 { return "nvm" }
        1 { return "direct" }
        default { return "cancel" }
    }
}

function Show-NodeProviderMenu {
    <#
    .SYNOPSIS
    干净机器上的 Node provider 选择菜单。
    .RETURNS
    "nvm" / "direct" / "cancel"
    #>
    param()

    return (Show-NodeFallbackInstallMenu -ActiveProvider "none" -Reason "未检测到可用的 Node.js。")
}

function Show-NodeRuntimeRepairMenu {
    <#
    .SYNOPSIS
    当前 provider 可修复时的原地安装/更新菜单。
    .RETURNS
    "repair" / "cancel"
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$ActiveProvider,

        [string]$NodeVersion = "",

        [string]$RequiredNodeVersion = "20",

        [bool]$NodeAvailable = $false,

        [bool]$NpmAvailable = $false
    )

    $providerLabel = Get-NodeProviderDisplayName -ProviderType $ActiveProvider
    $currentVersion = if ([string]::IsNullOrWhiteSpace($NodeVersion)) { "未知" } else { $NodeVersion }
    $missingParts = @()
    if (-not $NodeAvailable) { $missingParts += "node" }
    if (-not $NpmAvailable) { $missingParts += "npm" }
    $runtimeState = if ($missingParts.Count -gt 0) {
        "缺失: $($missingParts -join ', ')"
    } else {
        "当前版本: $currentVersion，最低要求: v$RequiredNodeVersion+"
    }

    $choice = Show-SingleSelectMenu -Title "检测到 $providerLabel 可原地修复。`n$runtimeState`n是否通过当前工具安装/切换 Node.js LTS？" -Options @(
        "安装/更新到 Node.js LTS",
        "取消（不修改当前环境）"
    ) -DefaultIndex 0

    switch ($choice) {
        0 { return "repair" }
        default { return "cancel" }
    }
}

function Sync-FnmNodeRuntimePath {
    <#
    .SYNOPSIS
    fnm 安装/切换版本后，同步当前进程 PATH。
    #>
    param(
        [hashtable]$Result = @{}
    )

    $candidateDirs = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($env:FNM_MULTISHELL_PATH)) {
        $candidateDirs.Add($env:FNM_MULTISHELL_PATH)
    }

    $fnmRoots = @()
    if (-not [string]::IsNullOrWhiteSpace($env:FNM_DIR)) {
        $fnmRoots += $env:FNM_DIR
    }
    $fnmRoots += (Join-Path $env:LOCALAPPDATA "fnm")
    $fnmRoots += (Join-Path $env:USERPROFILE ".fnm")

    foreach ($root in @($fnmRoots)) {
        if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path $root -PathType Container)) { continue }
        $versionsRoot = Join-Path $root "node-versions"
        if (-not (Test-Path $versionsRoot -PathType Container)) { continue }

        $installationDirs = @(Get-ChildItem -Path $versionsRoot -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName "installation" } |
            Where-Object { Test-Path (Join-Path $_ "node.exe") -PathType Leaf } |
            Sort-Object -Descending)
        foreach ($dir in $installationDirs) {
            $candidateDirs.Add($dir)
        }
    }

    foreach ($dir in @($candidateDirs)) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        $hasNode = Test-Path (Join-Path $dir "node.exe") -PathType Leaf
        $hasNpm = Test-Path (Join-Path $dir "npm.cmd") -PathType Leaf
        if (-not ($hasNode -and $hasNpm)) { continue }

        $normalizedDir = $dir.TrimEnd('\')
        $pathEntries = @($env:PATH -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $alreadyPresent = $false
        foreach ($entry in $pathEntries) {
            if ($entry.Trim().Trim('"').TrimEnd('\') -ieq $normalizedDir) {
                $alreadyPresent = $true
                break
            }
        }
        if (-not $alreadyPresent) {
            $env:PATH = "$normalizedDir;$env:PATH"
            Write-UiInfo "  已将 fnm 当前 Node.js 路径注入 PATH: $normalizedDir" -Level Detail
        }

        $Result["FnmRuntimePath"] = $normalizedDir
        return
    }
}

function Repair-NodeViaFnm {
    <#
    .SYNOPSIS
    使用现有 fnm 安装/切换 Node.js LTS，不安装或卸载 fnm 本体。
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
        Write-UiPrimary "📦 通过 fnm 安装/切换 Node.js LTS..." -Level Detail
        if (-not (Test-CommandAvailable -Command "fnm")) {
            throw "fnm 命令不可用，无法原地修复当前 fnm 运行时"
        }

        $fnmVersion = Get-CommandVersion -Command "fnm"
        if ($fnmVersion) {
            $result.Data["FnmVersion"] = $fnmVersion
            Write-UiSuccess "✓ fnm 可用 (版本: $fnmVersion)" -Level Detail
        }

        $installResult = Invoke-ExternalCommand -Command "fnm" -Arguments @("install", "--lts") -TimeoutSeconds 300 -RetryCount 0
        if (-not $installResult.Success) {
            throw "fnm install --lts 失败: $($installResult.Error)"
        }

        $defaultResult = Invoke-ExternalCommand -Command "fnm" -Arguments @("default", "lts-latest") -TimeoutSeconds 120 -RetryCount 0
        if (-not $defaultResult.Success) {
            throw "fnm default lts-latest 失败: $($defaultResult.Error)"
        }

        $useResult = Invoke-ExternalCommand -Command "fnm" -Arguments @("use", "--install-if-missing", "lts-latest") -TimeoutSeconds 120 -RetryCount 0
        if (-not $useResult.Success) {
            throw "fnm use lts-latest 失败: $($useResult.Error)"
        }

        Refresh-SessionPath
        Sync-FnmNodeRuntimePath -Result $result.Data

        $result.Success = $true
        $result.Data["ProviderTarget"] = "fnm"
        $result.Data["RepairMode"] = "InPlaceFnm"
        return (Complete-NodeRuntimeInstall -Result $result -ProviderType "fnm")
    } catch {
        $result.ErrorMessage = "通过 fnm 修复 Node.js 失败: $($_.Exception.Message)"
        Write-UiDanger "✗ $($result.ErrorMessage)"
    }

    return $result
}

function Sync-NvmNodeRuntimePath {
    <#
    .SYNOPSIS
    nvm-windows 激活版本后，同步当前进程 PATH，避免 node/npm 在安装进程内不可见。
    #>
    param(
        [hashtable]$Result = @{}
    )

    foreach ($envVar in @("NVM_HOME", "NVM_SYMLINK")) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($envVar, "Process"))) {
            foreach ($scope in @("User", "Machine")) {
                $value = [Environment]::GetEnvironmentVariable($envVar, $scope)
                if (-not [string]::IsNullOrWhiteSpace($value)) {
                    [Environment]::SetEnvironmentVariable($envVar, $value, "Process")
                    break
                }
            }
        }
    }

    $candidateDirs = [System.Collections.Generic.List[string]]::new()
    $nvmSymlink = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "Process")
    if (-not [string]::IsNullOrWhiteSpace($nvmSymlink)) {
        $candidateDirs.Add($nvmSymlink)
    }

    $nvmHome = [Environment]::GetEnvironmentVariable("NVM_HOME", "Process")
    if ([string]::IsNullOrWhiteSpace($nvmHome) -and $Result.ContainsKey("NvmHome")) {
        $nvmHome = [string]$Result["NvmHome"]
    }
    if ([string]::IsNullOrWhiteSpace($nvmHome)) {
        $nvmHome = Join-Path $env:APPDATA "nvm"
    }

    $selectedVersion = ""
    if ($Result.ContainsKey("NvmSelectedVersion")) {
        $selectedVersion = [string]$Result["NvmSelectedVersion"]
    }
    if (-not [string]::IsNullOrWhiteSpace($nvmHome) -and -not [string]::IsNullOrWhiteSpace($selectedVersion)) {
        $candidateDirs.Add((Join-Path $nvmHome $selectedVersion))
        $candidateDirs.Add((Join-Path $nvmHome "v$selectedVersion"))
    }

    foreach ($dir in @($candidateDirs)) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        $hasNode = Test-Path (Join-Path $dir "node.exe") -PathType Leaf
        $hasNpm = Test-Path (Join-Path $dir "npm.cmd") -PathType Leaf
        if (-not ($hasNode -and $hasNpm)) { continue }

        $normalizedDir = $dir.TrimEnd('\')
        $pathEntries = @($env:PATH -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $alreadyPresent = $false
        foreach ($entry in $pathEntries) {
            if ($entry.Trim().Trim('"').TrimEnd('\') -ieq $normalizedDir) {
                $alreadyPresent = $true
                break
            }
        }
        if (-not $alreadyPresent) {
            $env:PATH = "$normalizedDir;$env:PATH"
            Write-UiInfo "  已将 nvm 当前 Node.js 路径注入 PATH: $normalizedDir" -Level Detail
        }
    }
}

function Complete-NodeRuntimeInstall {
    <#
    .SYNOPSIS
    统一完成 Node.js安装后的校验与 npm 配置
    .PARAMETER Result
    当前 provider 安装结果对象
    .PARAMETER ProviderType
    provider 类型（fnm/nvm/direct）
    .RETURNS
    安装结果对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Result,

        [Parameter(Mandatory = $true)]
        [string]$ProviderType
    )

    if (-not $Result.Success) {
        return $Result
    }

    try {
        # 验证 Node.js 和 npm 可用性
        Write-UiPrimary "🔍 验证 Node.js ..." -Level Detail
        Refresh-SessionPath
        if ($ProviderType -eq "nvm") {
            Sync-NvmNodeRuntimePath -Result $Result
        } elseif ($ProviderType -eq "fnm") {
            Sync-FnmNodeRuntimePath -Result $Result.Data
        }

        if (-not (Test-CommandAvailable -Command "node")) {
            throw "Node.js 安装后仍不可用，请检查 PATH 配置"
        }
        if (-not (Test-CommandAvailable -Command "npm")) {
            if ($ProviderType -eq "nvm") {
                Sync-NvmNodeRuntimePath -Result $Result
            } elseif ($ProviderType -eq "fnm") {
                Sync-FnmNodeRuntimePath -Result $Result.Data
            }
            if (-not (Test-CommandAvailable -Command "npm")) {
                throw "npm 安装后仍不可用，请检查 PATH 配置"
            }
        }

        $nodeVersion = Get-CommandVersion -Command "node"
        $npmVersion = Get-CommandVersion -Command "npm"
        Write-UiSuccess "✓ Node.js $nodeVersion 可用" -Level Detail
        Write-UiSuccess "✓ npm $npmVersion 可用" -Level Detail

        $nodeDetails = Test-CommandAvailable -Command "node" -ReturnDetails
        $npmDetails = Test-CommandAvailable -Command "npm" -ReturnDetails
        $nodeResolvedPath = [string]$nodeDetails.ResolvedPath
        $npmResolvedPath = [string]$npmDetails.ResolvedPath
        if (-not [string]::IsNullOrWhiteSpace($nodeResolvedPath)) {
            $Result.Data["NodePath"] = $nodeResolvedPath
            Write-UiInfo "  Node.js 路径: $nodeResolvedPath" -Level Debug
        }
        if (-not [string]::IsNullOrWhiteSpace($npmResolvedPath)) {
            $Result.Data["NpmPath"] = $npmResolvedPath
            Write-UiInfo "  npm 路径: $npmResolvedPath" -Level Debug
        }

        # nvm-windows 校验同时接受 NVM_SYMLINK 目录与 NVM_HOME 子树：
        # Sync-NvmNodeRuntimePath 会把"版本目录"（如 <NVM_HOME>\v24.18.0）注入 PATH 并排在最前，
        # 此时 node 解析到版本目录而非 symlink 目录，两者都是合法的 nvm 路径，不应误报"未切换"。
        $nvmSymlinkRoot = $null
        $nvmHomeRoot = $null
        if ($ProviderType -eq "nvm") {
            $nvmSymlink = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "Process")
            if ([string]::IsNullOrWhiteSpace($nvmSymlink)) { $nvmSymlink = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "User") }
            if ([string]::IsNullOrWhiteSpace($nvmSymlink)) { $nvmSymlink = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "Machine") }
            if (-not [string]::IsNullOrWhiteSpace($nvmSymlink)) {
                $nvmSymlinkRoot = $nvmSymlink.Replace("/", "\").TrimEnd("\").ToLower()
            }

            $nvmHome = [string]$Result.Data["NvmHome"]
            if ([string]::IsNullOrWhiteSpace($nvmHome)) { $nvmHome = [Environment]::GetEnvironmentVariable("NVM_HOME", "Process") }
            if ([string]::IsNullOrWhiteSpace($nvmHome)) { $nvmHome = [Environment]::GetEnvironmentVariable("NVM_HOME", "User") }
            if ([string]::IsNullOrWhiteSpace($nvmHome)) { $nvmHome = [Environment]::GetEnvironmentVariable("NVM_HOME", "Machine") }
            if ([string]::IsNullOrWhiteSpace($nvmHome)) { $nvmHome = Join-Path $env:APPDATA "nvm" }
            if (-not [string]::IsNullOrWhiteSpace($nvmHome)) {
                $nvmHomeRoot = $nvmHome.Replace("/", "\").TrimEnd("\").ToLower()
            }
        }

        $expectedProviderRoot = switch ($ProviderType) {
            "nvm" {
                if ($nvmSymlinkRoot) { $nvmSymlinkRoot } else { $nvmHomeRoot }
            }
            "direct" {
                (Join-Path $env:ProgramFiles "nodejs").Replace("/", "\").TrimEnd("\").ToLower()
            }
            default { $null }
        }
        if ($expectedProviderRoot -and -not [string]::IsNullOrWhiteSpace($nodeResolvedPath)) {
            $resolvedNodeDir = (Split-Path -Parent $nodeResolvedPath).Replace("/", "\").TrimEnd("\").ToLower()
            if ($ProviderType -eq "nvm") {
                # symlink 目录精确匹配，或 node 位于 NVM_HOME 子树（版本目录）均视为合法
                $matchSymlink = $nvmSymlinkRoot -and ($resolvedNodeDir -eq $nvmSymlinkRoot)
                $matchHomeSubtree = $nvmHomeRoot -and ($resolvedNodeDir -eq $nvmHomeRoot -or $resolvedNodeDir.StartsWith($nvmHomeRoot + "\"))
                if (-not ($matchSymlink -or $matchHomeSubtree)) {
                    throw "Node.js 当前实际路径为 $resolvedNodeDir，未切换到目标 provider [$ProviderType]"
                }
            } elseif ($resolvedNodeDir -ne $expectedProviderRoot) {
                throw "Node.js 当前实际路径为 $resolvedNodeDir，未切换到目标 provider [$ProviderType]"
            }
        }

        $Result.Version = $nodeVersion
        $Result.Data["Version"] = $nodeVersion
        $Result.Data["NodeVersion"] = $nodeVersion
        $Result.Data["NpmVersion"] = $npmVersion

        # 配置 npm 镜像（仅在国内网络环境下）
        Write-UiPrimary "⚙ 配置 npm 镜像..." -Level Detail
        try {
            $currentRegistry = & npm config get registry 2>$null
            if ($currentRegistry -and $currentRegistry -notmatch 'npmmirror|taobao') {
                $setRegistryResult = Invoke-ExternalCommand -Command "npm" -Arguments @("config", "set", "registry", "https://registry.npmmirror.com") -SuppressOutput -TimeoutSeconds 30 -RetryCount 0
                if ($setRegistryResult.Success) {
                    Write-UiSuccess "✓ npm 镜像已设置为 npmmirror" -Level Detail
                } else {
                    Write-UiWarning "⚠ npm 镜像设置失败，但不影响使用: $($setRegistryResult.Error)" -Level Detail
                }
            } else {
                Write-UiInfo "  npm 镜像已配置，跳过" -Level Detail
            }
        } catch {
            Write-UiWarning "⚠ npm 镜像配置异常，但不影响使用: $($_.Exception.Message)" -Level Detail
        }


        # fnm / nvm-windows / direct 均由各自工具或系统 PATH 管理，无需写入 PowerShell Profile
        $Result.Data["ProfileConfigured"] = $true
        Write-UiInfo "  fnm/nvm/direct 无需写入 PowerShell Profile" -Level Detail

        $Result.Data["ProviderType"] = $ProviderType
        $Result.Data["ProviderHealthy"] = $true
        $Result.Success = $true
        $Result.Message = "Node.js 安装配置完成"

        return $Result
    } catch {
        $Result.Success = $false
        $Result.ErrorMessage = "Node.js 安装后配置失败: $($_.Exception.Message)"
        $Result.Message = $Result.ErrorMessage
        Write-UiDanger "✗ $($Result.ErrorMessage)"
        return $Result
    }
}
