# installer/ — 安装器入口层

> 面包屑：[根目录](../CLAUDE.md) › installer/
> 生成时间：2026-06-24（Manage TUI 从 Ink 迁移到 OpenTUI + Bun 单文件可执行分发 + ccq 直跑（不注入 Profile））

---

## 文件职责

| 路径/文件 | 平台/运行时 | 职责 |
|------|---------|------|
| `windows/Install.ps1` | Windows / PS 5.1+ | Windows 安装入口：**PS5.1 单运行时**，前置检测内联（Windows 版本 / winget 自动安装 / PS7 非阻塞推荐 / Windows Terminal）+ Basic 三步直装（NodeJS / Git / ClaudeCode），无 re-exec；**末尾确认下载 ccq.exe 到 %USERPROFILE%/.local/bin/（与 Claude Code native installer 同目录）并加入用户 PATH** |
| `windows/core/` | Windows / PowerShell | Windows runtime core：Ui、Process、Profile、Json、Registry、Update、Admin、Net、**ccq 可执行文件管理函数**（架构检测 / 下载 / PATH） |
| `windows/steps/` | Windows / PowerShell | Windows 9 个安装步骤模块（NodeJS 含 5 子模块 / Git / ClaudeCode / Ccline / ClaudeConfig / ClaudeMd / OpenSpec / CodexCli / AntigravityCli）；**CcSwitch / CcgWorkflow / Mcp 已删除**（迁 TUI 或废弃） |
| `contracts/`（installer 内） | JSON 契约 + 测试 | install 链契约：`steps.json`（StepId / 分组 / 依赖）、`build.json`、`cleanup-policy.json` + `Test-Contracts.ps1`（Windows/macOS 共享） |
| `tui/`（根级） | Bun / OpenTUI | **Manage TUI 子项目**：`src/` TypeScript 实现 **6 菜单**（供应商 / MCP / Skills / 提示词 / 配置文件 / 工具管理），经 `bun build --compile` 交叉编译为 4 平台单文件可执行产物；contracts 在 `tui/contracts/`（内嵌进可执行文件） |
| `macos/Install.zsh` | macOS / bash→zsh | macOS 安装入口：前置检测内联 + Basic 直装 + **末尾确认下载 ccq 到 ~/.local/bin/（与 Claude Code native installer 同目录）并确保该目录在 PATH**，支持 `curl ... | bash` 后自动切换 `/bin/zsh` |
| `build.ps1` | PowerShell 5.1+ | Windows / GitHub Actions 构建入口，输出 `install.ps1`；并从 `tui/dist/` 拷贝 2 个 Windows ccq 可执行文件到 `dist/` |
| `build.sh` | POSIX sh | macOS / Unix 本机构建入口，输出 `install.sh`；并从 `tui/dist/` 拷贝 2 个 macOS ccq 可执行文件到 `dist/` |

旧入口 `windows/Bootstrap.ps1`（前置检测入口，非 core/Bootstrap.ps1）、`windows/Manage.ps1`、`macos/Manage.zsh` 已删除，管理面板改为直接运行 `ccq` 命令。旧 ManageCore.ps1 / ManageCore.zsh（目录缓存 wrapper）已删除。旧 `installer/Bootstrap.ps1` / `installer/Install.ps1` / `installer/Manage.ps1` 和旧构建入口 `installer/build/Build-SingleFile.ps1` 不作为支持路径保留。

---

## 云端短 artifact

```text
Windows（3 件）
├── install.ps1               # PS 5.1+ 安装入口（前置检测 + Basic 直装 + 末尾下载 ccq.exe）
├── ccq-windows-x64.exe       # ccq Windows x64 单文件可执行
└── ccq-windows-arm64.exe     # ccq Windows ARM64 单文件可执行

macOS（3 件）
├── install.sh                # bash→zsh 安装入口（前置检测 + Basic 直装 + 末尾下载 ccq）
├── ccq-macos-x64             # ccq macOS x64 单文件可执行
└── ccq-macos-arm64           # ccq macOS ARM64 单文件可执行（Apple Silicon）
```

