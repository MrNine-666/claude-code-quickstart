# Windows Install Steps Contract

## 1. Scope / Trigger

Apply to `installer/windows/steps/**`, `installer/macos/steps/**`,
`installer/contracts/steps.json`, the Windows Registry fallback and the
bootstrap lifecycle that invokes these steps.

## 2. Step Signatures

An active step implements these semantic functions:

```powershell
Test-<StepId>Installed  # @{ IsInstalled; Version; Data; Message }
Install-<StepId>        # @{ Success; ErrorMessage; Data }
Verify-<StepId>         # @{ Success; ErrorMessage } (optional in practice)
```

An update-capable step may also implement:

```powershell
Update-<StepId>         # @{ Success; ErrorMessage; Data; UpdatedItems = @() }
```

`Bootstrap.ps1` accepts both these hashtable results and legacy Boolean
returns. New steps should use the hashtable shape so status, version, data and
technical errors remain available to the summary and tests.

## 3. Current Contract and Ownership

`installer/contracts/steps.json` is the cross-platform source of truth. Basic
contains exactly two active steps:

| StepId | Order | Dependencies | Windows | macOS |
|---|---:|---|---|---|
| `NodeJS` | 10 | none | `windows/steps/NodeJS.ps1` plus four submodules | `macos/steps/NodeJS.zsh` |
| `Git` | 20 | none | `windows/steps/Git.ps1` | `macos/steps/Git.zsh` |

Both are required, skip when already installed and are not optional. The
installer then offers the ccq executable; Claude Code, Codex, Providers, MCP,
Skills and other surrounding tools are owned by the TUI tool-management
lifecycle, not by installer steps.

`ClaudeCode.ps1` remains only as historical reference. It is not listed in
`steps.json`, not returned by the Registry fallback, and must not be re-added to
the Basic install flow. The same rule applies to deleted Ccline/CcgWorkflow/Mcp
installer steps.

## 4. Active Step Behavior

### NodeJS

- Reuse an existing `node`/`npm` from any provider when its version is
  sufficient; report a skip without migration or cleanup.
- If insufficient, repair the active provider in place when it is safely
  detectable (fnm/nvm/direct). Only when that is not possible, offer the
  platform fallback: nvm-windows or direct Node.js on Windows, and the official
  nvm script on macOS.
- Never uninstall a provider, rewrite PATH to clean up another provider or
  move npm global packages between providers.
- Verify `node --version` and `npm --version`; configure the established npm
  mirror behavior after a successful install.

The Windows NodeJS implementation is split into `NodeJS-Detect.ps1`,
`NodeJS-Common.ps1`, `NodeJS-Nvm.ps1` and `NodeJS-Direct.ps1`, which must be
loaded before `NodeJS.ps1` by `Get-StepFiles`.

### Git

`Git.ps1` installs through the established winget wrapper, applies the four Git
recommendations and Git Bash UTF-8 wrapper configuration, then verifies
`git --version` and the expected global configuration.

## 5. Adding or Changing a Step

1. Add or update the StepId, platform file paths, order, dependency, group and
   skip/update flags in `installer/contracts/steps.json`.
2. Implement both platform consumers when the capability is supported on both
   platforms; keep Windows files PS5.1/StrictMode-compatible.
3. Register the same metadata in the Windows Registry inline fallback and keep
   its consistency assertion passing.
4. Add the step to the focused contract and lifecycle tests. Do not infer the
   install plan from a README or from an archived task.
5. Update the relevant installer spec when the step boundary or result shape
   changes.

## 6. Validation Matrix

| Check | Expected result |
|---|---|
| `Test` reports installed | Lifecycle skips without reinstall or migration |
| `Test` reports missing | Install runs, then Verify must pass |
| dependency missing | Registry-derived dependency closure adds it before the selected step |
| one step fails | Failure is recorded, user gets friendly and technical detail, later independent steps follow the configured policy |
| source contract unavailable | Registry inline fallback is used and consistency is checked |
| old ClaudeCode file is discovered | It remains historical and is not consumed |

## 7. Tests Required and Wrong vs Correct

Run:

```powershell
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/windows/Install.ps1 -ListSteps
```

Also run `zsh -n installer/macos/Install.zsh` and the macOS `--list-steps`
probe when changing shared step metadata. Add focused tests for every new
dependency, fallback branch and result field.

```powershell
# Wrong: adding a new Basic step only to a stale README or one platform file.
# Correct: change steps.json, both supported consumers, Registry fallback and
# contract/lifecycle tests together.
```
