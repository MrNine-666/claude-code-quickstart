# installer/windows/core/ — Windows 核心基础库

> 面包屑：[根目录](../../../CLAUDE.md) › [installer/](../../CLAUDE.md) › windows/ › core/
> 生成时间：2026-03-06 (Install+Manage 分离架构)

所有核心模块通过 **dot-source** 加载（非 Module），无 `Export-ModuleMember`，函数在调用方作用域内直接可用。

---

## 模块一览

| 文件 | 行数 | 职责 |
|------|------|------|
| `Ui.ps1` | 893 | TUI 组件：语义颜色系统（6 色）、菜单、进度、摘要表格 |
| `Process.ps1` | 492 | 外部命令执行、PATH 刷新、版本检测、npm/winget 封装 |
| `Profile.ps1` | 526 | `$PROFILE` 安全编辑：备份、标记块读写、原子写入 |
| `Update.ps1` | ~310 | **更新状态管理**：更新清单、内容指纹、更新快照（与 macOS `Update.zsh` 对称的集中式 Update core，从 Profile.ps1 迁出） |
| `Admin.ps1` | 137 | 管理员权限检测与自提权 |
| `Net.ps1` | ~270 | 端点可达性检测、文件下载 |
| `Registry.ps1` | 280 | **共享步骤注册表**：元数据、分组、依赖、迁移映射（消除 DRY 违规） |
| `Bootstrap.ps1` | 617 | 步骤状态模型、生命周期调度、拓扑排序、恢复逻辑 |
| `ManageCore.ps1` | ~145 | **Manage JS 单文件 bundle 缓存调用 wrapper**：检测 Node.js → 源码/缓存/下载三级解析 manage.js → node 调用（TTY 继承） |
| `Provider.ps1` | ~810 | 供应商管理核心：CRUD + Sync + 交互菜单，Install-ApiKey 和 Manage 共用 |

---

## Ui.ps1

### 终端能力检测

初始化时自动检测（`Initialize-TerminalCapabilities`）：
- `$script:IsWindowsTerminal`：环境变量 `$env:WT_SESSION` 不为空
- `$script:SupportsAnsi`：PS 6+ 或 Windows Terminal 时为 `$true`

> 所有 UI 函数在 `SupportsAnsi = false` 时自动降级为纯文本 ASCII 模式。

### 语义颜色系统（6 色）

| 函数 | 语义角色 | 颜色（ANSI 模式） | 用途 |
|------|---------|-----------------|------|
| `Write-UiSuccess` | 成功 | 亮绿 `\e[92m` | 成功确认、完成提示 |
| `Write-UiPrimary` | 品牌/进行中 | Claude Orange `\e[38;2;217;119;87m` | 标题、横幅、活跃进度 |
| `Write-UiWarning` | 警告 | 亮黄 `\e[93m` | 警告、可恢复错误 |
| `Write-UiDanger` | 危险 | 亮红 `\e[91m` | 错误、失败 |
| `Write-UiInfo` | 信息 | 白色 `\e[97m` | 数据、路径、指令性文本 |
| `Write-UiDim` | 次要 | 灰色 `\e[90m` | 时间戳、提示、装饰分隔线 |

> **零逃逸约束**：`$script:AnsiColors` 和 `-ForegroundColor` **仅限** `Ui.ps1` 内部使用。外部文件通过 `Write-Ui*` 函数访问颜色。入口脚本在 Ui.ps1 加载前的早期错误处理块（PS 版本检查）例外。

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
| `Invoke-WingetInstall` | `-PackageId -PackageName [-Silent] [-AcceptLicense]` | `@{Success; ErrorMessage}` |

> **注意**：`Invoke-NpmGlobalInstall` **无 `-DisplayName` 参数**，步骤文件调用时不要传此参数。

