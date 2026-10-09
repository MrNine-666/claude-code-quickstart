# installer/ - Installer Development Entry

Claude Code Quickstart 的跨平台安装器源码目录。这里面向维护者，说明 Windows / macOS 安装入口、构建入口、契约边界和调试命令；面向用户的产品介绍与 CLI 用法见根目录 [README.md](../README.md)，TUI 子项目开发说明见 [tui/README.md](../tui/README.md)。

---

## Directory Responsibilities

```text
installer/
├── build.ps1              # Windows 人工 scripts-only 构建：install.ps1 / download-tui.ps1
├── build.sh               # macOS / Unix 人工 scripts-only 构建：install.sh / download-tui.zsh
├── contracts/             # install 链契约：steps / build / cleanup-policy + Test-Contracts.ps1
├── windows/
│   ├── Install.ps1        # Windows PS 5.1+ 完整安装入口
│   ├── Download-Tui.ps1   # Windows 专用 CCQ 下载入口（不装基础环境）
│   ├── core/              # Windows PowerShell runtime core（Ccq.ps1 为 CCQ 行为唯一实现）
│   └── steps/             # Windows 安装步骤模块
└── macos/
    ├── Install.zsh        # macOS bash→zsh 完整安装入口
    ├── Download-Tui.zsh   # macOS 专用 CCQ 下载入口（不装基础环境）
    ├── core/              # macOS zsh runtime core（Ccq.zsh 为 CCQ 实现，Load.zsh 为加载顺序唯一声明）
    └── steps/             # macOS 安装步骤模块
```

安装器只负责 Basic 三步（NodeJS / Git / ClaudeCode）与末尾下载 `ccq` 单文件可执行文件；供应商、配置文件、全局规则、MCP、Skills 和工具管理由 `ccq` 管理控制台承接。

---

## Local Debugging

### Windows

```powershell
# Windows 源码安装入口（PS 5.1+ 兼容）
pwsh -File installer/windows/Install.ps1

# 只安装 ccq 的专用入口（不装 Node.js / Git）
pwsh -File installer/windows/Download-Tui.ps1

# 查看 Basic 步骤列表
pwsh -File installer/windows/Install.ps1 -ListSteps
```

### macOS

```sh
# 运行源码安装入口
zsh installer/macos/Install.zsh

# 只安装 ccq 的专用入口（不装 Node.js / Git）
zsh installer/macos/Download-Tui.zsh

# 查看 Basic 步骤列表
zsh installer/macos/Install.zsh --list-steps

# zsh 语法检查
zsh -n installer/macos/Install.zsh
zsh -n installer/macos/Download-Tui.zsh
```

---

## Build

```powershell
# Windows 本地构建入口（不在 TUI Release CI 中调用）
pwsh -File installer/build.ps1 -ScriptsOnly
```

```sh
# macOS / Unix 构建入口
sh installer/build.sh --scripts-only
sh installer/build.sh --check

# 人工产物验证（不安装软件，不作为 TUI CI 门禁）
node installer/contracts/verify-raw-distribution.mjs
```

默认及显式 scripts-only 模式都只生成当前平台的脚本，不编译 TUI，不要求已有 exe/gzip，不读取 `GITHUB_REF_NAME`。Windows builder 需要 PowerShell 7；生成的脚本兼容 PS5.1。macOS / Unix builder 需要 Node.js，检测到 zsh 时执行语法检查。

默认输出到仓库根目录 `dist/`，这里只跟踪四个自包含脚本：

- `install.ps1`（Windows 完整安装入口，ASCII trampoline）
- `download-tui.ps1`（Windows 专用 CCQ 下载入口，ASCII trampoline）
- `install.sh`（macOS 完整安装入口，bash→zsh wrapper）
- `download-tui.zsh`（macOS 专用 CCQ 下载入口，bash→zsh wrapper，不嵌 steps 契约）

人工流程：修改 installer → 分别运行两个 builder → 验证 ASCII/PS5.1 Parser、`-ListSteps` / `-Help`、`zsh -n`、`--list-steps` / `--help` → 审阅并提交四个脚本到 main。builder 不执行 commit/tag/push，也不预删已有脚本或其他构建产物；TUI builder 只清理所选目标的 raw/gzip，保留四个脚本。

固定入口为 `https://raw.githubusercontent.com/MrNine-666/claude-code-quickstart/main/dist/<脚本名>`，用户命令见[根 README](../README.md#安装)。脚本无版本号，默认下载最新稳定版二进制；已有程序仍保留，升级用 `ccq update`。维护者需保证滚动脚本与最新稳定版兼容。

TUI Release CI 采用 sparse checkout 排除 `dist` 安装脚本，只使用 TUI 与构建契约；不读取、构建或上传安装脚本，只发布以下八个 raw/gzip artifact：

- `ccq-windows-x64.exe`
- `ccq-windows-x64.exe.gz`
- `ccq-windows-arm64.exe`
- `ccq-windows-arm64.exe.gz`
- `ccq-macos-x64`
- `ccq-macos-x64.gz`
- `ccq-macos-arm64`
- `ccq-macos-arm64.gz`

`contracts/build.json` 的 `BuildEntrypoints.{Windows,MacOS}.Artifacts` 仅声明人工脚本集合，`ReleaseArtifacts` 只声明八个二进制传输资产，并与 `UpdateTransports.GzipAssets` 的 raw/gzip 映射一致。脚本拼接由 `Role`（`Install` / `CcqDownload`）决定。

新 Release 不提供脚本附件；旧 `releases/latest/download/install.*` / `download-ccq.*` 命令需迁移到 Raw main/dist。历史 Profile URL 检测保留，用于清理旧配置。

---

## Contract Boundaries

- install 链契约位于 `installer/contracts/`，包括步骤分组、构建配置、清理策略和契约测试。
- TUI 链契约位于 `tui/contracts/`，其中运行时消费项会内嵌进 `ccq` 可执行文件。
- Windows 与 macOS 共享 install 契约；平台差异只放在各自 runtime core / steps 中。

---

## Key Constraints

- Windows 安装入口必须兼容 PowerShell 5.1，不得使用 PS7 专有语法。
- Windows 构建后的 `dist/install.ps1` 必须保持纯 ASCII trampoline，以兼容 `irm ... | iex` 在 PS5.1 下的编码行为。
- `dist/*.ps1` 通过 `irm ... | iex` 执行时没有稳定 `$PSScriptRoot`，进入单文件 artifact 的路径读取必须先判空并提供 fallback。
- NodeJS 步骤采用运行时优先：Windows/macOS 现有 node/npm 版本达标均直接跳过；不达标时优先在当前 provider 内安装/更新到 LTS，不做跨 provider 迁移；Windows 无法安全修复时使用 nvm/direct 兜底，macOS 无法原地修复时通过 nvm 官方脚本兜底。
- 修改 contracts、构建拼接、远程入口后，验证源码模式与人工生成的自包含 artifact。完整安装器契约仅属本地检查，不作为 TUI Release 门禁。
