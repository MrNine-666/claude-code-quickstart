# Replace a Running ccq.exe and Preflight Lock Detection Design

## Design Boundary

只改 `installer/windows/core/Process.ps1` 中的 `Install-CcqExecutable`，
以及（为支持契约测试而新增的）两个辅助函数。macOS 链不动 — POSIX 允许
替换运行中的可执行文件，没有 183 问题。`Invoke-FileDownload` 不动（它只管
把字节流写到临时路径，替换是调用方的事）。

## Data Flow

```
Install-CcqExecutable(DownloadUrl)
  ├─ 1. Get-CcqExecutablePath → $ccqPath
  ├─ 2. [NEW] Test-CcqExecutableLocked $ccqPath
  │     尝试 [IO.File]::Open($ccqPath, Open, ReadWrite, None)
  │     被锁 → 列出持有进程，中止（不下载）
  │     探测异常 → 放行，交给重试兜底
  ├─ 3. Invoke-FileDownload → $tempPath（现有）
  ├─ 4. 校验非空（现有）
  ├─ 5. [REPLACED] Replace-CcqExecutable $tempPath $ccqPath
  │     目标不存在 → [IO.File]::Move
  │     目标存在 → [IO.File]::Replace(temp, target, backup, true)
  │       循环 20 × 250ms：成功即出；失败后 Test-ExpectedFile 二次确认
  │     全部失败 → Restore-Backup，throw
  └─ 6. Add-DirectoryToUserPath（现有）
```

## Key Decisions

### 1. Use `[System.IO.File]::Replace` Instead Of `Move-Item -Force`

`File.Replace(temp, target, backupPath, ignoreMetadataErrors=$true)` 是 NTFS
事务性替换。它不要求先删除目标，因此对「目标被运行中进程占用」的容忍度远
高于 `Move-Item -Force`（后者语义是「先删再移」，删不掉运行中的 exe 就抛
183）。

**同卷约束**：`File.Replace` 要求 temp 与 target 同卷。现有
`$tempPath = "$ccqPath.download.$PID"` 已经在同目录，天然满足。改动时必须
保持 temp 在 target 同目录下。backupPath 同样放同目录
（`$ccqPath.backup.$PID`），原因相同。

`self-update.ts:914` 用的就是这条路，参数一致，已验证。

### 2. Reuse The Retry Scale Verified By self-update.ts

`self-update.ts` 的 `WINDOWS_HELPER_MAX_ATTEMPTS = 20`、
`WINDOWS_HELPER_INTERVAL_MS = 250`。安装器直接复用这两个常量值。理由：同一
仓库、同一类问题、同一套已验证参数，不要给第三处实现留一个第三种参数。

### 3. Confirm The Target After An Apparent Error

`self-update.ts:922-926` 的关键防御：`File.Replace` 抛错不代表没成功。
抛错后用 `Test-Path` + 大小校验二次确认目标已是期望产物，是就是成功。
安装器照搬这一步。这避免了「替换实际成功但被误判失败 → 触发不必要的回滚
→ 把好文件删了」的灾难。

### 4. Failure Rollback With `Restore-Backup`

`File.Replace` 成功时 backup 就是旧 ccq.exe，target 是新 ccq.exe。若后续
校验发现 target 不对，从 backup 恢复。但 Win32 `ReplaceFile` 并非端到端
原子：`ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 (1177)` 可能已把旧 target 改名为
backup，却没有把 temp 落到 target。此时必须先恢复 backup；回滚未确认成功时
保留 backup 并在错误中报告路径，不能仅凭 target 存在就删除它。

同一长生命周期安装进程再次进入时会复用 `$ccqPath.backup.$PID`。若该路径已
存在，它属于上次失败留下的恢复凭据：新事务在修改 target 前中止，只清理本次
temp，并原样保留旧 backup。残留发现与自动清理由独立 cleanup-policy 任务负责。

核心不变量：**绝不让用户失去可用的 ccq.exe 或唯一恢复凭据**。spec `windows-core.md` 的
“ccq download fails or is empty -> Remove only the temporary file; preserve the existing
target” 要扩展为“替换失败也要保留现有 target”。

### 5. Run The Lock Preflight Before Download

`Test-CcqExecutableLocked` 在下载前跑。被锁 → 立即中止 + 列进程。这避免
用户白下 104MB（gzip 后 38MB，但仍是不必要的）。预检只在**确认**被锁时
中止；任何探测异常（文件不存在、权限拒绝等）都放行，交给重试兜底 — 预检
是优化路径，不是门禁，不能因为预检的误判阻断正常安装。

### 6. List Processes Holding The Lock

用 `Get-CimInstance Win32_Process` + 命令行匹配锁定目标。PS5.1 有
`Get-CimInstance`，可用。列 PID + 命令行帮助用户定位「是哪个 ccq 还开着」。
匹配策略：找 `Name = 'ccq.exe'` 的进程，其 CommandLine 含目标路径。
若拿不到 CommandLine（权限不足等），退化到「列出所有 ccq.exe 进程的 PID」。

## Contract Test Design

在 `installer/contracts/Test-Contracts.ps1` 新增
`Test-CcqLockedFileReplaceContract`：

| Assertion | Method |
|---|---|
| `Install-CcqExecutable` 源码含 `File]::Replace` | 正则探针 |
| 含重试常量 20 / 250ms | 正则探针 |
| 含占用预检函数 | 正则探针 `Test-CcqExecutableLocked` |
| 含「ccq 正在运行」类可读错误 | 正则探针片段 |
| `Move-Item -Destination.*-Force` 不再用于 ccq 落盘 | 反向断言：源码中 `Install-CcqExecutable` 函数体不含该模式 |

行为探针（mock 文件系统与进程）：用函数注入缝，验证「目标被锁 → 预检中止，
不调用下载」「重试窗口内释放 → 替换成功」两条路径。沿用现有
`Test-CcqVersionHandoffContract` 的 `Invoke-Expression $confirmFunction.Extent.Text`
+ mock 函数覆盖的手法。

## Rollback Shape

- 代码回滚：`git revert` 单个 commit，`Install-CcqExecutable` 回到
  `Move-Item -Force`。
- 运行时回滚：替换失败时 `Restore-Backup` 恢复旧 ccq.exe，用户立即可用。
- 契约不变：十 artifact 契约、`steps.json`、`build.json` 都不动。

## Compatibility

- PS5.1：`[System.IO.File]::Replace`、`[System.IO.File]::Open`、
  `[System.IO.FileShare]::None`、`Get-CimInstance` 全部在 .NET Framework
  / PS5.1 可用。无 PS7-only API。
- StrictMode：所有 `.Count` 读取前用 `@(...)` 包裹；函数返回数组用 `,@()`。
- `$PSScriptRoot` 为空的 Release 执行：`Install-CcqExecutable` 不依赖
  `$PSScriptRoot`，所有路径来自 `Get-CcqExecutablePath`（基于
  `$env:USERPROFILE`）。不受影响。
- macOS：本任务不改 macOS 链。
