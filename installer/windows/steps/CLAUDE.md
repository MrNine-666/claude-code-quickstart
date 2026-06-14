# installer/windows/steps/ — Windows 安装步骤模块

> 面包屑：[根目录](../../../CLAUDE.md) › [installer/](../../CLAUDE.md) › windows/ › steps/
> 生成时间：2026-06-14 (MCP 重构：Mcp.ps1 从 751 行扩展到 2000 行，完全自给自足)

---

## 步骤契约（HC-2）

每个步骤文件**必须**实现三个函数（函数名使用语义化命名，无数字前缀）：

```powershell
# 检测是否已安装/已完成
function Test-<StepId>Installed {
    return @{
        IsInstalled = [bool]
        Version     = [string]   # 版本号，不适用时为 ""
        Data        = @{}        # 传递给 StepResult.Data
        Message     = [string]   # 状态说明
    }
}

# 执行安装
function Install-<StepId> {
    return @{
        Success      = [bool]
        ErrorMessage = [string]
        Data         = @{}       # 版本号等写入此处
    }
}

# 验证安装结果（可选，不需要时返回 @{Success=$true}）
function Verify-<StepId> {
    return @{ Success = [bool]; ErrorMessage = [string] }
}
```

### Update 函数契约（可选）

可更新步骤额外实现 `Update-<StepId>` 函数，由 Registry 的 `UpdateFunction` 字段注册：

```powershell
# 执行更新（仅可更新步骤需要实现）
function Update-<StepId> {
    return @{
        Success      = [bool]
        ErrorMessage = [string]
        Data         = @{}
        UpdatedItems = @(        # 变更记录数组
            "<Scope>::<Target>::<Change>"
            # 示例: "npm::claude-code::1.2.3->1.3.0"
            # 示例: "config::env.KEY::added"
            # 示例: "noop::StepId::no-change"
        )
    }
}
```

> Windows 8 个步骤注册统一 Update 函数：ClaudeCode、ClaudeConfig、ClaudeMd、Ccline、CcgWorkflow、CodexCli、AntigravityCli、OpenSpec。
> Windows 6 个步骤不参与统一更新（UpdateFunction 为空）：NodeJS、Git、ApiKey、CcSwitch、Mcp、Skills。
> macOS 通过 `installer/contracts/steps.json` 复用 StepId；CcSwitch 额外注册 `MacOSUpdateFunction = Update-CcSwitch`，走 Homebrew Cask 更新，不改变 Windows CcSwitch 的不可更新语义。

> **注意**：Bootstrap.ps1 的 `Invoke-StepLifecycle` / `Invoke-UpdateLifecycle` 同时兼容 `bool` 和 `hashtable` 两种返回类型（向后兼容旧步骤）。

---

## 步骤总览

Windows 与 macOS 保持相同 StepId、分组、依赖和用户可见能力边界；跨平台元数据以 `installer/contracts/steps.json` 为契约，平台实现分别位于 `installer/windows/steps/*.ps1` 与 `installer/macos/steps/*.zsh`。

