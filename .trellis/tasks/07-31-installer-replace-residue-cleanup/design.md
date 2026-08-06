# Windows ccq Backup Residue Cleanup Design

## 1. Boundary

本任务只修改 Windows installer 的 replacement lifecycle。所有权保持在
`installer/windows/core/Process.ps1`；`cleanup-policy.json` 继续只描述 Profile
更新快照，TUI self-update 和 macOS 不参与本设计。

## 2. Trigger And Data Flow

```text
Replace-CcqExecutable(temp, target)
  -> File.Replace / Move + retry
  -> verify target exists and target length == captured temp length
  -> Clear-CcqReplacementBackupsAfterVerifiedReplace(
       target, currentBackup, expectedLength
     )
       -> re-verify target invariant
       -> bounded cleanup of currentBackup
       -> enumerate exact sibling ccq.exe.backup.<digits> files
       -> keep live/unknown PID candidates
       -> remove dead-PID candidates
       -> report retained paths as warning data
  -> return replacement success regardless of cleanup warning
```

Cleanup never runs before target verification and never runs from a failure or
rollback branch. This makes the verified target, rather than file age, the
proof that old backup bytes are no longer the only recovery copy.

## 3. Helper Contract

The implementation should expose one narrow PowerShell helper equivalent to:

```powershell
Clear-CcqReplacementBackupsAfterVerifiedReplace `
  -TargetPath <absolute ccq.exe> `
  -CurrentBackupPath <absolute current backup> `
  -ExpectedTargetSize <positive Int64> `
  -MaxAttempts 20 `
  -IntervalMs 250

# -> @{
#   RemovedPaths = @(...)
#   RetainedPaths = @(...)
#   WarningMessage = ""
# }
```

The helper re-checks the target path and expected size before any deletion.
Arrays are materialized explicitly so PowerShell 5.1 StrictMode never reads
`.Count` from `$null` or creates nested empty arrays.

## 4. Candidate Identity And Liveness

- Candidate directory is exactly `Split-Path -Parent $TargetPath`.
- Candidate basename must match escaped target basename plus
  `.backup.<digits>`; no wildcard-only deletion is allowed.
- `CurrentBackupPath` is handled explicitly because its PID is the active
  installer PID. It can be removed only after target verification, using
  bounded retries and post-delete existence checks.
- Other candidates are removed only when their parsed PID does not resolve to
  a live process. PID reuse produces a safe false negative: the file is kept.
- Process lookup failure, malformed PID, directory/reparse point, filesystem
  exception, or persistent delete failure keeps the candidate.

No age threshold is needed. PID absence plus a newly verified target provides
the ownership and recovery proof; adding age would either delay cleanup without
improving safety or encourage deletion when target health is unknown.

## 5. Failure Semantics

Cleanup is best effort after the primary replacement has succeeded. A retained
backup must not change `Replace-CcqExecutable.Success`; instead the caller emits
one warning containing the retained absolute paths. This avoids reporting an
installation failure when the new executable is already verified, while still
making residue actionable.

All pre-existing failure semantics remain unchanged: target-missing rollback,
same-PID collision, current temp cleanup, and recovery backup preservation.

## 6. Verification

Extend `Test-CcqLockedFileReplaceContract` with isolated fixtures for:

- transient current-backup lock released inside the retry window;
- persistent current-backup lock returning success with warning and residue;
- dead-PID historical backup cleanup after successful replacement;
- live-PID, malformed-name and non-file candidates preserved;
- target mismatch preventing every cleanup action;
- existing failure, rollback and collision probes unchanged.

The persistent-lock fixture must inject a real `FileShare.None` handle at the
post-replace cleanup boundary. Tests must never use the user's installed path.

## 7. Compatibility And Rollback

The implementation remains PowerShell 5.1-compatible and uses the existing
`20 x 250 ms` retry magnitude. Rollback is local: remove the cleanup helper and
restore the existing two direct success-path `Remove-Item` calls. No contract
migration or user-data migration is required.
