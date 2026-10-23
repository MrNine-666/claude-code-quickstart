# installer/ - Installer Development Entry

Claude Code Quickstart 的跨平台安装器源码目录。这里面向维护者，说明 Windows / macOS / Linux 安装入口、构建入口、契约边界和调试命令；面向用户的产品介绍与 CLI 用法见根目录 [README.md](../README.md)，TUI 子项目开发说明见 [tui/README.md](../tui/README.md)。

---

## Directory Responsibilities

```text
installer/
├── build.ps1              # Windows 人工 scripts-only 构建：install.ps1 / download-tui.ps1
├── build.sh               # Unix 人工 scripts-only 构建：install.sh / download-tui.sh（dispatcher）/ download-tui.zsh
├── contracts/             # install 链契约：steps / build / linux-platforms / cleanup-policy + Test-Contracts.ps1 / Test-LinuxInstaller.sh
├── windows/
│   ├── Install.ps1        # Windows PS 5.1+ 完整安装入口
│   ├── Download-Tui.ps1   # Windows 专用 CCQ 下载入口（不装基础环境）
│   ├── core/              # Windows PowerShell runtime core（Ccq.ps1 为 CCQ 行为唯一实现）
│   └── steps/             # Windows 安装步骤模块
├── macos/
│   ├── Install.zsh        # macOS bash→zsh 完整安装入口
│   ├── Download-Tui.zsh   # macOS 专用 CCQ 下载入口（不装基础环境）
│   ├── core/              # macOS zsh runtime core（Ccq.zsh 为 CCQ 实现，Load.zsh 为加载顺序唯一声明）
│   └── steps/             # macOS 安装步骤模块
└── linux/
    ├── Install.sh         # Linux Bash 完整安装入口
    ├── Download-Tui.sh    # Linux 专用 CCQ 下载入口（不装基础环境，不依赖 Node）
    ├── core/              # Linux Bash runtime core（Ccq.sh 为 CCQ 实现，Load.sh 为加载顺序唯一声明，Registry.sh 为 steps.json 的 Bash 快照）
    └── steps/             # Linux 安装步骤模块
```

安装器只负责 Basic 两步（NodeJS / Git）与末尾下载 `ccq` 单文件可执行文件；供应商、配置文件、全局规则、MCP、Skills 和工具管理（含 Claude Code）由 `ccq` 管理控制台承接。`windows/steps/ClaudeCode.ps1` 与 `macos/steps/ClaudeCode.zsh` 仅为历史文件，未被 `contracts/steps.json` 引用，不属于安装流程；Linux 不移植。

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

### Linux

```sh
# 运行源码安装入口（普通用户 + 交互终端；安装系统包时单独调用 sudo）
bash installer/linux/Install.sh

# 只安装 ccq 的专用入口（不装 Node.js / Git）
bash installer/linux/Download-Tui.sh

# 查看 Basic 步骤列表（无 TTY / root 下也可运行）
bash installer/linux/Install.sh --list-steps

# bash 语法检查
bash -n installer/linux/Install.sh installer/linux/Download-Tui.sh installer/linux/core/*.sh installer/linux/steps/*.sh

# 行为测试（fake sudo/包管理器/curl + 临时 HOME，不安装软件、不联网）
bash installer/contracts/Test-LinuxInstaller.sh --host-safe
```

在 Windows 上请使用 Git Bash 的 `bash` / `sh`；PowerShell 中的 `bash` 指向 WSL。`--host-safe` 跳过真实 root 与切换普通用户阶段；五个发行版镜像只在 GitHub CI（`installer-unix.yml`）中运行，不要求本地 Docker。

---

## Build

```powershell
# Windows 本地构建入口（不在 TUI Release CI 中调用）
pwsh -File installer/build.ps1 -ScriptsOnly
```

```sh
# Unix 构建入口（Windows 上用 Git Bash 的 sh）
sh installer/build.sh --scripts-only
sh installer/build.sh --check

# 人工产物验证（不安装软件，不作为 TUI CI 门禁）
node installer/contracts/verify-raw-distribution.mjs
```