| StepId | 名称 | 文件 | 可选 | SkipIfInstalled | 可更新 | 主要依赖 | 分组 |
|--------|------|------|:----:|:---------------:|:------:|---------|------|
| NodeJS | Node.js (fnm) | `NodeJS.ps1` | — | ✓ | — | 无 | 基础 |
| Git | Git | `Git.ps1` | — | ✓ | — | 无 | 基础 |
| ClaudeCode | Claude Code | `ClaudeCode.ps1` | — | ✓ | ✓ | NodeJS | 基础 |
| ApiKey | 第三方供应商配置 | `ApiKey.ps1` | — | ✓ | — | ClaudeCode | 基础 |
| Ccline | ccline | `Ccline.ps1` | — | ✓ | ✓ | ClaudeCode | 进阶 |
| ClaudeConfig | Claude 基础配置 | `ClaudeConfig.ps1` | — | ✓ | ✓ | ClaudeCode | 进阶 |
| ClaudeMd | CLAUDE.md 配置 | `ClaudeMd.ps1` | — | ✓ | ✓ | ClaudeConfig | 进阶 |
| Mcp | MCP Server 配置 | `Mcp.ps1` | — | ✓ | — | ClaudeCode | 进阶 |
| CcgWorkflow | CCG 工作流 | `CcgWorkflow.ps1` | — | ✓ | ✓ | NodeJS | 进阶 |
| Skills | Skills | `Skills.ps1` | **仅 Manage** | false | — | NodeJS, ClaudeCode | Manage |
| OpenSpec | OpenSpec CLI | `OpenSpec.ps1` | — | ✓ | ✓ | NodeJS | 进阶 |
| CcSwitch | cc-switch | `CcSwitch.ps1` | **✓** | ✓ | — | ClaudeCode | 进阶 |
| CodexCli | Codex CLI | `CodexCli.ps1` | **✓** | ✓ | ✓ | NodeJS | 进阶 |
| AntigravityCli | Antigravity CLI | `AntigravityCli.ps1` | **✓** | ✓ | ✓ | 无 | 进阶 |

---

## NodeJS — Node.js (fnm)

**文件**：`NodeJS.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`, `Profile.ps1`

**安装流程**：
1. 检测 `fnm` / `node` 是否已安装
2. 用 `winget install Schniz.fnm` 安装 fnm
3. 写入 `$PROFILE` 标记块（`fnm env` 初始化）
4. `Refresh-SessionPath` + `fnm install --lts`
5. 验证 `node --version` / `npm --version`

---

## Git — Git

**文件**：`Git.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`

**安装流程**：`winget install Git.Git` → 配置 4 项 Git 推荐设置 → 写入 Git Bash UTF-8（Python + PowerShell wrapper）→ 验证 `git --version` / `git config --list --global`

---

## ClaudeCode — Claude Code

**文件**：`ClaudeCode.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`

**安装流程**：`npm install -g @anthropic-ai/claude-code` → 验证 `claude --version`

---

## ApiKey — 第三方供应商配置（HC-12 关键）

**文件**：`ApiKey.ps1`
**依赖核心模块**：`Provider.ps1`（供应商 CRUD + 交互菜单）
**配置路径**：`$env:USERPROFILE\.claude\settings.json`

### 架构变更（Install+Manage 分离）

ApiKey 步骤已精简为**薄包装层**，核心供应商逻辑委托给 `core/Provider.ps1`：

| 职责 | 旧版 ApiKey.ps1 (~710行) | 新版 ApiKey.ps1 (~170行) |
|------|--------------------------|--------------------------|
| 供应商模板 | `$script:ApiProviders` 自行定义 | 引用 `Provider.ps1` 的 `$script:BuiltinProviders` |
| 供应商选择 + API Key 输入 | 自行实现完整流程 | 委托 `Add-Provider -Activate` |
| Profile 文件管理 | 自行写入 `~/.claude/providers/` | 由 `Provider.ps1` 统一管理 |
| 供应商切换 (ccp) | 注入 `Switch-ClaudeProvider` 到 `$PROFILE` | **已移除**，改用 `Manage → 供应商管理` |
| settings.json 写入 | 自行实现 JSON 合并 | 由 `Provider.ps1` 的 `Switch-Provider` 处理 |

### SkipIfInstalled

`SkipIfInstalled = $true`（注册表已更新）。首次配置后自动跳过，用户通过 `Manage.ps1 -Action Provider` 管理供应商。

### Install-ApiKey 流程

```
Install-ApiKey($state)
  ├── 清理旧版 ccp 标记块（Remove-ManagedBlockFromFile）
  ├── 调用 Add-Provider -Activate（委托给 Provider.ps1）
  │   ├── 供应商选择菜单（内置 4 个 + 自定义）
  │   ├── API Key 输入（SecureString）
  │   ├── 写入 Provider Profile → ~/.claude/providers/<key>.json
  │   └── 激活：合并到 settings.json
  └── 写入 ~/.claude.json（hasCompletedOnboarding = true）
```

