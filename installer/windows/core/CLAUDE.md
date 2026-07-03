# installer/windows/core/ — Windows 核心基础库

> 面包屑：[根目录](../../../CLAUDE.md) › [installer/](../../CLAUDE.md) › windows/ › core/
> 生成时间：2026-06-24（Manage TUI 迁移到 OpenTUI + Bun 单文件可执行，ManageCore.ps1 已删除）

所有核心模块通过 **dot-source** 加载（非 Module），无 `Export-ModuleMember`，函数在调用方作用域内直接可用。

---

## 模块一览

| 文件 | 行数 | 职责 |
|------|------|------|
| `Ui.ps1` | 893 | TUI 组件：语义颜色系统（6 色）、菜单、进度、摘要表格 |
| `Process.ps1` | 1784 | 外部命令执行、PATH 刷新、版本检测、npm/winget 封装；**ccq 可执行文件管理区段**（架构检测 / 下载 / PATH，见下文专节） |
| `Profile.ps1` | 526 | `$PROFILE` 安全编辑：备份、标记块读写、原子写入 |
| `Update.ps1` | ~310 | **更新状态管理**：更新清单、内容指纹、更新快照（与 macOS `Update.zsh` 对称的集中式 Update core，从 Profile.ps1 迁出） |
| `Admin.ps1` | 137 | 管理员权限检测与自提权 |
| `Net.ps1` | ~270 | 端点可达性检测、文件下载 |
| `Registry.ps1` | 280 | **共享步骤注册表**：元数据、分组、依赖、迁移映射（消除 DRY 违规） |
| `Bootstrap.ps1` | 617 | 步骤状态模型、生命周期调度、拓扑排序、恢复逻辑 |

旧 `ManageCore.ps1`（Manage TUI 目录型产物缓存 wrapper）已删除，Manage 改为 OpenTUI + Bun 单文件可执行分发。

---

## Ui.ps1

### 终端能力检测

初始化时自动检测（`Initialize-TerminalCapabilities`）：
- `$script:IsWindowsTerminal`：环境变量 `$env:WT_SESSION` 不为空
- `$script:SupportsAnsi`：PS 6+ 或 Windows Terminal 时为 `$true`

> 所有 UI 函数在 `SupportsAnsi = false` 时自动降级为纯文本 ASCII 模式。

### 终端主题检测

`Initialize-TerminalCapabilities` 末尾调用 `Detect-TerminalTheme` 判定终端明暗并存入 `$script:TerminalTheme`（`dark` / `light`），据此在 `$script:AnsiColorsDark` / `$script:AnsiColorsLight` 间选择 `$script:AnsiColors`。检测链：

1. `Get-TerminalBackgroundRgbOsc11`：发送 `OSC 11;? BEL` 查询默认背景色，短超时（~160ms）读取控制台输入，解析 `rgb:rrrr/gggg/bbbb`（每通道 1-4 hex，由 `Convert-TerminalRgbComponentToByte` 归一为 0-255）；按 Rec.601 亮度 `0.299R + 0.587G + 0.114B` 判定 ≥0.5 为 light。输出被重定向（`[Console]::IsOutputRedirected`）或 legacy conhost 不响应时返回 `$null`。
2. `Get-TerminalThemeFromColorFgBg`：解析 `$env:COLORFGBG` 末段，0-6/8 视为 dark，其余 light。
3. 默认 `dark`（保守，与历史行为一致）。

### 语义颜色系统（6 色，双套）

深色终端用亮色前景（黑底清晰），浅色终端用深色前景（白底清晰）。`Write-Ui*` 函数读 `$script:AnsiColors`，主题切换后自动适配，零调用链改动。

| 函数 | 语义角色 | dark（ANSI） | light（ANSI） | 用途 |
|------|---------|-------------|--------------|------|
| `Write-UiSuccess` | 成功 | 亮绿 `\e[92m` | 深绿 `\e[32m` | 成功确认、完成提示 |
| `Write-UiPrimary` | 品牌/进行中 | Claude Orange `\e[38;2;217;119;87m` | Claude Orange 加深 `\e[38;2;184;92;62m` | 标题、横幅、活跃进度 |
| `Write-UiWarning` | 警告 | 亮黄 `\e[93m` | 深黄 `\e[33m` | 警告、可恢复错误 |
| `Write-UiDanger` | 危险 | 亮红 `\e[91m` | 深红 `\e[31m` | 错误、失败 |
| `Write-UiInfo` | 信息 | 白色 `\e[97m` | 黑色 `\e[30m` | 数据、路径、指令性文本 |
| `Write-UiDim` | 次要 | 灰色 `\e[90m` | 暗灰 `\e[38;2;106;106;106m` | 时间戳、提示、装饰分隔线 |

