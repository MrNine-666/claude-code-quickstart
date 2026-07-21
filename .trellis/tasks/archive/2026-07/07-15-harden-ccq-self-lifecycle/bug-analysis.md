# Bug Analysis: ccq self-update and Windows self-uninstall

## 1. Root Cause Category

- **Category**: B/D/E - Cross-layer contract, test coverage gap, and implicit
  platform assumption.
- **Specific Cause**: download and apply exchanged an implicit fixed temp path
  instead of a verified transaction; Windows paths were writable but the code
  assumed the running image was replaceable/deletable; helper behavior did not
  distinguish CLI and TUI restart policy.

## 2. Why Earlier Protection Failed

1. Source-shape tests checked helper text but did not execute lock/retry paths.
2. The old update result exposed loose URL/version/path fields, so TypeScript
   could not prevent callers from re-deriving state.
3. Direct deletion reported the Windows loader error as if it represented an
   external file occupation, masking that the current process itself held it.
4. String version comparison and prerelease `localeCompare` hid downgrade and
   `beta.10` ordering errors.

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | Immutable plan and downloaded transaction capability | DONE |
| P0 | Runtime validation | Release size/SHA-256 fail closed and apply-time recheck | DONE |
| P0 | Platform helper | PS5.1 deferred update/uninstall after parent exit | DONE |
| P0 | Test coverage | Stream, integrity, spawn error, Windows lock, compiled smoke | DONE |
| P1 | Documentation | Executable self-lifecycle code-spec and cross-layer checklist | DONE |

## 4. Systematic Expansion

- **Similar Issues**: installer downloads and any future self-repair command must
  not reuse fixed temp paths or infer Windows file availability from existence.
- **Design Improvement**: carry validated capabilities between stages and keep
  platform mechanics below caller policy.
- **Process Improvement**: cross-platform code is not complete with source
  regex tests; native helper execution and compiled smoke must be CI gates.

## 5. Knowledge Capture

- [x] Added `.trellis/spec/backend/ccq-self-lifecycle.md`.
- [x] Added the self-modifying executable checklist to the cross-layer guide.
- [x] Added runtime regressions and Windows CI/smoke gates.

## Bug Analysis: PS5.1 helper hash verification depended on module auto-loading

### 1. Root Cause Category

- **Category**: D/E - Test coverage gap and implicit environment assumption.
- **Specific Cause**: the generated helper invoked `Get-FileHash`. Source-shape
  checks accepted it, but a real `powershell.exe -NoProfile -File` helper process
  can fail before copying when the utility module is not auto-loaded.

### 2. Why Fixes Failed

1. The first runtime test discarded helper stderr, so the failure looked like a
   lock/retry logging problem rather than a command-resolution failure.
2. Retrying the lock test reproduced the symptom but added no discriminating
   evidence; capturing stderr exposed the missing cmdlet immediately.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Runtime compatibility | Hash with `System.Security.Cryptography.SHA256` and explicit disposal | DONE |
| P0 | Test coverage | Execute the generated helper under `-NoProfile -File` and retain stderr | DONE |
| P1 | Contract | Forbid `Get-FileHash` in the self-lifecycle code-spec | DONE |

### 4. Systematic Expansion

- **Similar Issues**: every generated PS5.1 helper must avoid optional module
  auto-loading, not only syntax introduced after Windows PowerShell 5.1.
- **Design Improvement**: keep security-critical helper primitives on explicit
  .NET APIs whose availability is part of the target runtime.
- **Process Improvement**: source assertions supplement native execution; they
  cannot replace it.

### 5. Knowledge Capture

- [x] Updated `.trellis/spec/backend/ccq-self-lifecycle.md`.
- [x] Kept native update-helper execution in the Windows verification matrix.
