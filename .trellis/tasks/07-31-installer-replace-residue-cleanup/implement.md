# Windows ccq Backup Residue Cleanup Implementation Plan

## Preconditions

- [x] Backup residue reproduced with a Windows PowerShell 5.1 isolated probe.
- [x] Scope limited to installer-generated `ccq.exe.backup.<PID>` files.
- [x] `cleanup-policy.json`, TUI self-update temp and macOS are out of scope.
- [x] Existing contract baseline passes under `pwsh`.

## 1. Add The Post-Verification Cleanup Helper

- [x] Add a PS5.1/StrictMode-safe helper in `installer/windows/core/Process.ps1`.
- [x] Require target existence and expected-size equality before deletion.
- [x] Match only exact sibling `<target>.backup.<digits>` ordinary files.
- [x] Retry current-backup deletion with the existing `20 x 250 ms` magnitude.
- [x] Remove historical candidates only when the parsed PID is no longer live.
- [x] Preserve candidates on malformed identity, active PID, lookup error,
      reparse/directory type, or delete failure.
- [x] Return structured removed/retained path arrays and warning text.

## 2. Integrate With Replace-CcqExecutable

- [x] Invoke cleanup only after the existing final target verification passes.
- [x] Replace direct success-path backup deletion with the helper.
- [x] Keep replacement success when cleanup retains files; emit one warning
      containing absolute retained paths.
- [x] Leave failure, rollback, collision and temp semantics unchanged.

## 3. Extend Executable Contract Coverage

- [x] Add transient and persistent current-backup lock probes to
      `Test-CcqLockedFileReplaceContract`.
- [x] Add dead-PID deletion and live-PID preservation fixtures.
- [x] Cover malformed filename, non-file candidate, target mismatch and
      filesystem/process lookup failure.
- [x] Assert persistent residue is visible but does not downgrade a verified
      replacement to failure.
- [x] Keep all existing locked target, rollback and collision probes passing.

## 4. Update Durable Contract

- [x] Update `.trellis/spec/project/installer/windows-core.md` with trigger,
      identity, liveness and warning semantics.
- [x] Do not modify `cleanup-policy.json`, TUI self-update specs or macOS specs.

## Validation

```powershell
pwsh -NoProfile -File installer/contracts/Test-Contracts.ps1
pwsh -NoProfile -File installer/windows/Install.ps1 -ListSteps
powershell.exe -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('installer/windows/core/Process.ps1',[ref]$null,[ref]$null) | Out-Null"
pwsh -NoProfile -File installer/build.ps1
git diff --check
```

## Rollback Points

- Helper integration is one local chunk in `Process.ps1`; revert it without
  changing replacement/rollback code.
- Contract probes are a separate chunk and must be reverted only with the
  corresponding implementation.
- No real `~/.local/bin` residue is deleted during implementation or tests.

## Verification Evidence (2026-08-06)

- [x] `pwsh -NoProfile -File installer/contracts/Test-Contracts.ps1`
- [x] `pwsh -NoProfile -File installer/windows/Install.ps1 -ListSteps`
- [x] Windows PowerShell 5.1 AST parse of `Process.ps1`
- [x] Direct Windows PowerShell 5.1 cleanup probes for dead-PID deletion and
      persistent-lock retention with an absolute-path warning
- [x] Independent `trellis-check`: no task-scoped findings
- [x] `git diff --check`
- [x] Isolated `bun-windows-x64` compile without `--windows-icon` metadata:
      pass (`117803520` bytes), confirming the source bundle/compile path is healthy
- [ ] `pwsh -NoProfile -File installer/build.ps1`: installer generation and
      syntax validation pass, but the full four-platform TUI build is blocked
      outside this task by Bun 1.3.14 `--windows-icon` metadata commit failing
      with `FailedToCommit`; two bounded runs reproduced the same failure and
      timed out after the failed target.
