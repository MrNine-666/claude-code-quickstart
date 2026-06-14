# McpManager.ps1 - MCP Server 管理（轻量 Node.js wrapper）
# 版本: 2.0.0（JS 全包架构）
# 作者: 哈雷酱
# 功能: 调用 ~/.ccq/scripts/mcp-manager.js 完成所有 MCP 管理

#Requires -Version 7.0
Set-StrictMode -Version Latest

# 导入依赖模块
. "$PSScriptRoot\Ui.ps1"
. "$PSScriptRoot\Process.ps1"

# ============================================================================
# 脚本部署（内嵌 base64，构建时注入）
# ============================================================================

# 构建时注入：$script:EmbeddedMcpManagerB64 = "..."
# 此变量在 Release 模式下由 build.ps1 自动填充
$script:EmbeddedMcpManagerB64 = $null

# MCP Manager 脚本版本（与 mcp-manager.js 的 SCRIPT_VERSION 保持一致）
$script:McpManagerScriptVersion = "1.0.0"

<#
.SYNOPSIS
获取 MCP Manager JS 脚本路径

.DESCRIPTION
返回固定路径 ~/.ccq/scripts/mcp-manager.js
#>
function Get-McpManagerScriptPath {
    $ccqScriptsDir = Join-Path $env:USERPROFILE ".ccq" "scripts"
    return Join-Path $ccqScriptsDir "mcp-manager.js"
}

<#
.SYNOPSIS
部署 MCP Manager JS 脚本到 ~/.ccq/scripts/

.DESCRIPTION
优先从以下来源部署：
1. 内嵌 base64（Release 模式）
2. 源码目录 contracts/scripts/mcp-manager.js（源码模式）

.OUTPUTS
System.Boolean - 部署成功返回 $true
#>
function Install-McpManagerScript {
    $scriptPath = Get-McpManagerScriptPath
    $scriptDir = Split-Path $scriptPath -Parent

    # 确保目录存在
    if (-not (Test-Path $scriptDir)) {
        New-Item -ItemType Directory -Path $scriptDir -Force | Out-Null
    }

    # 检查已有脚本版本
    if (Test-Path $scriptPath) {
        try {
            # 读取脚本头部的 SCRIPT_VERSION
            $existingContent = Get-Content $scriptPath -Raw -ErrorAction SilentlyContinue
            if ($existingContent -match "const SCRIPT_VERSION = '([^']+)'") {
                $existingVersion = $matches[1]
                if ($existingVersion -eq $script:McpManagerScriptVersion) {
                    # 版本一致，跳过部署
                    return $true
                }
            }
        } catch {
            # 读取失败，继续部署
        }
    }

    # 部署策略 1: 内嵌 base64（Release 模式）
    if ($script:EmbeddedMcpManagerB64) {
        try {
            $bytes = [Convert]::FromBase64String($script:EmbeddedMcpManagerB64)
            [IO.File]::WriteAllBytes($scriptPath, $bytes)
            Write-UiSuccess "MCP Manager 脚本已部署（内嵌模式）"
            return $true
        } catch {
            Write-UiWarning "内嵌脚本部署失败: $($_.Exception.Message)"
        }
    }

    # 部署策略 2: 从源码目录复制（源码模式）
    $contractsRoot = $null
    if ($PSScriptRoot) {
        # 源码模式：installer/windows/core/ -> installer/contracts/
        $contractsRoot = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "contracts"
    }

    if ($contractsRoot -and (Test-Path $contractsRoot)) {
        $sourceScript = Join-Path $contractsRoot "scripts" "mcp-manager.js"
        if (Test-Path $sourceScript) {
            try {
                # 复制 JS 脚本
                Copy-Item -Path $sourceScript -Destination $scriptPath -Force

                # 同时复制契约文件到 ~/.ccq/mcp-servers.json（供 JS 脚本加载）
                $sourceContract = Join-Path $contractsRoot "mcp-servers.json"
                if (Test-Path $sourceContract) {
                    $destContract = Join-Path (Split-Path $scriptPath -Parent) ".." "mcp-servers.json"
                    Copy-Item -Path $sourceContract -Destination $destContract -Force
                }

                Write-UiSuccess "MCP Manager 脚本已部署（源码模式）"
                return $true
            } catch {
                Write-UiWarning "源码脚本复制失败: $($_.Exception.Message)"
            }
        }
    }

    # 部署失败
    Write-UiDanger "无法部署 MCP Manager 脚本（内嵌和源码模式均失败）"
    return $false
}

<#
.SYNOPSIS
MCP 管理交互菜单（主入口）

.DESCRIPTION
调用 node ~/.ccq/scripts/mcp-manager.js manage
完整的 TUI 和业务逻辑均在 JS 脚本中实现

