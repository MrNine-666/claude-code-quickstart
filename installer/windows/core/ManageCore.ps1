# ManageCore.ps1 - Manage JS 脚本集合部署（轻量 Node.js wrapper）
# 版本: 0.1.0（Phase 0 基础设施）
# 作者: 哈雷酱
# 功能: 部署 manage.js + provider/skills/update-manager.js 到 ~/.ccq/scripts/
#       （轻量 wrapper，与 McpManager.ps1 部署范式对称）
#
# 说明：本模块在 Phase 0 仅提供部署能力，尚未接入 Manage.ps1 主入口。
#       待 Phase 1-3 完成 JS 业务逻辑迁移后，由 Manage.ps1 调用本模块切换到 JS 路径。

#Requires -Version 7.0
Set-StrictMode -Version Latest

# 导入依赖模块（UI 用于友好提示）
. "$PSScriptRoot\Ui.ps1"
. "$PSScriptRoot\Process.ps1"

# ============================================================================
# 脚本部署（内嵌 base64，构建时注入）
# ============================================================================

# 构建时注入：$script:EmbeddedManageScriptsJson = '{"manage.js":"...","provider-manager.js":"...",...}'
# 此变量在 Release 模式下由 build.ps1 自动填充
$script:EmbeddedManageScriptsJson = $null

# Manage JS 脚本版本（取 manage.js 的 SCRIPT_VERSION）
$script:ManageCoreVersion = "1.0.0"

# 需要部署的脚本清单（与 build.ps1 Get-ManageScriptsBase64 保持一致）
$script:ManageScriptNames = @(
    'manage.js',
    'provider-manager.js',
    'skills-manager.js',
    'update-manager.js'
)

<#
.SYNOPSIS
获取 Manage JS 脚本目录路径
#>
function Get-ManageScriptsDir {
    return (Join-Path $env:USERPROFILE ".ccq" "scripts")
}

<#
.SYNOPSIS
部署 Manage JS 脚本集合到 ~/.ccq/scripts/

.DESCRIPTION
优先从以下来源部署：
1. 内嵌 base64 JSON（Release 模式）
2. 源码目录 contracts/scripts/*.js（源码模式）

.OUTPUTS
System.Boolean - 部署成功返回 $true
#>
function Install-ManageScripts {
    $scriptsDir = Get-ManageScriptsDir

    # 确保目录存在
    if (-not (Test-Path $scriptsDir)) {
        New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
    }

    # 检查是否需要部署（版本检测：manage.js 的 SCRIPT_VERSION）
    $managePath = Join-Path $scriptsDir "manage.js"
    if (Test-Path $managePath) {
        try {
            $existingContent = Get-Content $managePath -Raw -ErrorAction SilentlyContinue
            if ($existingContent -match "const SCRIPT_VERSION = '([^']+)'") {
                $existingVersion = $matches[1]
                if ($existingVersion -eq $script:ManageCoreVersion) {
                    # 版本一致，跳过部署
                    return $true
                }
            }
        } catch {
            # 读取失败，继续部署
        }
    }

    # 部署策略 1: 内嵌 base64 JSON（Release 模式）
    if ($script:EmbeddedManageScriptsJson) {
        try {
            $scriptsMap = $script:EmbeddedManageScriptsJson | ConvertFrom-Json
            $deployedCount = 0
            foreach ($fileName in $script:ManageScriptNames) {
                $b64 = $scriptsMap.$fileName
                if (-not $b64) { continue }
                $destPath = Join-Path $scriptsDir $fileName
                $bytes = [Convert]::FromBase64String($b64)
                [IO.File]::WriteAllBytes($destPath, $bytes)
                $deployedCount++
            }
            if ($deployedCount -gt 0) {
                Write-UiSuccess "Manage JS 脚本集合已部署（内嵌模式，$deployedCount 个文件）"
                return $true
            }
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
        $sourceScriptsDir = Join-Path $contractsRoot "scripts"
        if (Test-Path $sourceScriptsDir) {
            try {
                $copiedCount = 0
                foreach ($fileName in $script:ManageScriptNames) {
                    $sourceScript = Join-Path $sourceScriptsDir $fileName
                    if (Test-Path $sourceScript) {
                        Copy-Item -Path $sourceScript -Destination (Join-Path $scriptsDir $fileName) -Force
                        $copiedCount++
                    }
                }
                if ($copiedCount -gt 0) {
                    Write-UiSuccess "Manage JS 脚本集合已部署（源码模式，$copiedCount 个文件）"
                    return $true
                }
            } catch {
                Write-UiWarning "源码脚本复制失败: $($_.Exception.Message)"
            }
        }
    }

    # 部署失败
    Write-UiDanger "无法部署 Manage JS 脚本集合（内嵌和源码模式均失败）"
    return $false
}

<#
.SYNOPSIS
启动 manage.js 交互式管理面板

.DESCRIPTION
调用 node ~/.ccq/scripts/manage.js（TTY 继承，交互式菜单）
HC-MCP-TTY 约束：禁止向 success stream 返回布尔值（对齐 Show-McpManageMenu）

.OUTPUTS
无（函数本身不产生 success-stream 输出）
#>
function Show-ManagePanel {
    # 1. 检查 Node.js
    $nodeCheck = Test-CommandAvailable -Command "node"
    if (-not $nodeCheck) {
        Write-UiDanger "Node.js 未安装或不在 PATH 中"
        Write-UiInfo "请先安装 Node.js LTS：https://nodejs.org/"
        return
    }

    # 2. 确保 JS 脚本存在且为最新版本
    $deployed = Install-ManageScripts
    if (-not $deployed) {
        return
    }

    # 3. 调用 manage.js（TTY 继承，交互式菜单）
    $scriptsDir = Get-ManageScriptsDir
    $managePath = Join-Path $scriptsDir "manage.js"
    try {
        & node $managePath
        if ($LASTEXITCODE -ne 0) {
            Write-UiWarning "管理面板退出码: $LASTEXITCODE"
        }
    } catch {
        Write-UiDanger "管理面板执行失败"
        Write-UiDim "错误详情: $($_.Exception.Message)"
    }
}

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 对外入口：Show-ManagePanel（待 Phase 1-3 完成后接入 Manage.ps1）
# 部署工具：Get-ManageScriptsDir / Install-ManageScripts
