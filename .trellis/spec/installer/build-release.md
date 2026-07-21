# Build, Embedding, and Release Contract

## 1. Scope / Trigger

Apply to `installer/build.ps1`, `installer/build.sh`,
`installer/contracts/build.json`, `tui/scripts/build.ts`, embedded contracts,
Release CI, version injection and artifact smoke tests.

## 2. Artifact Signatures

Current Release artifact set is exactly six files:

```text
install.ps1
install.sh
ccq-windows-x64.exe
ccq-windows-arm64.exe
ccq-macos-x64
ccq-macos-arm64
```

TUI compile targets are `bun-windows-{x64,arm64}` and
`bun-darwin-{x64,arm64}`. Installed binaries must run without Bun or Node.

## 3. Contracts

- `build.json` owns installer composition and artifact names. CI expected lists,
  dist counts, Release body and contract tests must match it.
- Windows `install.ps1` is an ASCII trampoline. The real UTF-8 script is base64
  embedded and decoded locally because PS5.1 `irm | iex` may misdecode GitHub
  octet-stream bytes even with a BOM.
- A Release-invoked PowerShell script has no stable `$PSScriptRoot`. Check for an
  empty path before `Join-Path`, `Test-Path`, `Get-Content` or dot-sourcing, and
  use inline/environment fallback.
- `install.sh` is a bash-to-zsh wrapper around the macOS source chain.
- TUI contracts are imported with Bun's `text` loader into
  `EMBEDDED_CONTRACTS`. Source mode reads `tui/contracts/`; executable mode must
  not need adjacent files.
- Do not use `bun build --compile --minify` by default. OpenTUI host registration
  and compiled-mode behavior require the unminified build unless compiled smoke
  proves otherwise.
- `tui/assets/ccq-icon.ico` is the source Windows icon. `tui/scripts/build.ts`
  passes `--windows-icon` only for a Windows x64 native build because Bun does
  not support the flag during cross-compilation; the other targets retain the
  default icon. The build must remain successful when the optional icon file or
  Bun metadata embedding is unavailable.
- Tree-sitter is source-mode only; compiled executables use the plain text
  fallback.
- `tui/package.json` stays `0.0.0-dev`. A Git tag is the Release version source;
  CI injects it before build, and `src/version.ts` embeds it.
- Local `tui/scripts/build.ts` may report an arm64 cross-compile limitation, but
  a Release must not publish a partial artifact set.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Artifact name/count differs from build contract | Contract/CI failure |
| Windows remote entry contains non-ASCII body | Build/encoding failure |
| `$PSScriptRoot` absent | Fallback path; no empty `-Path` argument |
| Compiled mode lacks disk contracts | Embedded loader succeeds |
| Embedded key missing/malformed | Named failure, no silent empty config |
| Tag version differs from `ccq --version` | Release build failure |
| One target failed during Release build | Do not publish partial Release |
| Optional Windows icon cannot be embedded | Keep the executable build valid and report the skipped icon |
| Linux artifact appears before implementation | Contract failure |

## 5. Good / Base / Bad Cases

- Good: source and compiled contract probes return the same parsed providers and
  templates.
- Base: main-branch smoke reports `0.0.0-dev`.
- Bad: reading `tui/contracts/providers.json` relative to `process.cwd()` in the
  compiled binary.
- Bad: adding two Linux artifacts only to `build.ts` without contract/CI/install
  support.
- Bad: making a cross-compiled arm64 build fail only because `--windows-icon`
  was passed to Bun.

## 6. Tests Required

```sh
cd tui
bun run typecheck
bun run verify
bun run build

cd ..
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/build.ps1
sh installer/build.sh --check
```

Also smoke each available compiled target with `--version`, help and no-arg
non-TTY behavior. On Windows verify both `pwsh -File` source mode and an
`irm | iex`-equivalent Release trampoline execution.

## 7. Wrong vs Correct

```powershell
# Wrong: UTF-8 body is sent directly through a PS5.1 octet-stream pipeline.
Get-Content installer/windows/Install.ps1

# Correct: build emits an ASCII trampoline which decodes the embedded UTF-8 body.
```
