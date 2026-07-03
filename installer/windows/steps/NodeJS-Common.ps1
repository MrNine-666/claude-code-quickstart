# NodeJS-Common.ps1 - Node.js 通用工具层
# 职责：运行时修复/兜底菜单、fnm 原地修复、安装后配置；旧迁移/卸载函数仅作 deprecated 回滚缓冲

#Requires -Version 5.1
Set-StrictMode -Version Latest

function Resolve-NpmForBackup {
    <#
    .SYNOPSIS
    [已废弃] 利用 snapshot 中的环境信息，主动定位并激活 npm（修复 PATH 缺失问题）
    .DESCRIPTION
    新流程不再做跨 provider 迁移与 npm 全局包搬迁，此函数仅保留作为回滚缓冲，无调用点。
    .PARAMETER EnvSnapshot
    Test-NodeJSInstalled 返回的 Data 哈希表
    .RETURNS
    @{ Available = [bool]; Method = [string]; ErrorMessage = [string] }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$EnvSnapshot
    )

    # 1. npm 已在 PATH，无需修复
    if (Test-CommandAvailable -Command "npm") {
        return @{ Available = $true; Method = "already-in-path"; ErrorMessage = "" }
    }

    Write-UiWarning "npm 不在当前 PATH 中，尝试定位..." -Level Debug

    # 2. 尝试通过 snapshot 中记录的 NpmPath 直接定位
    $npmPath = [string]$EnvSnapshot["NpmPath"]
    if ($npmPath -and (Test-Path $npmPath -PathType Leaf)) {
        $npmDir = Split-Path -Parent $npmPath
        Write-UiInfo "  从 snapshot 定位到 npm: $npmDir" -Level Debug
        $env:PATH = "$npmDir;$env:PATH"
        if (Test-CommandAvailable -Command "npm") {
            Write-UiSuccess "通过 snapshot 路径恢复 npm 可用性" -Level Debug
            return @{ Available = $true; Method = "snapshot-path"; ErrorMessage = "" }
        }
    }

    # 3. nvm 场景：尝试激活 nvm 或从 NvmHome 子目录查找
    if ([bool]$EnvSnapshot["NvmDetected"]) {
        # 3a. nvm 命令可用 - 尝试 nvm use
        if ([bool]$EnvSnapshot["NvmCommandAvailable"]) {
            Write-UiPrimary "  尝试通过 nvm 激活 Node.js 环境..." -Level Debug
            try {
                $nvmListResult = Invoke-ExternalCommand -Command "nvm" -Arguments @("list") -SuppressOutput -TimeoutSeconds 15 -RetryCount 0
                if ($nvmListResult.Success -and $nvmListResult.Output) {
                    $versions = @($nvmListResult.Output -split "`n" | ForEach-Object {
                        if ($_ -match '(\d+\.\d+\.\d+)') { $matches[1] }
                    } | Where-Object { $_ })
                    if ($versions) {
                        $targetVersion = $versions | Select-Object -First 1
                        Write-UiPrimary "  执行 nvm use $targetVersion..." -Level Debug
                        $useResult = Invoke-ExternalCommand -Command "nvm" -Arguments @("use", $targetVersion) -SuppressOutput -TimeoutSeconds 30 -RetryCount 0
                        Refresh-SessionPath
                        if (Test-CommandAvailable -Command "npm") {
                            Write-UiSuccess "通过 nvm use $targetVersion 恢复 npm 可用性" -Level Debug
                            return @{ Available = $true; Method = "nvm-use"; ErrorMessage = "" }
                        }
                    }
                }
            } catch {
                Write-UiWarning "  nvm 激活失败: $($_.Exception.Message)" -Level Debug
            }
        }

        # 3b. 直接扫描 NvmHome 子目录
        $nvmHome = [string]$EnvSnapshot["NvmHome"]
        if ([string]::IsNullOrWhiteSpace($nvmHome)) {
            $nvmHome = Join-Path $env:APPDATA "nvm"
        }
        if ($nvmHome -and (Test-Path $nvmHome)) {
            $nvmNodeDirs = @(Get-ChildItem -Path $nvmHome -Directory -ErrorAction SilentlyContinue |
                Where-Object { Test-Path (Join-Path $_.FullName "npm.cmd") })
            if ($nvmNodeDirs) {
                $bestDir = $nvmNodeDirs | Sort-Object Name -Descending | Select-Object -First 1
                Write-UiInfo "  从 NvmHome 定位到 npm: $($bestDir.FullName)" -Level Debug
                $env:PATH = "$($bestDir.FullName);$env:PATH"
                if (Test-CommandAvailable -Command "npm") {
                    Write-UiSuccess "通过 NvmHome 目录恢复 npm 可用性" -Level Debug
                    return @{ Available = $true; Method = "nvm-dir-scan"; ErrorMessage = "" }
                }
            }
        }
    }

    # 4. 直接安装场景：从 ProgramFiles\nodejs 定位
    if ([bool]$EnvSnapshot["DirectNodeDetected"]) {
        $directPath = [string]$EnvSnapshot["DirectNodePath"]
        if ([string]::IsNullOrWhiteSpace($directPath)) {
            $directPath = "$env:ProgramFiles\nodejs"
        }
        if ((Test-Path $directPath) -and (Test-Path (Join-Path $directPath "npm.cmd"))) {
            Write-UiInfo "  从直接安装路径定位到 npm: $directPath" -Level Debug
            $env:PATH = "$directPath;$env:PATH"
            if (Test-CommandAvailable -Command "npm") {
                Write-UiSuccess "通过直接安装路径恢复 npm 可用性" -Level Debug
                return @{ Available = $true; Method = "direct-path"; ErrorMessage = "" }
            }
        }
    }

    # 5. 最终回退：PATH 刷新后重试
    Refresh-SessionPath
    if (Test-CommandAvailable -Command "npm") {
        Write-UiSuccess "PATH 刷新后 npm 可用" -Level Detail
        return @{ Available = $true; Method = "path-refresh"; ErrorMessage = "" }
    }

    return @{ Available = $false; Method = "none"; ErrorMessage = "所有定位策略均失败，npm 无法激活" }
}

