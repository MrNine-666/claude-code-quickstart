# Windows Core Contract

## 1. Scope / Trigger

Apply to `installer/windows/core/**`, `installer/windows/Install.ps1`, the
Windows single-file build, and any step that consumes the PowerShell runtime
helpers. These files are dot-sourced scripts, not PowerShell modules.

## 2. Load and Ownership Contract

`installer/windows/Install.ps1` loads core files in this exact order:

```text
Json.ps1 -> Ui.ps1 -> Process.ps1 -> Profile.ps1 -> Update.ps1
         -> Admin.ps1 -> Net.ps1 -> Registry.ps1 -> Bootstrap.ps1
```

The same order is declared in `installer/contracts/build.json`. `Registry.ps1`
must be loaded before `Bootstrap.ps1` and before step files are resolved;
`Update.ps1` must follow `Profile.ps1` because it calls Profile backup and
atomic-write helpers. The Windows source and the release artifact use the same
runtime boundary, but a release artifact may not have a usable `$PSScriptRoot`.

| Module | Owns |
|---|---|
| `Json.ps1` | PS5.1-compatible JSON-to-hashtable conversion |
| `Ui.ps1` | terminal capability/theme detection, semantic output, menus, progress and error details |
| `Process.ps1` | external commands, retries/timeouts, npm/winget wrappers, PATH refresh and ccq executable management |
| `Profile.ps1` | marked Profile edits, backups and atomic file writes |
| `Update.ps1` | update manifest, content fingerprints and update snapshots |
| `Admin.ps1` | administrator detection, elevation and step privilege assertions |
| `Net.ps1` | endpoint probes and interruptible file downloads |
| `Registry.ps1` | shared step contract loading, inline fallback, groups, dependencies and ordered files |
| `Bootstrap.ps1` | in-memory step state, dependency ordering and Test -> Install/Update -> Verify lifecycle |

## 3. Runtime Contracts

### PowerShell compatibility and arrays

- All Windows installer code targets PowerShell 5.1+ with
  `Set-StrictMode -Version Latest`.
- Do not use PS7-only syntax or APIs (`-AsHashtable`, `$PSStyle`, `?:`, `??`,
  `&&`, `||` pipeline chaining, or parallel foreach). Use the conversion helper
  in `Json.ps1` instead of `ConvertFrom-Json -AsHashtable`.
- Any command, function or pipeline result whose `.Count` is read must first be
  assigned as `@(...)`. Functions returning arrays use `return ,$array` when
  expansion would change the contract.

### Process and command execution

`Invoke-ExternalCommand` accepts `-Command`, `-Arguments`,
`-WorkingDirectory`, `-TimeoutSeconds`, `-RetryCount` and `-SuppressOutput` and
returns a result containing `Success`, `ExitCode`, `Output`, `Error`, `Command`
and `ResolvedPath`. It must quote a `.ps1` path containing spaces when invoking
the fallback PowerShell engine. `Invoke-NpmGlobalInstall` accepts only
`-PackageName`, `-Version` and `-Force`; callers must not pass a
`-DisplayName` parameter.

`Invoke-WingetInstall` supports `-Silent`, `-AcceptLicense`, `-Force` and
`-InstallerType`. Silent mode must redirect and asynchronously consume stdout
and stderr. Use `-InstallerType wix` only for the Microsoft.PowerShell package
when the MSI must be forced; do not pass it to the MSIX-only Windows Terminal
package.

### Profile, update and privilege safety

Profile edits use exactly these markers:

```text
# >>> Claude Code Quickstart >>>
# <<< Claude Code Quickstart <<<
```

Backups live under `%TEMP%\ClaudeEnvInstaller\Backups`. Use
`Write-FileAtomically -FilePath ... -Content ...`; do not introduce a `-Path`
alias or direct destructive replacement. The shared marker block historically
contained both fnm initialization and the obsolete `ccq` Profile function, so
legacy cleanup must not delete a block based on markers alone. It may remove
only an AST-parsed `ccq` function that matches both historical Release URLs;
all other lines stay in place, and parse/identity uncertainty must cause a
zero-write skip. `Update.ps1` depends on Profile and provides
`Read-UpdateManifest`, `Write-UpdateManifest`,
`Get-StringFingerprint`, `New-UpdateSnapshot` and `Clear-OldUpdateSnapshots`.
The manifest is user runtime state and is not the installer step state.

`Assert-StepPrivilege` returns a Boolean, not an object. `Invoke-SelfElevated`
must reject an empty script path because pipeline-executed release artifacts
cannot be relaunched with `-File`.

