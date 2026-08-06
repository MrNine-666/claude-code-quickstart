# Backup Residue Probe

## Scope

验证 `Replace-CcqExecutable` 成功后，目标目录中的
`ccq.exe.backup.<PID>` 是否可能因清理阶段的文件占用而遗留。

## Probe

- Runtime: Windows PowerShell 5.1 on Windows.
- Fixture: isolated `%TEMP%` directory containing `ccq.exe` with `OLD-BUILD`
  and `ccq.exe.download.<PID>` with `NEW-BUILD`.
- The fixture dot-sourced `installer/windows/core/Process.ps1` and invoked the
  real `Replace-CcqExecutable` function.
- A scoped `Remove-Item` wrapper acquired a `FileShare.None` read handle on the
  generated backup immediately before delegating to the real provider. This
  models another process retaining the old-image/backup handle at the exact
  post-replace cleanup boundary; it does not touch the user's installed ccq.

## Result

The function returned `Success = True`; the target contained `NEW-BUILD`; the
download temp was gone; and `ccq.exe.backup.<PID>` remained after the cleanup
call. Releasing the injected handle allowed the backup to be removed afterward.

This confirms the residue path is physically possible under the current
`Remove-Item -ErrorAction SilentlyContinue` cleanup contract. It does not
establish how often an uninstrumented concurrent process wins the race, so a
stress/frequency probe is still optional evidence rather than an acceptance
requirement.

## Existing Coverage Gap

`installer/contracts/Test-Contracts.ps1` already proves that a locked target
fails closed without leaving temp/backup residue, but it does not cover a
successful replacement whose backup deletion loses a concurrent handle race.

## Decision Input

The residue is confirmed. Planning still needs a scope decision for ownership:
installer-side cleanup for `ccq.exe.backup.<PID>`, TUI self-update cleanup for
`.ccq.exe.update-*.tmp`, or a narrowly specified shared policy with separate
owners. `cleanup-policy.json` currently describes only profile snapshot
directories and should not be expanded by symmetry alone.