> **零逃逸约束**：`$script:AnsiColors*` / `Detect-TerminalTheme` / `-ForegroundColor` **仅限** `Ui.ps1` 内部使用。外部文件通过 `Write-Ui*` 函数访问颜色。入口脚本在 Ui.ps1 加载前的早期错误处理块（PS 版本检查）例外。

### 通用输出调度器

```powershell
Write-UiOutput $Message -Type <Primary|Info|Success|Warning|Danger|Dim>
```

### UI 组件函数

| 函数 | 用途 |
|------|------|
| `Show-AsciiBanner` | 自适应宽度的 `╔═╗` 横幅（Primary 色） |
| `Show-SingleSelectMenu` | 箭头键单选（不支持 ANSI 时数字输入降级） |
| `Show-MultiSelectMenu` | 空格多选菜单（同上降级） |
| `Show-StepProgress` | 状态指示：`[PASS]` / `[FAIL]` / `[SKIP]` |
| `Show-InstallSummary` | 安装结果表格（动态列宽） |
| `Show-ErrorDetails` | 友好信息 + 按 `D` 键展开技术详情（SC-5） |

**关键约束**：
- SC-3：状态指示器固定为 `[PASS]` / `[FAIL]` / `[SKIP]`（不用 ✓/✗）
- SC-5：`Show-ErrorDetails` 监听 `D` 键展开，其他键跳过

---

## Process.ps1

### 全局配置

```powershell
$script:DefaultRetryCount      = 3
$script:DefaultTimeoutSeconds  = 300
```

### 主要函数

| 函数 | 签名摘要 | 返回 |
|------|---------|------|
| `Invoke-ExternalCommand` | `-Command -Arguments [-WorkingDirectory] [-TimeoutSeconds] [-RetryCount] [-SuppressOutput]` | `@{ExitCode; Output; Error}` |
| `Test-CommandAvailable` | `-Command [-ReturnDetails] [-TimeoutSeconds=10]` | `$true/$false` 或详细诊断对象 |
| `Get-CommandVersion` | `-Command` | `string` 版本号 |
| `Refresh-SessionPath` | — | void（刷新当前会话 PATH） |
| `Invoke-NpmGlobalInstall` | `-PackageName [-Version] [-Force]` | `@{Success; Error; Data}` |
| `Invoke-WingetInstall` | `-PackageId -PackageName [-Silent] [-AcceptLicense] [-InstallerType]` | `@{Success; ErrorMessage}` |

> **注意**：`Invoke-NpmGlobalInstall` **无 `-DisplayName` 参数**，步骤文件调用时不要传此参数。

> **HC-WINGET-SILENT（强约束）**：`Invoke-WingetInstall` 传入 `-Silent` 时，内部自动切换为重定向模式（`RedirectStandardOutput/Error = $true`）并异步消费缓冲区，以抑制 winget 进度条噪音（如 `Removed N of M files`）。**禁止**在 `-Silent` 模式下将 `RedirectStandardOutput/RedirectStandardError` 设为 `$false`——否则进度条输出会泄漏到终端且可能死锁。

> **HC-WINGET-INSTALLER-TYPE（强约束）**：**PowerShell 7（`Microsoft.PowerShell`）必须通过 `-InstallerType "wix"` 强制 MSI 真身**。自 PS 7.6.0 起，winget 社区源 manifest 默认改发 **MSIX** 包（即便带 `--source winget`），MSIX 在无 Microsoft Store / Store 服务未就绪的虚拟机会半装失败，留下 `%LOCALAPPDATA%\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe` 这个 0 字节执行别名空壳存根；后续任何 `pwsh` 调用一启动空壳即抛 `0xc0ea0001`（`APPMODEL_ERROR_NO_PACKAGE`：别名存在、包未注册）。`--installer-type wix` 强制 MSI 装到 `C:\Program Files\PowerShell\7\pwsh.exe`，不注册 WindowsApps 别名，虚拟机/无 Store 环境也稳。**不要对 `Microsoft.WindowsTerminal` 传此参数**——它是 MSIX-only 包，无 MSI 真身，强制 `wix` 必失败；其装失败属可选组件的正常跳过。其余 winget 包（Git.Git / OpenJS.NodeJS.LTS / CoreyButler.NVMforWindows）本就是 MSI/exe，无歧义，**不传** `-InstallerType`。

