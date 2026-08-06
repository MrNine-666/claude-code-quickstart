# Clean Stale Windows ccq Replacement Backups

父任务：`.trellis/tasks/07-30-fix-ccq-install-replace-chain`

## Goal

让 Windows 安装器在确认新 `ccq.exe` 可用后回收自己产生的
`ccq.exe.backup.<PID>`，同时保留活动事务和失败恢复所需的 backup，避免
`~/.local/bin/` 长期积累可确认无主的替换残留。

## Background

### Confirmed Backup Residue

`Replace-CcqExecutable` 成功路径末尾删 `$TargetPath.backup.$PID` 时，若旧
ccq 进程仍持有旧映像句柄，`Remove-Item` 可能因共享冲突静默失败，留下
`ccq.exe.backup.<PID>`。

Windows PowerShell 5.1 隔离探针已确认该竞态路径：在替换成功后、清理
`backup` 之前由另一个句柄占用该文件时，替换仍返回成功、目标变成新版本、temp
被消费，但 `Remove-Item -ErrorAction SilentlyContinue` 会静默失败并留下
`ccq.exe.backup.<PID>`。完整证据见 `research/backup-residue-probe.md`。

该探针证明路径真实可发生，但不推断无仪器并发场景下的发生频率；不应因此扩大
清理范围或删除恢复 artifact。

### Ownership Boundary

`installer/contracts/cleanup-policy.json` 当前只管 Profile 更新快照：

```json
"directoryPattern": "update_*",
"baseDirectory": {
  "windows": "%TEMP%\\ClaudeEnvInstaller\\Backups",
  "macos": "${TMPDIR:-/tmp}/ccq-backups"
}
```

域是 `%TEMP%` 下的 Profile 快照目录，与 `~/.local/bin` 下的可执行文件恢复
artifact 不同。该 JSON 只由 Profile/Update 快照代码消费，因此本任务不修改
`cleanup-policy.json`，清理由 `installer/windows/core/Process.ps1` 负责。

## Requirements

- 只处理 Windows 安装器生成、与目标同目录且精确匹配
  `ccq.exe.backup.<digits>` 的普通文件。
- 当前替换生成的 backup 只有在新目标存在且尺寸与本次 temp 的已知尺寸一致后
  才能清理；删除遇到短时占用时使用现有 `20 x 250 ms` 量级做有界重试。
- 扫描历史 backup 时只删除来源 PID 已不存在的文件；PID 当前存在、PID 无法解析、
  文件类型异常或任何探测失败都必须保留。
- 持续占用导致清理失败时安装仍保持成功，但必须保留文件并输出包含绝对路径的
  warning，供下次成功替换再次回收。
- 绝不删除 `ccq.exe` 本体，不在目标验证前清理 backup，不删除失败/回滚路径明确
  保留的当前事务恢复 artifact。
- 保持 PowerShell 5.1、StrictMode 和现有替换返回值兼容。

## Out Of Scope

- TUI 自更新产生的 `.ccq.exe.update-*.tmp`、update helper、transport cache。
- macOS 可执行文件或首次安装行为。
- 修改 `installer/contracts/cleanup-policy.json` 的 Profile 快照策略。
- 启动时全目录清理、年龄阈值策略、用户主动保留的任意备份文件。
- 删除当前用户机器上的真实残留样本；实现和验证只使用隔离 fixture。

## Constraints

- PowerShell 5.1 兼容并保持 `Set-StrictMode -Version Latest`。
- 与 `.trellis/spec/project/installer/windows-core.md` 的替换契约不冲突：清理逻辑
  不得删除正在被替换事务使用的 backup。
- `Replace-CcqExecutable` 的失败、回滚、同 PID backup collision 和用户错误文案
  保持原语义。
- 清理是替换成功后的附属动作；清理失败不得把已验证的新目标降级为安装失败。

## Acceptance Criteria

- [x] `ccq.exe.backup.<PID>` 竞态有实测结论，证据写入 `research/`
- [x] 当前 backup 的短时占用在 `20 x 250 ms` 窗口内释放后可被删除，目标内容不变
- [x] 当前 backup 持续占用时目标仍为新版本、安装返回成功、backup 保留并显示路径
- [x] 来源 PID 已退出的精确历史 backup 在下一次成功替换后删除
- [x] 活动 PID、非法文件名、非普通文件和探测异常对应的候选始终保留
- [x] 失败/回滚/同 PID collision 合同不变，不误删恢复 artifact 或 `ccq.exe`
- [x] `cleanup-policy.json`、TUI 自更新和 macOS 文件保持不变
- [x] Windows PowerShell 5.1 语法探针与 source `-ListSteps` 通过
- [x] `pwsh -File installer/contracts/Test-Contracts.ps1` 通过

## Notes

- 来源：`07-30-installer-locked-file-replace` 的 check 阶段发现，
  当时按边界约束未处理（需改第三个文件，且父任务 PRD Notes 已写明
  「若超出本任务范围则单独立项」）。
- 用户机器上的 `.ccq.exe.update-4640-*.tmp` 属于 TUI 自更新，本任务不读取、
  修改或删除。
