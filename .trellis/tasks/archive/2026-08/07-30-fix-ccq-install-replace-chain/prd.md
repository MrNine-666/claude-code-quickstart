# Fix the Windows ccq Installation and Replacement Chain

## Goal

修复安装器覆盖已有 `ccq.exe` 时的失败，并消除 `self-update.ts` 与
PowerShell/zsh 安装链之间的能力落差。父任务只持有源需求、子任务映射和
跨子任务验收，不承担直接实现。

## Source Problem (User Report)

用户在已装 ccq 2.4.1 的机器上运行安装脚本升级到 2.4.3，下载完 104.26 MB
后失败：

```
✓ 下载完成: 104.26 MB
ccq 可执行文件安装失败: 当文件已存在时，无法创建该文件。
```

## Empirical Root Cause

排查过程中在用户机器上实测确认（非推断）：

1. **目标文件被运行中进程锁住。** `~/.local/bin/ccq.exe` 被 PID 52300
   占用，该进程命令行为 `ccq.exe cc aether`，父进程 pwsh 42336 存活，
   已运行约 6 小时。独占写打开该文件返回 LOCKED。

2. **`Move-Item -Force` 无法替换被锁映像。** 最小复现（PowerShell
   5.1.19041.6456）：目标空闲时成功；目标被 `FileShare.None` 打开时报
   「当文件已存在时，无法创建该文件」（Win32 `ERROR_ALREADY_EXISTS`
   183），源文件仍留在原地。`-Force` 的实现是「先删除目标再移动」，
   运行中的 exe 删除失败，于是 `MoveFile` 在目标仍存在的前提下被调用。
   **`-Force` 在此场景下无效。**

3. **`ccq cc` 常驻是设计使然，但不符合语义预期。**
   `tui/src/cli/commands/cc.ts:11-16` 用 `Bun.spawn(..., stdio: inherit)`
   + `await proc.exited`，ccq 作为父进程在整个 claude 会话期间常驻并锁住
   自身映像。`cx.ts:9-12` 同构。**未发现 TUI 退出后进程残留**：
   `tui-exit.ts` + `onDestroy` 路径完整，`spawnDetachedPowerShell` 已针对
   Bun 1.3.14 job object 问题用 `cmd /c start /b` 规避。

4. **安装脚本未采用 Release 已有的 gzip 资产。**
   `installer/contracts/build.json` 含四个 `.gz`，`self-update.ts:311`
   已实现 gzip 优先 + raw 回退，但两个安装脚本只拼 raw 名
   （`Process.ps1:476`、`Install.zsh:575`），无任何 `.gz` 引用与解压逻辑。
   实测体积：raw 109,264,384 B vs gzip 40,174,995 B，**可省 63%**。

## Capability Gap Matrix

| Capability | `self-update.ts` | Installer |
|---|---|---|
| gzip 传输 + raw 回退 | 有 | 无 |
| `File::Replace` 替换锁定文件 | 有 | 无（`Move-Item -Force`） |
| 重试退避 | 20 次 × 250 ms | 无 |
| 失败回滚 | `Restore-Target` | 无（删 temp 了事） |
| 占用预检 | 等父进程退出 | 无（下完 104 MB 才失败） |

## Requirements

- 安装脚本优先使用 gzip 资产传输，raw 作为回退（子任务 1）
- 安装脚本能替换被运行中进程锁住的 `ccq.exe`，失败可回滚（子任务 2）
- 下载前做占用预检，失败信息对用户可读（子任务 2）
- `ccq cc`/`cx` 在 POSIX 上不残留父进程（子任务 3a）
- `ccq cc`/`cx` 在 Windows 上不以 `ccq.exe` 作为常驻父进程（子任务 3b）
- 成功替换后有界清理 installer 生成的无主 `ccq.exe.backup.<PID>`，同时保护活动
  事务和失败恢复 artifact（子任务 4）
- Windows 与 macOS 两条安装链行为对齐
- 不破坏现有 Release 十 artifact 契约

## Subtask Mapping

| Subtask | Deliverable | Blocking Relation |
|---|---|---|
| `07-30-installer-gzip-transport` | 两脚本 gzip 优先 + raw 回退 | 无 |
| `07-30-installer-locked-file-replace` | `File::Replace` + 重试 + 预检 + 错误信息 | 无 |
| `07-30-cli-posix-execve` | POSIX `process.execve` 替换进程映像 | 无 |
| `07-30-cli-windows-shim` | Windows shell shim 绕开 `ccq.exe` | 无 |
| `07-31-installer-replace-residue-cleanup` | 回收 dead-PID installer backup，保护活动与恢复 artifact | 在 locked-file replace 落地后实施 |

前四个子任务互不阻塞；第五个子任务依赖 locked-file replace 已产生明确的 backup
合同。五个子任务均可独立验证、归档。子任务 2 单独即可修复源问题；子任务 3b
不能替代子任务 2（TUI 自更新与用户手动开启 ccq 仍会锁住映像）。

## Cross-Task Acceptance

- [x] 在 `ccq.exe` 被运行中进程占用的场景下，安装脚本能成功升级或给出
      可读的预检提示，不再出现「当文件已存在时，无法创建该文件」
- [x] 安装脚本默认走 gzip，Release 缺 `.gz` 时自动回退 raw 且成功
- [x] Windows 与 macOS 安装链在上述两点上行为一致
- [x] `installer/contracts/Test-Contracts.ps1` 通过
- [x] `cd tui && bun run verify` 通过
- [x] Release 仍产出十个 artifact，`build.json` 契约未破
- [x] 成功替换后回收 installer 生成的 dead-PID backup；活动 PID、探测失败和恢复
      artifact 始终保留，清理失败不把成功安装降级为失败

## Completion Evidence

- gzip-first/raw fallback：`5854745`；Windows contracts、PS5.1 与 Git Bash
  `build.sh --check` 通过。本机无 zsh，原生 macOS behavior probe 未执行，用户于
  2026-08-07 明确接受该环境限制后归档。
- locked-file replace 与占用预检：`7d4f9da`，完成状态记录：`a99497c`。
- POSIX execve：`fe5c217`；Windows 环境未执行真实 POSIX replacement probe，限制已写入
  子任务归档记录。
- Windows detached native Agent launch：`07810ff`，focused、完整 TUI gate 与 compiled
  smoke 通过。
- installer backup residue cleanup：`0200c13`，contracts、PS5.1 probe、source
  `-ListSteps` 与独立检查通过。

## Notes

- 现场残留 `~/.local/bin/.ccq.exe.update-4640-9d17b34caee2.tmp`（2.5 MB，
  正常应 104 MB）是此前某次 TUI 自更新中断的垃圾。命名前缀与安装器所用
  `ccq.exe.download.$PID` 不同，与本次报错无因果关系，可安全删除。
- 用户侧即时绕过：关闭占用 `ccq.exe` 的进程后重跑安装脚本。
- `process.execve` 在 Bun 1.3.14 Windows 上实测抛
  `The feature process.execve is unavailable on the current platform`，
  这是子任务 3a/3b 必须分平台的硬约束依据。