### 供应商模板（定义于 Provider.ps1）

内置供应商由 `core/Provider.ps1` 的 `$script:BuiltinProviders` 统一定义：

| Key | Name | 模型配置 |
|-----|------|----------|
| `zhipu` | 智谱 GLM | Haiku=`glm-4.5-air`，Opus/Sonnet=`glm-5.1`，额外写入 `API_TIMEOUT_MS=3000000` |
| `minimax` | MiniMax | 3 个模型环境键和 `ANTHROPIC_MODEL` 均写入 `MiniMax-M3`，额外写入 `API_TIMEOUT_MS=3000000` |
| `moonshot` | Kimi Code | 3 个模型环境键、`ANTHROPIC_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL` 均写入 `kimi-for-coding`，额外写入 `ENABLE_TOOL_SEARCH=false` |
| `deepseek` | DeepSeek | Haiku/Subagent=`deepseek-v4-flash`，Opus/Sonnet/主模型=`deepseek-v4-pro[1m]`，额外写入 `CLAUDE_CODE_EFFORT_LEVEL=max` |
| `bailian` | 阿里云百炼 | 3 个模型环境键、`ANTHROPIC_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL` 均写入 `qwen3.7-plus` |
| `custom` | 自定义供应商 | 无（用户按需配置） |

### 写入格式（HC-12）

**~/.claude/settings.json**（所有供应商，模型选择统一写入 env）：
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<API_KEY>",
    "ANTHROPIC_BASE_URL": "<BaseUrl>",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<HaikuModel>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "<OpusModel>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<SonnetModel>",
    "ANTHROPIC_MODEL": "<ProviderMainModel>",
    "CLAUDE_CODE_SUBAGENT_MODEL": "<ProviderSubagentModel>",
    "CLAUDE_CODE_EFFORT_LEVEL": "<ProviderEffort>",
    "API_TIMEOUT_MS": "<ProviderTimeout>",
    "ENABLE_TOOL_SEARCH": "<ProviderToolSearch>"
  }
}
```

> 若某供应商不需要模型覆盖，则只写入 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_BASE_URL`。Kimi Code 额外写入 `ENABLE_TOOL_SEARCH=false`；DeepSeek 额外写入主模型、子代理模型和 effort 配置；切换到其他供应商时会清理这些受管额外 env。历史旧版别名映射字段会在切换供应商时自动迁移为上述 env 键。

**~/.claude.json**：
```json
{
  "hasCompletedOnboarding": true
}
```

此配置用于标记 Claude Code 环境已完成初始化，由 ApiKey 步骤自动创建。如果文件已存在，将合并写入，保留用户已有字段。

### 供应商后续管理

安装完成后，供应商的增删改查和切换统一通过 `installer/windows/Manage.ps1 -Action Provider` 管理（详见 [windows/core/CLAUDE.md](../core/CLAUDE.md) Provider.ps1 章节）。

> **禁止**写入 `anthropicApiKey`、`openaiApiKey` 等顶层字段。
> **禁止**写入 Anthropic / OpenAI / Azure 供应商。

---

## Ccline — ccline

**文件**：`Ccline.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`

**包名**：`@cometix/ccline`（scoped package）

**安装流程**：
1. 前置检查（Claude Code + npm）
2. `npm install -g @cometix/ccline`
3. 配置 `statusLine`（官方 schema）写入 `~/.claude/settings.json`
4. 执行 `ccline --patch <cli.js>` 对 Claude Code 进行 patch

**statusLine 配置格式（Claude Code 官方 schema）**：
```json
{
  "statusLine": {
    "type": "command",
    "command": "ccline",
    "padding": 0
  }
}
```

**检测条件**：`$settings.statusLine.type -eq "command"`

**ccline patch**：安装后自动定位 `npm prefix/node_modules/@anthropic-ai/claude-code/cli.js`，执行 `ccline --patch` 注入状态栏支持。失败时仅警告不中断。

---

## CcSwitch — cc-switch [可选]

