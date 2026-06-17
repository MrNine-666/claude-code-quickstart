# ManageCore.ps1 - Manage JS 单文件 bundle 缓存调用 wrapper（轻量 Node.js wrapper）
# 版本: 1.0.0（Phase 10：方案 3 架构 — esbuild 单文件 bundle + 固定目录缓存）
# 作者: 哈雷酱
# 功能: 检测 Node.js → 解析 manage.js（源码优先 / 缓存复用 / 过期 curl）→ node 调用（TTY 继承）
#
# 缓存策略（HC-CACHE-TMPDIR）：
#   - 源码模式（$PSScriptRoot 可解析到 contracts/scripts/manage.js）：直接运行源码，离线可用
#   - Release 模式：缓存 $env:TEMP\.ccq\manage.js（1 小时 TTL），过期 curl /latest/download/manage.js
# HC-15：irm|iex 下 $PSScriptRoot 为空，源码探测前判空，缓存路径仅依赖 $env:TEMP

#Requires -Version 7.0
Set-StrictMode -Version Latest

# 导入依赖模块（构建时被剥离；源码模式下提供 UI 与命令检测）
. "$PSScriptRoot\Ui.ps1"
. "$PSScriptRoot\Process.ps1"

# ============================================================================
# 配置常量
# ============================================================================

# manage.js 单文件 bundle 的固定 Release 下载地址（HC-ZERO-CACHE：无版本号 / 无内容哈希）
$script:ManageBundleUrl = 'https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/manage.js'

# 缓存有效期（小时）
$script:ManageCacheTtlHours = 1

<#
.SYNOPSIS
获取 manage.js 固定缓存路径（$env:TEMP\.ccq\manage.js）
#>
function Get-ManageCachePath {
    return (Join-Path $env:TEMP '.ccq' 'manage.js')
}

<#
.SYNOPSIS
源码模式探测：返回源码 manage.js 路径，不可用时返回 $null

.DESCRIPTION
HC-15：$PSScriptRoot 为空（irm|iex Release 模式）时直接返回 $null，转走缓存路径。
源码模式下从 installer/windows/core/ 上溯两级定位 contracts/scripts/manage.js。
#>
function Get-SourceManageScript {
    if (-not $PSScriptRoot) { return $null }
    $contractsScript = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'contracts' 'scripts' 'manage.js'
    if (Test-Path $contractsScript -PathType Leaf) {
        return $contractsScript
    }
    return $null
}

<#
.SYNOPSIS
解析要执行的 manage.js 路径：源码优先 → 缓存复用 → 过期下载

.OUTPUTS
System.String - manage.js 路径；彻底失败返回 $null
#>
function Resolve-ManageScript {
    # 1. 源码模式优先（离线可用，require 子模块直接命中同目录）
    $sourceScript = Get-SourceManageScript
    if ($sourceScript) {
        return $sourceScript
    }

    # 2. Release 模式：缓存检查（1 小时 TTL）
    $cachePath = Get-ManageCachePath
    if (Test-Path $cachePath -PathType Leaf) {
        $age = (Get-Date) - (Get-Item $cachePath).LastWriteTime
        if ($age.TotalHours -lt $script:ManageCacheTtlHours) {
            return $cachePath
        }
    }

    # 3. 缓存缺失或过期：下载最新 bundle
    $cacheDir = Split-Path $cachePath -Parent
    if (-not (Test-Path $cacheDir -PathType Container)) {
        New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    }
    try {
        Invoke-WebRequest -Uri $script:ManageBundleUrl -OutFile $cachePath -UseBasicParsing -TimeoutSec 60
        return $cachePath
    } catch {
        # 下载失败：存在旧缓存则降级复用（可能非最新），否则报错返回 $null
        if (Test-Path $cachePath -PathType Leaf) {
            Write-UiWarning "manage.js 下载失败，复用已有缓存（可能非最新）"
            return $cachePath
        }
        Write-UiDanger "manage.js 下载失败且无缓存可用"
        Write-UiDim "错误详情: $($_.Exception.Message)"
        return $null
    }
}

<#
.SYNOPSIS
启动 manage.js 交互式管理面板

.DESCRIPTION
检测 Node.js → 解析 manage.js（源码 / 缓存 / 下载）→ node 调用（TTY 继承，交互式菜单）。
HC-MCP-TTY 约束：不向 success stream 返回布尔值。

.OUTPUTS
无（函数本身不产生 success-stream 输出）
#>
function Show-ManagePanel {
    # 1. 检查 Node.js
    if (-not (Test-CommandAvailable -Command 'node')) {
        Write-UiDanger "Node.js 未安装或不在 PATH 中"
        Write-UiInfo "请先安装 Node.js LTS：https://nodejs.org/"
        return
    }

    # 1b. 检查 Node.js 版本（<20 警告，对齐 wrapper spec「Node.js version too old」场景）
    try {
        $nodeVersion = (& node --version 2>$null)
        if ($nodeVersion -match '^v?(\d+)\.' -and [int]$Matches[1] -lt 20) {
            Write-UiWarning "检测到 Node.js 版本 $nodeVersion (<20)，部分功能可能不可用，请通过 nvm/fnm 升级"
        }
    } catch { }

    # 2. 解析 manage.js（源码 / 缓存 / 下载）
    $managePath = Resolve-ManageScript
    if (-not $managePath) {
        return
    }

    # 3. 调用 manage.js（TTY 继承，交互式菜单）
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
# 对外入口：Show-ManagePanel
# 工具：Get-ManageCachePath / Get-SourceManageScript / Resolve-ManageScript
