#Requires -Version 5.1
# Download-Ccq.ps1 - CCQ 专用下载入口（Windows）
# 功能: 只把 ccq 可执行文件安装到 %USERPROFILE%\.local\bin\ccq.exe 并配置用户 PATH。
#       不安装、不更新 Node.js / Git / Claude Code / Codex / Pi，也不进入 installer step 生命周期。
# 说明: 全部 CCQ 行为实现在 core/Ccq.ps1；本入口只负责加载共享 runtime 并调用带模式的 handoff。

param(
    [switch]$Help,

    [string]$CcqReleaseTag = "__CCQ_RELEASE_TAG__"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 将 param 默认值显式提升到 script 作用域（trampoline 兼容）。
# dist/download-ccq.ps1 经 irm|iex 走 ASCII trampoline：真实脚本由 [scriptblock]::Create
# 还原后以 & $sb 执行，此链路下 param 变量不会自动绑定到 $script: 作用域；
# 而 Get-CcqReleaseTag / Get-CcqReleaseDownloadBaseUrl 在 StrictMode 下读
# $script:CcqReleaseTag 会抛"未设置"异常。源码 -File 模式碰巧能跑通，release 模式必现。
$script:CcqReleaseTag = $CcqReleaseTag

# ─── 中文编码修复（必须在 dot-source core/ 之前执行，不能移入 core/ 模块）─────
try {
    if (-not ([System.Management.Automation.PSTypeName]'_CcqKernel32Cp').Type) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class _CcqKernel32Cp {
    [DllImport("kernel32.dll")] public static extern bool SetConsoleOutputCP(uint cp);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleCP(uint cp);
}
'@ -ErrorAction SilentlyContinue
    }
    [_CcqKernel32Cp]::SetConsoleOutputCP(65001) | Out-Null
    [_CcqKernel32Cp]::SetConsoleCP(65001) | Out-Null
} catch { }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if ($Help) {
    Write-Host '用法: download-ccq.ps1 [-CcqReleaseTag <vX.Y.Z>]'
    Write-Host ''
    Write-Host '只下载并安装 ccq 管理控制台可执行文件到 %USERPROFILE%\.local\bin，'
    Write-Host '并把该目录加入用户 PATH。不会安装 Node.js / Git / Claude Code / Codex / Pi。'
    exit 0
}

$script:WindowsRoot = if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { "" } else { $PSScriptRoot }
$script:InstallerRoot = if ([string]::IsNullOrWhiteSpace($script:WindowsRoot)) { "" } else { Split-Path -Parent $script:WindowsRoot }

# ─── Dot-source 核心模块（顺序由 contracts/build.json 唯一决定）──────────────
#
# Json.ps1 + Registry.ps1 是 bootstrap（PS5.1 hashtable 转换 + 合同定位与
# Get-CoreLoadOrder）；其余 core 由 Get-CoreLoadOrder 从
# BuildEntrypoints.Windows.Artifacts['CcqDownload'].CoreFiles 读取后按序加载。
# release trampoline 已由 build.ps1 内联全部 core，没有可用的 $PSScriptRoot，
# 因此下面整段在 $script:WindowsRoot 为空时跳过。
#
# 专用入口不加载 core/Bootstrap，也不加载任何 step 模块，因此不会触发
# step registry / Node.js / Git / Agent 工具安装。
. "$script:WindowsRoot\core\Json.ps1"
. "$script:WindowsRoot\core\Registry.ps1"

if (-not [string]::IsNullOrWhiteSpace($script:WindowsRoot)) {
    $coreFiles = Get-CoreLoadOrder -Role 'CcqDownload'
    foreach ($coreRelPath in $coreFiles) {
        $coreLeaf = Split-Path -Leaf $coreRelPath
        if ($coreLeaf -in @('Json.ps1', 'Registry.ps1')) { continue }
        $corePath = Join-Path $script:InstallerRoot $coreRelPath
        if (-not (Test-Path -LiteralPath $corePath -PathType Leaf)) {
            throw "core 模块不存在: $corePath（来源: contracts/build.json）"
        }
        if ($corePath) { . $corePath }
    }
}

# ─── 主流程：Dedicated 模式跳过首次下载确认，其余安全决策与完整 install 共用 ──

try {
    # 专用入口是脚本化调用入口，必须用退出码反映真实结果：
    # 下载/替换失败时非零退出，避免 `irm | iex` 或 CI 把失败当成功。
    if (-not (Confirm-CcqExecutableDownload -Mode Dedicated)) {
        Write-Host ""
        Write-Host 'ccq 可执行文件未安装成功。'
        exit 1
    }
} catch {
    Write-UiDanger "ccq 可执行文件安装失败: $($_.Exception.Message)"
    Write-Host ""
    Write-Host '如需手动安装，请访问: https://github.com/MrNine-666/claude-code-quickstart/releases'
    exit 1
}
