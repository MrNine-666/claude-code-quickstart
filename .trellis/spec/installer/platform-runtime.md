# Installer Platform Runtime Contract

## 1. Scope / Trigger

Apply to `installer/windows/**`, `installer/macos/**`, `steps.json`, bootstrap
flow, platform detection, NodeJS/Git handling and final ccq installation.

## 2. Signatures and Step Contract

Every active install step provides platform-specific functions equivalent to:

```text
Test-<Step>Installed / test equivalent
Install-<Step>
Verify-<Step>
```

`installer/contracts/steps.json` currently defines Basic as exactly:

```text
NodeJS (Order 10, no dependencies)
Git    (Order 20, no dependencies)
```

Windows consumes `StepFile`; macOS consumes `MacOSStepFile`.

## 3. Contracts

- Install bootstraps NodeJS/Git, then offers/downloads `ccq`. Claude Code,
  Codex, Provider, MCP, Skills and surrounding tools are managed by the TUI.
- Status is detected on every run; there is no persistent install-state file.
- Windows is one PowerShell 5.1+ runtime. Do not re-exec into pwsh or use PS7
  syntax (`-AsHashtable`, `$PSStyle`, ternary, `??`, `&&`, `||`, parallel foreach).
- Under StrictMode, command/function/pipeline results used with `.Count` are
  assigned through `@(...)`; array-returning functions use `return ,$array`.
- Windows core is dot-sourced in this order: `Json.ps1` -> `Ui.ps1` ->
  `Process.ps1` -> `Profile.ps1` -> `Update.ps1` -> `Admin.ps1` -> `Net.ps1`
  -> `Registry.ps1` -> `Bootstrap.ps1`. `Json.ps1` owns the PS5.1 hashtable
  conversion, and `Update.ps1` loads after Profile helpers.
- macOS uses bash wrapper -> `/bin/zsh`, Homebrew official install behavior and
  nvm official fallback. It never invokes winget, registry, MSI/EXE or Windows
  Profile APIs.
- NodeJS is runtime-first on both platforms: reuse a sufficient active node/npm;
  repair the current nvm/fnm provider when possible; otherwise use the platform
  fallback. Do not migrate providers, clean PATHs, or move global npm packages.
- macOS does not hand-write nvm initialization; the official installer owns it.
- Install steps use `[PASS]`, `[FAIL]`, `[SKIP]`; macOS may also use
  `[UNSUPPORTED]`/`[MANUAL]`, neither counting as success.
- Final `ccq` lives at `~/.local/bin/ccq.exe` on Windows or
  `~/.local/bin/ccq` on macOS. Do not inject a `function ccq` Profile wrapper.
- Final `ccq` handoff normalizes the installed `ccq --version` and installer
  Release tag (`vX.Y.Z` -> `X.Y.Z`) before comparing them. Equal versions skip
  without a menu. Different versions show overwrite/preserve choices and
  default to preserve; only explicit overwrite continues to atomic replacement.
  If source mode has no comparable Release tag, preserve the working executable
  and report that comparison was unavailable.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Existing Node/npm satisfies minimum | Skip with no provider migration |
| Active provider can update to LTS | Update within that provider and verify |
| Provider cannot be safely repaired | Use documented platform fallback |
| Step install succeeds but verify fails | Failed step, friendly message/detail |
| Contract path unavailable in single-file execution | Inline/env fallback or safe skip; no empty path call |
| User declines ccq download | Bootstrap remains valid; report skipped |
| Installed ccq matches Release tag | Skip download; report versions match |
| Installed ccq differs from Release tag | Show overwrite/preserve menu; preserve by default |
| Installed ccq exists but target tag is unknown | Preserve existing ccq with an explicit warning |
| Unsupported OS/version/architecture | Fail or manual/unsupported explicitly; never false success |
| Linux invocation | Unsupported current platform; proposal is not runtime behavior |

## 5. Good / Base / Bad Cases

- Good: an existing fnm Node LTS on macOS is reused with zero Profile cleanup.
- Good: installed `ccq 1.2.2` plus a `v1.2.3` installer displays both versions
  and downloads only after the user selects overwrite.
- Base: Git is already present, so the step reports skip and continues to ccq.
- Base: installed `ccq 1.2.3` plus a `v1.2.3` installer skips as current.
- Bad: treating any responsive `ccq` as current without comparing its version.
- Bad: installing Claude Code as a third Basic step because an old README or
  OpenSpec still describes that flow.
- Bad: using `$result = Some-Command; $result.Count` under StrictMode.

## 6. Tests Required

- `pwsh -File installer/contracts/Test-Contracts.ps1`.
- Windows source: `pwsh -File installer/windows/Install.ps1 -ListSteps` and
  relevant PS5.1 syntax/runtime tests.
- macOS source: `zsh -n installer/macos/Install.zsh` and
  `zsh installer/macos/Install.zsh --list-steps`.
- Node provider matrices cover sufficient, repairable and fallback states without
  migration side effects.
- Any remote-entry change also runs the built artifact mode described in
  `build-release.md`.
- `Test-CcqVersionHandoffContract` asserts normalization, same-version skip,
  mismatch default-preserve, explicit overwrite continuation, and the matching
  macOS source contract.

## 7. Wrong vs Correct

```powershell
# Wrong under StrictMode when a command returns $null.
$items = Get-Items
if ($items.Count -gt 0) { }

# Correct
$items = @(Get-Items)
if ($items.Count -gt 0) { }
```

```text
Wrong: ccq exists -> return
Correct: compare installed version + Release tag -> equal: skip;
         different: preserve-by-default menu; overwrite: atomic replace
```
