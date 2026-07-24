# Linux Installer Support Implementation Plan

## Preconditions

- Do not run `task.py start` until the user reviews `prd.md`, `design.md` and
  this plan.
- Before editing production code, load `trellis-before-dev` and the current
  installer specs.
- Preserve unrelated work and keep Windows/macOS source behavior gated during
  every phase.

## 1. Establish Contract Gates

- [ ] Add `installer/contracts/linux-platforms.json` with pinned official
      distro images, exact IDs/families, package managers, architecture aliases,
      glibc policy and best-effort mappings.
- [ ] Verify candidate CI images exist; pin exact non-rolling tags and document
      why Arch alone uses a rolling tag.
- [ ] Extend `installer/contracts/steps.json` with Linux runtime directory and
      `LinuxStepFile` fields for NodeJS/Git.
- [ ] Redesign `installer/contracts/build.json` around a Unix dispatcher owning
      one `install.sh`, separate macOS/Linux payload compositions and the exact
      eight-file Release list.
- [ ] Extend `installer/contracts/Test-Contracts.ps1` to fail first on missing or
      inconsistent Linux paths, distro mappings, payloads, binaries and counts.
- [ ] Add a Bash-focused contract test under `installer/contracts/` for fixture
      platform detection, command mapping, privilege/no-TTY behavior and
      lifecycle postflight.

Rollback point: contract-only changes may be reverted without touching runtime.

## 2. Implement Linux Source Runtime

- [ ] Add `installer/linux/Install.sh` and Bash core modules for UI, process,
      profile, platform, package manager, JSON/registry and bootstrap behavior.
- [ ] Implement `/etc/os-release` parsing without `eval`; accept only validated
      keys/values and fixture-test malformed input.
- [ ] Implement official, best-effort and unsupported classification including
      CentOS Stream, WSL1/WSL2 and glibc/musl branches.
- [ ] Normalize `x86_64`/`amd64` and `aarch64`/`arm64`; reject every other arch.
- [ ] Enforce normal-user, sudo-per-command and TTY-before-mutation boundaries.
- [ ] Add Linux NodeJS lifecycle: sufficient runtime reuse, current nvm/fnm
      repair, official nvm fallback and verification.
- [ ] Add Linux Git lifecycle using only the contract-selected package manager
      and post-install verification.
- [ ] Add idempotent Bash/Zsh `~/.local/bin` handling and manual other-shell
      instructions without rewriting unrelated profile content.
- [ ] Implement Linux `ccq` architecture URL selection, version handoff,
      download, chmod and atomic replacement at `~/.local/bin/ccq`.
- [ ] Prove partial failures report the correct lifecycle state and reruns do
      not duplicate profile blocks or migrate Node providers.

Focused validation:

```sh
bash -n installer/linux/Install.sh installer/linux/core/*.sh installer/linux/steps/*.sh
bash installer/linux/Install.sh --list-steps
bash installer/contracts/Test-LinuxInstaller.sh
pwsh -File installer/contracts/Test-Contracts.ps1
```

Rollback point: Linux directory is isolated; Windows/macOS remain untouched.

## 3. Build The Unified Unix Installer

- [ ] Refactor `installer/build.sh` from macOS-only output to the manifest-owned
      Unix artifact without importing Windows composition.
- [ ] Generate a POSIX dispatcher that embeds separate encoded macOS zsh and
      Linux Bash payloads, decodes only the selected payload, propagates exit
      status and cleans temporary files.
- [ ] Preserve the existing macOS source order, steps contract embedding,
      Release tag injection and version-handoff semantics inside its payload.
- [ ] Add Linux source order and embedded contracts from `build.json`.
- [ ] Validate dispatcher structure, both payload markers, no repository path
      dependencies and unknown-platform failure.
- [ ] Update local build help/check behavior and installer navigation docs.

Focused validation:

```sh
sh installer/build.sh --check
sh installer/build.sh --platform unix
zsh -n installer/macos/Install.zsh
zsh installer/macos/Install.zsh --list-steps
bash installer/linux/Install.sh --list-steps
```

Built artifact smokes run on the matching CI OS rather than platform spoofing
the real payload execution.

Rollback point: restore the macOS-only manifest/builder before any Release
expected-list change is merged.