**文件**：`CcSwitch.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`, `Admin.ps1`, `Net.ps1`

**功能**：Claude Code / Codex / Gemini CLI 全方位辅助桌面软件

**Windows 安装**：从 GitHub Release (`farion1231/cc-switch`) 下载 MSI/EXE → 静默安装（需管理员权限）。非 CLI 工具，安装后通过开始菜单或桌面快捷方式启动。

**macOS 安装**：`installer/macos/steps/CcSwitch.zsh` 使用 Homebrew Cask：

```sh
brew install --cask cc-switch
brew upgrade --cask cc-switch
```

Homebrew 不可用、安装失败或验证失败时返回 `ManualRequired` 并输出 GitHub Release 手动指引；该状态不计入安装摘要的 Success。

---

## ClaudeConfig — Claude 基础配置

**文件**：`ClaudeConfig.ps1`
**配置路径**：`$env:USERPROFILE\.claude\settings.json`（与 ApiKey 同一文件）

**写入策略**：声明式字段管理，读取 -> 补缺失 -> 原子写入。仅管理 ClaudeConfig 自有字段，不覆盖 ApiKey（供应商配置/Base URL/模型环境键）、Ccline（statusLine）或用户自定义配置。

**ClaudeConfig 管辖的 env 字段**：

| 字段 | 默认值 | 写入策略 |
|------|--------|----------|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `90` | 仅补缺失 |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | `0` | 仅补缺失 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | 仅补缺失 |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | 仅补缺失 |
| `DISABLE_INSTALLATION_CHECKS` | `1` | 仅补缺失 |
| `MAX_THINKING_TOKENS` | `31999` | 仅补缺失 |

**其他 ClaudeConfig 管辖字段**：

| 字段 | 默认值 | 写入策略 |
|------|--------|----------|
| `language` | `简体中文` | 仅补缺失 |
| `plansDirectory` | `.claude/plan` | Install 补缺失 / Update 对齐 |
| `permissions.allow` | 14 项基础权限 | 合并（只添加缺失项，不删除已有项） |
| `attribution` | `{ commit: "", pr: "" }` | 仅补缺失 |

**ClaudeConfig 不触碰的字段**：`model`（用户自行选择）、`statusLine`（Ccline）、`hooks`（用户/插件）、`outputStyle`（用户自定义）、`mcpServers`（Mcp）、`env.ANTHROPIC_AUTH_TOKEN`/`env.ANTHROPIC_BASE_URL`/`env.ANTHROPIC_DEFAULT_HAIKU_MODEL`/`env.ANTHROPIC_DEFAULT_OPUS_MODEL`/`env.ANTHROPIC_DEFAULT_SONNET_MODEL`/`env.ANTHROPIC_MODEL`/`env.CLAUDE_CODE_SUBAGENT_MODEL`/`env.CLAUDE_CODE_EFFORT_LEVEL`/`env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK`/`env.API_TIMEOUT_MS`/`env.ENABLE_TOOL_SEARCH`（ApiKey）、`env.CODEAGENT_POST_MESSAGE_DELAY`/`env.CODEX_TIMEOUT`/`env.BASH_DEFAULT_TIMEOUT_MS`/`env.BASH_MAX_TIMEOUT_MS`（CcgWorkflow）

> **注意**：statusLine 配置完全由 Ccline 步骤负责，ClaudeConfig 不触碰 statusLine 字段。

---

## ClaudeMd — CLAUDE.md 配置

**文件**：`ClaudeMd.ps1`
**目标**：`$env:USERPROFILE\.claude\CLAUDE.md`
**依赖**：无（不依赖 Claude 基础配置）

**功能**：生成全局 Claude Code 工作规范主文件。~100 行（确保在 token 截断限制内完整可见）。详细的工具速查由 McpManager 动态渲染到 `rules/ccq-mcp-*.md`；通用工作流原则已并入主 `CLAUDE.md`。

**命名约定**：CCQ 管理的 rules 文件统一使用 `ccq-` 前缀，与用户自定义 rules 隔离。

