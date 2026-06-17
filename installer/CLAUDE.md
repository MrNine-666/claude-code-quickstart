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
| `windows/core/` | Windows / PowerShell | Windows runtime core：UI、Process、Profile、Registry、Bootstrap、**ManageCore（Manage JS bundle 缓存 wrapper）**、Provider |
| `windows/steps/` | Windows / PowerShell | Windows 13 个安装步骤 + Skills 管理模块，StepId 与 macOS 保持一致 |
| `contracts/` | JSON 契约 + Node.js 脚本 | 跨平台 StepId、分组、依赖、Provider、MCP、ClaudeConfig、模板、构建清单、Skills catalogue、UI 文案策略 + **Manage/MCP 管理 JS 脚本集合** |
| `contracts/scripts/manage.js` | Node.js | **Manage 管理面板入口**：子菜单 require 路由到 Provider / Skills / Update / MCP 四个子管理器（esbuild 打包进单文件 bundle），含共享原子写入、Profile 锁、临时缓存工具 |
| `contracts/scripts/provider-manager.js` | Node.js | **Provider 管理核心**：供应商 CRUD、settings.json 字段所有权、Profile 标记块同步 |
| `contracts/scripts/skills-manager.js` | Node.js | **Skills 管理核心**：发现、安装、更新、卸载、发现缓存与 CCG 管理技能过滤 |
| `contracts/scripts/update-manager.js` | Node.js | **Update 管理核心**：版本检测、npm outdated 缓存、快照、更新摘要与回滚 API |
| `contracts/scripts/mcp-manager.js` | Node.js | **MCP 管理核心**：状态计算、CRUD、凭据同步、Rules 渲染、交互 TUI（1180 行，零外部依赖）|
| `macos/Install.zsh` | macOS / bash→zsh | macOS 安装入口：合并 Bootstrap 前置检测，支持 `curl ... | bash` 后自动切换 `/bin/zsh` |
| `macos/Manage.zsh` | macOS / zsh | macOS 管理入口：加载 ManageCore，并路由到 JS 管理面板（Update / Provider / MCP / Skills） |
| `build.ps1` | PowerShell 7+ | Windows / GitHub Actions 构建入口，输出 `bootstrap.ps1`、`install.ps1`、`manage.ps1`；并经 esbuild 打包 `dist/manage.js` 单文件 bundle（含 4 子管理器 + mcp-manager.js）|
| `build.sh` | POSIX sh + node | macOS / Unix 本机构建入口，输出 `install.sh`、`manage.sh`；并经 esbuild 打包 `dist/manage.js` 单文件 bundle，支持无 `pwsh` 的结构检查 |

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

- Windows core 加载顺序：`Ui.ps1` → `Process.ps1` → `Profile.ps1` → `Update.ps1` → `Admin.ps1` → `Net.ps1` → `Registry.ps1` → `Bootstrap.ps1` → `ManageCore.ps1` → `Provider.ps1`（`Update.ps1` 须在 Profile 之后、Provider 之前：下界依赖 Profile 的 `Write-FileAtomically`/`Initialize-BackupDirectory`，上界因 Provider 依赖 `Get-StringFingerprint`）。
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

MCP（Model Context Protocol）安装与管理采用 **职责分离 + 跨平台统一** 架构：**Install 自给自足，Manage 走 JS 核心**。

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
│ • Rules 同步（内联渲染：PS 纯函数 / macOS node -e）           │
│                                                              │
│ Windows: Mcp.ps1 (2000 行，完全自给自足)                     │
│ macOS:   Mcp.zsh (416 行 + node -e 内联)                    │
└──────────────────────────────────────────────────────────────┘
                          ↓ Manage 链路由
┌──────────────────────────────────────────────────────────────┐
│ Manage 职责 (manage.js → mcp-manager.js)                    │
├──────────────────────────────────────────────────────────────┤
│ • 交互 TUI（状态表格 + CRUD 菜单）                            │
│ • 状态计算（Custom/Active/Disabled/Missing）                  │
│ • CRUD 操作（disable / enable / remove）                      │
│ • Rules 渲染（~/.claude/rules/ccq-mcp-*.md）                 │
│ • Vault 恢复辅助                                              │
│                                                              │
│ 跨平台共享核心：mcp-manager.js (1180 行，零外部依赖)           │
│ 平台 wrapper：ManageCore.{ps1,zsh} 部署 JS 并路由             │
└──────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **Install 完全自给自足**
   - `steps/Mcp.*` 包含所有安装 + Rules 渲染逻辑
   - Windows 用纯 PowerShell `Sync-McpRules` 函数
   - macOS 用 `node -e` 内联脚本复用契约
   - 两者输出字节一致，均从契约读取 `McpRulesCategories`

2. **Manage 走 JS 统一核心**
   - `mcp-manager.js` 经 esbuild 静态打包进 `dist/manage.js` 单文件 bundle
   - `manage.js` 子菜单 [4] MCP 通过 `require('./mcp-manager').runInteractive()` 同进程调用
   - 无平台 wrapper 文件(`McpManager.{ps1,zsh}` 已删除)
   - TUI、CRUD、Rules 渲染全由 JS 实现

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
| **Rules 同步** | ✅ `Sync-McpRules` 内联 | ✅ `ccq_mcp_sync_rules` node -e | 契约 McpRulesCategories |