首次安装命令：

```powershell
irm https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.ps1 | iex
```

```sh
curl -fsSL https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.sh | bash
```

安装后直接运行 `ccq` 命令进入管理面板（6 菜单），**不再注入 Profile**。

---

## Windows 源码调试命令

```powershell
# 验证全部 PowerShell 文件语法
pwsh -File test-syntax.ps1

# 安装（PS5.1 单运行时直跑，末尾下载 ccq.exe）
pwsh -File installer/windows/Install.ps1

# 查看步骤列表（仅列 Basic）
pwsh -File installer/windows/Install.ps1 -ListSteps

# 直接运行 ccq（安装后）
ccq

# 从源码运行 TUI（开发调试）
cd tui
bun run dev
```

---

## macOS 源码调试命令

```sh
# 安装（末尾下载 ccq）
zsh installer/macos/Install.zsh

# 查看 macOS 步骤列表（仅列 Basic）
zsh installer/macos/Install.zsh --list-steps

# 直接运行 ccq（安装后）
ccq

# 从源码运行 TUI（开发调试）
cd tui
bun run dev
```

macOS 硬约束：最低 macOS 12+；使用 Homebrew + nvm（**只做 nvm，不支持 fnm/npm 全局包备份**）；Profile 写入 `~/.zprofile` / `~/.zshrc`；禁止调用 winget、注册表、MSI/EXE、Windows Terminal 或 Windows `$PROFILE`。

---

## 构建命令

```powershell
# Windows / CI Windows job 构建入口（生成 install.ps1 + 2 个 Windows ccq 可执行文件）
pwsh -File installer/build.ps1
```

```sh
# macOS / Unix 本机构建入口（生成 install.sh + 2 个 macOS ccq 可执行文件）
sh installer/build.sh
sh installer/build.sh --check
```

默认输出目录为 repo 根目录 `dist/`。CI Release job 汇总两个平台 job 产物后上传 **6 个 artifact**（`install.ps1` / `install.sh` / `ccq-windows-x64.exe` / `ccq-windows-arm64.exe` / `ccq-macos-x64` / `ccq-macos-arm64`）。

---

## 加载边界

- Windows core 加载顺序：`Ui.ps1` → `Process.ps1` → `Profile.ps1` → `Json.ps1` → `Update.ps1` → `Admin.ps1` → `Net.ps1` → `Registry.ps1`（`Update.ps1` 须在 Profile 之后：依赖 `Write-FileAtomically`/`Initialize-BackupDirectory`；`Json.ps1` 提供 PS5.1 兼容 `ConvertFrom-JsonToHashtable`）。旧 `ManageCore.ps1` 已删除。
- Windows steps 由 `Get-StepFiles` 从 `installer/contracts/steps.json` 生成，路径必须是 `windows/steps/*.ps1`。
- macOS steps 使用 `MacOSStepFile`，路径必须是 `macos/steps/*.zsh`。
- install 链契约读取 `installer/contracts/`（steps / build / cleanup-policy），TUI 链契约在 `tui/contracts/`（claude-config / mcp-servers / providers / templates），**内嵌进 ccq 可执行文件**；内联 fallback 只用于 release artifact 或 contracts 不可用场景。

### Release 单文件执行边界（HC-15）

`dist/*.ps1` 通过 `irm ... | iex` 执行时没有稳定脚本文件上下文，`$PSScriptRoot` 为空。进入 Windows 单文件 artifact 的 `windows/core/*.ps1` 与 `windows/steps/*.ps1` 必须遵守：

