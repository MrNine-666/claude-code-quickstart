# Windows Core Contract

## 1. Scope / Trigger

适用于 `installer/windows/core/**`、`installer/windows/Install.ps1`、Windows 单文件
构建，以及任何消费 PowerShell runtime helpers 的步骤。这些文件是 dot-sourced
脚本，不是 PowerShell modules。

## 2. Load And Ownership Contract

`installer/windows/Install.ps1` 必须严格按以下顺序加载 core 文件：

```text
Json.ps1 -> Ui.ps1 -> Process.ps1 -> Profile.ps1 -> Update.ps1
         -> Admin.ps1 -> Net.ps1 -> Registry.ps1 -> Bootstrap.ps1
```

`installer/contracts/build.json` 中声明了相同顺序。`Registry.ps1` 必须在
`Bootstrap.ps1` 之前加载，也必须在解析步骤文件之前加载；`Update.ps1` 必须跟在
`Profile.ps1` 之后，因为它调用 Profile backup 和 atomic-write helpers。Windows
source 与 release artifact 使用相同的 runtime 边界，但 release artifact 可能没有
可用的 `$PSScriptRoot`。

| Module | Owns |
|---|---|
| `Json.ps1` | 兼容 PS5.1 的 JSON-to-hashtable 转换 |
| `Ui.ps1` | 终端能力/主题检测、语义输出、菜单、进度和错误详情 |
| `Process.ps1` | 外部命令、重试/超时、npm/winget wrapper、PATH 刷新和 ccq 可执行文件管理 |
| `Profile.ps1` | 带标记的 Profile 编辑、备份和原子文件写入 |
| `Update.ps1` | 更新 manifest、内容指纹和更新快照 |
| `Admin.ps1` | 管理员检测、提权和步骤权限断言 |
| `Net.ps1` | endpoint probe 和可中断文件下载 |
| `Registry.ps1` | 共享步骤合同加载、inline fallback、分组、依赖和有序文件 |
| `Bootstrap.ps1` | 内存步骤状态、依赖排序和 Test -> Install/Update -> Verify 生命周期 |

## 3. Runtime Contracts

### PowerShell Compatibility And Arrays

- 所有 Windows installer 代码以 PowerShell 5.1+ 和
  `Set-StrictMode -Version Latest` 为目标。
- 不得使用仅 PS7 支持的语法或 API（`-AsHashtable`、`$PSStyle`、`?:`、`??`、
  `&&`、`||` 管道串联或并行 foreach）。使用 `Json.ps1` 中的转换 helper，不要使用
  `ConvertFrom-Json -AsHashtable`。
- 任何读取 `.Count` 的命令、函数或管道结果都必须先赋值为 `@(...)`。当展开会改变
  合同时，返回数组的函数使用 `return ,$array`。
- 以上两条规则对同一个值互斥。函数一旦通过 `return ,$array` 重塑结果，调用方不得
  再用 `@(...)` 包裹，否则空列表会嵌套为 `@(@())`，导致 `.Count` 读为 1，并渲染
  出伪元素，例如空的带括号进程列表。

### Process And Command Execution

`Invoke-ExternalCommand` 接受 `-Command`、`-Arguments`、`-WorkingDirectory`、
`-TimeoutSeconds`、`-RetryCount` 和 `-SuppressOutput`，并返回包含 `Success`、
`ExitCode`、`Output`、`Error`、`Command` 和 `ResolvedPath` 的结果。调用回退
PowerShell engine 时，含空格的 `.ps1` 路径必须加引号。`Invoke-NpmGlobalInstall`
只接受 `-PackageName`、`-Version` 和 `-Force`；调用方不得传入 `-DisplayName` 参数。

`Invoke-WingetInstall` 支持 `-Silent`、`-AcceptLicense`、`-Force` 和
`-InstallerType`。静默模式必须重定向并异步消费 stdout 和 stderr。只有在必须强制
使用 MSI 安装 Microsoft.PowerShell package 时才使用 `-InstallerType wix`；不得将其
传给仅支持 MSIX 的 Windows Terminal package。

### Profile, Update And Privilege Safety

Profile 编辑必须严格使用以下标记：

```text
# >>> Claude Code Quickstart >>>
# <<< Claude Code Quickstart <<<
```

