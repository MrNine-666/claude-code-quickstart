# installer/windows/steps/ -- Windows 安装步骤

本目录实现安装器步骤。当前 `installer/contracts/steps.json` 只消费：

- `NodeJS.ps1`，以及先加载的四个 NodeJS 子模块。
- `Git.ps1`。

`ClaudeCode.ps1` 仅是历史参考，不属于 Basic、Registry fallback 或安装
入口；Claude Code/Codex 及周边工具由 TUI 工具管理承接。

## 必读规范

- [Windows steps contract](../../../.trellis/spec/installer/steps.md)
- [Windows core contract](../../../.trellis/spec/installer/windows-core.md)
- [Platform runtime](../../../.trellis/spec/installer/platform-runtime.md)

新增或修改步骤时，必须同步 `steps.json`、两个受支持平台的实现、Windows
Registry inline fallback 和合约/生命周期测试。Windows 文件保持
`#Requires -Version 5.1` 与 StrictMode 兼容。

## 最小验证

```powershell
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/windows/Install.ps1 -ListSteps
```

```sh
zsh installer/macos/Install.zsh --list-steps
```