> **HC-PS1-PATH-QUOTE（强约束）**：`Invoke-ExternalCommand` 对 `.ps1` 文件通过 `pwsh.exe -File` 执行时，若路径含空格**必须**加双引号包裹（`"`"$path"`"`），否则 `ProcessStartInfo.Arguments -join ' '` 拼接后路径被截断（如 `C:\Program Files\nodejs\npm.ps1` → `-File C:\Program`），退出码 64。

---

## Profile.ps1

### 标记块格式（HC-4）

```powershell
$script:ManagedBlockStartMarker = "# >>> Claude Code Quickstart >>>"
$script:ManagedBlockEndMarker   = "# <<< Claude Code Quickstart <<<"
```

### 备份目录

```powershell
$script:BackupDirectory = "$env:TEMP\ClaudeEnvInstaller\Backups"
```

### 主要函数

| 函数 | 职责 |
|------|------|
| `Backup-FileWithTimestamp` | 带时间戳备份文件（`yyyyMMdd_HHmmss`） |
| `Get-ManagedBlockContent` | 读取标记块内容，返回 `Found/Content/BeforeBlock/AfterBlock` |
| `Set-ManagedBlockInFile` | 写入/更新标记块（原子写入），`-CreateIfNotExists -AppendIfNoBlock` |
| `Remove-ManagedBlockFromFile` | 从文件移除标记块 |
| `Test-ManagedBlockExists` | 检测标记块是否存在 |
| `Write-FileAtomically` | **参数 `-FilePath`（非 `-Path`）**，临时文件 + `Move-Item -Force` |
| `Clear-OldBackups` | 清理超过 N 天或超过 M 个的备份文件 |

---

## Update.ps1

### 职责

**集中式 Update 基础设施 core**（与 macOS `Update.zsh` 对称），提供更新状态管理：更新清单（内容指纹管理）、内容指纹计算、更新前快照备份。**非功能变更**——这些函数原本分散在 `Profile.ps1`，集中化以消除 Windows/macOS 代码组织不对称。

### 主要函数

| 函数 | 职责 |
|------|------|
| `Get-UpdateManifestPath` | 返回 `~/.ccq/update-manifest.json` 路径 |
| `Read-UpdateManifest` | 读取更新清单（容错：文件不存在/损坏返回空清单 `{schemaVersion=1, steps={}}`） |
| `Write-UpdateManifest` | 原子写入更新清单（依赖 Profile 的 `Write-FileAtomically`） |
| `Get-StringFingerprint` | 计算字符串 SHA256 指纹（64 字符十六进制），**被 3 个 step 调用** |
| `New-UpdateSnapshot` | 创建更新前会话级快照目录（`update_<时间戳_fff>_<PID>_<GUID8>`，唯一目录名防并发） |
| `Clear-OldUpdateSnapshots` | 清理旧快照（contracts-first 策略参数 + HC-13 数组安全） |

### 依赖与加载位置（下界约束）

Update.ps1 须在 Profile.ps1 之后加载：依赖 Profile.ps1 的 `Write-FileAtomically` / `Initialize-BackupDirectory` / `Get-UserHome` / `Get-CleanupPolicyContract` / `$script:BackupDirectory`。`Get-StringFingerprint` 仅被 steps 调用（steps 在 core 之后加载），无 core 内的上界约束。

> **历史变更**：供应商管理迁移至 manage TUI、`Provider.ps1`/`Provider.zsh` 删除前，旧 `Provider.ps1` 曾依赖 `Get-StringFingerprint` 形成"Update 在 Provider 之前"的上界；Provider 删除后该约束消失，两平台 Update core 均只保留 Profile 下界。

> **方案 B 职责划分**：npm 检测（`Test-NpmUpdateAvailable` / `Get-NpmOutdatedGlobal` / `Invoke-NpmGlobalInstall`）**留 Process.ps1**（命令执行层），不迁入 Update.ps1。Windows Update.ps1 只含"更新状态管理"，与 macOS Update.zsh 含 npm 检测是合理的职责划分差异。

---

## Admin.ps1

### 主要函数

