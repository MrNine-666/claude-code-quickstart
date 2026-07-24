# Linux Installer Support Design

## 1. Design Summary

Extend the current two-platform installer into a three-platform contract without
merging platform runtimes. Windows keeps its PowerShell composition. macOS keeps
its zsh implementation. Linux gains a Bash implementation. The public Unix
artifact remains one `install.sh`, implemented as a small dispatcher containing
separate encoded macOS and Linux payloads.

This remains one Trellis task because the source, contract, builder, binary,
self-update and Release changes form one atomic artifact contract. Splitting
them into independently shipped children would create intermediate states that
the existing gates intentionally reject.

## 2. Current State And Owners

```text
platform source
  -> installer/contracts/steps.json + build.json
  -> installer/build.ps1 or installer/build.sh
  -> dist installer + tui/scripts/build.ts binaries
  -> .github/workflows/build-and-release.yml
  -> Release assets
  -> installer ccq download / TUI self-update
```

Current owners that must change together:

- `installer/contracts/steps.json`: step file and runtime directory contract.
- `installer/contracts/build.json`: composition and eight-file Release set.
- `installer/contracts/Test-Contracts.ps1`: cross-platform consistency gate.
- `installer/build.sh`: Unix single-file composition and Unix binary collection.
- `tui/scripts/build.ts`: Bun compile target registry.
- `tui/src/core/self-update.ts:getAssetName`: installed runtime asset selection.
- `.github/workflows/build-and-release.yml`: test/build/smoke dependency graph.

`tui/src/core/self-update.ts:164` currently rejects every platform except
`win32` and `darwin`. POSIX apply and self-uninstall already use a non-Windows
path, so Linux needs an asset mapping and tests rather than a third replacement
algorithm.

## 3. Contracts

### 3.1 Linux platform matrix

Add `installer/contracts/linux-platforms.json` as the owning data source for:

- official distro ID, family and pinned CI image;
- accepted version/variant constraints;
- package-manager command and install argv template;
- `ID_LIKE` best-effort mapping;
- x64/arm64 host-name aliases;
- Bash runtime, glibc-only and WSL policy.

The initial pinned baselines are the candidates accepted in the PRD. Before
implementation is activated, the implementer verifies that each exact image is
available and records the final tag in this contract. Floating tags are rejected
except for Arch rolling, where `latest` is the product policy.

Linux shell code cannot depend on Node or jq before bootstrap. Runtime platform
detection therefore remains implemented in `linux/core/Platform.sh`; the
contract test executes its inspection functions against fixtures and compares
the results to `linux-platforms.json`. CI matrix generation reads the JSON
directly. This keeps the data owner executable without introducing a bootstrap
dependency into the runtime.

### 3.2 Step contract

Extend `steps.json` with:

- `DirectoryPolicy.RuntimeCoreDirectories.Linux`;
- required `LinuxStepFile` for every active Basic step;
- Linux-specific skip semantics only where they differ from the shared step.

Basic remains exactly NodeJS and Git. Their IDs, lifecycle functions and TUI
boundary do not change.

### 3.3 Build contract

Replace the macOS-only Unix artifact ownership with an explicit `Unix` entry:

- builder: `installer/build.sh`;
- allowed payload platforms: `macos`, `linux`;
- artifact: one `install.sh`;
- executable files: macOS x64/arm64 plus Linux x64/arm64.

The manifest stores separate macOS and Linux payload composition lists. The
Release artifact list is the exact eight-file set from the PRD. Windows remains
an independent entry owned by `build.ps1`.

## 4. Source Layout

Add a Linux runtime parallel to, but not pretending to be identical to, macOS:

```text
installer/linux/Install.sh
installer/linux/core/Ui.sh
installer/linux/core/Process.sh
installer/linux/core/Profile.sh
installer/linux/core/Platform.sh
installer/linux/core/PackageManager.sh
installer/linux/core/Json.sh
installer/linux/core/Registry.sh
installer/linux/core/Bootstrap.sh
installer/linux/steps/NodeJS.sh
installer/linux/steps/Git.sh
```

Portable algorithms may be extracted into `installer/unix/core/` only when the
same executable contract is proven under Bash 3.2, current Bash and zsh. The
first implementation should reuse contract shapes and test fixtures, not force
macOS Homebrew and Linux package-manager protocols behind a false abstraction.

## 5. Runtime Flow

### 5.1 Unified built `install.sh`

The generated file contains a POSIX-compatible dispatcher followed by encoded
payloads. It performs only these operations:

1. detect `uname -s`;
2. choose macOS zsh or Linux Bash payload;
3. create a private temporary file;
4. decode only the selected payload;
5. execute it with `/bin/zsh` or discovered `bash`;
6. preserve the child exit code and remove temporary files via `trap`.

The dispatcher must not parse unselected platform source. This is why direct
concatenation of zsh and Bash modules is rejected.

### 5.2 Linux preflight

