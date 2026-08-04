# Installer And Release Product Contracts

此领域适用于 `installer/**`、`installer/contracts/**`、`tui/scripts/build.ts`、
Release CI、`dist/` artifact 与 installer 阶段的 `ccq` download/handoff 行为。

## Contract Index

| Spec | Applies to |
|---|---|
| [平台 Runtime](./platform-runtime.md) | Windows PS5.1、macOS zsh、Basic step 与 ccq handoff |
| [Windows Core](./windows-core.md) | dot-source 顺序、PowerShell contract 与 ccq PATH/replacement helper |
| [Windows Step](./steps.md) | step signature、活动 NodeJS/Git step 与 Registry fallback |
| [Build 与 Release](./build-release.md) | 单文件 installer/executable、embedding 与 artifact gate |

## Directory Boundaries

- `windows/Install.ps1`：PowerShell 5.1+ 单 runtime 入口。
- `windows/core/`：按 [Windows Core](./windows-core.md) 所拥有精确顺序
  dot-source 的 Windows runtime。
- `windows/steps/`：由 [Windows Step](./steps.md) 拥有的活动 NodeJS 与 Git
  实现。
- `macos/Install.zsh`：bash-to-zsh 的 macOS 12+ 原生入口。
- `macos/core/`、`macos/steps/`：zsh、Homebrew 与 nvm 平台实现。
- `contracts/`：`steps.json`、`build.json`、`cleanup-policy.json` 与 contract
  verification。
- `build.ps1`、`build.sh`：installer 生成与四个 executable 收集。

## Pre-Development Checklist

- [ ] 修改 contract、build composition、remote entrypoint 或 cross-platform
      行为时，阅读 Platform Runtime 和 Build 与 Release。
- [ ] 将 `installer/contracts/steps.json` 与 `build.json` 视为 executable
      contract；同步更新 test 与每个 consumer。
- [ ] Windows source 保持 PS5.1-compatible、StrictMode-safe，并在 Release
      没有可用 `$PSScriptRoot` 时仍有效。
- [ ] macOS 原生 zsh/Homebrew/nvm 行为不得引入 Windows 机制。
- [ ] 不要把 Agent 或周边工具生命周期移回 installer。
- [ ] 修改 Windows core 或 step 时，同时加载 [Windows Core](./windows-core.md)
      与 [Windows Step](./steps.md)。
- [ ] 验证 source mode 与 built Release mode。

## Development And Verification

```powershell
pwsh -File installer/windows/Install.ps1 -ListSteps
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/build.ps1
```

```sh
zsh -n installer/macos/Install.zsh
zsh installer/macos/Install.zsh --list-steps
sh installer/build.sh --check
```

## Current Scope

正式平台是 Windows x64/arm64 与 macOS x64/arm64。Linux 仍是未实现的 proposal；
在 source、contract、CI 与 smoke test 一起落地前，不得将其加入当前 artifact
数量或 runtime 声明。