function Backup-NpmGlobalPackages {
    <#
    .SYNOPSIS
    [已废弃] 备份 npm 全局包（名称和版本）
    .DESCRIPTION
    新流程不再做跨 provider 迁移，此函数仅保留作为回滚缓冲，无调用点。
    .RETURNS
    备份结果对象
    #>
    param()

    $result = @{
        Success = $false
        Packages = @()
        ErrorMessage = ""
    }

    try {
        Write-UiPrimary "📦 备份 npm 全局包列表..." -Level Detail

        # 注意：调用方应在调用前先执行 Resolve-NpmForBackup 确保 npm 可用
        if (-not (Test-CommandAvailable -Command "npm")) {
            Write-UiWarning "npm 命令不可用（已尝试所有定位策略），跳过全局包备份" -Level Debug
            $result.Success = $true
            $result.Packages = @()
            return $result
        }

        $listOutput = & npm list -g --json --depth=0 2>$null
        $npmExitCode = $LASTEXITCODE
        if (-not $listOutput) {
            if ($npmExitCode -ne 0) {
                throw "npm list -g 无输出且退出码为 $npmExitCode，无法安全备份全局包"
            }
            Write-UiWarning "⚠ npm list -g 返回为空，将按无全局包处理" -Level Debug
            $result.Success = $true
            return $result
        }

        $jsonText = ($listOutput -join "`n").Trim()
        try {
            $json = $jsonText | ConvertFrom-Json -ErrorAction Stop
        } catch {
            throw "npm list -g 输出解析失败，无法安全备份全局包: $($_.Exception.Message)"
        }
        if ($npmExitCode -ne 0) {
            Write-UiWarning "⚠ npm list -g 退出码为 $npmExitCode，但已成功解析 JSON，继续迁移流程" -Level Debug
        }
        if ($json -and $json.dependencies) {
            foreach ($pkg in $json.dependencies.PSObject.Properties) {
                $pkgName = [string]$pkg.Name
                if ($pkgName -eq "npm") { continue }

                $pkgVersion = ""
                if ($pkg.Value -and $pkg.Value.PSObject.Properties.Name -contains "version") {
                    $pkgVersion = [string]$pkg.Value.version
                }

                $result.Packages += @{
                    Name = $pkgName
                    Version = $pkgVersion
                }
            }
        }

        $result.Success = $true
        Write-UiSuccess "✓ npm 全局包备份完成，共 $($result.Packages.Count) 个包" -Level Detail
    } catch {
        $result.ErrorMessage = "备份 npm 全局包失败: $($_.Exception.Message)"
        Write-UiDanger "✗ $($result.ErrorMessage)"
    }

    return $result
}
function Restore-NpmGlobalPackages {
    <#
    .SYNOPSIS
    [已废弃] 恢复 npm 全局包
    .DESCRIPTION
    新流程不再做跨 provider 迁移，此函数仅保留作为回滚缓冲，无调用点。
    .PARAMETER Packages
    备份的全局包数组（@{Name;Version}）
    .RETURNS
    恢复结果对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [array]$Packages
    )

    $result = @{
        Success = $true
        Installed = @()
        Failed = @()
    }

    if (-not $Packages -or $Packages.Count -eq 0) {
        Write-UiInfo "无 npm 全局包需要恢复" -Level Detail
        return $result
    }

    try {
        if (-not (Test-CommandAvailable -Command "npm")) {
            throw "npm 命令不可用，无法恢复全局包"
        }

        Write-UiPrimary "📥 开始恢复 npm 全局包..." -Level Detail
        foreach ($pkg in $Packages) {
            $name = [string]$pkg.Name
            $version = [string]$pkg.Version
            if ([string]::IsNullOrWhiteSpace($name)) { continue }

            $fullName = $name
            if (-not [string]::IsNullOrWhiteSpace($version)) {
                $fullName = "$name@$version"
            }

            try {
                $installResult = Invoke-ExternalCommand -Command "npm" -Arguments @("install", "-g", $fullName) -TimeoutSeconds 180 -RetryCount 0
                if ($installResult.Success) {
                    $result.Installed += $fullName
                    Write-UiSuccess "✓ 已恢复: $fullName" -Level Debug
                } else {
                    $result.Failed += @{ Name = $fullName; Error = $installResult.Error }
                    Write-UiWarning "⚠ 恢复失败: $fullName，$($installResult.Error)" -Level Debug
                }
            } catch {
                $result.Failed += @{ Name = $fullName; Error = $_.Exception.Message }
                Write-UiWarning "⚠ 恢复异常: $fullName，$($_.Exception.Message)" -Level Debug
            }
        }

        if ($result.Failed.Count -gt 0) {
            $result.Success = $false
        }
    } catch {
        $result.Success = $false
        $result.Failed += @{ Name = "全部"; Error = $_.Exception.Message }
        Write-UiWarning "⚠ npm 全局包恢复过程中断: $($_.Exception.Message)"
    }

    return $result
}

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