备份位于 `%TEMP%\ClaudeEnvInstaller\Backups`。使用
`Write-FileAtomically -FilePath ... -Content ...`；不要引入 `-Path` alias 或直接
进行破坏性替换。共享标记块历史上同时包含 fnm 初始化和过时的 `ccq` Profile
函数，因此 legacy cleanup 不得仅根据标记删除整个块。它只能删除同时匹配两个
历史 Release URL 的 AST 解析 `ccq` 函数；其他行必须原样保留，解析/身份不确定时
必须零写入跳过。`Update.ps1` 依赖 Profile，并提供
`Read-UpdateManifest`, `Write-UpdateManifest`,
`Get-StringFingerprint`、`New-UpdateSnapshot` 和 `Clear-OldUpdateSnapshots`。
该 manifest 是用户 runtime 状态，不是 installer step 状态。

`Assert-StepPrivilege` 返回 Boolean，而不是对象。`Invoke-SelfElevated` 必须拒绝空脚本
路径，因为通过管道执行的 release artifact 不能用 `-File` 重新启动。

### Registry, Bootstrap And Release Paths

`Registry.ps1` 在 source mode 读取 `installer/contracts/steps.json`，合同不可用时使用
匹配的 inline fallback。`Get-StepFiles` 返回有序相对路径，并将声明的子模块放在
主步骤之前。`Bootstrap.ps1` 仅在内存中保存 `StepResult`/`InstallState`；每次运行
重新测试环境，绝不从持久化安装状态文件恢复。

当 `$PSScriptRoot` 为空时，绝不能将空值传给 `Join-Path`、`Test-Path`、`Get-Content`
或 dot-sourcing。使用 artifact 的 inline 或 environment fallback，或带明确诊断地
安全跳过。

### ccq Executable Handoff

`Get-CcqArchitecture` 将 Windows ARM64 映射为 `windows-arm64`，其他受支持架构映射
为 `windows-x64`。`Install-CcqExecutable` 检查目标锁定状态，下载到临时文件，确认
非空，通过 `Replace-CcqExecutable` 替换 `%USERPROFILE%\.local\bin\ccq.exe`，并调用
`Add-DirectoryToUserPath`。
PATH 更新属于用户级别（`HKCU\Environment`），不得注入 Profile wrapper。
`Add-DirectoryToUserPath` 必须用 `DoNotExpandEnvironmentNames` 读取原始 registry 值，
追加时不得展开既有条目，并使用原始 `RegistryValueKind` 写回；不得通过
`Environment.GetEnvironmentVariable` / `Environment.SetEnvironmentVariable` 往返改写
完整用户 PATH。下载失败必须保留已有 ccq 可执行文件。
`ConvertTo-CcqComparableVersion` 移除 `ccq ` 命令前缀和开头的 Release-tag `v`。
`Get-CcqReleaseTargetVersion` 只接受可比较的 `v*` Release tag。
`Confirm-CcqExecutableDownload` 跳过相同版本，为不同版本显示默认保留的覆盖菜单，
目标版本不可用时保留已有可执行文件。

### Gzip-First Transport And Raw Handoff

`Install-CcqExecutable -DownloadUrl <raw-url>` 负责可选的传输优化。它推导
`$DownloadUrl + '.gz'`，对 gzip 临时文件调用一次现有 `Invoke-FileDownload`；gzip
不可用或无效时，再用第二次调用回退到原始 raw URL。downloader 合同不变；每次调用
读取自己的响应长度，因此会重新开始进度。

解压 seam 为：

```powershell
Expand-CcqGzipFile -GzipPath <gzip-temp> -OutputPath <raw-temp>
# -> @{ Success = $true/$false; ErrorMessage = '...'; OutputSize = [long]... }
```

它使用兼容 PowerShell 5.1 的 `System.IO.Compression.GzipStream`，读取到 EOF 以暴露
CRC/trailer 错误，并用 `FileMode.CreateNew` 创建输出。输入、gzip 和输出流在
`finally` 中独立释放；释放失败不得阻止后续句柄释放。失败或空输出只删除 raw
残片并返回第一个有用错误。