> **HC-WINGET-SILENT（强约束）**：`Invoke-WingetInstall` 传入 `-Silent` 时，内部自动切换为重定向模式（`RedirectStandardOutput/Error = $true`）并异步消费缓冲区，以抑制 winget 进度条噪音（如 `Removed N of M files`）。**禁止**在 `-Silent` 模式下将 `RedirectStandardOutput/RedirectStandardError` 设为 `$false`——否则进度条输出会泄漏到终端且可能死锁。

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
| `Get-StringFingerprint` | 计算字符串 SHA256 指纹（64 字符十六进制），**被 Provider.ps1 + 3 个 step 调用** |
| `New-UpdateSnapshot` | 创建更新前会话级快照目录（`update_<时间戳_fff>_<PID>_<GUID8>`，唯一目录名防并发） |
| `Clear-OldUpdateSnapshots` | 清理旧快照（contracts-first 策略参数 + HC-13 数组安全） |

### 依赖与加载位置（双边界约束）

Update.ps1 必须在 `Profile → Update → … → Provider` 的唯一位置加载，由两个边界夹定：

- **下界**（Update 在 Profile 之后）：依赖 Profile.ps1 的 `Write-FileAtomically` / `Initialize-BackupDirectory` / `Get-UserHome` / `Get-CleanupPolicyContract` / `$script:BackupDirectory`
- **上界**（Update 在 Provider 之前）：`Provider.ps1:754` 依赖 `Get-StringFingerprint` 计算 pathHash

> **与 macOS 的合理差异**：macOS `Provider.zsh` 不依赖 fingerprint，故 macOS 把 `Update.zsh` 放在 CoreFiles **最末**（Provider 之后）；Windows 因 `Provider.ps1` 依赖 `Get-StringFingerprint`，必须放 Provider 之前。两平台加载位置不一致是**正确的**，源于 Provider 实现差异。

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

**v1.2.0 新增**：共享步骤注册表，消除 `Install.ps1` 与 `Manage.ps1` 之间的重复定义。

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
"ApiKey"        = @("ClaudeCode")
"Ccline"        = @("ClaudeCode")
"CcSwitch"      = @("ClaudeCode")
"ClaudeConfig"  = @("ClaudeCode")
"ClaudeMd"      = @()
"Mcp"           = @("ClaudeCode")
"CcgWorkflow"   = @("NodeJS")
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

## ManageCore.ps1

### 职责（P10：Manage JS 单文件 bundle 缓存 wrapper）

**轻量 Node.js wrapper**（~145 行），把 `manage.js` 单文件 bundle 解析到可执行路径并以 TTY 继承方式调用，作为 Manage 四大管理面板（Provider / Skills / Update / MCP）的统一入口。业务逻辑全在 `manage.js` bundle（esbuild 打包 4 子管理器）中实现，平台层仅负责「检测 Node.js → 解析 manage.js → node 调用」。原 `McpManager.ps1` 平台 wrapper 已于 P8 删除，MCP 管理并入 `manage.js` → `mcp-manager.js`。

### 三级解析策略（HC-CACHE-TMPDIR + HC-15）

1. **源码模式优先**（离线可用）：`$PSScriptRoot` 可解析时定位 `installer/contracts/scripts/manage.js` 直接运行（require 同目录子模块）
2. **缓存命中**（0 网络）：`$env:TEMP\.ccq\manage.js` 修改时间 <1 小时直接复用
3. **过期下载**（远端最新）：`Invoke-WebRequest /releases/latest/download/manage.js` 覆盖缓存；下载失败时降级复用旧缓存

> **HC-15**：`irm|iex` Release 模式下 `$PSScriptRoot` 为空，源码探测前判空，缓存路径仅依赖 `$env:TEMP`。

### 主要函数

