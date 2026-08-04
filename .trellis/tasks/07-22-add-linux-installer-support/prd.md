# Linux Installer Support

## Goal

让受支持的 Linux 用户通过官方 `install.sh` 安装 Node.js、Git 和 `ccq`，
并将 Claude Code、Codex 及周边工具的生命周期继续交给根级 OpenTUI 管理，
保持现有 installer 产品边界不变。

## Background

- 当前正式平台只有 Windows x64/arm64 与 macOS x64/arm64；Linux 尚未实现。
- `tui/scripts/build.ts:18` 只声明四个 Windows/macOS Bun compile target。
- `installer/contracts/build.json` 将 `install.sh` 定义为 macOS artifact，
  `installer/build.sh` 也只接受 `--platform macos`。
- `.github/workflows/build-and-release.yml` 只包含 Windows/macOS 测试、构建
  和 smoke jobs，并按四个可执行文件、六个 Release artifact 做硬校验。
- 迁移记录中的 `add-linux-platform-support` 只有提案、没有任务或已确认范围；
  本 PRD 是当前 Linux 支持边界的唯一任务级来源。

## Requirements

### R1. Installer Boundary

Linux installer 只检测或安装 Node.js、Git 和 `ccq`。不得直接安装或管理
Claude Code、Codex、Provider、MCP、Skills 或其他由 TUI 管理的工具。

### R2. Official Distribution Matrix

首发正式覆盖 Ubuntu、Debian、Fedora、CentOS Stream 与 Arch Linux。每个
发行版只选择一个仍受维护、可在 CI 中复现的版本作为正式测试基线；初始
候选为 Ubuntu 24.04、Debian 12、Fedora 44、CentOS Stream 9 与 Arch
rolling。实现时必须将实际可用的精确 image/tag 固定在 executable contract
中，除 Arch rolling 外不得使用浮动 tag。

CentOS 识别范围仅包含 CentOS Stream 9/10，不包含已停止维护的 CentOS
Linux 7/8。未被选为 CI 基线的受识别版本属于尽力兼容，不享有正式测试保证。

### R3. Architecture And Libc

Release 同时发布 `ccq-linux-x64` 与 `ccq-linux-arm64`。二者只承诺 glibc
环境；Alpine/musl 必须在下载不兼容产物前被明确拒绝，不发布 musl artifact。

### R4. Unified Unix Entry

macOS 与 Linux 共用一个 Release 入口 `install.sh`。该文件只做平台探测、
临时 payload 清理和解释器分派；macOS 继续运行独立 zsh payload，Linux
运行独立 Bash payload。未知 Unix 平台必须明确失败。

新增两个 Linux 可执行文件后，Release artifact 集合必须恰好为八个：

```text
install.ps1
install.sh
ccq-windows-x64.exe
ccq-windows-arm64.exe
ccq-macos-x64
ccq-macos-arm64
ccq-linux-x64
ccq-linux-arm64
```

### R5. Privilege Boundary

真实安装必须由普通用户运行，不允许用 root 执行整段安装链。只有安装系统包
时可对单条包管理命令调用 `sudo`。Node.js 与 `ccq` 必须归当前用户所有，
`ccq` 固定安装到 `~/.local/bin/ccq`。无 sudo、无法提权或系统不可安全修改
时必须进入 `ManualRequired`，不得报告成功。

### R6. Package Managers

- Ubuntu/Debian 使用 APT。
- Fedora/CentOS Stream 使用 DNF；只有目标基线确实需要时才兼容 YUM。
- Arch 使用 Pacman。

缺少预期包管理器、系统不可变或无法取得所需权限时，不得猜测其他修改路径；
必须输出可执行的手动安装指引并安全退出。

### R7. Node.js Strategy

Linux 遵循 runtime-first：现有 `node`/`npm` 达标即复用；检测到 nvm/fnm
时只在当前 provider 内修复；否则使用 nvm 官方脚本做用户级兜底。不得通过
发行版包管理器安装系统 Node，不迁移 provider、PATH 或全局 npm 包。

### R8. Shell And Profile