**说明**：
- macOS 更精简（416 行 + node -e），大量使用 `node -e` 单行脚本处理 JSON 和 Rules 渲染
- Windows 更完整（2000 行），PowerShell 原生实现所有逻辑(含 Rules 渲染纯函数)
- 两者功能等价，架构一致，都是自给自足的安装步骤，**Rules 输出字节一致**

### 重构历史

**P8 简化(2026-06-16)**：
- **变更**：删除 `McpManager.{ps1,zsh}` 平台 wrapper 文件(422 行)
- **原因**：Install 链已自给自足(Mcp 步骤内联 Rules 渲染)，Manage 链走 JS 统一核心(无需平台 wrapper)
- **结果**：架构更简洁清晰，逻辑单一真理源(契约 + mcp-manager.js)

**v2.0.0 重构**(2026-06-14)：
- **问题**：Windows Mcp.ps1 (751 行) 调用 McpManager.ps1 中缺失的函数，导致 `CommandNotFoundException`
- **解决**：将 19 个安装函数从旧版 McpManager 迁移到 Mcp.ps1，实现完全自给自足
- **结果**：Mcp.ps1 扩展到 2000 行，McpManager.ps1 精简到 247 行(后续 P8 删除)
- **macOS**：检查发现 Mcp.zsh 已完全对齐，无需修改

**架构收益**：
- ✅ 消除冗余：删除 422 行平台 wrapper，逻辑更聚焦
- ✅ 职责清晰：Install 自给自足，Manage 纯 JS 核心
- ✅ 易于维护：单一真理源(契约 + mcp-manager.js)

---

## Manage 管理入口（单文件 bundle + 固定目录缓存）

**P10 架构反转**（2026-06-16）：从"base64 多文件部署到 ~/.ccq/scripts/"改为"esbuild 单文件 bundle 缓存到 $TMPDIR/.ccq/（1 小时 TTL）"。目标：wrapper 极简化（无版本号管理）、1 小时内零网络请求、系统重启清理。

### 架构流程

```text
ccq（Profile 快捷函数，固定 GitHub Release URL，不含版本号）
  │
  │  [2] 管理面板 → curl manage.sh | bash  /  irm manage.ps1 | iex
  ▼
manage.sh / manage.ps1（轻量 wrapper，从 Release 拉取）
  │  职责：检测 Node.js → 委派 ManageCore 缓存解析 → 调用 node 固定路径
  ▼
ManageCore.zsh / ManageCore.ps1（缓存 wrapper，~50 行）
  │  三级解析：
  │  1. 源码优先（离线）→ installer/contracts/scripts/manage.js
  │  2. 缓存命中（0 网络）→ $TMPDIR/.ccq/manage.js（修改时间 <1h 直接复用）
  │  3. 过期下载（远端最新）→ curl /releases/latest/download/manage.js
  ▼
node $TMPDIR/.ccq/manage.js（esbuild 单文件 bundle，~150KB）
  │  manage.js + 4 子模块静态打包，invokeManager 改 require 同进程调用
  │
  ├── [1] Provider 管理 → require('./provider-manager').runInteractive()
  ├── [2] Skills 管理   → require('./skills-manager').runInteractive()
  ├── [3] Update 管理   → require('./update-manager').runInteractive()
  └── [4] MCP 管理      → require('./mcp-manager').runInteractive()
```

### 核心变更（vs 旧 base64 部署架构）

| 维度 | 旧架构（base64 部署） | P10 新架构（bundle 缓存） |
|------|---------------------|------------------------|
| **打包方式** | `Get-ManageScriptsBase64` 编码 4 文件 → base64 JSON | `esbuild` 单文件 bundle → dist/manage.js |
| **wrapper 职责** | 解码 base64 → 写 ~/.ccq/scripts/*.js → 版本检测 | 源码优先 → 缓存 TTL → curl 下载 |
| **缓存位置** | ~/.ccq/scripts/（持久化，需手动清理） | $TMPDIR/.ccq/（系统重启清理） |
| **缓存策略** | SCRIPT_VERSION 版本号，一致跳过 | 修改时间 <1h 复用，无版本号 |
| **子模块调用** | `spawn('node', [scriptPath])` 独立进程 | `require('./子模块').runInteractive()` 同进程 |
| **网络开销** | 首次 + 版本变更下载 wrapper（含 base64） | 首次 + 每小时过期重拉 bundle |
| **离线可用** | 源码模式 + 已部署版本 | 源码模式 + 未过期缓存 |

### 离线与回滚

- **源码模式入口（离线可用）**：`pwsh installer/windows/Manage.ps1` / `zsh installer/macos/Manage.zsh` → ManageCore 直接运行 `installer/contracts/scripts/manage.js`，require 同目录子模块
- **缓存降级**：下载失败时复用旧缓存（可能非最新），仍可运行
- **网络边界**：`manage.ps1` / `manage.sh` 本身不含 bundle（仅 ~50 行缓存调度），首次或过期需网络拉取；子操作（Skills 安装/Update 检测/MCP 配置）仍需网络

打包与 contracts 内联细节见 [installer/contracts/README.md](contracts/README.md) 的「Manage JS 单文件 bundle（P10 方案 3）」小节。