1. 不得裸用 `$PSScriptRoot` 推导源码路径；使用前先判空。
2. 不得把空字符串传给 `Join-Path` / `Test-Path` / `Get-Content` 等 `-Path` 参数。
3. contracts/templates 查找失败时，必须回退到 inline fallback、环境变量 fallback 或安全跳过。
4. Windows Release `dist/install.ps1` 必须是纯 ASCII trampoline（`installer/contracts/build.json` 的 `OutputEncoding` 固定为 `asciiTrampoline`）。GitHub Release asset 返回 `application/octet-stream` 时，PS5.1 的 `irm ... | iex` 会把 UTF-8 字节误解码为 Latin1/ANSI，BOM 也无法纠正；入口脚本里的 `[Console]::OutputEncoding` / `SetConsoleOutputCP(65001)` 只能修复控制台输出，不能修复已被 `irm` 误解码的脚本文本。真实脚本必须以 base64 内嵌，并在本机用 `[Text.Encoding]::UTF8.GetString(...)` 还原后执行。
5. 修改 contracts、templates、构建拼接、远程入口相关代码后，必须同时验证：
   - 源码模式：`pwsh -File installer/windows/Install.ps1`
   - Release 模式：`irm 'https://.../install.ps1' | iex`

典型错误：

```powershell
$root = $PSScriptRoot
Test-Path (Join-Path $root "installer\contracts")
```

`irm|iex` 场景下 `$root` 为空，会触发：

```text
Cannot bind argument to parameter 'Path' because it is an empty string.
```

---

## ccq 可执行文件管理（OpenTUI + Bun 单文件）

**OpenTUI + Bun 单文件可执行迁移**（2026-06-24）：Manage 从 Ink + Node 22 + 目录型 tgz 缓存迁移到 **OpenTUI + Bun `>=1.2.0` + 单文件可执行分发**。`tui/src/` TypeScript 经 `bun build --compile` 交叉编译为 **4 平台单文件可执行产物**（`ccq-windows-x64.exe` / `ccq-windows-arm64.exe` / `ccq-macos-x64` / `ccq-macos-arm64`），安装时下载到 `~/.local/bin/ccq[.exe]`，与 Claude Code native installer 的 `claude[.exe]` 同目录，并通过用户级 PATH 目录天然可达（**不注入 Profile**）。

### 架构流程

```text
安装后调用链：
  ccq（单文件可执行，通过 PATH 天然可达）
    ↓
  tui/src/index.tsx（OpenTUI 渲染）
    ├─ non-TTY 守卫（HC-NON-TTY）
    ├─ 内嵌版本号（CCQ_VERSION，供热更新比对）
    └─ App（6 菜单 + 整可执行文件热更新）
         ├─ 供应商        ├─ MCP
         ├─ Skills        ├─ 提示词
         ├─ 配置文件       └─ 工具管理（ClaudeCode+Ccline/CcgWorkflow/OpenSpec/CodexCli/AntigravityCli）

安装时调用链：
  Install.ps1 / Install.zsh（末尾确认下载 ccq 可执行文件）
    ↓
  core/ccq 管理函数（架构检测 / 下载 / PATH）
    ├─ Windows: Get-CcqArchitecture / Install-CcqExecutable / Add-DirectoryToUserPath
    └─ macOS: ccq_get_architecture / ccq_install_executable（内部直写 ~/.zprofile 确保 ~/.local/bin 在 PATH）
```

### 离线与热更新

- **离线可用**：可执行文件自包含（零外部依赖 + contracts 内嵌），安装后完全离线运行。但 Skills 安装/更新、工具管理检测/安装、需远端资源的 MCP 操作、热更新检查仍需网络。
- **热更新**：整可执行文件热更新（后台检查 GitHub Release latest 版本 → 强确认下载 → 原子替换 `~/.local/bin/ccq[.exe]`），应用内手动入口为主（优先），后台自动为辅（启动时触发但不阻塞）。
- **旧链清理**：旧 Ink + Node (`manage/source/`) / 目录缓存 wrapper（ManageCore.ps1 / ManageCore.zsh）/ Manage.ps1 / Manage.zsh 入口全链已删除。

产物构建与 PATH 管理细节见根 [CLAUDE.md](../CLAUDE.md) 的「Manage TUI 架构」小节。