**写入方式**：`Write-FileAtomically -FilePath`（**注意参数名**）。主文件采用原子覆写（直接替换，无备份）。

**检测条件**：`Test-ClaudeMdInstalled` 检查主文件 3 个关键标识。

---

## Mcp — MCP Server 配置

**文件**：`Mcp.ps1` (2000 行，完全自给自足)
**依赖核心模块**：`Ui.ps1`, `Profile.ps1`, `Process.ps1`
**配置路径**：
- `$env:USERPROFILE\.claude.json` - MCP Server 配置（mcpServers）
- `$env:USERPROFILE\.claude\settings.json` - 权限配置（permissions）
- `$env:USERPROFILE\.ccq\mcp-meta.json` - MCP Vault（凭据持久化 + 状态管理）

**架构**：完整的安装管道实现（契约加载、基础工具、Vault 管理、安装管道、主要函数），**不依赖** `core/McpManager.ps1` 中的安装函数。McpManager 仅负责 Manage 管理（wrapper + Rules 同步）。

### 功能模块（26 个函数）

**契约加载**（2 个）：
- `Load-McpContract` - 从 `contracts/mcp-servers.json` 加载 MCP Server 定义
- `Initialize-McpFallbackConfig` - 内联 fallback 配置（Release 模式）

**基础工具**（7 个）：
- `Get-UserHome` - 获取用户主目录
- `Get-ClaudeSettingsPath` - 获取 Claude settings.json 路径
- `ConvertTo-NormalizedVersion` - 规范化版本号为 [int, int, int]
- `Read-McpCredentialValue` - 读取凭据（支持明文/SecureString/文件路径）
- `Test-ObjectProperty` - 检测对象属性
- `ConvertTo-CanonicalObject` - 规范化对象结构
- `Get-McpDefinitionHash` - 计算 MCP Server 配置指纹（SHA-256）

**Vault 管理**（7 个）：
- `Ensure-CcqMetaDir` - 确保 `~/.ccq/` 目录存在
- `Get-McpMetaPath` - 获取 Vault 路径
- `New-EmptyMcpMeta` - 创建空 Vault 结构
- `Invoke-McpCorruptionRecovery` - Vault 腐败恢复（自动备份）
- `Read-McpMeta` - 读取 Vault（带腐败检测）
- `Write-McpMeta` - 写入 Vault（原子写入）
- `Invoke-WithMcpLock` - Vault 并发保护（Mutex，30s 超时）

**安装管道**（6 个）：
- `Install-McpRuntimeDeps` - 安装运行时依赖（Node.js / npm）
- `Get-McpCredentials` - 收集 MCP Server 凭据（交互式）
- `New-McpSettingsEntry` - 生成 MCP Server 配置条目
- `Install-McpSoftware` - 安装 MCP 软件（npm global / npx）
- `Write-McpEnvFile` - 写入 .env 文件（用于 envFile 凭据）
- `Install-McpSingleServer` - 单个 MCP Server 完整安装流程

**主要函数**（4 个）：
- `Test-McpInstalled` - 检测已安装的 MCP Server 数量
- `Install-Mcp` - MCP 安装主流程（选择 → 安装 → Rules 同步）
- `Verify-Mcp` - 验证安装结果
- `Clear-NpxCache` - 清理 npx 缓存（避免安装失败）

### 关键特性

**增量安装支持**：
- 设置 `SkipIfInstalled = $false`，允许用户每次都能进入选择菜单
- 自动检测已安装的 MCP Server 并在选项中标记 `[已安装]`
- 默认只选中推荐的且未安装的 MCP Server
- 自动跳过已安装的 MCP Server，只安装新选择的

**Vault 集成**（mcp-lifecycle）：
- Install-Mcp Phase 3：凭据收集前读取 `~/.ccq/mcp-meta.json` 检查历史凭据，提示 `[Y/n]` 自动填充
- Install-Mcp Phase 5：`.claude.json` 写入成功后，通过 `Invoke-WithMcpLock` 将凭据持久化到 vault
- 凭据在 vault 写入后立即清零（安全）
- Vault 读写失败不阻塞主流程（仅 warning）
- Vault 腐败自动恢复：保留最近 5 个备份