Linux installer 以 Bash 为唯一运行时，自动处理 Bash/Zsh 的 nvm 与
`~/.local/bin` 初始化。Fish 等其他登录 shell 不自动修改配置，只提供明确
的手动 PATH 指引。重复运行必须幂等，不能重复追加受管初始化片段。

### R9. Interaction Model

首版只支持交互安装。有 TTY 时允许确认安装计划、sudo 和 `ccq` 下载/覆盖；
无 TTY 时只允许 `--list-steps`、语法检查和测试探针，不能依靠隐含默认值
执行系统修改。`ccq` 版本相同跳过、版本不同默认保留、显式覆盖后原子替换的
既有 handoff 语义必须保持一致。

### R10. Best-Effort Environments

Linux Mint、Rocky Linux、AlmaLinux、Manjaro 等衍生发行版可根据
`/etc/os-release` 的 `ID_LIKE` 进入对应家族路径，但必须先显示“未经验证”
警告，不属于正式 CI 或兼容修复承诺。WSL2 同样属于尽力兼容；WSL1 明确
不支持。Windows 原生环境继续只使用 `install.ps1`。

### R11. Contracts And Build

Linux 必须同时进入步骤契约、平台矩阵契约、构建契约、单文件 composition、
Bun compile targets、自更新 asset 选择和 dist 校验。source、contract、
builder、artifact 与 runtime 不能维护相互独立的手写平台列表而缺少一致性门禁。

### R12. CI And Release

测试采用分层矩阵：五个发行版分别验证平台探测、包管理器和安装步骤；Linux
x64/arm64 两个 `ccq` 产物分别执行真实启动 smoke。不要求五个发行版与两种
架构形成十组合全交叉矩阵，但任一正式基线、任一 Linux binary 或统一
`install.sh` 验证失败时都不得发布部分 Release。

### R13. Compatibility

Windows PS5.1 与 macOS 12+ 的现有 source/built 行为、可执行文件、自更新、
artifact 名称和安装边界必须保持兼容。Linux 不能引入 Windows 或 Homebrew
机制，macOS 也不能开始消费 Linux 包管理逻辑。

## Acceptance Criteria

- [ ] AC1 (R2, R6, R10): executable contract 固定五个正式 CI baseline、
      发行版 ID/family/package-manager 映射、衍生版警告和 unsupported 分支，
      contract test 可检测漂移。
- [ ] AC2 (R3, R11): Bun 构建产生可独立运行的 `ccq-linux-x64` 与
      `ccq-linux-arm64`；自更新可选择同名带 SHA-256 digest 的 Release asset。
- [ ] AC3 (R4, R11): 构建后的 `install.sh` 在 Darwin/Linux 分派到正确
      payload，未知 OS、WSL1 与 musl 在执行修改前失败，临时 payload 均被清理。
- [ ] AC4 (R5-R9): Linux source mode 可完成 Node.js、Git、`ccq` 和 PATH
      handoff；复用、缺权限、缺包管理器、无 TTY、版本相同、默认保留和显式
      覆盖路径均有自动化验证，失败不得伪装成功。
- [ ] AC5 (R11, R12): contracts、builders、CI expected lists、Release body
      和 dist 校验一致地声明且只声明八个 artifact，任何缺失均阻断发布。
- [ ] AC6 (R12): 五发行版脚本矩阵和 Linux x64/arm64 binary smoke 为
      Release 前置依赖；不发布部分 Linux 或部分全平台 artifact 集合。
- [ ] AC7 (R13): Windows installer contracts/source/built tests 与 macOS
      zsh/source/built tests继续通过，现有六个 artifact 内容和名称不变。
- [ ] AC8 (R1-R13): installer spec、目录导航和用户安装文档更新为已实现
      的八 artifact/三平台事实，不把 best-effort 环境描述成正式支持。

## Out Of Scope

- Alpine/musl、WSL1、Linux x86/其他架构和额外 musl binary。
- 衍生发行版的正式 CI 与兼容修复承诺。
- 无人值守安装或新增全平台 `--yes` 行为。
- installer 直接安装 Agent、Provider、MCP、Skills 或周边工具。
- 五个发行版与两种 CPU 架构的十组合全交叉 runtime matrix。