```text
parse args
  -> --list-steps may run without TTY/root checks
  -> require Linux + Bash
  -> reject uid 0 for real install
  -> read /etc/os-release
  -> classify official / best-effort / unsupported
  -> reject WSL1 and musl
  -> normalize uname -m to linux-x64/linux-arm64
  -> validate expected package manager and downloader
  -> require TTY for mutation
```

Unknown exact distro IDs may use `ID_LIKE` only after an explicit unverified
warning and confirmation. A missing or malformed `/etc/os-release` is
unsupported, not silently treated as Ubuntu.

### 5.3 Basic lifecycle

The registry consumes `LinuxStepFile` and preserves the shared state machine:
`Pending -> Running -> Success|Failed|Skipped|Unsupported|ManualRequired`.

- NodeJS: reuse sufficient node/npm; repair current nvm/fnm; otherwise run the
  pinned nvm official installer from the official URL and verify active LTS.
- Git: reuse sufficient Git; otherwise invoke the mapped package manager with
  sudo and verify `git --version`.
- `ccq`: retain version normalization, same-version skip, mismatch
  preserve-by-default and explicit atomic overwrite. Download
  `ccq-linux-x64` or `ccq-linux-arm64` to `~/.local/bin/ccq` and chmod 0755.

The installer does not roll back package-manager or nvm side effects after a
later failure. It reports partial state accurately and remains safe to rerun.
The `ccq` file replacement itself stays atomic.

### 5.4 Profile ownership

The nvm official installer owns nvm initialization. CCQ may idempotently ensure
`~/.local/bin` appears in Bash/Zsh startup only through one marked block or an
equivalent exact-line check. It does not rewrite unrelated PATH entries. Fish
and other shells receive manual instructions only.

## 6. TUI Binary And Lifecycle

Extend `tui/scripts/build.ts` and `tui/package.json` with
`bun-linux-{x64,arm64}` targets and output names from the build contract.
Release still fails if any required target is missing even though local arm64
cross-compile failures may be reported as nonfatal by the developer build.

Extend `getAssetName()` to map:

```text
linux/x64   -> ccq-linux-x64
linux/arm64 -> ccq-linux-arm64
```

`verify-self-update.mjs` must cover both mappings, unsupported architectures,
digest enforcement and the existing POSIX chmod/fsync/rename path with
`platform: 'linux'`. `verify-compiled-contracts.mjs` must accept Linux hosts.

## 7. CI And Release

Add a Linux contract job on `ubuntu-latest` that reads
`linux-platforms.json` and runs each pinned distro image through Docker. Each
matrix member validates Bash syntax, distro classification, package-manager
argv, source `--list-steps`, no-TTY refusal and fixture-driven lifecycle paths.
Tests use fake commands/PATH and temporary HOME values; they do not mutate the
runner host.

Add compiled smokes:

- x64 binary on a native Ubuntu runner;
- arm64 binary on a native public runner when available, otherwise an explicit
  QEMU/container job;
- `--version`, help, no-arg non-TTY behavior and embedded-contract probe.

The Unix build job emits the unified `install.sh` and collects both macOS and
Linux binaries. Release depends on Windows, macOS, Linux installer tests and
both Linux binary smokes. The final collector asserts exactly eight files and
updates the Release body table from the same names.

## 8. Failure Matrix

| Condition | Required result |
|---|---|
| root executes real install | fail before mutation; explain normal-user command |
| no TTY for real install | cancel/fail safely; no package or file mutation |
| unknown distro with known `ID_LIKE` | warn + explicit continue; best-effort only |
| unknown distro/family | unsupported; no guessed package manager |
| WSL1 or musl | unsupported before binary download |
| missing package manager/sudo | `ManualRequired` with exact manual command |
| existing sufficient Node/Git | skip without provider migration |
| step command succeeds but postflight fails | failed step; never false success |
| existing ccq target version unknown | preserve existing binary |
| one Linux binary/build/smoke missing | block the complete Release |
| dispatcher child fails | return child exit code and clean temporary payload |

## 9. Alternatives Rejected

- **A separate `install-linux.sh`:** clearer name but creates a ninth artifact
  and two Unix public entry URLs. The user selected one `install.sh`.
- **Directly reuse macOS zsh source:** couples Linux to Homebrew and macOS APIs.
- **Concatenate zsh and Bash bodies:** the selected interpreter may parse
  incompatible unselected syntax.
- **Install system Node from APT/DNF/Pacman:** versions and permissions diverge
  across the five distro families.
- **Ten distro/architecture jobs:** redundant for an architecture-independent
  installer and too costly for the agreed quality target.
- **Publish arm64 without runtime smoke:** contradicts the two-architecture
  support commitment.

## 10. Rollout And Rollback

This change lands atomically behind contract gates. No Release claim changes
until all eight artifacts and Linux smokes pass. Rollback is a normal revert of
the Linux source/manifest/CI changes; no user data migration is introduced.
Existing Linux users who installed `ccq` receive a normal user-owned binary and
can uninstall through current POSIX self-uninstall behavior.