**MCP Rules 动态渲染**：
- Install-Mcp 末尾调用 `Sync-AllMcpRules`（由 `core/McpManager.ps1` 提供），根据已启用的 MCP Server 动态生成 `rules/ccq-mcp-*.md` 文件
- 分类定义在 `core/McpManager.ps1` 的 `$script:McpRulesCategories` 中维护
- 3 个分类：Search（搜索）、Documentation（文档）、Development（代码检索）
- 某分类下所有 MCP 禁用时，对应 rules 文件自动删除

**契约加载策略**：
1. 优先读取 `installer/contracts/mcp-servers.json`（源码模式）
2. Fallback 到内联配置（Release 模式，`irm|iex` 执行）
3. 支持 4 个核心 MCP Server：context7、deepwiki、exa、playwright

**安装错误处理**：
- contextweaver 安装增强：针对 Windows 权限问题，添加 npm 缓存清理和 `--force` 重试机制
- RuntimeDeps 检测：自动检测 Node.js 和 npm 版本
- 安装失败时友好错误提示，不中断其他 MCP Server 安装

### 与 McpManager 的职责分离

| 职责 | Mcp.ps1 (Install) | McpManager.ps1 (Manage) |
|------|-------------------|-------------------------|
| **契约加载** | ✅ 完整实现 | ❌ 不负责 |
| **安装管道** | ✅ 完整实现（6 个函数） | ❌ 不负责 |
| **Vault 管理** | ✅ 完整实现（7 个函数） | ✅ 提供 Vault 恢复辅助 |
| **Rules 同步** | ✅ 调用 McpManager | ✅ 提供 `Sync-AllMcpRules` |
| **交互管理** | ❌ 不负责 | ✅ 提供交互 TUI（调用 mcp-manager.js） |
| **CRUD 操作** | ❌ 不负责 | ✅ 提供 disable/enable/remove（调用 mcp-manager.js） |

**设计原则**：Mcp.ps1 完全自给自足，不依赖 McpManager.ps1 的安装函数；McpManager.ps1 是轻量 wrapper（247 行），主要职责是调用 `~/.ccq/scripts/mcp-manager.js` 完成 Manage 管理。

---

## CcgWorkflow — CCG 工作流

**文件**：`CcgWorkflow.ps1`
**依赖**：NodeJS + ClaudeConfig

**功能**：通过官方 `npx --yes ccg-workflow@latest init --skip-prompt --skip-mcp --lang zh-CN --install-dir "$env:USERPROFILE\.claude"` 执行非交互安装，写入当前 CCG Workflow 的核心产物，并清理已迁移到主 `CLAUDE.md` 的历史 CCG rules 文件。

**安装命令**：
```powershell
npx --yes ccg-workflow@latest init --skip-prompt --skip-mcp --lang zh-CN --install-dir "$env:USERPROFILE\.claude"
```

**安装后目录结构**：
- `~/.claude/commands/ccg/` — 命令模板（Slash Commands，含核心命令与 skill 生成命令）
- `~/.claude/agents/ccg/` — Agent 模板
- `~/.claude/hooks/ccg/` — Hook 脚本（workflow-state / session-start / subagent-context / skill-router）
- `~/.claude/.ccg/` — CCG 配置目录（含 config.toml、engine/、prompts/）
- `~/.claude/skills/ccg/` — Skills 与质量关卡规则
- `~/.claude/bin/codeagent-wrapper.exe` — 核心二进制
- `~/.claude/settings.json` — 注册 CCG hooks
- 历史 CCG rules 文件会被清理，通用工作流原则由 ClaudeMd 主模板统一管理

