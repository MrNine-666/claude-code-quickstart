# installer/ - Installer Development Entry

Claude Code Quickstart 的跨平台安装器源码目录。这里面向维护者，说明 Windows / macOS 安装入口、构建入口、契约边界和调试命令；面向用户的产品介绍与 CLI 用法见根目录 [README.md](../README.md)，TUI 子项目开发说明见 [tui/README.md](../tui/README.md)。

---

## Directory Responsibilities

```text
installer/
├── build.ps1              # Windows / CI Windows 构建入口：生成 install.ps1 并拷贝 Windows ccq 产物
├── build.sh               # macOS / Unix 构建入口：生成 install.sh 并拷贝 macOS ccq 产物
├── contracts/             # install 链契约：steps / build / cleanup-policy + Test-Contracts.ps1
├── windows/
│   ├── Install.ps1        # Windows PS 5.1+ 安装入口
│   ├── core/              # Windows PowerShell runtime core
│   └── steps/             # Windows 安装步骤模块
└── macos/
    ├── Install.zsh        # macOS bash→zsh 安装入口
    ├── core/              # macOS zsh runtime core
    └── steps/             # macOS 安装步骤模块
```

安装器只负责 Basic 三步（NodeJS / Git / ClaudeCode）与末尾下载 `ccq` 单文件可执行文件；供应商、配置文件、全局规则、MCP、Skills 和工具管理由 `ccq` 管理控制台承接。

---

## Local Debugging

### Windows

```powershell
# 运行源码安装入口（PS 5.1+ 兼容）
pwsh -File installer/windows/Install.ps1

# 查看 Basic 步骤列表
pwsh -File installer/windows/Install.ps1 -ListSteps
```

### macOS

```sh
# 运行源码安装入口
zsh installer/macos/Install.zsh

# 查看 Basic 步骤列表
zsh installer/macos/Install.zsh --list-steps

# zsh 语法检查
zsh -n installer/macos/Install.zsh
```

---

## Build

```powershell
# Windows / CI Windows job 构建入口
pwsh -File installer/build.ps1
```

```sh
# macOS / Unix 构建入口
sh installer/build.sh
sh installer/build.sh --check
```

默认输出到仓库根目录 `dist/`。Release 上传 10 个 artifact：

- `install.ps1`
- `install.sh`
- `ccq-windows-x64.exe`
- `ccq-windows-x64.exe.gz`
- `ccq-windows-arm64.exe`
- `ccq-windows-arm64.exe.gz`
- `ccq-macos-x64`
- `ccq-macos-x64.gz`
- `ccq-macos-arm64`
- `ccq-macos-arm64.gz`

---

## Contract Boundaries

- install 链契约位于 `installer/contracts/`，包括步骤分组、构建配置、清理策略和契约测试。
- TUI 链契约位于 `tui/contracts/`，其中运行时消费项会内嵌进 `ccq` 可执行文件。
- Windows 与 macOS 共享 install 契约；平台差异只放在各自 runtime core / steps 中。

---

## Key Constraints

- Windows 安装入口必须兼容 PowerShell 5.1，不得使用 PS7 专有语法。
- Windows Release `dist/install.ps1` 必须保持纯 ASCII trampoline，以兼容 `irm ... | iex` 在 PS5.1 下的编码行为。
- `dist/*.ps1` 通过 `irm ... | iex` 执行时没有稳定 `$PSScriptRoot`，进入单文件 artifact 的路径读取必须先判空并提供 fallback。
- NodeJS 步骤采用运行时优先：Windows/macOS 现有 node/npm 版本达标均直接跳过；不达标时优先在当前 provider 内安装/更新到 LTS，不做跨 provider 迁移；Windows 无法安全修复时使用 nvm/direct 兜底，macOS 无法原地修复时通过 nvm 官方脚本兜底。
- 修改 contracts、templates、构建拼接、远程入口相关代码后，需要同时验证源码模式与 Release 模式。
