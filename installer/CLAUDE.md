# installer/ — 安装器入口层

> 面包屑：[根目录](../CLAUDE.md) › installer/
> 生成时间：2026-06-14 (MCP 架构重构：Install 自给自足 + 轻量 Manager wrapper)

---

## 文件职责

| 路径/文件 | 平台/运行时 | 职责 |
|------|---------|------|
| `windows/Bootstrap.ps1` | Windows / PS 5.1+ | 前置检测：Windows 版本 → winget → Windows Terminal → PS 7 安装 → Git Bash UTF-8 |
| `windows/Install.ps1` | Windows / PS 7.0+ | Windows 安装入口：Basic / Advanced 分组安装，动态加载 `windows/core/` 与 `windows/steps/` |
| `windows/Manage.ps1` | Windows / PS 7.0+ | Windows 管理入口：加载 ManageCore，并路由到 JS 管理面板（Update / Provider / MCP / Skills） |
| `windows/core/` | Windows / PowerShell | Windows runtime core：UI、Process、Profile、Registry、Bootstrap、**McpManager（轻量 wrapper）**、**ManageCore（Manage JS 集合部署 wrapper）**、Provider |
| `windows/steps/` | Windows / PowerShell | Windows 13 个安装步骤 + Skills 管理模块，StepId 与 macOS 保持一致 |
| `contracts/` | JSON 契约 + Node.js 脚本 | 跨平台 StepId、分组、依赖、Provider、MCP、ClaudeConfig、模板、构建清单、Skills catalogue、UI 文案策略 + **Manage/MCP 管理 JS 脚本集合** |
| `contracts/scripts/manage.js` | Node.js | **Manage 管理面板入口**：子菜单路由到 Provider / Skills / Update / MCP 四个子管理器，含共享原子写入、Profile 锁、临时缓存工具 |
| `contracts/scripts/provider-manager.js` | Node.js | **Provider 管理核心**：供应商 CRUD、settings.json 字段所有权、Profile 标记块同步 |
| `contracts/scripts/skills-manager.js` | Node.js | **Skills 管理核心**：发现、安装、更新、卸载、发现缓存与 CCG 管理技能过滤 |
| `contracts/scripts/update-manager.js` | Node.js | **Update 管理核心**：版本检测、npm outdated 缓存、快照、更新摘要与回滚 API |
| `contracts/scripts/mcp-manager.js` | Node.js | **MCP 管理核心**：状态计算、CRUD、凭据同步、Rules 渲染、交互 TUI（1180 行，零外部依赖）|
| `macos/Install.zsh` | macOS / bash→zsh | macOS 安装入口：合并 Bootstrap 前置检测，支持 `curl ... | bash` 后自动切换 `/bin/zsh` |
| `macos/Manage.zsh` | macOS / zsh | macOS 管理入口：加载 ManageCore，并路由到 JS 管理面板（Update / Provider / MCP / Skills） |
| `macos/core/McpManager.zsh` | macOS / zsh | macOS MCP 管理轻量 wrapper（175 行），调用 `~/.ccq/scripts/mcp-manager.js` |
| `build.ps1` | PowerShell 7+ | Windows / GitHub Actions 构建入口，输出 `bootstrap.ps1`、`install.ps1`（含 MCP JS 内嵌）、`manage.ps1`（含 MCP + Manage JS 集合内嵌）|
| `build.sh` | POSIX sh + node | macOS / Unix 本机构建入口，输出 `install.sh`（含 MCP JS 内嵌）、`manage.sh`（含 MCP + Manage JS 集合内嵌），支持无 `pwsh` 的结构检查 |

旧源码入口 `installer/Bootstrap.ps1`、`installer/Install.ps1`、`installer/Manage.ps1` 和旧构建入口 `installer/build/Build-SingleFile.ps1` 不作为支持路径保留。

---

## 云端短 artifact

```text
Windows
├── bootstrap.ps1  # PS 5.1+ 引导入口
├── install.ps1    # PS 7+ 安装入口
└── manage.ps1     # PS 7+ 管理入口

macOS
├── install.sh     # bash→zsh 安装入口
└── manage.sh      # bash→zsh 管理入口
```

首次安装命令：

```powershell
irm https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/bootstrap.ps1 | iex
```

