# Installer Locked-File Replacement Implementation Plan

## Preconditions

- [x] 读 spec：`.trellis/spec/project/installer/windows-core.md`、`platform-runtime.md`
- [x] 读参照实现：`tui/src/core/self-update.ts:880-950`
- [x] 读现状：`installer/windows/core/Process.ps1:1675-1754`、`Net.ps1:76+`
- [x] 读契约：`installer/contracts/Test-Contracts.ps1:543+`

## Implementation Steps

### 1. Add `Test-CcqExecutableLocked` In Process.ps1

在 `Get-CcqExecutablePath` 附近新增。签名：

```powershell
function Test-CcqExecutableLocked {
    param([string]$Path)
    # 返回 @{ Locked=$true; Processes=@(...); Detail="" } 或 @{ Locked=$false; Detail="" }
}
```

- `$path` 不存在 → `Locked=$false`（不是占用问题，交给后续逻辑）。
- `[IO.File]::Open($path, Open, ReadWrite, None)` 成功 → 关闭，`Locked=$false`。
- 抛 IOException / UnauthorizedAccessException → `Locked=$true`，
  `Get-CimInstance Win32_Process -Filter "Name='ccq.exe'"` 列进程。
  每个 proc 取 `ProcessId` + `CommandLine`（可能为空，容错）。
- 任何其他异常 → `Locked=$false`，`Detail` 记异常名，放行交给重试。
- StrictMode：进程列表用 `@(...)` 包裹再 `.Count`。

### 2. Add `Replace-CcqExecutable` In Process.ps1

提取替换逻辑为独立函数，便于契约测试 mock。签名：

```powershell
function Replace-CcqExecutable {
    param([string]$TempPath, [string]$TargetPath)
    # 返回 @{ Success=$true/$false; ErrorMessage=""; BackupPath="" }
}
```

- `$backupPath = "$TargetPath.backup.$PID"`，同目录（满足 `File.Replace` 同卷）。
- 若同 PID 的 backup 已存在，在修改 target 前中止，只清理本次 temp，保留并报告
  旧 backup；不得把恢复凭据当普通残留删除。
- 目标不存在 → `[IO.File]::Move($TempPath, $TargetPath)`，成功即出。
- 目标存在 → 循环 1..20：
  - `[IO.File]::Replace($TempPath, $TargetPath, $backupPath, $true)`
  - 成功 → break。
  - 抛错 → temp 已被消费、target 存在且大小 == temp 大小 → 视为成功 break
    （二次确认，对齐 self-update.ts:922，并避免同尺寸重装假阳性）。
  - 否则 `Start-Sleep -Milliseconds 250`。
- 20 次都没成功 → 若 backup 存在且 target 缺失，先从 backup 恢复；回滚未确认
  成功时保留 backup 并报告路径。target 仍存在也不能据此证明 backup 可删除。
  清理 temp。返回 `Success=$false` + 可读错误。
- 成功路径：清理 backup，返回 `Success=$true`。

### 3. Rewrite `Install-CcqExecutable` In Process.ps1:1675-1754

保留外壳与 PATH 逻辑，替换中间：

```powershell
# [NEW] 占用预检
$lockState = Test-CcqExecutableLocked -Path $ccqPath
if ($lockState.Locked) {
    $procs = $lockState.Processes
    $msg = "ccq 正在运行，无法替换 ccq.exe"
    if ($procs) {
        $msg += "（进程: " + (($procs | ForEach-Object { "PID $($_.ProcessId)" }) -join ', ') + "）"
    }
    $msg += "。请先关闭所有 ccq 窗口（含 `ccq cc` 启动的会话）后重试。"
    $result.ErrorMessage = $msg
    Write-UiDanger "ccq 可执行文件安装失败: $msg"
    return $result
}
# 探测异常不阻断，Detail 静默或 Write-UiDim

# 现有下载 + 非空校验不变

# [REPLACED] 替换
$replaceResult = Replace-CcqExecutable -TempPath $tempPath -TargetPath $ccqPath
if (-not $replaceResult.Success) {
    $result.ErrorMessage = $replaceResult.ErrorMessage
    Write-UiDanger "ccq 可执行文件安装失败: $($result.ErrorMessage)"
    return $result
}
```

catch 块保留现有「清理 temp + 返回错误」行为。

### 4. Contract Tests (`Test-Contracts.ps1`)

新增 `Test-CcqLockedFileReplaceContract`：

- 读 `Process.ps1` 源码。
- 正向断言：`Install-CcqExecutable` 函数体含
  `[System.IO.File]::Replace`、`Test-CcqExecutableLocked`、
  `250`（重试间隔）、`20`（重试次数，可放宽为 `MAX_ATTEMPTS`）、
  `ccq 正在运行`（可读错误片段）。
- 反向断言：`Install-CcqExecutable` 函数体不含
  `Move-Item -Destination.*-Force`（确保旧替换被移除）。
- 行为探针：mock `Test-CcqExecutableLocked` 返回 Locked=$true，
  断言 `Invoke-FileDownload` 不被调用。

### 5. Verification Gates

```bash
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/windows/Install.ps1 -ListSteps
pwsh -File installer/build.ps1
git diff --check
```

## Review Gates

- [x] `File.Replace` 同卷约束保持（temp/backup 与 target 同目录）
- [x] 失败回滚保留旧 target 或唯一 backup（绝不让用户失去可恢复 ccq）
- [x] 预检只在确认锁定时阻断，探测异常放行
- [x] 无 PS7-only API
- [x] StrictMode 数组安全
- [x] 契约测试覆盖预检阻断 + 反向断言旧 Move-Item 已移除

## Completion Evidence

- [x] `pwsh -NoProfile -File installer/contracts/Test-Contracts.ps1`
- [x] Windows PowerShell 5.1 `Parser.ParseFile` 语法检查
- [x] `pwsh -File installer/windows/Install.ps1 -ListSteps`
- [x] Windows PowerShell 5.1 `Install.ps1 -ListSteps`
- [x] 真实独占锁、重试释放、替换、回滚和句柄复开探针
- [x] `git diff --check`（仅报告工作区 LF/CRLF 转换提示）

实现与检查已完成；归档前不再修改锁定替换合同。原生 `zsh` 检查属于并行的
`07-30-installer-gzip-transport` 子任务，不作为本任务的完成门禁。

## Rollback Points

- 代码：单 commit，`git revert` 即回。
- 契约：测试新增不破坏现有断言；失败可注释新增测试块。
