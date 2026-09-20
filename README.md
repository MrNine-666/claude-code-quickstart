# Claude Code Quickstart (CCQ)

Windows / macOS 上的 CLI Agent 环境安装器 + 管理控制台，支持 Claude Code、Codex、Pi。

一条命令装好 Node.js、Git 和 `ccq`，之后在 `ccq` 里统一管理三个 Agent 的工具、供应商、配置、MCP、Skills 和扩展，不用手改配置文件。

---

## 目录

- [它能做什么](#它能做什么)
- [系统要求](#系统要求)
- [安装](#安装)
- [使用 ccq](#使用-ccq)
- [常见问题](#常见问题)

---

## 它能做什么

- **装环境一条命令**：Windows 走 PowerShell，macOS 走 Homebrew / zsh，自动装好 Node.js 和 Git；已经装好的自动跳过，重复执行也不会出错
- **三个 Agent 一个界面**：顶部 Header 切换 Claude Code / Codex / Pi，三套配置互不影响
- **换供应商不碰其它配置**：每个供应商单独一份，切换或设默认只改供应商相关的东西，语言、权限等设置原样保留
- **模型信息自动填**：从上游拉出模型列表，再自动补上上下文窗口、输出上限、价格、思考等级
- **中转不认 Pi 就伪装**：内置 Claude Code / Codex CLI / Gemini CLI 请求头预设，选一下就能以对应客户端身份请求
- **MCP / Skills / 扩展统一维护**：凭据填一次多处复用，装了什么、有没有更新一眼可见
- **误删有保护**：卸载、覆盖等操作都要确认，更新前自动留一份可回滚的备份

---

## 系统要求

|  | Windows | macOS |
|---|---|---|
| 系统 | Windows 10 1903+ / Windows 11 | macOS 12 及以上 |
| 权限 | 建议用管理员 | 普通用户即可 |
| Node.js | 已有达标版本就复用，否则自动装 LTS | 同左 |

网络需要能访问 GitHub 与 npm registry。

---

## 安装

### 方式一 一条命令安装

Windows：以**管理员身份**打开 PowerShell，执行

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
irm 'https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.ps1' | iex
```

macOS（12+）：

```sh
curl -fsSL "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.sh" | bash
```

装完**新开一个终端**，运行 `ccq` 进入控制台。

![Windows 安装界面](./assets/screenshots/windows-install.png)

#### 只装 ccq 控制台（不装 Node.js / Git）

Windows：

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
irm 'https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/download-ccq.ps1' | iex
```

macOS：

```sh
curl -fsSL "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/download-ccq.zsh" | zsh
```

这两个入口只装 `ccq` 本体，不装 Node.js、Git 和三个 Agent。

![macOS 安装界面](./assets/screenshots/macos-install.png)

### 方式二 下载脚本执行

从 [Releases](../../releases) 下载对应平台的安装脚本和可执行文件，然后运行：

```powershell
# Windows
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
.\install.ps1
```

```sh
# macOS
bash ./install.sh
```

### 方式三 从源码运行（开发者）

```sh
git clone https://github.com/MrNine-666/claude-code-quickstart.git
cd claude-code-quickstart

cd tui
bun run dev
```

---

安装脚本只负责基础环境和 `ccq` 本体。Claude Code / Codex / Pi 以及周边工具，装完后在 `ccq` 的「工具管理」里按需安装。

---

## 使用 ccq

直接运行 `ccq` 进入控制台。控制台有 7 个页面，常用操作也有命令行命令。

### 常用命令

| 命令 | 说明 |
|---|---|
| `ccq` | 打开控制台 |
| `ccq ls [--tool claude\|codex\|pi]` | 列出供应商，默认 `claude` |
| `ccq use <名字> [--tool claude\|codex]` | 设为默认供应商 |
| `ccq update [--check]` | 检查或更新 `ccq` 本体 |
| `ccq tools update [名字]` | 更新全部工具，或只更新指定工具 |
| `ccq tools uninstall <名字> [-y]` | 卸载工具，默认要 y/N 确认 |
| `ccq uninstall [-y]` | 卸载 `ccq`，默认要 y/N 确认 |

脚本、管道等非交互场景记得加 `--yes` 或 `-y`。

### 七个页面

**1）工具管理**：安装 / 更新 / 卸载 Claude Code、Codex、Pi，以及 Ccline、OpenSpec、Trellis、CodeGraph 等公共工具。侧边栏底部可以更新 `ccq` 自己。

![工具管理](./assets/screenshots/tui-tool.png)

**2）供应商**：给三个 Agent 各配一套供应商。内置智谱 GLM、DeepSeek、Kimi Coding Plan、MiniMax 模板，填个 Key 就能用，也可以自己加。

- **拉模型**：填好地址和 API Key，按 `Ctrl+D` 自动列出可用模型
- **自动补信息**：在模型列表按 `Space`，自动补上上下文窗口、输出上限、价格、思考等级；同名多来源会先给你看摘要，按 `Ctrl+S` 保存
- **配置 Pi 的请求头**：有些中转会认客户端身份，在「请求头」上方左右键选 Claude Code / Codex CLI / Gemini CLI，按 `Enter` 应用即可
- Kimi 两个模板同一端点、同一 Key，只差上下文档位：1M 版需 Allegretto 及以上套餐，256K 版 Moderato 及以上即可，token 消耗约为 1M 版一半

![供应商管理](./assets/screenshots/tui-providers.png)

**3）配置文件**：查看和修改三个 Agent 的配置。按 `Ctrl+T` 写入带注释的推荐配置，`Ctrl+O` 补全缺失项，都不会覆盖你已经设置好的内容。

![配置文件管理](./assets/screenshots/tui-config.png)

**4）全局规则**：编辑三个 Agent 的全局规则文件，让 Agent 每次对话都遵守你的要求。

![全局规则管理](./assets/screenshots/tui-prompt.png)

**5）MCP**：`A` 新增、`E` 编辑、`D` 删除、`Enter` 启用 / 停用。内置 Context7、DeepWiki、Tavily、Playwright、Exa Search、MasterGo、Figma、Chrome DevTools 等常用 MCP，凭据填一次就存下来。

![MCP 管理](./assets/screenshots/tui-mcp.png)

**6）Skills**：一眼看到每个 Skill 在 Claude Code / Codex / Pi 里装没装。按 `a` 进安装页可搜索并多选安装；遇到同名不同来源会逐项问你，不会误覆盖。

![Skills 管理](./assets/screenshots/tui-skills.png)

**7）扩展**：给 Pi 装扩展。空搜索框列出已装的，输入关键词按 `Enter` 搜索官方目录；`Enter` 安装 / 更新，`A` 更新全部，`D` 卸载。卸载只删扩展本身，不动你的设置和凭据。

![扩展管理](./assets/screenshots/tui-extensions.png)

### 临时指定供应商

`ccq` 只管配置，不接管 Agent 进程。临时换供应商直接调底层命令：

```powershell
claude --settings ~/.claude/providers/custom.json
codex --profile custom
pi --provider custom --model model-id
```

参数可以直接追加，例如 `codex --profile custom -m gpt-5`。要长期生效，Claude Code / Codex 用 `ccq use custom --tool claude`、`ccq use custom --tool codex`；Pi 在「配置文件」页改默认 Provider。

---

## 常见问题

**安装失败了怎么办？**

重新跑一遍安装脚本就行。已经装好的会自动跳过，重复执行是安全的。

**找不到 `ccq` 命令？**

先新开一个终端。还不行就在当前终端临时补一下 PATH：

```powershell
# Windows
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
```

```sh
# macOS
export PATH="$HOME/.local/bin:$PATH"
```

**怎么卸载？**

`ccq uninstall` 卸掉控制台本体，或在「工具管理」里逐个卸载工具。卸载不会动你已有的配置和用户数据。

---

## 许可证

[MIT](LICENSE)

---

## 相关链接

- [LINUX DO](https://linux.do/)