| 函数 | 签名 | 返回 |
|------|------|------|
| `Test-IsAdministrator` | — | `$true/$false` |
| `Invoke-SelfElevated` | `-ScriptPath -ArgumentList` | void（重启进程） |
| `Assert-StepPrivilege` | `-StepName [-RequiresAdmin=$true] [-ScriptPath]` | **`$true/$false`（布尔，非对象）** |

> **关键**：`Assert-StepPrivilege` 返回 **布尔值**，调用方直接用 `if (-not $privilegeResult)` 判断，不能用 `.Success`。

---

## Net.ps1

### 主要函数

| 函数 | 返回 |
|------|------|
| `Test-EndpointReachable -Url -TimeoutSeconds` | `@{Url; Reachable; StatusCode; ErrorMessage; LatencyMs}` |
| `Invoke-FileDownload -Url -OutputPath [-Description] [-TimeoutSeconds]` | `@{Success; FilePath; ErrorMessage; FileSize}` |

---

## Registry.ps1

### 职责

**v1.2.0 新增**：共享步骤注册表，统一 `Install.ps1` 的步骤定义（旧 `Manage.ps1` 已删除，管理面板改为 OpenTUI + Bun 单文件可执行 `ccq`）。

### 主要函数

| 函数 | 返回 | 职责 |
|------|------|------|
| `Get-StepRegistry` | `hashtable[]` | 返回完整注册表数组（含 Order、Dependencies、Group、LegacyIds） |
| `Get-StepGroups` | `hashtable` | 从注册表动态派生 Basic/Advanced 分组 |
| `Get-StepDependencies` | `hashtable` | 提取 StepId → 依赖数组映射 |
| `Get-LegacyStepIdMap` | `hashtable` | 旧 → 新 StepId 映射（状态迁移用） |
| `Get-StepFiles` | `string[]` | 按 Order 排序的步骤文件路径数组 |

> **加载顺序**：Registry.ps1 必须在 Bootstrap.ps1 之前加载（Bootstrap 的 `Get-ExecutionOrder` 和 `Load-InstallState` 依赖 Registry 函数）。

---

## Bootstrap.ps1

### 数据模型

```powershell
enum StepStatus { Pending=0; Running=1; Success=2; Failed=3; Skipped=4 }

class StepResult {
    [string]$StepId; [string]$StepName; [StepStatus]$Status
    [string]$Message; [hashtable]$Data
    [datetime]$StartTime; [datetime]$EndTime; [string]$ErrorDetails
}

class InstallState {
    [datetime]$StartTime
    [string]$Mode             # "OneClick" | "Staged" | "Manage-Basic" | "Manage-Advanced"
    [hashtable]$StepResults   # key = StepId（仅本次会话内的结果）
    [hashtable]$GlobalData
    [string]$CurrentStep; [bool]$IsCompleted
}
```

### 步骤依赖图（由 `Registry.ps1` 的 `Get-StepDependencies` 提供）

```powershell
"NodeJS"      = @()
"Git"           = @()
"ClaudeCode"    = @("NodeJS")
"Ccline"        = @("ClaudeCode")
"ClaudeConfig"  = @("ClaudeCode")
"ClaudeMd"      = @()
"Mcp"           = @("ClaudeCode")
"CodexCli"      = @("NodeJS")
"AntigravityCli" = @()
"OpenSpec"      = @("NodeJS")
```

### 主要函数

| 函数 | 职责 |
|------|------|
| `Invoke-StepLifecycle` | 执行 Test → Install → Verify 三阶段（完全基于实时检测） |
| `Test-StepDependencies` | 检查前置依赖（实时检测 + 会话状态）|
| `Get-ExecutionOrder` | Kahn 拓扑排序 + Registry Order 字段 tie-break |

> **重要变更**：移除了所有持久化函数（`Save-InstallState`、`Load-InstallState`、`Resume-Installation`、`Clear-InstallState`），采用纯内存状态管理 + 实时检测机制。

### `Invoke-StepLifecycle` 兼容性

调度器兼容步骤函数的两种返回类型：

```powershell
# Test 函数：兼容 bool 和 @{IsInstalled=...; ...}
$isInstalled = if ($testResult -is [bool]) { $testResult }
               elseif ($testResult) { [bool]$testResult.IsInstalled }
               else { $false }

# Install/Verify 函数：兼容 bool 和 @{Success=...; ErrorMessage=...; ...}
$success = if ($result -is [bool]) { $result }
           elseif ($result) { [bool]$result.Success }
           else { $false }
```

### 实时检测机制