两个传输临时文件都限定在目标目录和 PID 内：
`<ccq.exe>.download.<PID>` 用于 raw，追加 `.gz` 的同一路径用于 gzip。
gzip 失败会删除两者，打印 raw 回退警告，且绝不触碰目标。若 raw 也失败，raw 错误
为主错误并附带 gzip 上下文。任一来源成功后，仅将完整非空的 raw 临时文件传给
`Replace-CcqExecutable`；gzip 字节不得进入替换路径。

### ccq Executable Replacement

目标通常是运行中的映像，因为 `ccq cc` 会话会保持 `ccq.exe` 映射。因此替换是由
`Replace-CcqExecutable` 负责的独立合同；`Install-CcqExecutable` 委托给它，不得自行
落地下载文件。

- 目标存在时使用 `[System.IO.File]::Replace(temp, target, backup, $true)`，仅在目标
  不存在时使用 `[System.IO.File]::Move`。这里禁止 `Move-Item -Force`：它的语义是
  先删除再移动，删除运行中的映像会失败，底层 `MoveFile` 随后看到目标仍存在并
  抛出 Win32 `ERROR_ALREADY_EXISTS` (183)。
- `File::Replace` 的 backup 参数必须传 `[NullString]::Value`，绝不能传 `$null`。
  PS5.1 会以导致无效路径错误的方式将 `$null` 编组到 `String` 参数，使回滚代码
  静默失效。
- `temp`、`backup` 和 `target` 必须位于目标自己的目录中，因为 `File::Replace`
  要求同一 volume。使用 `$target.download.$PID` 和 `$target.backup.$PID`。
- 已存在的 `$target.backup.$PID` 是恢复 artifact，不是可丢弃的 residue。同一个
  长生命周期 installer 进程的重试会复用 PID 和路径；新替换必须在触碰目标前失败，
  仅删除新的 `temp`，逐字节保留已有 backup 并报告其路径。residue 发现/清理属于
  独立生命周期。
- 以 250 ms 间隔重试替换 20 次，复用 `tui/src/core/self-update.ts` 和
  `windows-deferred-operation.ts` 已验证的间隔。不得发明新的重试值。
- 抛出异常并不能证明失败，因此重试前必须重新确认。installer 没有像
  `self-update.ts` 那样可比较的预期 SHA256，因此仅检查大小不够：对锁定目标重新
  安装同样大小的构建会把失败报告为成功。必须使用零成本判别：成功替换总会消费
  `temp`，锁定失败会留下 `temp`。
- `File::Replace` 从头到尾并非原子操作。在 `ERROR_UNABLE_TO_MOVE_REPLACEMENT_2`
  (1177) 下，旧目标已重命名为 `backup`，而 `temp` 仍保留原名，因此目标不存在。
  所以失败路径绝不能无条件删除 `backup`：它是用户唯一的旧版本副本。先检查目标
  是否存在；目标缺失时将 `backup` 回滚，只有确认目标存在后才能删除 `backup`。
  回滚未完成时保留 `backup`，并在错误消息中写出其路径。
- 高于原子性的约束是：用户绝不能最终失去可用的 `ccq.exe`。为满足这一点，回滚
  helper 可以从 `File::Replace` 降级为复制。
- 下载前锁定 probe（使用 `FileShare.None` 的 `[System.IO.File]::Open`）只是避免
  在传输完成后才发现无法替换的优化，不是硬门禁。只有 `IOException` 和
  `UnauthorizedAccessException` 表示已锁定；其他异常都继续进入替换重试。probe
  本身绝不能抛出或阻塞正常安装。probe stream 的 `Close` 与 `Dispose` 必须独立
  尝试；任一关闭异常不得阻止另一个释放动作，也不得留下安装器自己的占用句柄。
- `Get-CcqLockHolderProcesses` 使用 `return ,$array` 重塑结果，因此调用方直接读取
  `.Count`；参见上面的数组规则。

### ccq Replacement Backup Cleanup

`Replace-CcqExecutable` 只能在新 target 存在且尺寸等于本次 temp 的已知尺寸后调用：

```powershell
Clear-CcqReplacementBackupsAfterVerifiedReplace `
  -TargetPath <absolute ccq.exe> `
  -CurrentBackupPath <absolute current backup> `
  -ExpectedTargetSize <positive Int64> `
  -MaxAttempts 20 `
  -IntervalMs 250