### Registry, bootstrap and release paths

`Registry.ps1` reads `installer/contracts/steps.json` in source mode and uses a
matching inline fallback when contracts are unavailable. `Get-StepFiles` returns
ordered relative paths and places declared submodules before their main step.
`Bootstrap.ps1` keeps `StepResult`/`InstallState` in memory only; every run
re-tests the environment and never resumes from a persisted install-state file.

When `$PSScriptRoot` is empty, never pass an empty value to `Join-Path`,
`Test-Path`, `Get-Content` or dot-sourcing. Use the artifact's inline or
environment fallback, or skip safely with an explicit diagnostic.

### ccq executable handoff

`Get-CcqArchitecture` maps Windows ARM64 to `windows-arm64` and all other
supported architectures to `windows-x64`. `Install-CcqExecutable` downloads to
a temporary file, checks it is non-empty, atomically replaces
`%USERPROFILE%\.local\bin\ccq.exe`, and calls `Add-DirectoryToUserPath`.
The PATH update is user-level (`HKCU\Environment`) and must not inject a
Profile wrapper. `Add-DirectoryToUserPath` must read the raw registry value with
`DoNotExpandEnvironmentNames`, append without expanding existing entries, and
write with the original `RegistryValueKind`; it must not round-trip the complete
user PATH through `Environment.GetEnvironmentVariable` /
`Environment.SetEnvironmentVariable`. A failed download must leave an existing
ccq executable intact.
`ConvertTo-CcqComparableVersion` removes the `ccq ` command prefix and a leading
Release-tag `v`. `Get-CcqReleaseTargetVersion` accepts only a comparable `v*`
Release tag. `Confirm-CcqExecutableDownload` skips equal versions, presents a
preserve-by-default overwrite menu for unequal versions, and preserves an
existing executable when the target version is unavailable.

## 4. Validation and Error Matrix

| Condition | Required result |
|---|---|
| PS5.1 or StrictMode violation | Reject before release; add a focused compatibility check |
| `$PSScriptRoot` unavailable | Inline/env fallback or explicit safe skip; never an empty path call |
| Silent winget execution | Captured output is drained asynchronously; no progress-bar leak or deadlock |
| Profile write fails | Preserve the original file and report a technical detail |
| ccq download fails or is empty | Remove only the temporary file; preserve the existing target |
| ccq installed version equals target | Report current; do not prompt or download |
| ccq installed version differs | Show both versions; default menu selection preserves current |
| target Release tag unavailable | Preserve current executable; do not guess that `latest` differs |
| User PATH is `REG_EXPAND_SZ` with `%NVM_HOME%` / `%NVM_SYMLINK%` | Append the ccq directory while preserving the raw tokens and registry type |
| Profile marker block contains fnm or unknown user content | Remove only a positively identified historical `ccq` function; otherwise do not write |
| Non-admin pipeline execution | Do not attempt `-File` relaunch; instruct the user to rerun elevated |

## 5. Good / Base / Bad Cases

- Good: source mode resolves contracts from disk and release mode uses the same
  registry data through its inline fallback.
- Good: choosing overwrite after a mismatch still downloads to a temp path
  before replacing the existing executable.
- Base: `Git` is already present, so the lifecycle reports a skip without a
  persisted state-file mutation.
- Bad: reading `.Count` from a possibly null PowerShell pipeline result.
- Bad: writing a `ccq` function into `$PROFILE` to make the command available.
- Bad: overwriting an existing ccq binary before the new download is verified.
- Bad: returning on installed status before comparing with the Release tag.

## 6. Tests Required

- Run `pwsh -File installer/contracts/Test-Contracts.ps1`.
- Run `pwsh -File installer/windows/Install.ps1 -ListSteps` in source mode and
  exercise the built ASCII trampoline in release mode.
- Cover StrictMode array handling, empty-path release guards, silent winget
  output handling, atomic Profile writes and ccq temp-file replacement.
- `installer/contracts/Test-Contracts.ps1` behavior-probes same, preserve and
  overwrite decisions in the real Windows handoff function.
- Behavior-probe `Add-DirectoryToUserPath` through mocked registry boundaries;
  assert raw nvm tokens and `REG_EXPAND_SZ` survive and an existing entry causes
  no registry write.
- Behavior-probe Profile legacy cleanup with marked fnm, unmarked fnm, fnm-only,
  legacy-function-only and malformed blocks; fnm stays line-preserving and
  uncertain blocks cause no write.
- Run `git diff --check` after changing PowerShell or generated artifact inputs.

## 7. Wrong vs Correct

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
