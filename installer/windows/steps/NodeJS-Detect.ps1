# NodeJS-Detect.ps1 - Node.js 环境检测层
# 职责：检测 nvm/direct/portable 三种 provider 的安装状态

#Requires -Version 5.1
Set-StrictMode -Version Latest

function Test-NodeJSInstalled {
    <#
    .SYNOPSIS
    测试步骤 01 是否已完成（Node.js 安装）
    .RETURNS
    标准检测结果 hashtable（IsInstalled, Version, Data, Message）
    #>
    param()

    # 缓存检查
    $cached = Get-CachedTestResult -CacheKey "NodeJS"
    if ($cached) { return $cached }

    $result = @{
        IsInstalled = $false
        Version = ""
        Data = @{}
        Message = ""
    }

    try {
        Write-UiPrimary "🔍 检查 Node.js 安装状态..." -Level Detail

        # 检查 node/npm 是否可用（使用 ReturnDetails 获取完整信息）
        $nodeDetails = Test-CommandAvailable -Command "node" -ReturnDetails
        $npmDetails = Test-CommandAvailable -Command "npm" -ReturnDetails

        $nodeAvailable = [bool]$nodeDetails.Available
        $npmAvailable = [bool]$npmDetails.Available

        # 检测 nvm-windows（强信号：命令可用 / NVM_HOME 有值 / nvm 目录存在）
        $nvmCommandAvailable = Test-CommandAvailable -Command "nvm"
        $nvmHome = [Environment]::GetEnvironmentVariable("NVM_HOME", "Process")
        if ([string]::IsNullOrWhiteSpace($nvmHome)) {
            $nvmHome = [Environment]::GetEnvironmentVariable("NVM_HOME", "User")
        }
        if ([string]::IsNullOrWhiteSpace($nvmHome)) {
            $nvmHome = [Environment]::GetEnvironmentVariable("NVM_HOME", "Machine")
        }
        $nvmDetected = $nvmCommandAvailable -or
                       (-not [string]::IsNullOrWhiteSpace($nvmHome)) -or
                       (Test-Path (Join-Path $env:APPDATA "nvm") -PathType Container)

        # 检测直接安装的 Node.js
        $directNodePath = Join-Path $env:ProgramFiles "nodejs"
        $directNodeDirExists = Test-Path $directNodePath -PathType Container
        $directNodeRegistryExists = (Test-Path "HKLM:\SOFTWARE\Node.js") -or (Test-Path "HKLM:\SOFTWARE\WOW6432Node\Node.js")
        $directNodeDetected = $directNodeDirExists -or $directNodeRegistryExists

        # nvm-windows 使用 C:\Program Files\nodejs 作为 symlink 目标
        # 如果 nvm 已检测到，且 nodejs 目录是 symlink/junction，则不算 direct 安装
        if ($nvmDetected -and $directNodeDirExists) {
            $nodejsDirItem = Get-Item $directNodePath -Force -ErrorAction SilentlyContinue
            if ($nodejsDirItem -and ($nodejsDirItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                $directNodeDetected = $false
                $directNodeDirExists = $false
                Write-UiInfo "  $directNodePath 是 nvm symlink，不算 direct 安装" -Level Debug
            }
        }

        # 检测 winget 安装记录（辅助信号）
        $wingetAvailable = Test-CommandAvailable -Command "winget"
        $wingetNodeInstalled = $false
        $wingetNodeInstalledId = ""
        if ($wingetAvailable) {
            foreach ($packageId in @("OpenJS.NodeJS.LTS", "OpenJS.NodeJS")) {
                try {
                    $wingetResult = Invoke-ExternalCommand -Command "winget" -Arguments @("list", "--id", $packageId, "-e", "--disable-interactivity") -SuppressOutput -TimeoutSeconds 30 -RetryCount 0
                    if ($wingetResult.Success -and $wingetResult.Output -and $wingetResult.Output -match [regex]::Escape($packageId)) {
                        $wingetNodeInstalled = $true
                        $wingetNodeInstalledId = $packageId
                        break
                    }
                } catch {
                    # 0x8A150014 (-1978335212) = APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND
                    # winget 未找到匹配包是正常情况（Node.js 可能通过 nvm 安装），静默忽略
                    if ($_.Exception.Message -notmatch '-1978335212|8A150014|找不到.*匹配') {
                        Write-UiWarning "⚠ winget list Node.js 检测失败: $($_.Exception.Message)" -Level Detail
                    }
                }
            }
            if ($wingetNodeInstalled) {
                $directNodeDetected = $true
            }
        }

        # 检测绿色版（portable）Node.js：node/npm 可用但无任何已知 provider 信号
        $portableNodeDetected = $nodeAvailable -and $npmAvailable -and
            -not $nvmDetected -and -not $directNodeDetected

        # 核心检测数据
        $result.Data["NodePath"] = $nodeDetails.ResolvedPath
        $result.Data["NpmPath"] = $npmDetails.ResolvedPath
        $result.Data["NvmDetected"] = $nvmDetected
        $result.Data["NvmCommandAvailable"] = $nvmCommandAvailable
        $result.Data["NvmHome"] = $nvmHome
        $result.Data["DirectNodeDetected"] = $directNodeDetected
        $result.Data["PortableNodeDetected"] = $portableNodeDetected
        $result.Data["WingetNodeInstalledId"] = $wingetNodeInstalledId

        # 输出检测结果
        if ($nvmDetected) {
            Write-UiWarning "⚠ 检测到 nvm-windows 环境" -Level Detail
            if ($nvmHome) { Write-UiInfo "  NVM_HOME: $nvmHome" -Level Detail }
        }

        if ($directNodeDetected) {
            Write-UiWarning "⚠ 检测到直接安装的 Node.js 环境" -Level Detail
            if ($wingetNodeInstalledId) {
                Write-UiInfo "  winget 安装记录: $wingetNodeInstalledId" -Level Detail
            }
        }

        if ($portableNodeDetected) {
            Write-UiInfo "✓ 检测到绿色版（portable）Node.js 环境" -Level Detail
            if ($nodeDetails.ResolvedPath) {
                Write-UiInfo "  路径: $($nodeDetails.ResolvedPath)" -Level Detail
            }
        }

        $nodeVersionSatisfied = $false
        if ($nodeAvailable) {
            $nodeVersion = Get-CommandVersion -Command "node"
            $result.Data["NodeVersion"] = $nodeVersion
            Write-UiSuccess "✓ Node.js 已安装 (版本: $nodeVersion)" -Level Detail
            if ($nodeDetails.ResolvedPath) {
                Write-UiInfo "  路径: $($nodeDetails.ResolvedPath)" -Level Detail
            }

            # 检查版本是否满足要求
            if ($nodeVersion -match '^v?(\d+)\.') {
                $versionNumber = [int]$matches[1]
                if ($versionNumber -ge [int]$script:RequiredNodeVersion) {
                    $result.Version = $nodeVersion
                    $nodeVersionSatisfied = $true
                    Write-UiSuccess "✓ Node.js 版本满足要求 (需要: v$script:RequiredNodeVersion+)" -Level Detail
                } else {
                    Write-UiWarning "⚠ Node.js 版本过低 (当前: $nodeVersion, 需要: v$script:RequiredNodeVersion+)" -Level Detail
                }
            } else {
                Write-UiWarning "⚠ 无法解析 Node.js 版本号: $nodeVersion" -Level Detail
            }
        } else {
            Write-UiWarning "⚠ Node.js 未安装" -Level Detail
        }

        if ($npmAvailable) {
            $npmVersion = Get-CommandVersion -Command "npm"
            $result.Data["NpmVersion"] = $npmVersion
            Write-UiSuccess "✓ npm 已安装 (版本: $npmVersion)" -Level Detail
            if ($npmDetails.ResolvedPath) {
                Write-UiInfo "  路径: $($npmDetails.ResolvedPath)" -Level Detail
            }
        } else {
            Write-UiWarning "⚠ npm 未安装" -Level Detail
        }

        # Provider 信号判定（基于直接信号，不依赖路径推断）
        $providerSignals = @{}
        if ($nvmDetected) { $providerSignals["nvm"] = $true }
        if ($directNodeDetected) { $providerSignals["direct"] = $true }
        if ($portableNodeDetected) { $providerSignals["portable"] = $true }

        $providerType = "none"
        if ($providerSignals.Count -gt 1) {
            $providerType = "mixed"
        } elseif ($providerSignals.Count -eq 1) {
            $providerType = @($providerSignals.Keys)[0]
        }

        $providerHealthy = $false
        switch ($providerType) {
            "nvm"      { $providerHealthy = $nodeAvailable -and $npmAvailable -and $nodeVersionSatisfied -and $nvmDetected }
            "direct"   { $providerHealthy = $nodeAvailable -and $npmAvailable -and $nodeVersionSatisfied -and $directNodeDetected }
            "portable" { $providerHealthy = $nodeAvailable -and $npmAvailable -and $nodeVersionSatisfied }
        }
        $result.Data["ProviderType"] = $providerType
        $result.Data["ProviderHealthy"] = $providerHealthy

        # 判断是否已满足安装要求
        # SkipIfInstalled = $true：仅在 providerHealthy 且非 mixed 时才真正跳过
        Write-UiInfo "Provider: $providerType, 健康: $providerHealthy" -Level Debug
        if ($providerType -eq "mixed") {
            # mixed 但 node/npm/版本全部满足 → 视为已安装（避免自动补依赖时误入迁移流程）
            if ($nodeAvailable -and $npmAvailable -and $nodeVersionSatisfied) {
                $result.IsInstalled = $true
                $result.Message = "检测到混合 Node.js 环境，但运行时满足要求"
            } else {
                $result.IsInstalled = $false
                $result.Message = "检测到混合 Node.js 环境，需要进入安装阶段选择 provider"
            }
        } elseif ($providerHealthy) {
            $result.IsInstalled = $true
            $result.Message = "检测到健康 Node.js 环境（provider: $providerType），可直接跳过或进入迁移菜单"
        } elseif ($providerType -eq "none") {
            $result.Message = "未检测到 Node.js，需要选择安装方式"
        } else {
            $result.Message = "Node.js 不完整，需要安装或修复"
        }

    } catch {
        $result.Message = "Node.js 安装状态检查失败: $($_.Exception.Message)"
        Write-UiWarning "⚠ $($result.Message)" -Level Debug
    }

    # 写入缓存
    Set-CachedTestResult -CacheKey "NodeJS" -Result $result
    return $result
}
