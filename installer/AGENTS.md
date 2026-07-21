# installer/ -- 双平台安装入口

本目录只负责 Windows/macOS 的基础安装链：检测或安装 NodeJS、Git，随后
提供 `ccq` 单文件可执行程序。Agent 和周边工具生命周期属于 TUI。

## 目录边界

- `windows/Install.ps1`：PowerShell 5.1+ 单运行时入口。
- `windows/core/`：Windows dot-source runtime。
- `windows/steps/`：当前只消费 NodeJS 与 Git。
- `macos/Install.zsh`：bash 到 zsh 的 macOS 12+ 原生入口。
- `macos/core/`、`macos/steps/`：zsh/Homebrew/nvm 平台实现。
- `contracts/`：`steps.json`、`build.json`、`cleanup-policy.json`
  与合约测试。
- `build.ps1`、`build.sh`：生成安装脚本并收集四个 ccq 可执行产物。

## 必读规范

- [Installer index](../.trellis/spec/installer/index.md)
- [Platform runtime](../.trellis/spec/installer/platform-runtime.md)
- [Windows core](../.trellis/spec/installer/windows-core.md)
- [Windows steps](../.trellis/spec/installer/steps.md)
- [Build and release](../.trellis/spec/installer/build-release.md)

更细目录入口见 [windows/core/AGENTS.md](windows/core/AGENTS.md) 与
[windows/steps/AGENTS.md](windows/steps/AGENTS.md)。

## 调试与构建

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

涉及单文件、contracts 或远程入口时，同时验证源码模式与构建后的 Release
模式。Windows 保持 PS5.1/StrictMode 兼容；macOS 不得引入 winget、注册表、
MSI/EXE 或 Windows Profile 机制。