# -> @{ RemovedPaths = @(...); RetainedPaths = @(...); WarningMessage = '...' }
```

helper 在删除前再次验证 target 存在且尺寸一致。当前事务 backup 使用 `20 x 250 ms`
有界重试，因为来源 PID 就是仍在运行的 installer；历史项只扫描 target 直接同级、
精确匹配 `<target-name>.backup.<digits>` 的普通非 reparse 文件，并且只在
`Get-Process -Id <PID>` 以 `NoProcessFoundForGivenId` 明确证明 PID 不存在时删除。
PID 活动或复用、解析溢出、进程/目录探测异常、目录/reparse point、删除失败及 target
复验失败全部 fail closed：保留 artifact。

清理是已验证 replacement 的非致命后置动作。保留项不得把 `Success` 降级为 false，
但必须通过一条 warning 报告绝对路径；扫描失败时报告绝对目录。失败/回滚路径及
同 PID collision 仍保留恢复 backup，绝不能调用此清理。此生命周期由
`Process.ps1` 所有，不得扩展 `cleanup-policy.json` 的 Profile snapshot 范围，也不处理
TUI `.ccq.exe.update-*.tmp` 或 macOS artifact。

## 4. Validation And Error Matrix

| Condition | Required result |
|---|---|
| PS5.1 或 StrictMode 违规 | Release 前拒绝，并增加针对性的兼容性检查 |
| `$PSScriptRoot` 不可用 | 使用 inline/env 回退或明确安全跳过；绝不调用空路径 |
| 静默 winget 执行 | 异步排空捕获输出；不得进度条泄漏或死锁 |
| Profile 写入失败 | 保留原文件并报告技术细节 |
| ccq 下载失败或为空 | 只删除临时文件；保留已有目标 |
| gzip 下载/解压失败 | 删除 gzip/raw 临时文件，警告并重试原始 raw URL |
| gzip 成功但解压为空 | 将 gzip 视为失败；不得替换目标 |
| gzip 和 raw 都失败 | 先返回 raw 失败并附带 gzip 上下文；保留目标和所有恢复 artifact |
| 目标 ccq.exe 是运行中的映像 | 通过 `File::Replace` 替换；绝不先删后移 |
| 下载前锁定 probe 报告已锁定 | 以持有者 PID 和关闭会话提示提前失败；不得下载 |
| 锁定 probe 抛出意外异常 | 按未锁定继续；probe 不得阻塞安装 |
| 替换抛异常但 `temp` 已消失且目标大小匹配 | 视为成功；不得重试或回滚 |
| 替换抛异常且 `temp` 仍存在 | 在 20 x 250 ms 窗口内重试 |
| 重试耗尽且目标仍存在 | 删除 `temp`；保留失败事务生成的 backup 并报告其路径 |
| 重试耗尽且目标缺失 | 将 `backup` 回滚到目标；回滚失败时保留并报告路径 |
| 替换前已存在同 PID backup | 在修改目标前停止；只删除新的 `temp`，保留恢复 backup 并报告路径 |
| 替换后验证失败 | 从 `backup` 回滚；除非确认回滚成功，否则保留 `backup` |
| 已验证替换后的当前 backup 短时占用 | 在 20 x 250 ms 窗口内重试；释放后删除，target 保持新版本 |
| 已验证替换后的当前 backup 持续占用 | replacement 仍成功；保留 backup，并以 warning 报告绝对路径 |
| 精确历史 backup 的来源 PID 明确不存在 | 删除该普通文件；不得触碰 target |
| 历史 backup 的 PID 活动/复用或身份、类型、探测不确定 | 保留候选；不得用年龄或通配符推断可删除 |
| cleanup 前 target 复验失败 | 不删除任何当前或历史 backup；warning 报告绝对 target 路径 |
| ccq 已安装版本等于目标 | 报告当前版本；不提示、不下载 |
| ccq 已安装版本不同 | 显示两个版本；菜单默认选择保留当前版本 |
| 目标 Release tag 不可用 | 保留当前可执行文件；不得猜测 `latest` 不同 |
| 用户 PATH 为带 `%NVM_HOME%` / `%NVM_SYMLINK%` 的 `REG_EXPAND_SZ` | 保留 raw token 和 registry 类型，追加 ccq 目录 |
| Profile 标记块含 fnm 或未知用户内容 | 仅删除明确识别的历史 `ccq` 函数；否则不写入 |
| 非管理员管道执行 | 不尝试 `-File` 重启；提示用户提权后重试 |

## 5. Good / Base / Bad Cases

- 正确：source mode 从磁盘解析合同，release mode 通过 inline fallback 使用相同
  registry 数据。
- 正确：版本不匹配后选择覆盖时，仍先下载到临时路径，再替换已有可执行文件。
- 正确：有效 gzip fixture 完整解压到同目录 raw 临时文件，然后由已有
  `Replace-CcqExecutable` 消费。
- 正确：新 target 验证成功后删除已退出 PID 的精确历史 backup，并保留活动 PID
  或任何探测不确定的候选。
- 基线：`Git` 已存在，生命周期报告跳过，不修改持久化状态文件。
- 错误：从可能为 null 的 PowerShell 管道结果读取 `.Count`。
- 错误：将 `ccq` 函数写入 `$PROFILE` 以提供命令。
- 错误：新下载未验证就覆盖已有 ccq 二进制。
- 错误：让部分 gzip/raw 临时文件进入 `Replace-CcqExecutable`，或两次传输共享
  临时文件/进度总量。
- 错误：比较 Release tag 前因已安装状态直接返回。
- 错误：用 `Move-Item -Force` 落地下载的 ccq，并把原始 `ERROR_ALREADY_EXISTS`
  文本直接展示给用户。
- 错误：未先确认目标存在就于失败路径删除 `backup`。
- 错误：用 `*.backup.*` 通配符、文件年龄或一次失败的 PID 查询决定删除历史 backup。

## 6. Tests Required

- 运行 `pwsh -File installer/contracts/Test-Contracts.ps1`。
- 在 source mode 运行 `pwsh -File installer/windows/Install.ps1 -ListSteps`，并在
  release mode 执行构建后的 ASCII trampoline。
- 覆盖 StrictMode 数组处理、空路径 release guard、静默 winget 输出处理、原子
  Profile 写入和 ccq 临时文件替换。
- `installer/contracts/Test-Contracts.ps1` 在真实 Windows 交接函数中验证相同版本、
  保留和覆盖决策。
- 通过模拟 registry 边界验证 `Add-DirectoryToUserPath`；断言 raw nvm token 和
  `REG_EXPAND_SZ` 保留，已有条目不会写 registry。
- 验证 Profile legacy cleanup 的 marked fnm、unmarked fnm、fnm-only、仅旧函数和
  malformed block；fnm 保持行级不变，不确定 block 不写入。
- `Test-CcqLockedFileReplaceContract` 探测真实 `FileShare.None` 独占锁：重试窗口内
  释放锁后成功且不留下 `temp`/`backup`；持锁失败但保留旧目标且无 residue；
  `Restore-CcqExecutableBackup` 回滚到已验证的旧目标；同 PID backup 冲突时逐字节
  保留恢复 artifact 且目标不变。还要断言 probe 报告锁定后不会下载，并通过 probe
  返回后再次独占打开目标，证明其 stream 句柄已完整释放。
- 同一合同还必须覆盖 replacement 成功后的 backup cleanup：当前 backup 短时锁释放后
  删除，持续锁时保持 success 并以绝对路径告警；dead-PID 历史项删除；active PID、
  malformed/overflow PID、非普通文件、进程查询异常、目录枚举异常和 target 尺寸变化
  全部保留。故障注入的函数/cmdlet wrapper 必须在 `finally` 中拆除。
- 合同测试中的每个反向断言都必须针对实际删除的旧代码做 mutation-check：粘回旧文本
  并确认断言触发，再恢复并确认 PASS。静默匹配不到任何内容的反向断言属于死代码。
  `Install-CcqExecutable` 中的 `\bMove-Item` 边界是已验证示例：`-match` 不区分大小写，
  因而裸 `Move-Item` 也会匹配 `Remove-Item`。
- `Test-CcqGzipTransportContract` 必须生成 raw/gzip fixture，断言往返字节完全一致，
  拒绝 CRC/空输出，验证 gzip-before-raw URL 顺序、全新临时路径、清理、回退警告和
  raw-primary 双失败错误。exclusive-open probe 证明解压器释放了所有 PowerShell
  5.1 流句柄。
- 修改 PowerShell 或生成 artifact 输入后运行 `git diff --check`。

## 7. Wrong Vs Correct

```powershell
# Wrong: release mode can leave an empty path and StrictMode will throw.
$root = $PSScriptRoot
Test-Path (Join-Path $root 'installer/contracts')