```sh
curl -fsSL https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.sh | bash
```

安装后的 `ccq` Profile 快捷函数仍作为面板入口，但内部远程调用 `install.*` / `manage.*`，不再引用长 `.built.*` 文件名或 `ccq-*` artifact。

---

## Windows 源码调试命令

```powershell
# 验证全部 PowerShell 文件语法
pwsh -File test-syntax.ps1

# 引导 / 安装 / 管理
powershell -File installer/windows/Bootstrap.ps1
pwsh -File installer/windows/Install.ps1
pwsh -File installer/windows/Manage.ps1

# 查看步骤列表与可更新项
pwsh -File installer/windows/Install.ps1 -ListSteps
pwsh -File installer/windows/Manage.ps1 -Action Update -ListUpdates
```

---

## macOS 源码调试命令

```sh
# 安装 / 管理
zsh installer/macos/Install.zsh
zsh installer/macos/Manage.zsh

# 查看步骤列表与可更新项
zsh installer/macos/Install.zsh --list-steps
zsh installer/macos/Manage.zsh --action Update --list-updates
```

macOS 硬约束：最低 macOS 12+；使用 Homebrew + nvm（**只做 nvm，不支持 fnm/npm 全局包备份**）；Profile 写入 `~/.zprofile` / `~/.zshrc`；禁止调用 winget、注册表、MSI/EXE、Windows Terminal 或 Windows `$PROFILE`。

---

## 构建命令

```powershell
# Windows / CI Windows job 构建入口（只生成 Windows 三个 artifact）
pwsh -File installer/build.ps1
```

```sh
# macOS / Unix 本机构建入口（只生成 macOS 两个 artifact）
sh installer/build.sh
sh installer/build.sh --check
```

默认输出目录为 repo 根目录 `dist/`。Windows 构建入口只生成 `bootstrap.ps1`、`install.ps1`、`manage.ps1`；macOS 构建入口只生成 `install.sh`、`manage.sh`；CI Release job 下载两个平台 job 的产物后汇总五个短 artifact。

---

## 加载边界

- Windows core 加载顺序：`Ui.ps1` → `Process.ps1` → `Profile.ps1` → `Admin.ps1` → `Net.ps1` → `Registry.ps1` → `Bootstrap.ps1` → `McpManager.ps1` → `Provider.ps1`。
- Windows steps 由 `Get-StepFiles` 从 `installer/contracts/steps.json` 生成，路径必须是 `windows/steps/*.ps1`。
- macOS steps 使用 `MacOSStepFile`，路径必须是 `macos/steps/*.zsh`。
- Provider / MCP / ClaudeConfig / Skills / UI 文案优先读取 `installer/contracts/*.json`，内联 fallback 只用于 release artifact 或 contracts 不可用场景，并由 `installer/contracts/Test-Contracts.ps1` 校验一致性。

### Release 单文件执行边界（HC-15）

`dist/*.ps1` 通过 `irm ... | iex` 执行时没有稳定脚本文件上下文，`$PSScriptRoot` 为空。进入 Windows 单文件 artifact 的 `windows/core/*.ps1` 与 `windows/steps/*.ps1` 必须遵守：

1. 不得裸用 `$PSScriptRoot` 推导源码路径；使用前先判空。
2. 不得把空字符串传给 `Join-Path` / `Test-Path` / `Get-Content` 等 `-Path` 参数。
3. contracts/templates 查找失败时，必须回退到 inline fallback、环境变量 fallback 或安全跳过。
4. 修改 contracts、templates、指纹计算、构建拼接、远程入口相关代码后，必须同时验证：
   - 源码模式：`pwsh -File installer/windows/Manage.ps1`
   - Release 模式：`irm 'https://.../manage.ps1' | iex`

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

## MCP 架构说明

MCP（Model Context Protocol）安装与管理采用 **职责分离** 架构：**Install 在步骤，Manage 在 Manager**。

### 架构设计