| 函数 | 职责 |
|------|------|
| `Get-ManageCachePath` | 返回 `$env:TEMP\.ccq\manage.js` 固定缓存路径 |
| `Get-SourceManageScript` | 源码模式探测（`$PSScriptRoot` 上溯 contracts/scripts/manage.js），不可用返回 `$null` |
| `Resolve-ManageScript` | 三级解析（源码 → 缓存 TTL → 下载），返回 manage.js 路径或 `$null` |
| `Show-ManagePanel` | 对外入口：检测 Node.js（含 <20 版本警告）→ 解析 → `& node manage.js`（TTY 继承） |

### 配置常量

```powershell
$script:ManageBundleUrl    = '.../releases/latest/download/manage.js'  # HC-ZERO-CACHE：无版本号 / 无内容哈希
$script:ManageCacheTtlHours = 1                                        # 缓存有效期（小时）
```

> **加载顺序**：ManageCore.ps1 在 Bootstrap.ps1 之后、Provider.ps1 之前加载。依赖 Ui.ps1、Process.ps1 的函数。打包与缓存细节见 [installer/contracts/README.md](../../contracts/README.md) 的「Manage JS 单文件 bundle」小节。

---

## Provider.ps1

### 职责

**v2.0.0 新增**：供应商管理核心模块，提供完整 CRUD + 自动同步 + 交互菜单。被 `Install-ApiKey` 和 `Manage.ps1` 共用。

### 内置供应商模板

```powershell
$script:BuiltinProviders = @{
    zhipu    = @{ Name = "智谱 GLM"; BaseUrl = "https://open.bigmodel.cn/api/anthropic"; ModelEnv = @{...}; ExtraEnv = @{ API_TIMEOUT_MS = "3000000" } }
    minimax  = @{ Name = "MiniMax"; BaseUrl = "https://api.minimaxi.com/anthropic"; ModelEnv = @{...}; ExtraEnv = @{ ANTHROPIC_MODEL = "MiniMax-M3" } }
    moonshot = @{ Name = "Kimi Code"; BaseUrl = "https://api.kimi.com/coding/"; ModelEnv = @{...}; ExtraEnv = @{ ENABLE_TOOL_SEARCH = "false" } }
    deepseek = @{ Name = "DeepSeek"; BaseUrl = "https://api.deepseek.com/anthropic"; ModelEnv = @{...}; ExtraEnv = @{ CLAUDE_CODE_EFFORT_LEVEL = "max" } }
    bailian  = @{ Name = "阿里云百炼"; BaseUrl = "https://coding.dashscope.aliyuncs.com/apps/anthropic"; ModelEnv = @{...}; ExtraEnv = @{ ANTHROPIC_MODEL = "qwen3.7-plus" } }
    custom   = @{ Name = "自定义供应商"; BaseUrl = "" }
}
```

### 主要函数

| 函数 | 职责 |
|------|------|
| `Get-ProviderSettingsPath` | 返回 `~/.claude/settings.json` 路径（私有辅助） |
| `Get-ProviderProfilesDir` | 返回 `~/.claude/providers/` 目录路径 |
| `Read-SettingsJson` | 安全读取 settings.json 为 hashtable |
| `Write-SettingsJsonAtomic` | 原子写入 settings.json（temp + Move-Item） |
| `Get-ProviderManagedModelEnvFromLegacyAliases` | 兼容读取旧版别名映射字段并转换为模型 env 键 |
| `Get-ProviderManagedModelEnv` | 从 Profile 提取受管模型 env 键 |
| `Set-ProviderManagedModelEnv` | 写入 Profile 的 `modelEnv` 并清理旧字段 |
| `Get-ProviderManagedModelSummary` | 生成人类可读的模型配置摘要 |
| `Sync-ProviderFromSettings` | 从 settings.json 反向生成 Profile（迁移旧用户） |
| `Get-ProviderProfiles` | 扫描 `~/.claude/providers/*.json`，返回 Profile 数组 |
| `Get-ActiveProvider` | 识别当前活跃供应商（BaseUrl 匹配） |
| `Show-ProviderStatus` | 显示供应商状态表格（CJK-aware padding） |
| `Add-Provider` | 交互式添加供应商（`-Activate` 开关控制自动激活） |
| `Edit-Provider` | 修改已有供应商配置（API Key / Base URL / 名称 / 全部） |
| `Remove-Provider` | 删除供应商（活跃供应商安全阻止） |
| `Switch-Provider` | 切换活跃供应商（Profile → settings.json 合并） |
| `Show-ProviderManageMenu` | 供应商管理交互菜单（while 循环，Esc 返回） |