function Show-NodeMigrationMenu {
    <#
    .SYNOPSIS
    已废弃：跨 provider 迁移菜单不再使用。
    .DESCRIPTION
    保留此函数仅为旧调用点提供兼容缓冲；新流程使用 Show-NodeRuntimeRepairMenu
    或 Show-NodeFallbackInstallMenu，不卸载现有 provider，不清理 PATH。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$CurrentProviderType,

        [bool]$ProviderHealthy = $false
    )

    Write-UiWarning "Show-NodeMigrationMenu 已废弃，改用运行时修复/兜底安装流程。" -Level Debug
    return (Show-NodeFallbackInstallMenu -ActiveProvider $CurrentProviderType -Reason "当前旧菜单已停用。")
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

function Remove-PortableNodeFromPath {
    <#
    .SYNOPSIS
    [已废弃] 从持久化 PATH 中移除绿色版（portable）Node.js 路径
    .DESCRIPTION
    新流程不再清理用户 PATH 或执行 portable → nvm/direct 迁移。此函数仅保留作为回滚缓冲，无调用点。
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
        Success = $true
        ErrorMessage = ""
        CleanedPaths = @()
    }

    $targetMap = @{}
    foreach ($key in @("NodePath", "NpmPath")) {
        $resolvedPath = [string]$EnvSnapshot[$key]
        if (-not [string]::IsNullOrWhiteSpace($resolvedPath) -and (Test-Path $resolvedPath -PathType Leaf)) {
            $dir = (Split-Path -Parent $resolvedPath).Replace("/", "\").Trim().TrimEnd("\").ToLower()
            if (-not [string]::IsNullOrWhiteSpace($dir)) {
                $targetMap[$dir] = $true
            }
        }
    }

    if ($targetMap.Keys.Count -eq 0) {
        $result.Success = $false
        $result.ErrorMessage = "无法确定绿色版 Node.js 的实际路径，无法安全清理 PATH"
        Write-UiWarning "⚠ $($result.ErrorMessage)" -Level Detail
        return $result
    }

    # 清理当前会话 PATH
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

    # 清理用户级 PATH
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

    # 清理系统级 PATH
    $machinePath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    if ($machinePath) {
        $machineKept = @()
        $machineRemoved = @()
        foreach ($entry in ($machinePath -split ";")) {
            $trimmed = $entry.Trim().Trim('"')
            if (-not $trimmed) { continue }
            $normalized = $trimmed.Replace("/", "\").TrimEnd("\").ToLower()
            if ($targetMap.ContainsKey($normalized)) {
                $machineRemoved += $trimmed
            } else {
                $machineKept += $trimmed
            }
        }
        if ($machineRemoved.Count -gt 0) {
            try {
                [Environment]::SetEnvironmentVariable("PATH", ($machineKept -join ";"), "Machine")
                $result.CleanedPaths += $machineRemoved
                Write-UiSuccess "✓ 已清理系统级 PATH 中的绿色版 Node.js 路径" -Level Debug
            } catch {
                $result.Success = $false
                $result.ErrorMessage = "清理系统级 PATH 失败（可能需要管理员权限）: $($_.Exception.Message)"
                Write-UiWarning "⚠ $($result.ErrorMessage)" -Level Debug
            }
        }
    }

    # 广播 WM_SETTINGCHANGE（与 Uninstall-ExistingNode 一致）
    if ($result.CleanedPaths.Count -gt 0) {
        try {
            if (-not ([System.Management.Automation.PSTypeName]'CCQ.EnvBroadcast').Type) {
                Add-Type -Namespace CCQ -Name EnvBroadcast -MemberDefinition @"
                    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
                    public static extern IntPtr SendMessageTimeout(
                        IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
                        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
            }
            $HWND_BROADCAST = [IntPtr]0xFFFF
            $WM_SETTINGCHANGE = 0x001A
            $SMTO_ABORTIFHUNG = 0x0002
            $broadcastResult = [UIntPtr]::Zero
            [CCQ.EnvBroadcast]::SendMessageTimeout(
                $HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero,
                "Environment", $SMTO_ABORTIFHUNG, 5000, [ref]$broadcastResult) | Out-Null
        } catch {
            Write-UiWarning "⚠ 广播环境变量变更通知失败: $($_.Exception.Message)" -Level Debug
        }
    }

    # 残留检查：确认 portable 路径已从所有 PATH 作用域中移除
    $residualPaths = @()
    foreach ($scopeName in @("Process", "User", "Machine")) {
        $scopePath = if ($scopeName -eq "Process") { $env:PATH } else { [Environment]::GetEnvironmentVariable("PATH", $scopeName) }
        if (-not $scopePath) { continue }
        foreach ($entry in ($scopePath -split ";")) {
            $trimmed = $entry.Trim().Trim('"')
            if (-not $trimmed) { continue }
            $normalized = $trimmed.Replace("/", "\").TrimEnd("\").ToLower()
            if ($targetMap.ContainsKey($normalized)) {
                $residualPaths += "${scopeName}: $trimmed"
            }
        }
    }
    if ($residualPaths.Count -gt 0) {
        $result.Success = $false
        if ([string]::IsNullOrWhiteSpace($result.ErrorMessage)) {
            $result.ErrorMessage = "绿色版 Node.js 路径仍残留在 PATH: $($residualPaths -join '; ')"
        }
        Write-UiWarning "⚠ $($result.ErrorMessage)" -Level Detail
    }

    if ($result.CleanedPaths.Count -gt 0 -and $result.Success) {
        Write-UiSuccess "✓ 已从 PATH 移除绿色版 Node.js: $($result.CleanedPaths -join '; ')" -Level Detail
    }

    return $result
}

function Uninstall-Fnm {
    <#
    .SYNOPSIS
    [已废弃] 清理 fnm 及其 PATH/Profile 残留。
    .DESCRIPTION
    新流程不再卸载 fnm 或执行跨工具迁移。此函数仅保留作为回滚缓冲，无调用点。
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

        # 内联清理 $PROFILE 里的 [CCQ:FNM:BEGIN]...[CCQ:FNM:END] 子段
        # 不依赖已移除的 Profile 子段层死代码链（Remove-CcqSubsectionFromFile 等 6 个函数），
        # 改为直接逐行剥离 fnm 子段标记块，保持零依赖自洽。仅在用户主动选择迁移时触发，
        # 与「不主动动用户文件」的默认策略互不冲突。
        if (Test-Path $PROFILE) {
            try {
                $profileContent = @(Get-Content -Path $PROFILE -ErrorAction Stop)
                $newLines = [System.Collections.ArrayList]::new()
                $inFnmSection = $false
                $removedSection = $false
                foreach ($line in $profileContent) {
                    $trimmed = ([string]$line).Trim()
                    if ($trimmed -eq "# [CCQ:FNM:BEGIN]") {
                        $inFnmSection = $true
                        $removedSection = $true
                        continue
                    }
                    if ($inFnmSection -and $trimmed -eq "# [CCQ:FNM:END]") {
                        $inFnmSection = $false
                        continue
                    }
                    if (-not $inFnmSection) {
                        $null = $newLines.Add($line)
                    }
                }
                if ($removedSection) {
                    # 用 UTF-8 无 BOM 写回（New-Object 第二参 $false = emitBOM=false），
                    # 避免 Set-Content -Encoding UTF8 在 PS5.1 下写入 BOM 污染用户的 Profile。
                    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
                    $linesArray = @($newLines | ForEach-Object { [string]$_ })
                    [System.IO.File]::WriteAllLines($PROFILE, $linesArray, $utf8NoBom)
                    Write-UiSuccess "✓ 已从 $PROFILE 移除 fnm 子段" -Level Debug
                }
            } catch {
                Write-UiWarning "⚠ 清理 $PROFILE 的 fnm 子段失败: $($_.Exception.Message)" -Level Debug
            }
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

function Uninstall-ExistingNode {
    <#
    .SYNOPSIS
    [已废弃] 卸载冲突的 Node.js 管理工具和直接安装版本。
    .DESCRIPTION
    新流程不再卸载现有 nvm/direct provider 或清理其 PATH。此函数仅保留作为回滚缓冲，无调用点。
    .PARAMETER EnvSnapshot
    Test-NodeJSInstalled 返回的环境快照 Data
    .PARAMETER SkipDirect
    跳过 Node.js 的卸载（迁移目标本身为 direct 时使用）
    .PARAMETER SkipNvm
    跳过 nvm-windows 的卸载（迁移目标本身为 nvm 时使用）
    .RETURNS
    卸载结果对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$EnvSnapshot,
        [switch]$SkipDirect,
        [switch]$SkipNvm
    )

    $result = @{
        Success = $false
        ErrorMessage = ""
        CleanedPaths = @()
    }

    try {
        $cleanPaths = @()
        $cleanedPathMap = @{}

        # 收集待清理路径
        $candidatePaths = @(
            [string]$EnvSnapshot["NvmHome"],
            (Join-Path $env:APPDATA "nvm"),
            (Join-Path $env:APPDATA "npm"),
            "$env:ProgramFiles\nodejs",
            "${env:ProgramFiles(x86)}\nodejs"
        )

        $nodePath = [string]$EnvSnapshot["NodePath"]
        if ($nodePath -and (Test-Path $nodePath -PathType Leaf)) {
            $candidatePaths += (Split-Path -Parent $nodePath)
        }
        $npmPath = [string]$EnvSnapshot["NpmPath"]
        if ($npmPath -and (Test-Path $npmPath -PathType Leaf)) {
            $candidatePaths += (Split-Path -Parent $npmPath)
        }

        # 计算受保护的 provider 路径归属基准（尊重 SkipNvm / SkipDirect）：
        #   - nvm 归属：NvmHome 子树 / NVM_SYMLINK（symlink 目录，通常即 %ProgramFiles%\nodejs）
        #   - direct 归属：%ProgramFiles%\nodejs / %ProgramFiles(x86)%\nodejs
        #   - 若 %ProgramFiles%\nodejs 同时是 nvm 的 symlink，则优先算 nvm 归属
        # 目的：迁移目标为某 provider 时该 provider 被故意保留，其 PATH 不应被清除，
        #       否则会误删保留方的持久 PATH（历史 bug：SkipNvm 时仍清 nvm 路径）。
        $nvmHomeNorm = [string]$EnvSnapshot["NvmHome"]
        if ([string]::IsNullOrWhiteSpace($nvmHomeNorm)) { $nvmHomeNorm = Join-Path $env:APPDATA "nvm" }
        $nvmHomeNorm = $nvmHomeNorm.Replace("/", "\").TrimEnd("\").ToLower()

        $nvmSymlinkNorm = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "Process")
        if ([string]::IsNullOrWhiteSpace($nvmSymlinkNorm)) { $nvmSymlinkNorm = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "User") }
        if ([string]::IsNullOrWhiteSpace($nvmSymlinkNorm)) { $nvmSymlinkNorm = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "Machine") }
        if (-not [string]::IsNullOrWhiteSpace($nvmSymlinkNorm)) {
            $nvmSymlinkNorm = $nvmSymlinkNorm.Replace("/", "\").TrimEnd("\").ToLower()
        } else {
            $nvmSymlinkNorm = ""
        }

        $pfNodeNorm = "$env:ProgramFiles\nodejs".Replace("/", "\").TrimEnd("\").ToLower()
        $pfx86NodeNorm = "${env:ProgramFiles(x86)}\nodejs".Replace("/", "\").TrimEnd("\").ToLower()

        foreach ($pathItem in $candidatePaths) {
            if ([string]::IsNullOrWhiteSpace($pathItem)) { continue }
            $normalized = $pathItem.Replace("/", "\").Trim().TrimEnd("\")
            if ([string]::IsNullOrWhiteSpace($normalized)) { continue }
            $normalizedLower = $normalized.ToLower()

            # 归属判定
            $isNvmOwned = ($normalizedLower -eq $nvmHomeNorm) -or
                          $normalizedLower.StartsWith($nvmHomeNorm + "\") -or
                          ($nvmSymlinkNorm -and $normalizedLower -eq $nvmSymlinkNorm)
            $isDirectOwned = ($normalizedLower -eq $pfNodeNorm) -or ($normalizedLower -eq $pfx86NodeNorm)
            # %ProgramFiles%\nodejs 若同时是 nvm symlink，优先算 nvm（避免 SkipNvm 时误清）
            if ($nvmSymlinkNorm -and $nvmSymlinkNorm -eq $pfNodeNorm -and $normalizedLower -eq $pfNodeNorm) {
                $isNvmOwned = $true
                $isDirectOwned = $false
            }

            # 保留方路径跳过：SkipNvm 保护 nvm 归属；SkipDirect 保护 direct 归属（且非 nvm 归属）
            if ($SkipNvm -and $isNvmOwned) { continue }
            if ($SkipDirect -and $isDirectOwned -and -not $isNvmOwned) { continue }

            $cleanedPathMap[$normalizedLower] = $normalized
        }
        $cleanPaths = @($cleanedPathMap.Values)

        # 卸载 nvm-windows
        # 三级策略：winget uninstall → unins000.exe → throw 友好提示
        if ([bool]$EnvSnapshot["NvmDetected"] -and -not $SkipNvm) {
            Write-UiWarning "⚠ 开始卸载 nvm-windows..." -Level Detail
            $nvmUninstalled = $false

            # Path 1: winget uninstall
            if (Test-CommandAvailable -Command "winget") {
                try {
                    Write-UiInfo "  尝试 winget uninstall CoreyButler.NVMforWindows..." -Level Debug
                    $nvmWingetUninstall = Invoke-ExternalCommand -Command "winget" `
                        -Arguments @("uninstall", "--id", "CoreyButler.NVMforWindows", "-e",
                                     "--disable-interactivity", "--accept-source-agreements") `
                        -SuppressOutput -TimeoutSeconds 240 -RetryCount 0
                    if ($nvmWingetUninstall.Success) {
                        $nvmUninstalled = $true
                        Write-UiSuccess "✓ nvm-windows 通过 winget 卸载成功" -Level Debug
                    } else {
                        Write-UiWarning "⚠ winget 卸载 nvm-windows 失败: $($nvmWingetUninstall.Error)" -Level Debug
                    }
                } catch {
                    Write-UiWarning "⚠ winget 卸载 nvm-windows 异常: $($_.Exception.Message)" -Level Debug
                }
            }

            # Path 2: unins000.exe（回退）
            if (-not $nvmUninstalled) {
                $nvmHome = [string]$EnvSnapshot["NvmHome"]
                if ([string]::IsNullOrWhiteSpace($nvmHome)) { $nvmHome = "$env:APPDATA\nvm" }
                $uninstallerPath = Join-Path $nvmHome "unins000.exe"

                if (Test-Path $uninstallerPath) {
                    try {
                        $r = Invoke-ExternalCommand -Command $uninstallerPath `
                            -Arguments @("/VERYSILENT", "/NORESTART") `
                            -SuppressOutput -TimeoutSeconds 300 -RetryCount 0
                        if ($r.Success) {
                            $nvmUninstalled = $true
                            Write-UiSuccess "✓ nvm-windows 卸载完成" -Level Debug
                        } else {
                            Write-UiWarning "⚠ 卸载器执行失败: $($r.Error)" -Level Debug
                        }
                    } catch {
                        Write-UiWarning "⚠ 卸载器执行异常: $($_.Exception.Message)" -Level Debug
                    }
                } else {
                    Write-UiWarning "⚠ 未找到卸载器: $uninstallerPath" -Level Debug
                }
            }

            # Path 3: 均失败 → throw 友好提示
            if (-not $nvmUninstalled) {
                throw "nvm-windows 卸载失败（winget 和卸载器均未成功），请在「设置 → 应用 → 已安装的应用」或「控制面板 → 程序和功能」中手动卸载 nvm-windows 后重试"
            }

            # 会话清理（throw 阻断后仅成功路径可达）
            Remove-Item Env:NVM_HOME -ErrorAction SilentlyContinue
            Remove-Item Env:NVM_SYMLINK -ErrorAction SilentlyContinue
        }

        # 卸载直接安装的 Node.js
        # 主路径：winget uninstall（覆盖 winget/MSI 安装场景）
        # 回退：注册表 MSI ProductCode 卸载
        if ([bool]$EnvSnapshot["DirectNodeDetected"] -and -not $SkipDirect) {
            Write-UiWarning "⚠ 开始卸载直接安装的 Node.js..." -Level Detail
            $nodeUninstalled = $false

            # 主路径：winget uninstall（winget 能识别 MSI 安装的包）
            if (Test-CommandAvailable -Command "winget") {
                foreach ($pkgId in @("OpenJS.NodeJS.LTS", "OpenJS.NodeJS")) {
                    try {
                        Write-UiInfo "  尝试 winget uninstall --id $pkgId..." -Level Debug
                        $wingetProc = Start-Process -FilePath "winget" `
                            -ArgumentList "uninstall --id $pkgId --silent --accept-source-agreements" `
                            -Wait -PassThru -NoNewWindow
                        if ($wingetProc.ExitCode -eq 0) {
                            $nodeUninstalled = $true
                            Write-UiSuccess "✓ Node.js 通过 winget 卸载成功 ($pkgId)" -Level Debug
                            break
                        }
                    } catch {
                        Write-UiWarning "⚠ winget uninstall $pkgId 异常: $($_.Exception.Message)" -Level Debug
                    }
                }
            }

            # 回退路径：从注册表查找 MSI ProductCode 卸载
            if (-not $nodeUninstalled) {
                $uninstallKeyPaths = @(
                    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
                    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
                    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
                )
                foreach ($keyPath in $uninstallKeyPaths) {
                    try {
                        $items = @(Get-ItemProperty $keyPath -ErrorAction SilentlyContinue | Where-Object {
                            $_.DisplayName -like "Node.js*" -or $_.DisplayName -eq "Node.js"
                        })
                        foreach ($item in $items) {
                            $uninstallString = ""
                            if ($item.PSObject.Properties.Name -contains "QuietUninstallString" -and $item.QuietUninstallString) {
                                $uninstallString = [string]$item.QuietUninstallString
                            } elseif ($item.PSObject.Properties.Name -contains "UninstallString" -and $item.UninstallString) {
                                $uninstallString = [string]$item.UninstallString
                            }
                            if (-not $uninstallString) { continue }

                            if ($uninstallString -match '\{[0-9A-Fa-f\-]{36}\}') {
                                $productCode = $matches[0]
                                try {
                                    Write-UiInfo "  UninstallString → ProductCode: $productCode ($($item.DisplayName))" -Level Debug
                                    $msiProc = Start-Process -FilePath "msiexec.exe" `
                                        -ArgumentList "/x `"$productCode`" /quiet /norestart" `
                                        -Wait -PassThru -NoNewWindow
                                    $msiExitCode = $msiProc.ExitCode
                                    # 0 = 成功; 3010 = 需重启但事务已成功; 1605 = 产品已不存在
                                    switch ($msiExitCode) {
                                        0 {
                                            $nodeUninstalled = $true
                                            Write-UiSuccess "✓ MSI 卸载成功: $($item.DisplayName)" -Level Debug
                                        }
                                        3010 {
                                            $nodeUninstalled = $true
                                            Write-UiSuccess "✓ MSI 卸载成功 (需重启完成): $($item.DisplayName)" -Level Debug
                                        }
                                        1605 {
                                            Write-UiInfo "  MSI 产品已不存在: $($item.DisplayName)" -Level Debug
                                        }
                                        default {
                                            Write-UiWarning "⚠ MSI 卸载失败 (退出码: $msiExitCode): $($item.DisplayName)" -Level Debug
                                        }
                                    }
                                } catch {
                                    Write-UiWarning "⚠ MSI 卸载异常: $($item.DisplayName)，$($_.Exception.Message)" -Level Debug
                                }
                            }
                        }
                    } catch { }
                }
            }

            if ($nodeUninstalled) {
                Write-UiSuccess "✓ Node.js 卸载完成" -Level Detail
                # 等待卸载器释放文件句柄
                Start-Sleep -Seconds 3
            } else {
                throw "Node.js 卸载失败（winget + MSI 均未成功），请在「控制面板 → 程序和功能」中手动卸载 Node.js 后重试"
            }
        }

        # 清理 PATH（当前会话 + 用户级 + 系统级）
        $targetMap = @{}
        foreach ($target in $cleanPaths) {
            $normalizedTarget = $target.Replace("/", "\").Trim().Trim('"').TrimEnd("\").ToLower()
            if (-not [string]::IsNullOrWhiteSpace($normalizedTarget)) {
                $targetMap[$normalizedTarget] = $true
            }
        }

        if ($targetMap.Keys.Count -gt 0) {
            # 清理当前会话 PATH
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

            # 清理用户级 PATH
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

            # 清理系统级 PATH（Machine）
            $machinePath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
            if ($machinePath) {
                $machineKept = @()
                $machineRemoved = @()
                foreach ($entry in ($machinePath -split ";")) {
                    $trimmed = $entry.Trim().Trim('"')
                    if (-not $trimmed) { continue }
                    $normalized = $trimmed.Replace("/", "\").TrimEnd("\").ToLower()
                    if ($targetMap.ContainsKey($normalized)) {
                        $machineRemoved += $trimmed
                    } else {
                        $machineKept += $trimmed
                    }
                }
                if ($machineRemoved.Count -gt 0) {
                    try {
                        [Environment]::SetEnvironmentVariable("PATH", ($machineKept -join ";"), "Machine")
                        $result.CleanedPaths += $machineRemoved
                        Write-UiSuccess "✓ 已清理系统级 PATH: $($machineRemoved -join '; ')" -Level Debug
                    } catch {
                        Write-UiWarning "⚠ 清理系统级 PATH 失败（可能需要管理员权限）: $($_.Exception.Message)" -Level Debug
                    }
                }
            }
        }

        Refresh-SessionPath

        # 广播 WM_SETTINGCHANGE，通知其他进程刷新环境变量
        try {
            if (-not ([System.Management.Automation.PSTypeName]'CCQ.EnvBroadcast').Type) {
                Add-Type -Namespace CCQ -Name EnvBroadcast -MemberDefinition @"
                    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
                    public static extern IntPtr SendMessageTimeout(
                        IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
                        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
            }
            $HWND_BROADCAST = [IntPtr]0xFFFF
            $WM_SETTINGCHANGE = 0x001A
            $SMTO_ABORTIFHUNG = 0x0002
            $broadcastResult = [UIntPtr]::Zero
            [CCQ.EnvBroadcast]::SendMessageTimeout(
                $HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero,
                "Environment", $SMTO_ABORTIFHUNG, 5000, [ref]$broadcastResult) | Out-Null
            Write-UiSuccess "✓ 已广播环境变量变更通知" -Level Debug
        } catch {
            Write-UiWarning "⚠ 广播环境变量变更通知失败: $($_.Exception.Message)" -Level Debug
        }

        # 卸载残留检查
        # 注意：nvm/direct 残留检查必须带 -and -not $SkipNvm/-SkipDirect 守卫，
        # 否则迁移目标本身就是该 provider（故意保留）时，会把「故意保留的安装」误报为残留并 throw。
        $residualIssues = @()
        if ([bool]$EnvSnapshot["NvmDetected"] -and -not $SkipNvm) {
            if (Test-Path "$env:APPDATA\nvm") {
                $residualIssues += "$env:APPDATA\nvm 仍存在"
            }
            $nvmArpRemaining = $false
            foreach ($keyPath in @(
                "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
                "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
                "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
            )) {
                try {
                    $arpItems = Get-ItemProperty $keyPath -ErrorAction SilentlyContinue | Where-Object {
                        $_.DisplayName -like "*NVM*" -or $_.DisplayName -like "*nvm-windows*"
                    }
                    if ($arpItems) { $nvmArpRemaining = $true }
                } catch { }
            }
            if ($nvmArpRemaining) {
                # 尝试手动清理 ARP 注册表条目（Inno Setup 卸载器可能因进程占用而失败）
                foreach ($keyPath in @(
                    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
                    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
                )) {
                    try {
                        $nvmKeys = @(Get-ChildItem $keyPath -ErrorAction SilentlyContinue | Where-Object {
                            $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
                            $props -and ($props.DisplayName -like "*NVM*" -or $props.DisplayName -like "*nvm-windows*")
                        })
                        foreach ($key in $nvmKeys) {
                            try {
                                Remove-Item -Path $key.PSPath -Recurse -Force -ErrorAction Stop
                                Write-UiSuccess "✓ 已清理 NVM ARP 注册表条目: $($key.PSChildName)" -Level Debug
                            } catch {
                                Write-UiWarning "⚠ 清理 NVM ARP 注册表条目失败: $($key.PSChildName)，$($_.Exception.Message)" -Level Debug
                            }
                        }
                    } catch { }
                }

                # 重新检查
                $nvmArpStillRemaining = $false
                foreach ($keyPath in @(
                    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
                    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
                    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
                )) {
                    try {
                        $arpItems = Get-ItemProperty $keyPath -ErrorAction SilentlyContinue | Where-Object {
                            $_.DisplayName -like "*NVM*" -or $_.DisplayName -like "*nvm-windows*"
                        }
                        if ($arpItems) { $nvmArpStillRemaining = $true }
                    } catch { }
                }
                if ($nvmArpStillRemaining) {
                    Write-UiWarning "⚠ nvm-windows 控制面板条目（ARP 注册表）仍存在，可能需要手动在控制面板卸载" -Level Detail
                } else {
                    Write-UiSuccess "✓ NVM ARP 注册表条目已手动清理" -Level Debug
                }
            }
        }
        if ([bool]$EnvSnapshot["DirectNodeDetected"] -and -not $SkipDirect) {
            if (Test-Path "$env:ProgramFiles\nodejs") {
                $residualIssues += "$env:ProgramFiles\nodejs 仍存在"
            }
            # 检查注册表残留
            foreach ($regPath in @("HKLM:\SOFTWARE\Node.js", "HKCU:\SOFTWARE\Node.js")) {
                if (Test-Path $regPath) {
                    $residualIssues += "$regPath 注册表仍存在"
                }
            }
            # 检查系统级 PATH 残留
            $machinePathCheck = [Environment]::GetEnvironmentVariable("PATH", "Machine")
            if ($machinePathCheck) {
                $nodejsNorm = "$env:ProgramFiles\nodejs".Replace("/", "\").TrimEnd("\").ToLower()
                foreach ($entry in ($machinePathCheck -split ";")) {
                    $entryNorm = $entry.Trim().Trim('"').Replace("/", "\").TrimEnd("\").ToLower()
                    if ($entryNorm -eq $nodejsNorm) {
                        $residualIssues += "系统级 PATH 中仍含 nodejs 条目"
                        break
                    }
                }
            }
        }

        if ($residualIssues.Count -gt 0) {
            throw "卸载后仍检测到残留: $($residualIssues -join '; ')"
        }

        $result.Success = $true
        Write-UiSuccess "✓ 冲突工具卸载与 PATH 清理完成" -Level Detail
    } catch {
        $result.ErrorMessage = "卸载冲突环境失败: $($_.Exception.Message)"
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
    .PARAMETER ShouldRestoreGlobalPackages
    是否恢复 npm 全局包
    .PARAMETER GlobalPackagesBackup
    全局包备份列表
    .RETURNS
    安装结果对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Result,

        [Parameter(Mandatory = $true)]
        [string]$ProviderType,

        [bool]$ShouldRestoreGlobalPackages = $false,

        [array]$GlobalPackagesBackup = @()
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

        # 恢复 npm 全局包
        if ($ShouldRestoreGlobalPackages -and $GlobalPackagesBackup -and $GlobalPackagesBackup.Count -gt 0) {
            $restoreResult = Restore-NpmGlobalPackages -Packages $GlobalPackagesBackup
            $Result.Data["GlobalPackagesRestored"] = $restoreResult.Success
            $Result.Data["GlobalPackagesInstalledCount"] = $restoreResult.Installed.Count
            $Result.Data["GlobalPackagesFailedCount"] = $restoreResult.Failed.Count
            if ($restoreResult.Success) {
                Write-UiSuccess "✓ npm 全局包恢复完成（成功: $($restoreResult.Installed.Count)）" -Level Detail
            } else {
                Write-UiWarning "⚠ npm 全局包恢复部分失败（成功: $($restoreResult.Installed.Count)，失败: $($restoreResult.Failed.Count)）" -Level Detail
            }
        } else {
            $Result.Data["GlobalPackagesRestored"] = $false
            Write-UiInfo "  无需恢复 npm 全局包" -Level Detail
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