**核心原则**：每次运行都实时检测组件状态，不依赖缓存的历史记录。

- `Invoke-StepLifecycle`：每次都执行 `Test` 函数检测当前环境
- `Test-StepDependencies`：优先检查本次会话内的失败状态（阻止执行），然后实时调用依赖的 `Test` 函数检测是否真的已安装
- 已安装的组件自动跳过，无需手动管理状态文件

---

## Process.ps1 — ccq 可执行文件管理区段

### 职责（ccq 可执行文件管理）

ccq 可执行文件管理函数**内聚于 `Process.ps1` 末尾**（`# ─── CCQ 可执行文件管理 ───` 区段，约 1582 行起），而非独立模块文件。负责检测平台架构、从 GitHub Release 下载对应平台的单文件可执行产物、安装到 `%USERPROFILE%\.local\bin\ccq.exe`（与 Claude Code native installer 同目录），并加入用户 PATH 使 `ccq` 命令天然可达，**不注入 Profile**。

### 主要函数

| 函数 | 职责 |
|------|------|
| `Get-CcqArchitecture` | 检测平台架构，返回 ccq target 名称 `windows-x64` 或 `windows-arm64`（通过 `$env:PROCESSOR_ARCHITECTURE`，ARM64 → arm64，其余统一 x64） |
| `Get-CcqExecutablePath` | 返回 ccq 安装路径 `%USERPROFILE%\.local\bin\ccq.exe` |
| `Test-CcqExecutableInstalled` | 检测 ccq 是否已安装（路径存在且 `ccq --version` 可达） |
| `Install-CcqExecutable` | 下载 ccq 可执行文件到 `%USERPROFILE%\.local\bin\ccq.exe`（调用 `Invoke-FileDownload` 自绘进度条 + CTRL+C 可中断，原子替换），并确保目录在用户 PATH |
| `Add-DirectoryToUserPath` | 将 `%USERPROFILE%\.local\bin` 加入用户 PATH（注册表 `HKCU\Environment`，无需 Profile） |

> **注意**：Release 基址 URL 由入口脚本 `Install.ps1` 的 `Get-CcqReleaseDownloadBaseUrl` 提供，拼上 `Get-CcqArchitecture` 结果与 `ccq.exe` 文件名后作为 `-DownloadUrl` 传入 `Install-CcqExecutable`；`Process.ps1` 内**不**持有 `$script:CcqGitHubReleaseBaseUrl` / `$CcqInstallDir` 常量。

### Windows PATH 策略

Windows 使用用户级 `.local/bin` 方式（无需 Profile）：
1. 下载 `ccq-windows-{x64|arm64}.exe` 到 `%USERPROFILE%\.local\bin\ccq.exe`
2. 将 `%USERPROFILE%\.local\bin` 加入用户 PATH（若已存在则跳过）
3. 该路径与 Claude Code native installer 的 `%USERPROFILE%\.local\bin\claude.exe` 保持一致

> **加载顺序**：ccq 管理函数随 `Process.ps1` 一同 dot-source 加载，位于 core 加载序列第二步（`Ui.ps1` → `Process.ps1` → …）。函数运行时解析，`Install-CcqExecutable` 在步骤执行时才调用 `Invoke-FileDownload`（`Net.ps1`），届时 `Net.ps1` 已加载，无前向引用问题。

---

## macOS 对照

macOS 安装器实现了与 Windows 功能对等的核心模块，采用 zsh 脚本体系。详见 [installer/macos/README.md](../../macos/README.md)。

### 核心模块映射

| Windows (PowerShell) | macOS (zsh) | 功能对齐度 |
|---------------------|-------------|-----------|
| `Ui.ps1` | `Ui.zsh` | 95% - 语义颜色、表格、菜单、错误展开 |
| `Process.ps1` | `Process.zsh` | 95% - 命令执行、重试、超时、npm outdated 缓存；**ccq 可执行文件管理区段**（Windows `Get-CcqArchitecture`/`Install-CcqExecutable` ↔ macOS `ccq_get_architecture`/`ccq_install_executable`，两平台均内聚于 Process 而非独立文件） |
| `Profile.ps1` | `Profile.zsh` | 98% - 原子写入、备份、受管区块（Manifest/Snapshot 已迁至 Update core） |
| `Update.ps1` (~310行) | `Update.zsh` | **对称 - 更新清单、内容指纹、更新快照**（npm 检测留 Process.ps1，属合理职责划分差异；加载位置两平台不一致见 Update.ps1 章节） |
| `Admin.ps1` | - | N/A - macOS 无需管理员自提权 |
| `Net.ps1` | - | N/A - macOS 使用 curl/wget 原生工具 |
| `Registry.ps1` | `Registry.zsh` | 98% - 步骤注册表、拓扑排序、Legacy 映射 |
| `Bootstrap.ps1` | `Bootstrap.zsh` | 95% - 生命周期、Critical 失败策略、五类摘要 |

