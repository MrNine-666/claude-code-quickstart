# Installer and Release Guidelines

此层适用于 `installer/**`、`installer/contracts/**`、`tui/scripts/build.ts`、
Release CI、`dist/` 产物和安装阶段的 `ccq` 下载。

## Guidelines Index

| Spec | Applies to |
|---|---|
| [Platform Runtime](./platform-runtime.md) | Windows PS5.1, macOS zsh, Basic steps and ccq handoff |
| [Windows Core](./windows-core.md) | Windows core dot-source modules, PowerShell contracts and ccq PATH helpers |
| [Windows Steps](./steps.md) | Windows step function contracts, active NodeJS/Git steps and step registration |
| [Build and Release](./build-release.md) | single-file installers/executables, embedding and artifact gates |

## Pre-Development Checklist

- [ ] Read both installer specs when changing contracts, build composition,
      remote entrypoints or cross-platform behavior.
- [ ] Treat `installer/contracts/steps.json` and `build.json` as executable
      contracts; update tests and both platform consumers together.
- [ ] Keep Windows source PS5.1-compatible and test `$PSScriptRoot`-less Release
      execution assumptions.
- [ ] Keep macOS native zsh/Homebrew/nvm behavior free of Windows mechanisms.
- [ ] Do not move Agent/tool lifecycle back into the installer.
- [ ] When changing Windows core or steps, read [Windows Core](./windows-core.md)
      and [Windows Steps](./steps.md) in addition to this index.
- [ ] Verify source mode and built artifact mode.

## Current Scope

Official platforms are Windows x64/arm64 and macOS x64/arm64. Linux is an
unimplemented OpenSpec proposal and must not be added to current artifact counts
or runtime claims before source, contracts, CI and smoke tests land together.
