# Replace A Running ccq.exe And Detect Locks Before Download

## Goal

`Install-CcqExecutable` 用 `Move-Item -Force` 覆盖正在运行的 `ccq.exe` 时抛
`ERROR_ALREADY_EXISTS (183)`，表现为「当文件已存在时，无法创建该文件」。改用
`[System.IO.File]::Replace` + 重试退避 + 失败回滚，并在下载前做占用预检，
避免白下 104MB 才失败。

## Background

用户报告的实际失败输出：

```
文件大小: 104.26 MB
[========================================] 100% (104.26/104.26 MB) 3.37 MB/s
✓ 下载完成: 104.26 MB
ccq 可执行文件安装失败: 当文件已存在时，无法创建该文件。
```

失败点在 `installer/windows/core/Process.ps1:1723`：

```powershell
Move-Item -Path $tempPath -Destination $ccqPath -Force
```

### Verified Root Cause

现场存在运行中的 ccq 进程锁住目标映像（本机实测）：

```
Pid     : 52300
Path    : C:\Users\Administrator\.local\bin\ccq.exe
CmdLine : "...\ccq.exe" cc aether
Parent  : 42336 (pwsh.exe，存活)
```

目标文件独占打开测试结果为 `LOCKED`。

最小复现（PowerShell 5.1.19041.6456）：

| Scenario | Result |
|---|---|
| 目标空闲 | `Move-Item -Force` 成功 |
| 目标被 `FileShare.None` 独占打开 | 报 183「当文件已存在时，无法创建该文件」，源文件仍留原地 |
| 尝试重命名被锁目标 | 报「另一个程序正在使用此文件」 |

关键点：`-Force` 的语义是「目标存在 → 先删除 → 再移动」。运行中的 exe 删不掉，
于是底层 `MoveFile` 在目标仍存在时被调用，抛 183。**`-Force` 在此场景无效。**

### Existing Repository Solution

`tui/src/core/self-update.ts:910-938` 生成的 Windows helper 已经解决了同一问题：

- `[System.IO.File]::Replace(temp, target, backup, true)` 走 NTFS 事务性替换，
  而非删除+移动
- `Wait-Process -Id $ParentPid` 先等持有锁的进程退出
- 重试 `WINDOWS_HELPER_MAX_ATTEMPTS = 20` 次，间隔 `250ms`
- 失败时 `Restore-Target` 从 backup 回滚
- 「报错但目标已正确」的情况用 `Test-ExpectedFile` 二次确认后视为成功

安装链一项都没继承。这是实现不一致，不是设计取舍。

### Capability Gap Matrix

| Capability | self-update.ts | Installer |
|---|---|---|
| `File::Replace` 替换锁定文件 | 有 | 无（`Move-Item -Force`） |
| 重试退避 | 20 × 250ms | 无 |
| 失败回滚 | `Restore-Target` | 无（删 temp 了事） |
| 占用预检 | 等父进程退出 | 无（下完 104MB 才炸） |

## Requirements

- 用 `[System.IO.File]::Replace(temp, target, backup, ignoreMetadataErrors)`
  替换 `Move-Item -Force`；目标不存在时走 `File::Move`。
- 替换失败后重试，间隔退避。复用 `self-update.ts` 已验证的量级
  （20 次 × 250ms），不要另发明参数。
- 每次失败后先用「目标是否已是期望产物」二次确认，避免把已成功的替换误判为失败。
- 替换失败且无法恢复时，从 backup 回滚原有 `ccq.exe`，绝不让用户失去可用的旧版本。
- **下载前**做占用预检：尝试独占打开目标路径，被锁则立即中止并提示用户，
  不进入 104MB 下载。
- 捕获 Win32 183 及同类占用错误时，输出可操作提示（说明 ccq 正在运行、
  需要关闭哪些进程），而不是透传「当文件已存在时，无法创建该文件」。
- 预检提示应尽可能列出持有锁的进程（PID + 命令行），帮助用户定位。

## Constraints

- PowerShell 5.1 兼容。`[System.IO.File]::Replace` 在 .NET Framework 可用，
  但要求 temp 与 target 同卷 — 现有 `$tempPath = "$ccqPath.download.$PID"`
  已满足同目录，改动时必须保持。
- 不得因预检产生误判而阻断正常安装：预检只在确认被锁时中止，探测异常应放行
  并交给后续替换逻辑与重试兜底。
- macOS 侧不存在运行中映像锁问题（POSIX 允许替换正在执行的文件），本任务
  只改 Windows 链；但错误信息改善可一并考虑。
- 与子任务 `07-30-installer-gzip-transport` 同改 `Install-CcqExecutable`，
  建议本任务先落地。

## Acceptance Criteria

- [x] 目标 `ccq.exe` 被运行中进程锁住时，安装脚本在下载前就给出可操作提示并中止
- [x] 锁在重试窗口内释放时，替换能成功完成而无需用户重跑
- [x] 替换彻底失败时，原有 `ccq.exe` 仍可用（或保留唯一恢复 backup），且不留残留 temp
- [x] 目标空闲时的正常安装路径不受影响
- [x] 用户可见错误信息不再出现「当文件已存在时，无法创建该文件」这类无信息量文案
- [x] `pwsh -File installer/contracts/Test-Contracts.ps1` 通过
- [x] 新增契约测试覆盖「目标被锁 → 预检中止」与「替换重试成功」两条路径

## Notes

- 顺带发现 `~/.local/bin/.ccq.exe.update-4640-9d17b34caee2.tmp`（2.5MB，
  正常应为 104MB）是此前某次 TUI 自更新中断的残留。命名前缀属于
  `self-update.ts` 的 `uniqueWindowsHelperPath` 体系，与本次报错无因果关系，
  但说明自更新也曾中断过一次。可考虑在 `installer/contracts/cleanup-policy.json`
  里纳入这类残留清理，若超出本任务范围则单独立项。
- 修复后应考虑把「Windows 替换运行中可执行文件」的做法写进
  `.trellis/spec/project/installer/`，避免第三处实现再踩一次。