```
┌──────────────────────────────────────────────────────────────┐
│ Install 职责 (steps/Mcp.*)                                   │
├──────────────────────────────────────────────────────────────┤
│ • 契约加载（contracts/mcp-servers.json）                      │
│ • 运行时依赖检测（Node.js / npm）                             │
│ • MCP Server 选择菜单                                         │
│ • 凭据收集（交互式 + Vault 历史）                             │
│ • 配置生成（.claude.json / settings.json）                   │
│ • Vault 持久化（~/.ccq/mcp-meta.json）                       │
│ • Rules 同步调用（调用 McpManager）                           │
│                                                              │
│ Windows: Mcp.ps1 (2000 行，26 个函数)                        │
│ macOS:   Mcp.zsh (416 行，19 个函数)                         │
└──────────────────────────────────────────────────────────────┘
                          ↓ Rules 同步
┌──────────────────────────────────────────────────────────────┐
│ Manage 职责 (core/McpManager.*)                              │
├──────────────────────────────────────────────────────────────┤
│ • JS 脚本部署（~/.ccq/scripts/mcp-manager.js）               │
│ • 交互 TUI（状态表格 + CRUD 菜单）                            │
│ • 状态计算（Custom/Active/Disabled/Missing）                  │
│ • CRUD 操作（disable / enable / remove）                      │
│ • Rules 渲染（~/.claude/rules/ccq-mcp-*.md）                 │
│ • Vault 恢复辅助                                              │
│                                                              │
│ Windows: McpManager.ps1 (247 行，轻量 wrapper）              │
│ macOS:   McpManager.zsh (175 行，轻量 wrapper）              │
└──────────────────────────────────────────────────────────────┘
                          ↓ 调用
┌──────────────────────────────────────────────────────────────┐
│ 跨平台共享核心 (mcp-manager.js)                              │
├──────────────────────────────────────────────────────────────┤
│ • 1180 行，零外部依赖                                         │
│ • 完整 TUI 渲染（CJK-aware padding）                          │
│ • CRUD 业务逻辑                                               │
│ • 凭据同步算法                                                │
│ • Rules 动态渲染（3 个分类）                                  │
│ • Vault 读写 + 锁保护                                         │
│ • 命令行接口（manage / status / sync-rules）                 │
└──────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **完全自给自足**
   - `steps/Mcp.*` 包含所有安装所需函数
   - **不依赖** `core/McpManager.*` 中的安装函数
   - 避免 CommandNotFoundException 等依赖缺失错误

2. **轻量 Manager**
   - `core/McpManager.*` 只做 wrapper（Windows 247 行，macOS 175 行）
   - 主要职责：部署 JS 脚本 + 调用 `node mcp-manager.js`
   - 不包含复杂的安装管道逻辑

3. **跨平台共享**
   - `mcp-manager.js` 实现所有 Manage 核心逻辑
   - Windows 和 macOS 共用同一份 JS 代码
   - 零平台依赖，纯 Node.js 实现

4. **契约驱动**
   - MCP Server 定义来自 `contracts/mcp-servers.json`
   - Windows 和 macOS 共享相同的 MCP 配置契约
   - Vault schema 跨平台统一（`~/.ccq/mcp-meta.json`）

### 功能对比

| 功能 | Windows Mcp.ps1 | macOS Mcp.zsh | 共享 |
|------|-----------------|---------------|------|
| **行数** | 2000 | 416 | - |
| **实现风格** | PowerShell 原生 | zsh + node -e | - |
| **契约加载** | ✅ 2 个函数 | ✅ 内联 + node | contracts/mcp-servers.json |
| **基础工具** | ✅ 7 个函数 | ✅ 8 个函数 | - |
| **Vault 管理** | ✅ 7 个函数（Mutex） | ✅ 内联（flock） | ~/.ccq/mcp-meta.json |
| **安装管道** | ✅ 6 个函数 | ✅ 7 个函数 | - |
| **主要函数** | ✅ 4 个（含 Update） | ✅ 3 个（无 Update） | - |
| **Rules 同步** | ✅ 调用 McpManager | ✅ 调用 McpManager | mcp-manager.js |

**说明**：
- macOS 更精简（416 行），大量使用 `node -e` 单行脚本处理 JSON
- Windows 更完整（2000 行），PowerShell 原生实现所有逻辑
- 两者功能等价，架构一致，都是自给自足的安装步骤

### 重构历史

**v2.0.0 重构**（2026-06-14）：
- **问题**：Windows Mcp.ps1 (751 行) 调用 McpManager.ps1 中缺失的函数，导致 `CommandNotFoundException`
- **解决**：将 19 个安装函数从旧版 McpManager 迁移到 Mcp.ps1，实现完全自给自足
- **结果**：Mcp.ps1 扩展到 2000 行，McpManager.ps1 精简到 247 行（轻量 wrapper）
- **macOS**：检查发现 Mcp.zsh 已完全对齐，无需修改

**架构收益**：
- ✅ 消除依赖：Mcp 步骤不再依赖 Manager 的安装函数
- ✅ 职责清晰：Install 在步骤（自给自足），Manage 在 Manager（wrapper + JS）
- ✅ 跨平台统一：Windows 和 macOS 都是 wrapper + mcp-manager.js 核心
- ✅ 易于维护：安装逻辑和管理逻辑分离，互不影响

---

## Manage 管理入口（JS 化架构）

Manage 四大管理入口（Update / Provider / MCP / Skills）已统一迁移到 Node.js 核心，沿用 MCP 已验证的「轻量 wrapper + JS 核心」范式。用户入口 `ccq` 与面板交互对用户无感知变化。

### 架构流程

```text
ccq（Profile 快捷函数，固定 GitHub Release URL，不含版本号）
  │
  │  [2] 管理面板 → curl manage.sh | bash  /  irm manage.ps1 | iex
  ▼