**关键机制**：
- `--skip-mcp`：安装前后对 `.claude.json` 的 `mcpServers` 做快照比对，保护 Mcp 步骤的 MCP 配置
- `--yes`：确保非交互拉取最新版本，避免 npm 交互确认中断自动安装
- 超时/重试：`TimeoutSeconds 300`，`RetryCount 3`
- 安装后立即调用 `Refresh-SessionPath`
- 规则文件清理：更新时会清理历史文件 `ccq-ccgworkflow.md` / `ccq-multimodel.md` / `ccq-tools.md` / `ccq-workflow.md`

**CcgWorkflow 管辖的 env 字段**：

| 字段 | 默认值 | 写入策略 |
|------|--------|----------|
| `CODEAGENT_POST_MESSAGE_DELAY` | `1` | Install 补缺失 / Update 声明式对齐 |
| `CODEX_TIMEOUT` | `7200` | Install 补缺失 / Update 声明式对齐 |
| `BASH_DEFAULT_TIMEOUT_MS` | `600000` | Install 补缺失 / Update 声明式对齐 |
| `BASH_MAX_TIMEOUT_MS` | `3600000` | Install 补缺失 / Update 声明式对齐 |

---

## Skills — Skills [Manage 管理]

**文件**：`Skills.ps1`
**依赖**：NodeJS + ClaudeCode

**功能**：仅通过 `Manage → Skills 管理` 入口安装、更新或卸载 Claude Code 全局 Skills。安装流程（Basic / Advanced）不再包含 Skills，统一 Update 管理也不注册 Skills；Skills 管理菜单内部仍通过受控 catalogue 调用 `npx --yes skills add ... --yes --agent claude-code -g`，并通过 `Update-Skills` 调用 `npx --yes skills update [skill...] -g -y`。

**catalogue 来源**：优先读取 `installer/contracts/skills.json` 作为 Windows/macOS 共享业务源；内联 fallback 只用于 release artifact 或 contracts 不可用场景，并由 `installer/contracts/Test-Contracts.ps1` 与 contract 校验一致。`skills.json` 同时提供 `IgnoredSkillNames`，用于过滤 CCG Workflow 等其他步骤受管的 Skills，避免被普通 Skills 管理误更新或误卸载。

**安装策略**：
- 所有命令通过 `Invoke-ExternalCommand -Command "npx" -Arguments <string[]>` 执行，禁止 shell 字符串拼接
- 固定追加 `--agent claude-code` 与 `-g`
- `find-skills` / `fastapi` 等指定 skill 条目追加 `--skill <name>`
- source 选择为单选；动态发现到多个子 Skills 时进入子 Skills 多选，并逐个追加 `--skill <name>` 安装
- 在 Manage → Skills 安装流程中交互选择 copy 模式时追加 `--copy`；copy 模式只来自交互选择或局部布尔值，不读取环境变量
- 单项失败不阻止后续已选择子 Skills 继续执行，最终摘要列出失败项和实际 Skill name

**检测、更新与卸载**：
- `Test-SkillsInstalled` 通过 `npx --yes skills list -g -a claude-code --json` 实时检测，不扫描目录、不写持久化状态文件
- catalogue 保存 source、展示名称、简介、排序、默认选择和可选 `SkipDiscovery`；状态表展示 Description 作为简介，不再展示类别
- 实际 Skill name 默认通过 `npx --yes skills add <source> --list -g --agent claude-code` 动态发现并缓存到本次进程内；`SkipDiscovery` 条目改用 `StaticSkillName` 静态检测
- `ppt-master` 没有子 Skills，且远端 `--list` 明显较慢，因此检测阶段跳过远端 discovery，直接用 `StaticSkillName = ppt-master` 与本地 `skills list --json` 对比
- 进入状态表、安装选择菜单、卸载菜单或验证阶段前，先批量预取需要动态 discovery 的 catalogue 结果；默认最多 2 个 `--list` 查询并发，安装/卸载命令仍保持串行
- `SkillName` 仅用于指定单个 source 子技能时追加 `--skill <name>`；`StaticSkillName` 只用于跳过远端 discovery 的静态检测
- 集合类条目按动态发现结果计算 `已安装数/发现数`，判断 `已安装` / `部分安装` / `未安装`；动态发现失败时该条目状态为 `未知`，不阻断菜单或状态页
- 安装前后均使用 CLI 快照，记录本次新增的实际 Skill name 与缺失项
- Manage → Skills 管理拆分为安装 / 更新 / 卸载三个入口：安装使用 `skills add`，更新使用 `skills update`，卸载使用 `npx --yes skills remove <names...> -g -a claude-code --yes`，不直接删除目录