# Correct: guard the path and use the release fallback when it is unavailable.
$root = if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { '' } else { $PSScriptRoot }
if ($root) {
    Test-Path (Join-Path $root 'installer/contracts')
} else {
    # Use inline contract data or a safe, explicit skip.
}
```

```powershell
# Wrong: existence alone suppresses an available update.
if ($installed.IsInstalled) { return }

# Correct: normalize both facts, then require explicit overwrite on mismatch.
if ($currentVersion -eq $targetVersion) { return }
$choice = Show-SingleSelectMenu -Options @('覆盖', '保留') -DefaultIndex 1
```

```powershell
# Wrong: "delete target, then move" cannot replace a running image. Deleting a
# running exe fails, so MoveFile is called with the target still present and
# throws Win32 ERROR_ALREADY_EXISTS(183), surfaced as
# 「当文件已存在时，无法创建该文件」.
Move-Item -Path $tempPath -Destination $ccqPath -Force

# Correct: NTFS transactional replace does not require deleting the target.
[System.IO.File]::Replace($tempPath, $ccqPath, $backupPath, $true)
```

```powershell
# Wrong: PS5.1 marshals $null into the String parameter and throws
# 「路径的格式不合法」, so the rollback path is dead code.
[System.IO.File]::Replace($BackupPath, $TargetPath, $null, $true)

