# installer/macos

macOS 原生安装与管理实现目录。该目录使用 zsh + Homebrew + nvm 提供与 Windows 安装器等价的 Claude Code 环境安装、管理和更新体验。

---

## 入口

| 文件 | 职责 |
|------|------|
| `Install.zsh` | macOS 安装入口，合并 Bootstrap 前置检测，支持 Basic / Advanced 分组和 `ccq` 快捷函数注册 |
| `Manage.zsh` | macOS 管理入口，提供 Update / Provider / MCP / Skills 四类管理能力 |
| `core/*.zsh` | macOS runtime core：UI、Process、Profile、Platform、PackageManager、JSON、Registry、Bootstrap、McpManager、Provider |
| `steps/*.zsh` | macOS 13 个安装步骤 + Skills 管理模块，StepId 与 Windows 保持一致 |

**核心模块**：
- `Ui.zsh`：语义颜色系统、表格渲染、菜单交互、错误详情展开
- `Process.zsh`：命令执行、重试、超时、npm outdated 缓存、版本检测
- `Profile.zsh`：原子写入、备份管理、受管区块、Update Manifest、Snapshot
- `Platform.zsh`：平台检测、路径规范化
- `PackageManager.zsh`：Homebrew 封装
- `Json.zsh`：JSON 操作辅助
- `Registry.zsh`：步骤注册表、依赖拓扑排序、Legacy StepId 映射
- `Bootstrap.zsh`：步骤生命周期、Critical 失败策略、最终摘要
- `McpManager.zsh`：MCP Vault 管理、状态计算、批量切换、动态 Rules 渲染
- `Provider.zsh`：供应商 CRUD、切换、Sync、模型环境键管理

云端首次安装入口：

```sh
curl -fsSL "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.sh" | bash
```

`curl ... | bash` 入口只负责兼容常见远程执行形态；脚本主体会自动切换到 `/bin/zsh`。

---

## 关键约束

- 最低系统版本：macOS 12+。
- 包管理器：Homebrew。
- Node.js：通过 nvm 官方脚本安装 LTS，**只做 nvm（不支持 fnm / npm 全局包备份恢复）**；检测到当前 Node.js/npm 已满足最低版本时，安装生命周期最终状态应为 `Skipped`，不应标记为 `Success`。
- Profile 写入：
  - Homebrew 仅在 CCQ 执行官方安装成功后，按官方推荐追加 `eval "$(<brew路径> shellenv)"` 到 `~/.zprofile`。
  - `ccq` 快捷函数写入 `~/.zshrc`。
  - CCQ 自身写入优先使用 `# >>> Claude Code Quickstart >>>` 托管块；Homebrew 与 nvm 初始化遵循各自官方安装方式，不注入 CCQ 托管块。
- 配置 schema 与 Windows 共享：`~/.claude/settings.json`、`~/.claude.json`、`~/.claude/providers/`、`~/.ccq/mcp-meta.json`。
- Skills catalogue 与 ignore policy 共享 `installer/contracts/skills.json`；`IgnoredSkillNames` 中的 CCG Workflow 受管 Skills 不进入 macOS Skills 状态、更新或卸载候选。
- 禁止调用 Windows 专属机制：winget、注册表、MSI/EXE、Windows Terminal、Windows `$PROFILE`。
- 可选工具无自动路径或失败时返回 `ManualRequired` / `Unsupported`，不得计入 Success。

---

## 调试命令

```sh
# 查看步骤列表
zsh installer/macos/Install.zsh --list-steps

# 安装基础环境
zsh installer/macos/Install.zsh --group Basic

# 一键安装进阶必选组件
zsh installer/macos/Install.zsh --group Advanced --mode OneClick

# 选择安装进阶组件
zsh installer/macos/Install.zsh --group Advanced --mode Select

# 查看可更新组件
zsh installer/macos/Manage.zsh --action Update --list-updates

# 管理供应商 / MCP / Skills
zsh installer/macos/Manage.zsh --action Provider
zsh installer/macos/Manage.zsh --action Mcp
zsh installer/macos/Manage.zsh --action Skills
```

构建 macOS 单文件产物：

```sh
sh installer/build.sh
```

Windows PowerShell 构建入口只生成 Windows 产物，不再生成 macOS artifact。

生成产物：

- `dist/install.sh`
- `dist/manage.sh`