.OUTPUTS
System.Boolean - 成功返回 $true
#>
function Show-McpManageMenu {
    # 1. 检查 Node.js
    $nodeCheck = Test-CommandAvailable -Command "node"
    if (-not $nodeCheck) {
        Write-UiDanger "Node.js 未安装或不在 PATH 中"
        Write-UiInfo "请先安装 Node.js LTS：https://nodejs.org/"
        return $false
    }

    # 2. 确保 JS 脚本存在且为最新版本
    # （Install-McpManagerScript 内部有版本检测，版本一致时快速返回）
    $scriptPath = Get-McpManagerScriptPath
    $deployed = Install-McpManagerScript
    if (-not $deployed) {
        return $false
    }

    # 3. 调用 JS 脚本（manage 模式）
    # 关键：交互式 TUI 必须继承父进程的 TTY，不能用 Invoke-ExternalCommand
    # （后者重定向 stdin/stdout，导致子进程 process.stdin.isTTY = false）
    # 使用原生调用操作符 & 让 node 直接继承终端
    #
    # HC-MCP-TTY（强约束）：本函数禁止向 success stream 返回布尔值（如
    # `return ($LASTEXITCODE -eq 0)`）。否则交互模式下调用方 `Show-McpManageMenu`
    # 会把 True/False 打印到控制台；而若调用方改用 `$null = Show-McpManageMenu`
    # 吞返回值，PowerShell 会重定向整个函数的 stdout，连带 `& node "manage"` 的
    # 输出一起被捕获，导致 node 的 process.stdout.isTTY = false，交互 TUI 退化为
    # 「非交互式终端」分支。两者冲突，唯一正解是函数本身不产生 success-stream 输出。
    try {
        & node $scriptPath "manage"
        if ($LASTEXITCODE -ne 0) {
            Write-UiWarning "MCP 管理退出码: $LASTEXITCODE"
        }
    } catch {
        Write-UiDanger "MCP 管理执行失败"
        Write-UiDim "错误详情: $($_.Exception.Message)"
    }
}

<#
.SYNOPSIS
同步 MCP Rules 文件（被 steps/Mcp.ps1 调用）

.DESCRIPTION
调用 node ~/.ccq/scripts/mcp-manager.js sync-rules
动态生成 ~/.claude/rules/ccq-mcp-*.md

.OUTPUTS
System.Boolean - 成功返回 $true
#>
function Sync-AllMcpRules {
    # 确保脚本存在且为最新版本（内部有版本检测，快速返回）
    $scriptPath = Get-McpManagerScriptPath
    $deployed = Install-McpManagerScript
    if (-not $deployed) {
        return $false
    }

    # 调用 JS 脚本（sync-rules 模式，非交互可用 Invoke-ExternalCommand）
    try {
        $result = Invoke-ExternalCommand `
            -Command "node" `
            -Arguments @($scriptPath, "sync-rules") `
            -TimeoutSeconds 30 `
            -SuppressOutput:$true

        if ($result.ExitCode -eq 0) {
            Write-UiSuccess "MCP Rules 已同步"
            return $true
        } else {
            Write-UiWarning "MCP Rules 同步失败"
            return $false
        }
    } catch {
        Write-UiWarning "MCP Rules 同步异常: $($_.Exception.Message)"
        return $false
    }
}

<#
.SYNOPSIS
获取 MCP 状态（JSON 格式，供脚本调用）

.DESCRIPTION
调用 node ~/.ccq/scripts/mcp-manager.js status
返回状态数组的 PowerShell 对象

.OUTPUTS
System.Object[] - MCP 状态数组
#>
function Get-McpStatus {
    # 确保脚本存在且为最新版本（内部有版本检测，快速返回）
    $scriptPath = Get-McpManagerScriptPath
    $deployed = Install-McpManagerScript
    if (-not $deployed) {
        return @()
    }

    try {
        $result = Invoke-ExternalCommand `
            -Command "node" `
            -Arguments @($scriptPath, "status") `
            -TimeoutSeconds 30 `
            -SuppressOutput:$true

        if ($result.ExitCode -eq 0 -and $result.Output) {
            $statusJson = $result.Output -join "`n"
            return ($statusJson | ConvertFrom-Json)
        }
    } catch {
        # 静默失败
    }

    return @()
}

# ============================================================================
# 向后兼容：保留旧函数签名（空实现或转发到 JS）
# ============================================================================

# 这些函数被其他模块引用，保留空壳以避免破坏调用方
function Get-McpContract { return @{ McpServers = @{} } }
function Invoke-McpPreInstall { param($ServerId) }

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 对外入口：Show-McpManageMenu / Sync-AllMcpRules / Get-McpStatus
# 部署工具：Get-McpManagerScriptPath / Install-McpManagerScript
# 兼容空壳：Get-McpContract / Invoke-McpPreInstall