# Correct: [NullString]::Value reaches .NET as a real null, i.e. "keep no backup".
[System.IO.File]::Replace($BackupPath, $TargetPath, [NullString]::Value, $true)
```

```powershell
# Wrong: the backup is the user's only old build; deleting it unconditionally on
# failure is data loss whenever ERROR_UNABLE_TO_MOVE_REPLACEMENT_2(1177) left
# the target missing.
if (Test-Path $backupPath) { Remove-Item $backupPath -Force }

# Correct: restore first when the target is gone. A target that merely exists
# after a failed ReplaceFile call does not prove the old build is safe; clean a
# remaining backup only after this recovery attempt is confirmed successful.
$restoreAttempted = $false
$restored = $false
if ((Test-Path $backupPath) -and -not (Test-Path $TargetPath)) {
    $restoreAttempted = $true
    $restored = Restore-CcqExecutableBackup -BackupPath $backupPath -TargetPath $TargetPath
}
if ($restoreAttempted -and $restored -and (Test-Path $backupPath)) {
    Remove-Item $backupPath -Force -ErrorAction SilentlyContinue
}
```

```powershell
# Wrong: same-size reinstall of a locked target makes a failure look successful.
if ((Get-Item $TargetPath).Length -eq $tempSize) { $replaced = $true }

# Correct: a successful replace always consumes temp; a locked failure leaves it.
if (-not (Test-Path $TempPath) -and (Test-Path $TargetPath) -and
    (Get-Item $TargetPath).Length -eq $tempSize) { $replaced = $true }
```

```powershell
# Wrong: 通配扫描和忽略 PID 状态会删除活动事务或唯一恢复副本。
Get-ChildItem "$TargetPath.backup.*" | Remove-Item -Force

# Correct: 先复验新 target，再由 helper 对当前 backup 有界重试；历史项仅在
# 精确命名、普通文件且 PID 明确不存在时删除，其余一律保留并告警。
$cleanup = Clear-CcqReplacementBackupsAfterVerifiedReplace `
    -TargetPath $TargetPath -CurrentBackupPath $backupPath `
    -ExpectedTargetSize $tempSize -MaxAttempts 20 -IntervalMs 250
if ($cleanup.WarningMessage) { Write-UiWarning $cleanup.WarningMessage }
```