### 设计要点

- **安装复用**：`Add-Provider -Activate` 被 `Install-ApiKey` 直接调用，安装步骤不再自行实现供应商选择
- **自动同步**：`Sync-ProviderFromSettings` 在进入供应商管理菜单时自动执行
- **单一数据源**：`$script:BuiltinProviders` 是内置供应商的唯一定义
- **SecureString**：API Key 输入使用 `Read-Host -AsSecureString`，内存中用后即清
- **原子写入**：所有 Profile 和 settings.json 操作均为 temp + Move-Item

### 加载顺序

Provider.ps1 在 ManageCore.ps1 之后加载。依赖 Ui.ps1、Profile.ps1 的函数，**且依赖 Update.ps1 的 `Get-StringFingerprint`**（行 754 计算 pathHash）——这是 Update.ps1 必须在 Provider.ps1 之前加载的强约束（上界）。被 steps/ApiKey.ps1 dot-source 引用。

---

## macOS 对照

macOS 安装器实现了与 Windows 功能对等的核心模块，采用 zsh 脚本体系。详见 [installer/macos/README.md](../../macos/README.md)。

### 核心模块映射

| Windows (PowerShell) | macOS (zsh) | 功能对齐度 |
|---------------------|-------------|-----------|
| `Ui.ps1` | `Ui.zsh` | 95% - 语义颜色、表格、菜单、错误展开 |
| `Process.ps1` | `Process.zsh` | 95% - 命令执行、重试、超时、npm outdated 缓存 |
| `Profile.ps1` | `Profile.zsh` | 98% - 原子写入、备份、受管区块（Manifest/Snapshot 已迁至 Update core） |
| `Update.ps1` (~310行) | `Update.zsh` | **对称 - 更新清单、内容指纹、更新快照**（npm 检测留 Process.ps1，属合理职责划分差异；加载位置两平台不一致见 Update.ps1 章节） |
| `Admin.ps1` | - | N/A - macOS 无需管理员自提权 |
| `Net.ps1` | - | N/A - macOS 使用 curl/wget 原生工具 |
| `Registry.ps1` | `Registry.zsh` | 98% - 步骤注册表、拓扑排序、Legacy 映射 |
| `Bootstrap.ps1` | `Bootstrap.zsh` | 95% - 生命周期、Critical 失败策略、五类摘要 |
| `ManageCore.ps1` (~145行) | `ManageCore.zsh` (~130行) | **100% - Manage JS bundle 缓存 wrapper，三级解析（源码/缓存/下载）共享 `manage.js`** |
| `Provider.ps1` | `Provider.zsh` | 98% - CRUD、Sync、模型环境键管理 |

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
- Windows: `fnm` (Fast Node Manager)
- macOS: `nvm` 官方脚本

**状态指示器**：
- Windows: `[PASS]` / `[FAIL]` / `[SKIP]`
- macOS: `[PASS]` / `[FAIL]` / `[SKIP]` / `[UNSUPPORTED]` / `[MANUAL]`

### 共享机制

**contracts 业务契约**（100% 共享）：
- `installer/contracts/steps.json` - 步骤元数据、依赖、分组
- `installer/contracts/providers.json` - 供应商定义
- `installer/contracts/mcp-servers.json` - MCP Server 配置
- `installer/contracts/claude-config.json` - Claude 配置模板

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
| 供应商切换 | `Switch-Provider` | `ccq_switch_provider` |
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