manage.sh / manage.ps1（轻量 wrapper，从 Release 拉取）
  │  职责：检测 Node.js → 委派 ManageCore 部署 → 调用 node manage.js
  ▼
ManageCore.zsh / ManageCore.ps1（core/ 部署 wrapper）
  │  1. base64 内嵌解码 / 源码 fallback → 写入 ~/.ccq/scripts/*.js
  │  2. 按 SCRIPT_VERSION 版本检测，一致则跳过部署
  ▼
node ~/.ccq/scripts/manage.js（统一入口 + 子菜单路由）
  │
  ├── [1] Provider 管理 → spawn provider-manager.js
  ├── [2] Skills 管理   → spawn skills-manager.js
  ├── [3] Update 管理   → spawn update-manager.js
  └── [4] MCP 管理      → spawn mcp-manager.js（复用已迁移核心）
```

### 与 MCP 架构的对称性

| 维度 | MCP（已验证） | Provider / Skills / Update（本次迁移） |
|------|--------------|--------------------------------------|
| 平台 wrapper | `McpManager.{ps1,zsh}` | `ManageCore.{ps1,zsh}` |
| JS 核心 | `mcp-manager.js` | `provider/skills/update-manager.js` + `manage.js` 入口 |
| 部署位置 | `~/.ccq/scripts/` | `~/.ccq/scripts/` |
| 内嵌方式 | base64 到 install/manage 产物 | base64 到 manage 产物（`Get-ManageScriptsBase64` / `getManageScriptsBase64`） |
| 版本检测 | `SCRIPT_VERSION` | `SCRIPT_VERSION`（当前 `1.0.0`，与 `ManageCoreVersion` 同步） |

`manage.js` 作为统一入口，子菜单通过 `invokeManager(name)` spawn 同目录下的专项管理器；MCP 子菜单复用 `mcp-manager.js`，不重复实现。共享工具（`atomicWrite`、`withProfileLock`、临时缓存目录）在 `manage.js` 提取，跨子管理器复用。

### 部署、回滚与离线

- **部署降级链**：base64 内嵌（Release / `irm|iex`、`curl|bash`）→ 源码复制（`installer/contracts/scripts/*.js`）→ 已部署版本（版本检测命中跳过）。
- **旧实现回滚**：`Provider.legacy.{ps1,zsh}` / `Skills.legacy.{ps1,zsh}` / `Update.legacy.*` 保留一个稳定 release 周期，供回滚与功能对照。
- **源码模式入口（离线可用）**：`pwsh installer/windows/Manage.ps1` / `zsh installer/macos/Manage.zsh`。
- **网络边界**：`manage.ps1` / `manage.sh` 已 base64 内嵌全部 JS 集合，面板本身打开**不需要联网**；需要联网的是子操作——Skills 安装/更新（`npx skills`）、Update 检测（`npm outdated`）、MCP Server 配置等。完全离线场景请使用源码模式入口。

打包与 contracts 内联细节见 [installer/contracts/README.md](contracts/README.md) 的「Manage JS 集合打包」小节。