---

## CodexCli — Codex CLI（可选）

**文件**：`CodexCli.ps1`

```powershell
# 正确调用方式（无 -DisplayName 参数）
$installOut = Invoke-NpmGlobalInstall -PackageName "codex-cli"
```

---

## AntigravityCli — Antigravity CLI（可选）

**文件**：`AntigravityCli.ps1`
**依赖**：无（独立二进制 CLI，不依赖 Node.js）

**命令名**：`agy`

**Windows 安装方式**：官方未提供 npm 包，Windows 通过远程 PowerShell 安装脚本安装：

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

封装在 `Invoke-AntigravityCliInstaller`，通过 `pwsh -NoProfile -ExecutionPolicy Bypass -Command` 执行。官方脚本将 `agy.exe` 安装到 `%LOCALAPPDATA%\Antigravity\` 并更新用户 PATH。

**macOS 安装方式**：`installer/macos/steps/AntigravityCli.zsh` 使用官方 macOS/Linux 安装脚本：

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

安装后检测 `agy --version`，并补充当前会话 PATH 的 `~/.local/bin`。安装或更新失败时返回 `ManualRequired` 与手动指引，不伪报 Success。

**版本检测**：统一通过 `agy --version` 完成（`Get-AntigravityCliVersion`），无 npm list 路径。

**更新策略**：Windows 优先执行 `agy update`（官方自更新），命令不可用或失败时回退到官方安装脚本覆盖安装；macOS 同样优先尝试 `agy update`，随后通过 `install.sh` 刷新。`UpdatedItems` 使用 `agy::antigravity-cli::<old>-><new>`、`agy::antigravity-cli::installed` 或 `noop::AntigravityCli::no-change`。

**更新检测**：非 npm 包，无法获取远程最新版本、无法判断是否有更新，`Get-UpdateStatus` 将其 `HasUpdate` 置为 `$null`（语义为"无法获取更新状态"，默认勾选），执行 `agy update` 由官方 CLI 自行判断是否有新版本。

---

## OpenSpec — OpenSpec CLI（可选）

**文件**：`OpenSpec.ps1`
**依赖核心模块**：`Process.ps1`, `Ui.ps1`

**安装流程**：`npm install -g @fission-ai/openspec` → PATH 刷新 → 验证 `openspec --version` / `openspec --help`

---

## 新增步骤模板

添加新步骤时遵循此模板：

```powershell
#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\core\Ui.ps1"
. "$PSScriptRoot\..\core\Process.ps1"

function Test-<StepId>Installed {
    $result = @{ IsInstalled = $false; Version = ""; Data = @{}; Message = "" }
    try {
        # 检测逻辑
        $result.IsInstalled = $true
    } catch {
        $result.Message = $_.Exception.Message
    }
    return $result
}

function Install-<StepId> {
    $result = @{ Success = $false; ErrorMessage = ""; Data = @{} }
    try {
        # 安装逻辑
        $result.Success = $true
    } catch {
        $result.ErrorMessage = $_.Exception.Message
        Write-UiDanger $result.ErrorMessage
    }
    return $result
}

function Verify-<StepId> {
    $result = @{ Success = $false; ErrorMessage = "" }
    try {
        # 验证逻辑
        $result.Success = $true
    } catch {
        $result.ErrorMessage = $_.Exception.Message
    }
    return $result
}
```

在 `core/Registry.ps1` 的 `Get-StepRegistry` 中注册新步骤条目（含 StepId、函数名、依赖、分组、Order 等），依赖关系和分组信息均从 Registry 自动派生，无需额外维护。