## 4. Add Linux TUI Binaries And Self-Lifecycle

- [ ] Extend `tui/scripts/build.ts` target registry and comments with
      `bun-linux-x64` and `bun-linux-arm64`.
- [ ] Add focused package scripts only if they remain useful alongside the
      central target registry; do not create a second artifact-name source.
- [ ] Extend `tui/scripts/verify-compiled-contracts.mjs` for Linux current hosts.
- [ ] Extend `tui/src/core/self-update.ts:getAssetName` with both Linux assets.
- [ ] Extend `tui/scripts/verify-self-update.mjs` for Linux x64/arm64 selection,
      digest failure and the shared POSIX atomic apply path.
- [ ] Confirm POSIX self-uninstall and open-url behavior need no Linux-specific
      fork; add a regression only where evidence exposes a gap.

Focused validation:

```sh
cd tui
bun run typecheck
bun scripts/verify-self-update.mjs
bun scripts/verify-compiled-contracts.mjs
bun run build
```

Rollback point: Linux targets and asset mapping revert together; never retain
published assets that the installed runtime cannot select.

## 5. Wire CI And Release

- [ ] Add a Linux source/contract job whose Docker matrix is generated from
      `linux-platforms.json`; use fake commands and temporary HOME for mutation
      tests.
- [ ] Add native Linux x64 compiled smoke and native-or-QEMU Linux arm64 smoke.
- [ ] Make the Unix artifact build collect macOS and Linux binaries plus the
      unified `install.sh`.
- [ ] Update upload/download paths, platform cleanup lists, expected files,
      final count and Release body table to the exact eight-file contract.
- [ ] Make Release depend on all platform tests and both Linux binary smokes;
      fail closed on any missing artifact or digest.
- [ ] Keep main-branch and tag-version smoke expectations aligned with current
      version injection.

CI validation cases:

- Ubuntu/Debian -> APT mapping.
- Fedora/CentOS Stream -> DNF/YUM contract mapping.
- Arch -> Pacman mapping.
- derivative `ID_LIKE` -> warning and explicit continue.
- WSL1/musl/unknown -> no mutation and unsupported result.
- Linux x64/arm64 -> `--version`, help, no-arg non-TTY, embedded contracts.

Rollback point: do not change Release publication dependencies until all new
jobs are independently green.

## 6. Documentation And Durable Specs

- [ ] Update `.trellis/spec/installer/platform-runtime.md` with Linux runtime,
      distro/package-manager, privilege, shell and best-effort contracts.
- [ ] Update `.trellis/spec/installer/build-release.md` from six to eight
      artifacts and document the Unix dispatcher/payload build.
- [ ] Update `.trellis/spec/installer/index.md`, root `AGENTS.md`,
      `installer/AGENTS.md`, installer README and user-facing install commands.
- [ ] Remove wording that still calls Linux a proposal or unsupported platform;
      retain explicit Alpine/WSL1/derivative limitations.
- [ ] Ensure Release notes and docs do not claim the ten-combination matrix.

## 7. Full Quality Gate

Run focused gates first, then the complete blast-radius checks:

```powershell
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/windows/Install.ps1 -ListSteps
pwsh -File installer/build.ps1
```

```sh
zsh -n installer/macos/Install.zsh
zsh installer/macos/Install.zsh --list-steps
bash -n installer/linux/Install.sh installer/linux/core/*.sh installer/linux/steps/*.sh
bash installer/linux/Install.sh --list-steps
bash installer/contracts/Test-LinuxInstaller.sh
sh installer/build.sh --check
```

```sh
cd tui
bun run check
bun run build
```

- [ ] Smoke the built `install.sh` on real macOS and Linux paths.
- [ ] Smoke `ccq-linux-x64` and `ccq-linux-arm64` in CI.
- [ ] Verify dist and Release collections contain exactly eight artifacts.
- [ ] Run `git diff --check` and review that unrelated user changes remain.
- [ ] Perform final spec/source/CI consistency review before commit/archive.

## Completion Gate

Implementation is complete only when AC1-AC8 in `prd.md` are all evidenced by
source, focused gates and the full CI-compatible validation set. A locally built
Linux binary without the unified installer, distro matrix or Release blockers
does not count as partial completion suitable for release.