默认及显式 scripts-only 模式都只生成对应 builder 的脚本，不编译 TUI，不要求已有 exe/gzip，不读取 `GITHUB_REF_NAME`。Windows builder 需要 PowerShell 7；生成的脚本兼容 PS5.1。Unix builder 需要 Node.js，对 Linux payload 执行 `bash -n`，检测到 zsh 时对 macOS payload 执行 `zsh -n`；`--platform` 只接受 `unix`（默认，`macos` 为兼容别名），始终生成全部三个 Unix 脚本。

默认输出到仓库根目录 `dist/`，这里只跟踪五个自包含脚本：

- `install.ps1`（Windows 完整安装入口，ASCII trampoline）
- `download-tui.ps1`（Windows 专用 CCQ 下载入口，ASCII trampoline）
- `install.sh`（Unix 完整安装入口，POSIX dispatcher：macOS zsh payload + Linux Bash payload）
- `download-tui.sh`（Unix 专用 CCQ 下载入口，同一 dispatcher 结构）
- `download-tui.zsh`（macOS 专用 CCQ 下载入口，bash→zsh wrapper，不嵌 steps 契约，保留以兼容既有 Raw URL）

Unix dispatcher 按 `uname -s` 把对应 payload 从带引号 heredoc 写入 `mktemp` 临时文件，`export CCQ_STREAMED_SCRIPT_PATH` 后 `exec` `/bin/zsh`（Darwin）或 `bash`（Linux），未选中的 payload 不会被解析；heredoc marker 后缀取两个 payload 的 SHA-256 前缀，临时文件由 payload 自身的 EXIT trap 清理；未知平台或缺解释器时先删临时文件再失败。Linux payload 不嵌入契约，按 `Load.sh` 顺序内联 core（完整安装再加 steps）。

人工流程：修改 installer → 分别运行两个 builder → 验证 ASCII/PS5.1 Parser、`-ListSteps` / `-Help`、`bash -n` / `zsh -n`、`--list-steps` / `--help` → 审阅并提交五个脚本到 main。builder 不执行 commit/tag/push，也不预删已有脚本或其他构建产物；TUI builder 只清理所选目标的 raw/gzip，保留五个脚本。

**上线顺序：先 Release，后提交脚本。** 脚本默认下载 `releases/latest/download`，必须先发布含 Linux 资产的稳定 Release（确认 12 个资产、Linux smoke 通过且已是 latest stable），再本地构建并提交含 Linux 支持的 `dist/install.sh` 与 `dist/download-tui.sh`，同时更新根 README 与 Release 正文的 Linux 命令。在此之前 main 上的 Unix 脚本保持 macOS-only 行为。回滚脚本只需恢复上一版 `dist/*.sh`。