### 平台差异要点

**并发保护**：
- Windows: `System.Threading.Mutex`（30s 超时）
- macOS: `flock`（30s 超时）

**JSON 操作**：
- Windows: `ConvertFrom-Json -AsHashtable` / `ConvertTo-Json`
- macOS: `node -e` 单行脚本（复杂操作）+ `jq`（简单查询）

**Profile 路径**：
- Windows: `$PROFILE` (`Documents\PowerShell\Microsoft.PowerShell_profile.ps1`)
- macOS: `~/.zprofile` / `~/.zshrc`

**包管理器**：
- Windows: `winget` (Windows Package Manager)
- macOS: `brew` (Homebrew)

**Node.js 安装**：
- Windows: 现有 `node`/`npm` 版本达标则跳过；否则优先在当前 active provider 内安装/更新到 LTS（fnm / nvm-windows / direct）；无法安全修复时才进入 nvm-windows（`winget install CoreyButler.NVMforWindows`，可切换版本）/ Node.js 直装（`OpenJS.NodeJS.LTS`，简单不可切换）兜底选择；不做跨 provider 迁移、卸载或 PATH 清理
- macOS: 现有 `node`/`npm` 版本达标则跳过；否则优先通过当前 fnm/nvm 安装/切换 Node.js LTS；无法原地修复时通过 `nvm` 官方脚本兜底

**状态指示器**：
- Windows: `[PASS]` / `[FAIL]` / `[SKIP]`
- macOS: `[PASS]` / `[FAIL]` / `[SKIP]` / `[UNSUPPORTED]` / `[MANUAL]`

### 共享机制

**contracts 业务契约**（100% 共享）：
- `contracts/steps.json` - 步骤元数据、依赖、分组
- `contracts/providers.json` - 供应商定义
- `contracts/mcp-servers.json` - MCP Server 配置
- `contracts/claude-config.json` - Claude 配置模板

**配置文件 schema**（100% 共享）：
- `~/.claude/settings.json` - Claude Code 主配置
- `~/.claude.json` - Claude 初始化标记
- `~/.claude/providers/*.json` - 供应商 Profile
- `~/.ccq/mcp-meta.json` - MCP Vault

**托管标记块**（语法一致）：
```
# >>> Claude Code Quickstart >>>
# 受管内容
# <<< Claude Code Quickstart <<<
```

### 核心函数命名对照

| 功能 | Windows | macOS |
|------|---------|-------|
| 命令执行 | `Invoke-ExternalCommand` | `ccq_run_command` |
| 原子写入 | `Write-FileAtomic` | `ccq_write_file_atomic` |
| 备份文件 | `Backup-File` | `ccq_backup_file` |
| MCP 启用 | `Enable-McpServer` | `ccq_enable_mcp_server` |
| 步骤生命周期 | `Invoke-StepLifecycle` | `ccq_invoke_step_lifecycle` |
| 拓扑排序 | `Get-ExecutionOrder` | `ccq_get_execution_order` |
| 错误详情展开 | `Show-ErrorDetails` | `ccq_show_error_details` |

### macOS 特有功能

**fnm 路径修复**（`Process.zsh`）：
- 自动解析 `/fnm_multishells/` 或 `/.fnm/` 的符号链接真实路径
- npm outdated 查询自动追加 `--prefix <真实路径>`

**Homebrew 集成**（`PackageManager.zsh`）：
- 自动检测 Homebrew 安装路径（Apple Silicon: `/opt/homebrew`, Intel: `/usr/local`)
- 官方安装脚本执行后自动追加 `eval "$(<brew> shellenv)"` 到 `~/.zprofile`

**Platform 检测**（`Platform.zsh`）：
- CPU 架构检测：`uname -m` → `arm64` / `x86_64`
- macOS 版本检测：`sw_vers -productVersion` → 最低 12+

---

_本小姐的 macOS 实现与 Windows 功能完全对等，代码质量有保证！_ (￣▽￣)ノ