固定入口为 `https://raw.githubusercontent.com/MrNine-666/claude-code-quickstart/main/dist/<脚本名>`（`install.ps1`、`download-tui.ps1`、`install.sh`、`download-tui.sh`、`download-tui.zsh`；Linux 支持自 v2.7.0 起上线），用户命令见[根 README](../README.md#安装)。脚本无版本号，默认下载最新稳定版二进制；已有程序仍保留，升级用 `ccq update`。维护者需保证滚动脚本与最新稳定版兼容。

TUI Release CI 采用 sparse checkout 排除 `dist` 安装脚本，只使用 TUI 与构建契约；不读取、构建或上传安装脚本，只发布以下十二个 raw/gzip artifact（Linux x64 以 `bun-linux-x64-baseline` 编译，不要求 AVX2；Linux 仅 glibc）：

- `ccq-windows-x64.exe`
- `ccq-windows-x64.exe.gz`
- `ccq-windows-arm64.exe`
- `ccq-windows-arm64.exe.gz`
- `ccq-macos-x64`
- `ccq-macos-x64.gz`
- `ccq-macos-arm64`
- `ccq-macos-arm64.gz`
- `ccq-linux-x64`
- `ccq-linux-x64.gz`
- `ccq-linux-arm64`
- `ccq-linux-arm64.gz`

Linux x64 / arm64 分别在 `ubuntu-latest` / `ubuntu-24.04-arm` 上做原生 smoke（`smoke-linux`），二者是 Release 前置；任一缺失或失败则不发布部分资产。

`contracts/build.json` 的 `BuildEntrypoints.{Windows,Unix}.Artifacts` 仅声明人工脚本集合，`ReleaseArtifacts` 只声明十二个二进制传输资产，并与 `UpdateTransports.GzipAssets` 的 raw/gzip 映射一致。脚本拼接由 `Role`（`Install` / `CcqDownload`）决定：`Unix.Artifacts[role]` = dispatcher(`MacOS.Artifacts[role]` payload, `Linux.Artifacts[role]` payload)，`download-tui.zsh` 仍由 `MacOS.CcqDownload` 直接输出。

`.github/workflows/installer-unix.yml` 在 `installer/**`、`dist/*.sh`、`dist/download-tui.zsh` 或该 workflow 变化时运行，测试本次新鲜构建的 Unix 脚本（不读 `dist/`）：`linux-matrix` 按 `contracts/linux-platforms.json` 的五个镜像（Ubuntu 24.04 / Debian 13 / Fedora 44 / CentOS Stream 10 / Arch）用 `docker run` 运行 `Test-LinuxInstaller.sh`，`macos-dispatcher` 验证 `sh` / `bash` / `curl | bash` / `zsh` 分派与临时文件清理。它不是 TUI Release 前置；直推 main 时只能事后报红。

新 Release 不提供脚本附件；旧 `releases/latest/download/install.*` / `download-ccq.*` 命令需迁移到 Raw main/dist。历史 Profile URL 检测保留，用于清理旧配置。

---

## Contract Boundaries

- install 链契约位于 `installer/contracts/`，包括步骤分组、构建配置、清理策略和契约测试。
- TUI 链契约位于 `tui/contracts/`，其中运行时消费项会内嵌进 `ccq` 可执行文件。
- Windows、macOS 与 Linux 共享 install 契约；平台差异只放在各自 runtime core / steps 中。
- `contracts/linux-platforms.json` 是 Linux 发行版矩阵唯一 owner（CI 镜像、family → 包管理器、`ID_LIKE` 映射、架构别名、glibc/WSL 策略）。Bash runtime 在 bootstrap 前不能依赖 node/jq，`linux/core/Platform.sh`、`PackageManager.sh`、`Registry.sh` 保留等价实现，由 `Test-Contracts.ps1` 与 `Test-LinuxInstaller.sh` 检测漂移。

---

## Key Constraints

- Windows 安装入口必须兼容 PowerShell 5.1，不得使用 PS7 专有语法。
- Windows 构建后的 `dist/install.ps1` 必须保持纯 ASCII trampoline，以兼容 `irm ... | iex` 在 PS5.1 下的编码行为。
- `dist/*.ps1` 通过 `irm ... | iex` 执行时没有稳定 `$PSScriptRoot`，进入单文件 artifact 的路径读取必须先判空并提供 fallback。
- NodeJS 步骤采用运行时优先：Windows/macOS/Linux 现有 node/npm 版本达标均直接跳过；不达标时优先在当前 provider 内安装/更新到 LTS，不做跨 provider 迁移；Windows 无法安全修复时使用 nvm/direct 兜底，macOS/Linux 无法原地修复时通过 nvm 官方脚本兜底（Linux 不用发行版包管理器装系统 Node）。
- Linux 只支持 glibc x64/arm64；Alpine/musl、WSL1、32 位及其他架构在下载前拒绝。正式覆盖五个 CI 基线；衍生版（`ID_LIKE`）、非基线版本与 WSL2 仅尽力兼容，需警告并确认。
- Linux 真实安装拒绝 root，只对单条包管理命令调用 `sudo`；所有交互经 `/dev/tty`，无 TTY 时零修改退出。Pacman 只执行 `pacman -S --needed`，失败进入 `ManualRequired` 并提示 `sudo pacman -Syu git`。
- Linux `os-release` 逐行解析，禁止 `eval` / `source`；`~/.local/bin` 经标记块幂等写入 `~/.bashrc`（及已存在的 `~/.zshrc`），fish 等其他 shell 只给手动指引。
- `dist/*.sh`、`installer/build.sh`、`installer/linux/**` 与 `installer/contracts/*.sh` 由 `.gitattributes` 固定为 LF。
- 修改 contracts、构建拼接、远程入口后，验证源码模式与人工生成的自包含 artifact。完整安装器契约仅属本地检查，不作为 TUI Release 门禁。
