# tui/ — OpenTUI 管理控制台

> 面包屑：[根目录](../AGENTS.md) › tui/
> 生成时间：2026-06-24（Manage TUI 从 Ink 迁移到 OpenTUI + Bun 单文件可执行分发）

---

## 项目概述

**OpenTUI + Bun 单文件可执行 TUI + CLI 子命令入口**，实现 Claude Code Quickstart 的 6 菜单管理控制台（工具管理 / 供应商 / 配置文件 / 全局规则 / MCP / Skills）与 `Claude Code` / `Codex` 全称 Header；轻量命令行操作包括 `ccq cc <provider>` / `ccq cx [profile]` / `ccq ls [--tool claude|codex]` / `ccq use <provider> [--tool claude|codex]` / `ccq update` / `ccq tools update` / `ccq tools uninstall <name> [--yes|-y]` / `ccq uninstall [--yes|-y]`。通过 `bun build --compile` 交叉编译为 4 平台单文件可执行产物（`ccq-windows-x64.exe` / `ccq-windows-arm64.exe` / `ccq-macos-x64` / `ccq-macos-arm64`），运行时消费契约以内联文本形式内嵌进可执行文件，安装后通过 `ccq` 命令天然可达（**不注入 Profile**）。

---

## 技术栈

| 层次 | 技术选型 | 版本要求 |
|------|---------|---------|
| 运行时 | Bun | `>=1.2.0` |
| 渲染引擎 | OpenTUI | `@opentui/core@0.4.2` + `@opentui/react@0.4.2` + `@opentui/keymap@^0.4.2` |
| UI 框架 | React | `19.0.0` |
| 构建工具 | Bun | `bun build --compile` 交叉编译 |
| 类型系统 | TypeScript | `5.x` |
| UI 组件 | `@opentui-ui/toast`、`opentui-spinner` | 可选依赖 |

---

## 目录结构

```
tui/
├── src/
│   ├── index.tsx              # 入口：argv 子命令路由 + createCliRenderer + non-TTY 守卫 + CCQ_VERSION
│   ├── app.tsx                # 双栏布局 + 6 菜单路由 + Claude Code/Codex Header
│   ├── cli/                   # 非交互 CLI 子命令（cc / cx / ls / use / update / tools / uninstall / help / version）
│   ├── core/                  # 业务逻辑（从 manage/source/core 零改写迁移）
│   │   ├── contracts.ts       # 运行时契约内嵌读取（Bun text loader + 源码 fallback）
│   │   ├── settings.ts        # settings.json 读写
│   │   ├── providers.ts       # Claude Code 供应商 Profile 管理
│   │   ├── codex.ts           # Codex 官方 profile-file / provider TOML 管理
│   │   ├── toml-edit.ts       # Codex config/profile/MCP 结构化 TOML 编辑
│   │   ├── mcp.ts             # MCP vault + Claude/Codex 双目标 server 管理
│   │   ├── skills.ts          # Skills 安装 / 更新 / 卸载（agent 参数化）
│   │   └── ...
│   ├── services/              # 平台服务（从 manage/source/services 零改写迁移）
│   ├── state/                 # 状态管理（从 manage/source/state 零改写迁移）
│   ├── views/                 # 6 视图 + view-services 适配层
│   │   ├── provider-view.tsx  # 供应商视图
│   │   ├── mcp/               # MCP 视图
│   │   ├── skills-view.tsx    # Skills 视图
│   │   ├── prompts-view.tsx   # 全局规则视图
│   │   ├── config-view.tsx    # 配置文件视图
│   │   └── tools-view.tsx     # 工具管理视图
│   ├── components/            # 共享组件
│   │   ├── modal.tsx          # Modal（自造，`<box border>` + 焦点栈）
│   │   ├── data-table.tsx     # DataTable（官方 `<texttable>`）
│   │   ├── status-dot.tsx     # StatusDot
│   │   ├── list-state.tsx     # 列表状态组件（ListEmptyState / ListLoadingState）
│   │   └── ...
│   ├── hooks/                 # 自定义 hooks
│   │   ├── use-keyboard.ts    # 全局键盘分发（替代 Ink useInput）
│   │   └── use-detection-cache.ts
│   └── theme/                 # 主题配置
│       ├── index.ts           # 颜色 / 边框
│       └── logo.ts            # Logo（纯色 `<text>`，无 gradient）
├── assets/                    # 静态资源
│   └── ccq-icon.ico           # Windows 可执行文件图标（256×256 Claude 橙渐变 + CCQ 字母）
├── contracts/                 # TUI 链契约（运行时消费项内嵌；其余保留为磁盘源契约）
│   ├── providers.json         # 供应商定义（运行时内嵌）
│   ├── mcp-servers.json       # MCP Server 配置（运行时内嵌）
│   ├── claude-config.json     # Claude 配置模板（运行时内嵌）
│   ├── ccg-workflow.json      # CCG Workflow 配置（磁盘源契约，未来工具管理迁移用）
│   ├── templates/             # 模板目录（claude-md.* 运行时内嵌，index.json 为磁盘源契约）
│   └── claude-config-drift.js # 配置漂移检测脚本（CI / installer 引用）
├── scripts/                   # 构建 / 验证脚本
│   ├── build.ts               # 构建脚本（4 平台交叉编译 + Windows icon 嵌入）
│   ├── generate-icon.ts       # 图标生成器（SVG → sharp → ICO）
│   └── verify-*.mjs           # 验证脚本（bun 直跑 src，bun run verify 聚合）
├── dist/                      # 构建产物（4 个可执行文件）
├── package.json               # 项目配置（packageManager: bun）
├── tsconfig.json              # TypeScript 配置
└── bun.lock                   # Bun 锁文件

旧 `manage/` Ink 子项目（`manage/source/` TypeScript + Node 22 + 目录缓存）已删除。
```

---

## 关键约束

### HC-OPENTUI-STRUCTURE（新增）
SHALL 保持 OpenTUI 官方脚手架结构完整性，禁止破坏官方结构（`src/index.tsx` 入口、`bun.lock`）。官方命令为 `bun create tui --template react <项目名>`（等价于 `bunx create-tui -t react <项目名>`）。

### HC-BUSINESS-REUSE
从 `manage/source/` 迁移到 `tui/src/` 的纯 TS 业务逻辑（`core/` / `services/` / `state/`）**零重写**，仅 import 路径 / 扩展名适配，无逻辑改写。

### HC-EDITOR-OPENTUI
编辑器全部使用 OpenTUI 官方 `<textarea>` 和 `<code>`，替代 `react-ink-textarea` + `external-editor.ts`。四视图（供应商 extraEnv / MCP 字段 / 全局规则 / 配置文件）改为内嵌编辑，删除外部编辑器调用链。

### HC-TREESITTER-COMPILE（新增）
**Bun `--compile` 单文件可执行产物中禁用 Tree-sitter 语法高亮**，降级纯文本。根因：OpenTUI `TreeSitterClient.resolveWorkerPath()` 用 `existsSync(import.meta.dirname/parser.worker.js)` 判断 worker 路径，编译产物下 `import.meta.dirname` 是 Bun 虚拟路径（`B:\~BUN\root`），`existsSync` 完全失效（连目录都判 false），回退到不存在的 `parser.worker.ts` → `ModuleNotFound resolving "B:\~BUN\root\parser.worker.ts"`。且 Bun `--compile` **不会嵌入** `new Worker(new URL(...))` 动态引用的 worker 文件（官方文档明确：bundler 不自动检测 `new Worker()`，即使列为 entrypoint + 环境变量强制 `.js` 路径，实测仍 `ModuleNotFound`，`strings exe | grep worker` = 0）——「保留高亮」方案技术不可行。
- **实现**（`src/app.tsx`）：模块级 `IS_COMPILED_EXECUTABLE = import.meta.dirname != null && !existsSync(import.meta.dirname)`（源码模式 false / 编译产物 true），TreeSitter 初始化 `useEffect` 开头守卫 `if (IS_COMPILED_EXECUTABLE) return;`——**连 `getTreeSitterClient()` 都不创建**（构造即 `startWorker`，`console.error` 在 worker.onerror 内部无法外部拦截，必须从源头跳过）。
- **降级安全**：所有视图已做 `syntaxStyle ? <code> : <text>` 与 `if (!syntaxStyle)` 纯文本降级，`null` 不破坏界面；源码 dev 模式（`bun run dev`）仍保留语法高亮。
- **约束**：新增任何依赖 Tree-sitter / `getTreeSitterClient` 的功能时，必须先过 `IS_COMPILED_EXECUTABLE` 守卫；禁止在编译产物路径上尝试「嵌入 worker」方案（已证伪）。

### HC-BUN-COMPILE-MINIFY（新增）
**TUI 默认构建禁止启用 `bun build --compile --minify`**。OpenTUI 与第三方 host component 依赖运行时注册、副作用执行和组件名字符串；`--minify` 在编译产物下可能触发 tree-shaking / 注册顺序 / 组件名压缩类问题（历史教训：`opentui-spinner/react` 的裸副作用注册在编译产物下失效，报 `Unknown component type: spinner` / `spinnen`）。
- 默认构建命令保持 `bun build --compile --target ...`，不带 `--minify`。
- 如需重新尝试 minify，必须先为 OpenTUI host component 注册、Tree-sitter 降级、contracts 内嵌和关键视图交互补齐编译产物级门禁，再逐项验证。
- 第三方 host component 注册禁止依赖裸副作用 import；必须显式调用注册函数（如 `registerSpinner()`），确保 bundler 不会误删。

### HC-RELEASE-VERSION-SOURCE
**TUI 发布版本号以 Git tag 为唯一数据源，禁止人工修改 `tui/package.json` 为发布版本。** 仓库内 `tui/package.json` 的 `version` 保持开发态哨兵值 `0.0.0-dev`；GitHub Actions 在 tag 构建（`GITHUB_REF_TYPE=tag`）时从 `GITHUB_REF_NAME` 去掉前缀 `v`，临时写入 `package.json` 后再执行 `bun run build`。
- `src/version.ts` 继续从 `package.json` 读取 `CCQ_VERSION`，保证 `ccq --version`、`--help`、TUI 页脚与热更新比对共用同一内嵌版本。
- CI tag 构建必须在构建前验证 `bun src/index.tsx --version` 等于 tag 版本，并在 Windows/macOS smoke 中验证编译产物 `--version`。
- 非 tag 构建保留 `0.0.0-dev`，用于开发与主分支 smoke；不得为了发布手改、提交真实版本号。
- 禁止运行时联网获取“当前版本”：当前版本必须内嵌，热更新只允许联网获取 latest release 作为对比端，避免破坏离线可用与启动性能。

### HC-CLI-SUBCOMMAND
ccq 可执行文件支持「无参进 TUI + 子命令非交互」双入口。`src/index.tsx` 必须先解析 argv，再执行 non-TTY 守卫：
- `ccq`（无参）保持进入 OpenTUI 6 菜单；若无参且 non-TTY，仍输出只读提示并退出码 0。
- `ccq cc <provider> [claude-args...]` 用 `~/.claude/providers/<provider>.json` 作为 `claude --settings` 启动 Claude Code，**不写盘**，后续参数原样透传给 claude；必须用 `Bun.spawn(..., {stdio: ['inherit','inherit','inherit']})` 保持交互 TTY，禁止复用 `execCommand`（它 `stdio:'pipe'` 会吃掉 TTY）。
- `ccq ls` 列 provider 并标记当前默认；`ccq use <provider>` 复用 `switchProvider` 设置默认（写入 `~/.claude/settings.json`，持久生效）。
- `ccq update [--check]` 复用 `core/update.ts` 的整可执行文件热更新逻辑；`--check` 只检查，不下载/替换。
- `ccq tools update [name]` 复用 `core/tools-manage.ts` 检测与 `updateComponents` 更新工具；未指定 name 时仅更新 `hasUpdate=true` 的组件。
- `ccq tools uninstall <name> [--yes|-y]` 复用 `uninstallComponent` 卸载工具；默认必须输入 `y` 确认，追加 `--yes` 或 `-y` 才可跳过确认。非 TTY 环境未传 `--yes`/`-y` 时必须拒绝执行。
- `ccq uninstall [--yes|-y]` 卸载 ccq 本体（删除 `~/.local/bin/ccq[.exe]`）；默认必须输入 `y` 确认，追加 `--yes` 或 `-y` 才可跳过确认。非 TTY 环境未传 `--yes`/`-y` 时必须拒绝执行。
- `cc` 与 `use` 语义必须分离：`cc` = 临时 session 覆盖；`use` = 持久默认。新增 CLI 命令按 `ccq <verb> [object] [--flags] [-- passthrough]` 子命令骨架扩展，禁止把动作塞进裸 flag（如 `-cc`）。
- **多工具命名与 agentContext（HC-CLI-MULTITOOL）**：ccq 支持 Claude Code 与 Codex 双 Agent（内部键 `agentContext: 'cc' | 'cx'`，界面只展示全称 `Claude Code` / `Codex`，不显示缩写）。两工具的 provider/profile 独立存储，**禁止复用 claude provider 文件或塞进 `~/.claude/settings.json`**：
  - 独立短动词：claude = `cc`，codex = `cx`（`ccq cx <key> [codex-args...]`）；`cc` 语义不变。
  - Codex 走官方 `~/.codex/<key>.config.toml` + `codex --profile <key>` 机制；**不支持** `~/.codex/provider/*.config.toml`，Codex 0.134.0+ 不再读 `[profiles.<key>]` 与顶层 `profile = "<key>"` selector。
  - **Codex 路径固定 `~/.codex`**：ccq 管理的是用户系统级 Codex 配置，`codexDir()` **不读取 `CODEX_HOME`**。原因：上游 `ccg-workflow codex-mode` 硬编码 `~/.codex`；orca 等工具即使注入临时 `CODEX_HOME`，也以系统 `~/.codex` 为镜像源。禁止把 ccq 写入目标改回运行时 `CODEX_HOME`，避免临时 runtime home 与系统配置分裂。
  - **Codex key = 唯一身份**：用户只填一个 key，同时作为 `<key>.config.toml` 文件名、`--profile` 名、`model_provider` id、`[model_providers.<key>]` table id 与默认显示名；不设独立 profileName/providerId/displayName。
  - **Codex API key = 直写 profile TOML**：写入 `[model_providers.<key>].experimental_bearer_token`，同一 provider table 禁止再写 `env_key` / `auth` / `requires_openai_auth`；**不写 ccq vault、`ccq cx` 不注入 env**；UI 字段默认 mask，日志/toast/error/verify 输出全链脱敏。`official login` 类型不要求 API key，靠 `codex login` 完成认证。
  - **official login auth.json 可编辑**：`official` 虚拟条目仍不落盘 profile TOML，但支持编辑 `~/.codex/auth.json`——**add 态**（新增/选类型）textarea 展示脱敏预览（`access_token`/`refresh_token` 等 → `***`）且只读；**edit 态**（对 official 按 E）textarea 回填**明文原文**供直接编辑，`writeCodexAuthJson` 是唯一写入口，保存前校验 JSON 合法性（顶层须为对象），空内容保存 = 登出（删除 auth.json）。编辑态必然明文展示凭据（否则无法编辑），但 toast/日志/error 输出仍全链脱敏。区分 add/edit 靠 `CodexProviderFormValues.authEditable` 标志，adapter 的 `isTextReadOnly`/`buildText`/`parseText` 据此路由。
  - **编辑活跃 profile 同步 config.toml**：`saveCodexProviderForm` edit 态保存子文件后，若该 profile 是当前默认（`isDefaultCodexProfile`），必须重新 `setDefaultCodexProfile` 把新供应商键刷进 `~/.codex/config.toml`——否则子文件已改而 config.toml 停留在激活那一刻的旧值；非活跃 profile 编辑不触碰 config.toml。
  - `ls`/`use` 扩展 `--tool claude|codex`，`--tool` 缺省 = claude（`ccq ls` / `ccq use` 行为零破坏）；`ccq use <key> --tool codex` 结构化写 `~/.codex/config.toml` 的 provider/default 路径，**不写** `profile =` / `[profiles.<key>]`。
  - `cx` 与 `cc` 同为启动类：`Bun.spawn(..., {stdio:['inherit','inherit','inherit']})` 继承 TTY，退出码透传，ENOENT=127。
  - TOML 读写统一走 `core/toml-edit.ts` 结构化编辑（parse/get/set/delete/atomicWrite），**不默认使用 managed marker block**，只更新明确路径、保留无关字段/注释。
  - 每个工具的 profile 存储、凭据保管、spawn 方式各自独立，**不强行抽象统一 provider 模型**（claude 全塞 `--settings` 单文件，codex 走官方 TOML profile；协议本就不同，抽象会落空），只复用 UI/表单/校验/服务边界。
- **两类动词分类（HC-CLI-VERB-KIND）**：CLI 动词按"后续 token 语义"分两类，各动词的 `parseXxx` 函数独立解析后续 token，互不干扰；新增动词必须先归类：
  | 动词类型 | 后续 token 语义 | `--` 透传 | 既有/预留示例 |
  |---------|----------------|----------|--------------|
  | **启动类** | 对象=provider 名 + 参数透传给**底层工具**（claude/codex） | ✅ 用（`--` 后甩给底层工具） | `cc`（既有）/ `cx`（本 change 实现） |
  | **管理类** | 子命令 + **ccq 自有 flag**（`--all`/`--force`/`--json` 等），不透传给底层工具 | ❌ 不用（管理命令无底层工具可透传） | `ls`/`use`/`update`/`tools`/`uninstall`（既有）/ `mcp`/`skills`（预留） |
  - **禁止**给管理类动词套 `--` 透传语义：`--` 是为"启动类把参数转给 claude/codex"设计的，管理命令（如 `ccq mcp add`/`ccq update self`）该用自己的 flag 解析，不得复用 `parseCc` 的 `--` 逻辑。
  - 管理类动词支持"动词 + 子对象"两级（如 `ccq mcp list` / `ccq mcp add` / `ccq mcp rm <id>` / `ccq update self|tools|skills`），子对象由该动词的 `parseXxx` 自行路由，不在 `parseCli` 顶层展开。
  - 复用优先：管理类动词应直接包装既有 core 层能力（`core/update.ts` / `core/mcp.ts` / `core/skills-actions.ts` / `core/tools-manage.ts`），CLI 层只做参数解析 + 调用 + 退出码，不重复实现业务逻辑。
- 新增/修改 CLI 路由必须同步 `scripts/verify-cli-subcommands.mjs` 与本文档；新增工具动词须在本约束补一行动词表 + 存储约定；新增管理类动词须归入上表两类之一。

### HC-AGENT-CONTEXT-SHELL
TUI 不新增第 7 个 Codex 菜单；改由右侧 content 顶部的全局 **Header** 用全称 `Claude Code` / `Codex` 切换 `agentContext`（内部键 `cc` / `cx`，界面不展示缩写）。左侧导航恒为 6 项（工具管理 / 供应商 / 配置文件 / 全局规则 / MCP / Skills），Header 切换**不改变**菜单顺序，只重渲染当前模块的 Agent 数据域；默认 `Claude Code`。`agentContext` 下发给 Tools / Provider / Config / Prompts / MCP / Skills 各视图及其 service，视图不自行推断路径、不直接写运行时配置文件（写盘只在 core/service 层）。骨架门禁 `scripts/verify-agent-context.mjs`。
- **工具管理 / MCP / Skills 隐藏 Header**（shared-resource-injection-ui）：`displayMenuId` 属于共享双侧模块集合 `AGENT_HEADER_HIDDEN_MODULES`（`tools` / `mcp` / `skills`）时**不渲染 AgentHeader**，content 高度不预留 Header 行；残留 `focus === 'header'` 强制回 `view`，列表/网格顶行 `↑` 停在首项（不退回 header），`Esc` / 光标 0 时 `←` 回 `nav`。全局 `agentContext` 状态**保留**，进出这三个模块不改其值；切到其它 Agent 独占模块时 Header 恢复并展示保留的上下文。Skills 检测与 `agentContext` **解耦**（一次 `skills list -g --json` 无 `--agent` 得双侧态），`skillsViewServices` 不再按 `state.agentContext` 建 service key、不随 Header 重建。其它模块 Header 与 `view↑→header` 行为不变（门禁 `scripts/verify-manage-tui-state.mjs` / `scripts/verify-agent-context.mjs`）。

### HC-TOOLS-AGENT-GROUP
工具管理以**共享资源列表**为主（shared-resource-injection-ui）：列表**不按 `agentContext` 过滤**，7 组件全集常显（骨架 `scripts/verify-tools-context.mjs` / `scripts/verify-tools-shared-projection.mjs`）：
- Tools UI 主路径 = `projectSharedToolComponents(detected)`（返回 `SharedManagedComponent[]`，全集恒定顺序），**禁止**再用 `filterVisibleComponents(..., agentContext)` 作为列表主路径（该函数保留仅供 legacy 门禁 / CLI 兼容）。
- UI 必须展示为「分组 label + grid」结构，分组顺序固定为 **Agent → statusLine → 三方工具**；空分组隐藏。分组事实源只能来自 `COMPONENT_META` / `TOOL_GROUP_ORDER` / `TOOL_GROUP_META`，禁止在 `ToolsView` 内硬编码第二套分类或工具顺序。
- **资源分类 `sharingKind`（挂在 `COMPONENT_META`，单一事实源）驱动呈现**：
  - `shared-cli-per-agent-inject`（**CodeGraph / CcgWorkflow**）：卡片行 2 展示 `Claude Code ●|○` + `Codex ●|○` 双态徽章（全称，禁 `cc`/`cx` 缩写；`●`=已注入 success，`○`=未注入 muted），两侧状态由 `injectByAgent` 独立投影、互不塌缩（CodeGraph 来自 `hasClaude/CodexCodeGraphIntegration`，CcgWorkflow 来自 `hasClaude/CodexCcgWorkflowMode`；CcgWorkflow 无真·共享 CLI，**不伪造** `sharedInstalled`）。
  - `fully-shared-no-inject`（**OpenSpec / AntigravityCli**）：仅全局安装态，**无**行 2 inject 徽章。
  - `agent-exclusive`（**ClaudeCode / CodexCli / Ccline**）：行 2 仅标注适用范围（`Claude Code 本体` / `Codex 本体` / `仅 Claude Code`），Ccline 不提供 Codex 注入。
- **交互（Enter 开关 Modal / u 更新 / d 全量卸载，职责分离硬约束）**：
  - inject 类 **Enter** 打开开关管理 Modal（`select-inject-target`）：进入时用当前双侧 `injectByAgent.integrated` 初始化本地草稿（`injectDraft`），`↑/↓` 选 `Claude Code`/`Codex`，`空格`切换该侧草稿开/关（纯本地，不落盘），`Enter` 统一应用——对比草稿与实际态、对每个变化侧顺序执行 `injectComponent(id, target)` / `ejectComponent(id, target)`，`Esc` 取消。目标 **显式传入**，禁止依赖 Header agentContext（`ToolsView` 不得 useMemo 把 Header 绑死到 inject 路径）；无变化时提示「未改变任何开关」。
  - **u** = 更新当前项（含 inject 类共享 CLI）：inject 类 Enter 被开关 Modal 占用后，单项更新统一改由 `u` 触发；无更新则提示已是最新。
  - inject 类 **d** = 全量卸载（`confirm-uninstall`，`uninstallComponent(id, {fullUninstall:true})`：解除两侧注入 + 移除共享 CLI/包），**不**进入开关 Modal；确认文案写明「CLI + 全部注入」。单侧关闭注入**只走 Enter 开关 Modal**。
  - 非 inject 类 Enter 保持 install/update/已是最新，`u` 更新当前项，`d` 保持既有全局卸载。
- 快捷键单一数据源（HC-SHORTCUT-SINGLE-SOURCE）：开关相关键位注册在 `keybindings.ts`（`TOOLS_COMMANDS.INJECT_TARGET_TOGGLE`=空格 / `INJECT_TARGET_CONFIRM`=Enter 应用 / `INJECT_TARGET_CANCEL`=Esc；`UPDATE_ONE`=u），footer 仅在光标落在 inject 类（`grid-inject`）时提示「管理开关」，禁止视图硬编码键位字面量。
- install/update/uninstall 经 lifecycle command resolver 按目标 Agent 返回不同指令：
  - **CodeGraph**：检测安装态必须同时满足 CLI 可用与当前 Agent MCP 已接入（Claude Code 看 `~/.claude.json.mcpServers.codegraph`，Codex 看 `~/.codex/config.toml` 的 `[mcp_servers.codegraph]`）；install 语义是“确保共享 CLI + 接入当前 Agent”：若 `codegraph --version` 已可用，必须跳过 `npm install -g @colbymchenry/codegraph`，直接执行 `codegraph install --target=<claude|codex> --location=global --yes` 并校验 MCP 写入成功；CLI 不可用时才安装 npm 包；update 更新 npm CLI 后按已接入的 cc/cx 目标逐个重跑 `codegraph install ...`；uninstall 先执行 `codegraph uninstall --target=<claude|codex> --yes`，随后若 cc/cx 两边都无 CodeGraph MCP，则自动 `npm uninstall -g @colbymchenry/codegraph`，始终不删除项目 `.codegraph/` 索引（骨架 `scripts/verify-codegraph-lifecycle.mjs` + `scripts/verify-tools-manage.mjs`）。
  - **CcgWorkflow**：上游 GitHub 仓库真实标识为 `fengshao1227/ccg-workflow`（查 DeepWiki/GitHub 时不要用 `MrNine-666/ccg-workflow`）；Claude 走 `npx ccg-workflow@latest init ... --install-dir ~/.claude`（保留 mcpServers 快照保护）+ `npx ccg-workflow uninstall`；Codex Mode 走官方非交互 `npx ccg-workflow codex-mode install/uninstall`。文件边界（`config.toml`/`AGENTS.md`/hooks/rules）一律交给官方命令负责，**ccq 不手写 fs 删除 `~/.codex/config.toml`**（骨架 `scripts/verify-ccgworkflow-codex.mjs`）。

### HC-CONFIG-RULES-REUSE
Config / Global Rules 视图按 `agentContext` 切换目标文件但复用同一 UI（预览页 / `e` 编辑 / `Ctrl+T` 推荐 / `Ctrl+O` fill-missing 导入 / 损坏文件拒绝覆盖 / 脏编辑保护），骨架 `scripts/verify-config-rules-reuse.mjs`：
- **Config**：Claude 读写 `~/.claude/settings.json`；Codex 读写 `~/.codex/config.toml`，经 `core/toml-edit.ts` 结构化写入；Codex 推荐配置仅 fill-missing 补齐通用运行项（`model_reasoning_effort` / `approval_policy` / `sandbox_mode` / `web_search` / `hide_agent_reasoning` / `file_opener`），**不含 `model`**（模型由「供应商」profile 设为默认时原文覆盖决定），也不管理 provider/MCP/hooks/Skills/AGENTS.md。
- **Global Rules**：Claude 读写 `~/.claude/CLAUDE.md`；Codex **只**读写 `~/.codex/AGENTS.md`，推荐规则内容复用 cc 推荐规则。

### HC-MCP-FILE-SOURCE
MCP 状态以运行时配置文件为唯一事实源，**忽略 vault 历史 `disabled` 字段**（骨架 `scripts/verify-mcp-multitool.mjs`）：Claude 读 `~/.claude.json` 的 `mcpServers.<id>` 是否存在；Codex 读 `~/.codex/config.toml` 的 `[mcp_servers.<id>]`（`enabled = false` 判 Disabled）。同一 MCP 可在 Claude Code / Codex 独立启用。vault 只保管 MCP 凭据、配置备份、definition hash，**不作 Active/Disabled 状态源，也不保存 Codex API key**。

### HC-MCP-SHARED-INJECTION
MCP 视图以**共享双侧列表**为主（shared-resource-injection-ui Section 8-13，骨架 `scripts/verify-mcp-shared-projection.mjs`）：
- **双侧聚合投影 `computeSharedStatus()`**（`core/mcp.ts`）：一 Server ID 一行，`injectByAgent.{cc,cx}` 双侧开关态独立不塌缩；**每次实时读 `~/.claude.json` / `~/.codex/config.toml` 派生开关态**（对齐 HC-3 / HC-MCP-FILE-SOURCE，不缓存、不以 vault 推断激活）。列表全集 = `vault 定义 ∪ ~/.claude.json mcpServers ∪ ~/.codex config.toml [mcp_servers]`，按 Id 去重。**纯读投影，绝不物化 vault → runtime**（区别于带副作用的 `computeStatus`）；仅把两侧现有 runtime 配置**备份**进 vault 作共享定义体。`McpView` 禁止再用 `computeStatus(agentContext)` 作列表主路径。
- **vault 升格为共享定义源**：vault `servers.<id>.config/credentials` = 跨 Agent 复用的共享定义体；vault 有定义 **≠** 激活态（激活只从 runtime 派生）。
- **行内双态徽章**：一行展示 `● Claude Code` + `● Codex`（全称，禁 `cc`/`cx` 缩写；`●`=开启 success，`○`=禁用/未开启 muted）。面向用户文案统一「**开启 / 禁用**」，**不出现「注入」**（内部函数名可保留 inject/eject）。
- **Enter = 开关目标 Modal**（`select-toggle-target`，照搬 ToolsView `InjectTargetModal` 范式，`width=56`）：草稿预置各侧实时开关态，`↑/↓` 选 `Claude Code`/`Codex`，`空格`切草稿，`Enter` 按草稿 vs 实时态差异对两侧 `enableServer`/`disableServer`（显式传 target，未变侧不写），`Esc` 取消无写盘。Codex 语义：草稿开→存在则改 `enabled=true`/不存在写入；草稿关→写 `enabled=false` 不删块。
- **add = 只写 vault**（`persistSharedDefinition`，不开启任何侧）；**edit = 写 vault + 同步所有当前已开启侧**（`syncSharedDefinition`，未开启侧不开启）；Server ID 不可变、env-file 只读。开启入口唯一 = 列表行 Enter 开关 Modal。
- **d = 全量删除**（`removeSharedServer`，强确认文案写明「两侧 runtime + 共享定义」）：两侧移除 + 删 vault 定义 + 清 settings permission；**不**进选目标流，单侧禁用只走 Enter。
- 快捷键单一数据源：`keybindings.ts` 注册 `MCP_COMMANDS.TOGGLE`（Enter 管理开关）/ `TOGGLE_DRAFT`（空格）/ `TOGGLE_APPLY`（Enter 应用）/ `TOGGLE_CANCEL`（Esc）/ `DELETE`（d 全量删除）；footer 列表光标时展示「管理开关」，禁止视图硬编码键位。

### HC-MCP-OFFICIAL-DEFAULT（新增）
内置 MCP 默认配置对齐官方推荐，且 Claude Code 与 Codex 输出 schema 分离（骨架 `scripts/verify-mcp-official.mjs`）：
- **Exa / Context7 默认走官方 remote HTTP endpoint**（`https://mcp.exa.ai/mcp` / `https://mcp.context7.com/mcp`），`CredentialType: none`（免 key 匿名可用，key 可选不强制）；Playwright / Chrome DevTools / ACE Tool / MasterGo 保持 stdio 官方 npx 形态。
- **Claude Code HTTP MCP 输出保留 `type:'http'`**（`.claude.json mcpServers` 语义）；**Codex HTTP MCP TOML 不写 `type`**，靠 `url` 字段判定 streamable HTTP；Codex stdio 同样不写 `type`，仅保留 `command`/`args`/`env`。
- **Codex schema 转换在唯一出口**：`mcp.ts` 的 `writeCodexMcpServer` 经 `core/mcp-codex-schema.ts` 的 `toCodexMcpConfig` 按白名单（`command`/`args`/`env`/`url`/`bearer_token_env_var`/`http_headers`/`env_http_headers`/`startup_timeout_sec`/`tool_timeout_sec`/`enabled`/`required`）过滤，丢弃 `type` 与 Claude 专有字段；persist/enable/sync 补回三条写入路径统一走此出口。
- **effective definition**：契约 `McpServerDefinition` 可选带 `AgentConfigs: {cc?: Partial, cx?: Partial}`，`resolveEffectiveDefinition(def, agentContext)` 浅合并 base + 覆盖；无覆盖时 pass-through base，不制造差异。`AgentConfigs` 字段不参与最终定义输出。

### HC-SKILLS-AGENT
Skills CLI agent 映射：Claude Code → `--agent claude-code`，Codex → `--agent codex`（`skillsAgentOf`，骨架 `scripts/verify-skills-agent.mjs`）。物理存储与目录映射交由 `skills` CLI（`~/.agents/skills`），ccq **绝不手写 symlink/copy 或自删文件**。

### HC-SKILLS-SHARED-INJECT
Skills 是**共享本体 + per-Agent 注入**模型（非 MCP 对等双 runtime；实测 `skills` CLI：codex=universal agent 直读 canonical 本体 `~/.agents/skills`、装了即可用无独立开关，仅 Claude Code 是可独立建/删的 symlink 注入态）。shared-resource-injection-ui 第三阶段落地（门禁 `scripts/verify-skills-shared-projection.mjs` / `scripts/verify-skills-view.mjs` / `scripts/verify-skills-agent.mjs`）：
- **双侧检测 = 单次 CLI 派生**：`getInstalledSkills()` 无参 / 仅传 exec → **不带 `--agent`** 全量扫所有 agent 目录，一次调用得每条 skill 的 `agents` displayName 列表；显式 `cc`/`cx` 才带 `--agent`（旧单侧路径保留）。`projectSharedSkills` 从 `agents` 派生 `SkillSharedRow`：`sharedInstalled`（含 `Codex`=本体在）/ `claudeInjected`（含 `Claude Code`=symlink 在）/ `codexAvailable`（**恒等于** `sharedInstalled`，codex 无独立态）。非 `Claude Code`/`Codex` displayName 忽略（`SKILL_AGENT_DISPLAY_TO_CONTEXT`）。不缓存、不跑两次 CLI（对齐 HC-3）。
- **列表**：一行一 skill name + `Claude Code ●|○` + `Codex ●|○` 双态徽章（全称，禁 `cc`/`cx` 缩写；文案「已安装/未安装」）。Codex 徽章**只读镜像**共享本体（不画可操作 toggle），Claude Code 徽章反映可切 symlink 态。列表**不按 `agentContext` 过滤**。
- **安装目标 Modal**（安装页选中 skill 后 Enter，`select-install-target`）：复用 Tools `InjectTargetModal` 范式；`Claude Code` 可切，`Codex` **只读恒勾**（`● 安装`，装任何 skill 必写共享本体、直读即可用、无法不装）。空格仅切 Claude Code（Codex no-op）；Claude Code 勾 → `installResultToTargets` 含 cc（`add --agent claude-code` 建本体+symlink），不勾 → 含 cx（`add --agent codex` 仅本体）。
- **管理安装 Modal**（列表行 Enter，`manage-inject`）：`Claude Code` 行可切（`toggleClaudeInstall` → `add`/`remove --agent claude-code`），`Codex` 行只读「已安装（随本体）/未安装」。Esc 无写盘。
- **`u` 更新两侧** = `updateAllSkillsBothSides`（cc/cx 各 `update --agent <侧>`）；**`d` 全量卸载** = `uninstallSkillAllAgents` **单条** `skills remove <skill> -g --agent '*' --yes`（从所有 Agent 删 symlink + 本体，**非挨个 agent**）。单侧撤销的唯一非全量路径 = 管理 Modal 取消 Claude Code（`remove --agent claude-code`）；Codex 无单侧撤销。所有物理删除由官方 CLI 负责。
- 面向用户文案全链统一「已安装/未安装」「安装/卸载」，**不出现**「注入/解除」「开启/禁用」。快捷键来自 `SKILLS_COMMANDS` 单一源（footer 按上下文展示，禁视图硬编码键位字面量）。

### HC-NON-TTY
ccq 可执行文件 non-TTY（管道 / 重定向 / CI）输出只读提示、不进交互 TUI、退出码 0。`src/index.tsx` 入口实现：
```typescript
if (!process.stdin.isTTY) {
  console.log('Claude Code Quickstart 管理控制台');
  console.log('此工具需要交互式终端（TTY）运行。');
  console.log('请在交互式终端中直接运行 ccq 命令。');
  process.exit(0);
}
```

### HC-DELETE-LEGACY
删除旧链时必须全仓 grep 零业务引用确认（`manage-tui.tgz`/`ManageCore`/`ink`/`react-ink-textarea`/`external-editor`/`ccq-function`/`function ccq` 业务引用清零，测试 fixture/历史 plan 文档除外）。

### HC-SHORTCUT-SINGLE-SOURCE
快捷键说明**唯一**由 footer `ShortcutBar`（`app.tsx:178`）展示，按键文本从 `@opentui/keymap`（`config/keybindings.js` 绑定定义）经 `state/shortcuts.ts` 动态解析——**单一数据源**。
- **禁止**在视图/组件内硬编码键位字面量（`[I]`、`[Tab]`、`Ctrl+S` 等）；新增/改键一律走 `config/keybindings.js` 注册 + `shortcuts.ts` 映射，footer 自动同步。
- macOS 快捷键采用**编辑语义 Command + TUI 应用功能 Control**：复制 / 粘贴 / 撤回 / 重做 / 保存等编辑语义用 `⌘`（`KeyEvent.super`），不做 `⌃` 兼容；推荐边栏、导入/补全、面板/焦点切换等应用功能用 `⌃`（`KeyEvent.ctrl`）。非 macOS 仍显示 `Ctrl+...`。
- macOS footer 使用符号展示：Command=`⌘`、Control=`⌃`、Shift=`⇧`、Option=`⌥`；若未来发现终端字体不支持，再在 formatter 中统一 fallback 为 `Cmd+` / `Ctrl+`，禁止视图内单独处理。
- 页面内 `ActionHint`（`components/action-hint.tsx`）**仅承载操作说明文字 + disabled 状态**（footer label 容纳不下的详细描述/禁用提示），**禁止带 `[hotkey]` 前缀**重复展示键位。
- **理由**：键位变更只改 `keybindings.js` / `utils/keyboard.ts` / `shortcuts.ts`，杜绝页面内硬编码与 footer 分裂（历史教训：PromptsView / ConfigView / SkillsView / provider-view 曾用 ActionHint `[hotkey]` 与 footer 双显重复）。

### HC-LIST-STATE-COMPONENT
列表空状态与加载状态统一使用 `components/list-state.tsx` 组件（`ListEmptyState` / `ListLoadingState`），禁止在视图内重复实现空状态/加载状态布局。
- **ListEmptyState**：展示「暂无数据」等空状态提示 + 可选操作提示（hint），自动居中布局 + muted 配色。
- **ListLoadingState**：展示「加载中」提示 + Spinner 动画，自动居中布局。
- **理由**：统一视觉风格，减少重复代码，简化视图实现（历史教训：ConfigView / PromptsView / SkillsView 曾各自实现空状态布局，代码重复且样式不一致）。

### HC-TEXTAREA-NO-SCROLLBAR
**OpenTUI `<textarea>` 自带内部滚动但无可见滚动条**。`EditBufferRenderable` 提供 `scrollY` 只读属性与光标自动滚动能力（`scrollMargin` 等），但**类型定义中无 `scrollbarOptions` 配置项**（不同于 `<scrollbox>` 的 `verticalScrollbarOptions`）。
- **禁止**用 `<scrollbox>` 包裹 `<textarea>`：scrollbox 会接管/抑制 textarea 的内部滚动机制，导致 textarea 完全不滚动（已实测验证，2026-07-01）。
- **接受现状**：textarea 靠光标自动滚动（功能正常），无可见滚动条指示器；用户编辑时光标到达视口边界会自动翻页。
- **扩展方案**（未实施）：若需可见滚动位置指示，需自造独立指示器组件（读 `textareaRef.current.scrollY` 和 `lineCount` 算比例，在 textarea 旁渲染 `<box>` 模拟滚动条，监听 `onCursorChange` 实时更新），工作量大且收益有限。
- **理由**：避免后续再次尝试 scrollbox 包裹方案踩坑（历史教训：2026-07-01 尝试为 TextareaEditor 套 `<ThemedScrollbox>`，导致编辑模式 textarea 完全不滚动，已回滚）。

### HC-SPLIT-OVERFLOW-MARGIN
**flex column 中「标题(marginBottom) + flexGrow 边框(内含 scrollbox + 可溢出内容)」结构，内容溢出会挤掉标题的 marginBottom**：scrollbox 的 min-content 高度会沿 flex 链向上传导、撑大列的总高度，把上方标题行的 `marginBottom` 空行压缩掉，使边框顶边上移一行。
- **现象**：ConfigView / PromptsView split 分栏中，左列（推荐边栏，内容十几行溢出）边框比右列（空 textarea 不溢出）早一行、顶边不对齐。
- **修法**：给 `flexGrow={1}` 的边框 box 加 **`minHeight={0}`**，并给内部 `ThemedScrollbox` 的 style 加 `minHeight: 0`。`minHeight={0}` 放开 flex 子项收缩下限，让内容在分配高度内收缩而非沿 min-content 撑大父容器（flex-height-unify 后统一走 `flexGrow={1} + minHeight={0}`，**不再用 `flexBasis`**——自适应高度全部按 grow 分配、固定项用 `flexShrink={0}`）。
  ```jsx
  <box flexGrow={1} minHeight={0} borderStyle="rounded" ...>
      <ThemedScrollbox style={{flexGrow: 1, minHeight: 0}}>...</ThemedScrollbox>
  </box>
  ```
- **验证手段**：OpenTUI 提供离屏测试渲染器（`@opentui/react/test-utils` 的 `testRender` + `captureCharFrame()`），可离屏渲染并按行读取字符网格，精确测量边框顶边/底边行号——布局类 bug 应用它实测定位，禁止靠肉眼推演 flex 行为。
- **理由**：历史教训 2026-07-09——曾误判为「标题 `<text>` 多行 JSX 引入空白子节点」，改标题单行内联后 bug 依旧（CodePreview 正常渲染的多行 `<text>` 即反例）；离屏探针受控对照实验（唯一变量=内容是否溢出）才锁定真因。由 `verify-layout-shell.mjs` 正则门禁守护。

### HC-CODEPREVIEW-TRAILING-NEWLINE
**`CodePreview` 必须剥离尾部单个换行产生的伪空行**：`content.split('\n')` 对以 `\n` 结尾的标准文件内容（如 `"a\n"`）会在尾部产出一个空串（`["a", ""]`），若直接逐行渲染会多出一道可见空行。`CodePreview` 已在拆行后去掉这个 trailing-newline 伪空行（保留正文中间的真实空行）。
- **理由**：历史教训 2026-07-09——Codex 推荐规则模板仅 4 行（末尾带标准 `\n`），在推荐边栏正文下多渲染一道空行；Claude 侧内容长看不到末尾未察觉，实为通用渲染问题。修复对 c/cx、Config/Prompts 全部一处受益。行为对齐 `cat -n` / 编辑器（尾部换行不算独立一行，中间空行照常保留）。

---

## 开发调试

### 环境要求

- **Bun** `>=1.2.0`（安装：`curl -fsSL https://bun.sh/install | bash`）
- **Node.js**（可选，仅用于兼容性测试）

### 本地开发

```sh
# 安装依赖
cd tui
bun install

# 开发模式（热重载）
bun run dev

# 类型检查
bun run typecheck

# 构建 4 平台可执行文件
bun run build

# 运行全部 verify 门禁（parser / 状态机 / 迁移 / parity）
bun run verify
```

### 源码模式（离线）

源码模式直接运行 `tui/src/index.tsx`，contracts 通过相对路径 `tui/contracts/` 读取，**零网络**：

```sh
cd tui
bun run src/index.tsx
```

---

## 构建与分发

### 构建命令

```sh
# 在 tui/ 目录下构建 4 平台可执行文件
bun run build

# 或直接调用 Bun
bun build --compile --target bun-windows-x64 --outfile dist/ccq-windows-x64.exe src/index.tsx
bun build --compile --target bun-windows-arm64 --outfile dist/ccq-windows-arm64.exe src/index.tsx
bun build --compile --target bun-macos-x64 --outfile dist/ccq-macos-x64 src/index.tsx
bun build --compile --target bun-macos-arm64 --outfile dist/ccq-macos-arm64 src/index.tsx
```

### contracts 内嵌策略

运行时消费的契约通过 Bun `with { type: "text" }` 以内联字符串形式内嵌进可执行文件：
- **打包后**：`providers.json` / `mcp-servers.json` / `claude-config.json` / `templates/claude-md.base.md` / `templates/claude-md.platform-windows.md` / `templates/codex-md.md` 从 `EMBEDDED_CONTRACTS` Map 读取，不依赖 Bun 虚拟文件系统路径。
- **源码模式**：`contracts.ts` 通过相对路径上溯读取 `tui/contracts/`，零网络。
- **磁盘源契约**：`ccg-workflow.json` / `templates/index.json` / `claude-config-drift.js` 保留在 `tui/contracts/`，供 CI、installer 合约测试或后续迁移使用，不再作为 TUI 运行时内嵌 entry。

无需 `CCQ_CONTRACTS_DIR` 环境变量注入（旧 Ink + 目录缓存方案的遗留）。禁止把 Bun `file` loader 当作契约内容使用；`file` loader 返回路径字符串，会导致编译产物下 JSON 解析失败。

### 产物验证

```sh
# 验证运行时契约内嵌（运行编译产物契约探针，断言加载的是内容而非路径）
bun scripts/verify-compiled-contracts.mjs

# 验证 non-TTY 行为
echo | ./dist/ccq-macos-arm64
```

---

## Windows 可执行文件图标

### 图标设计

**位置**：`tui/assets/ccq-icon.ico`  
**规格**：256×256 PNG 压缩 ICO  
**风格**：Claude 橙色渐变圆角方块底（#D97757 → #C25F40）+ 白色粗体 "CCQ" 字母居中

### 生成方法

```bash
cd tui
bun run scripts/generate-icon.ts
```

**依赖**：`sharp`（已加入 `devDependencies`）

### 构建集成

`tui/scripts/build.ts` 已配置 Windows x64 本机构建时自动传入 `--windows-icon` 参数：

```typescript
// Windows x64 + 图标文件存在 → 添加 --windows-icon
if (useIcon && existsSync(ICON_PATH)) {
  args.push(`--windows-icon=${ICON_PATH}`);
  console.log(`   图标: ${ICON_PATH}`);
}
```

### ⚠️ 已知问题（Bun 1.3.14 Bug）

**当前状态**：`--windows-icon` 参数在 Bun 1.3.14 **不生效**，构建产物仍使用 Bun 默认图标。

**验证方法**：
- 构建时无报错，参数被接受
- 但提取 exe 图标仍为 Bun 默认蓝色螺旋图标
- 同样传入 `--windows-title` / `--windows-publisher` 等元数据参数也完全不生效

**根因**：Bun 1.3.14 的 Windows metadata 嵌入存在 regression bug，官方文档声称支持但实际未生效。

**解决方案**：
1. **等待 Bun 官方修复**（推荐）— 图标文件和构建脚本已就绪，Bun 修复后自动生效
2. **尝试 Bun Canary 版**：`bun upgrade --canary`（开发版，可能已修复）
3. **后处理方案**（不推荐）：用 `rcedit` 手动嵌入图标到已编译 exe

**当前策略**：保留 `--windows-icon` 参数和图标资源，等待 Bun 修复后自动生效。构建脚本已做容错处理（图标嵌入失败不中断构建流程）。

**追踪**：待 Bun 官方发布修复后，验证图标是否正常嵌入，并移除本节已知问题说明。

---

## 6 菜单视图

| 菜单 | 文件 | 功能 |
|------|------|------|
| 工具管理 | `views/tools-view.tsx` | Agent 组（ClaudeCode/CodexCli/AntigravityCli）两种 Header 常显；Ccline 仅 Claude Code；OpenSpec/CcgWorkflow/CodeGraph 按 `agentContext` 解析 lifecycle，CodeGraph CLI/integration 分层，CcgWorkflow Codex Mode 走官方非交互命令 |
| 供应商 | `views/provider-view.tsx` + `provider-form.tsx` | Claude Code Header 下管理 `~/.claude/providers/*.json`；Codex Header 下管理 `~/.codex/<key>.config.toml`，key 单一身份，API key 写 `experimental_bearer_token` 且全链脱敏 |
| 配置文件 | `views/config-view.tsx` | Claude Code 读写 `~/.claude/settings.json`；Codex 读写 `~/.codex/config.toml`。复用预览 / `e` 编辑 / `Ctrl+T` 推荐 / `Ctrl+O` fill-missing 导入；仅剥离 model + 供应商 env（AUTH_TOKEN/BASE_URL/受管模型键），Claude 侧 statusLine/hooks/outputStyle 等孤儿字段已放开直编 |
| 全局规则 | `views/prompts-view.tsx` | Claude Code 读写 `~/.claude/CLAUDE.md`；Codex 只读写 `~/.codex/AGENTS.md`。复用推荐规则内容、预览/编辑/导入与脏编辑保护 |
| MCP | `views/mcp/McpView.tsx` + `mcp-view-model.ts` | MCP Server 启用/禁用 + 凭据管理；Claude Code 状态来自 `~/.claude.json.mcpServers`，Codex 状态来自 `~/.codex/config.toml` 的 `[mcp_servers]`，vault 不作 Active/Disabled 事实源 |
| Skills | `views/SkillsView.tsx` | 共享本体+双侧注入：隐藏 Header、单次 CLI 双态投影、安装目标 Modal（Codex 只读恒勾）、u 更新两侧 / d 全量卸载（`--agent '*'`）；物理存储与映射交给 skills CLI（见 HC-SKILLS-SHARED-INJECT） |

---

## 热更新机制（确认式下载 + 结构化错误）

### 启动检查只更新 UI 状态

1. `src/app.tsx` 启动后调用 `checkLatestVersion()` 查询 GitHub Release latest tag vs 内嵌版本号（`CCQ_VERSION`）。
2. 启动检查**只更新侧边栏「检查更新」按钮状态**，不会下载文件、不会写入磁盘。
3. 已移除 `startBackgroundUpdateCheck()` 后台静默检查/静默下载链路；禁止恢复后台自动下载。

### 应用内手动入口

侧边栏底部「检查更新」入口：
- `latest`：Enter 重新检查。
- `available`：Enter 打开 Modal；用户再次 Enter 确认后才下载新版到 `<target-dir>/.ccq-update.tmp`，Esc 取消。
- 下载过程中 Modal 不关闭，展示 loading；Enter 禁用，Esc 通过 AbortSignal 停止下载。
- 下载失败时展示 `formatSelfUpdateError()` 生成的具体阶段、HTTP 状态、目标路径、临时路径或底层错误。
- 下载成功后 Modal 进入「下载完成」确认态；用户 Enter 才应用更新并重启，Esc 稍后处理。

### 替换与重启

- 更新目标优先使用当前运行的 ccq 可执行文件路径；若当前 `process.execPath` 不像 ccq（例如源码/Bun dev 模式），回退到安装目标 `~/.local/bin/ccq[.exe]`。
- **Windows**：运行中的 exe 无法可靠覆盖，使用 PowerShell helper：等待当前 pid 退出 → `Copy-Item` 临时文件覆盖目标 exe → 删除临时文件 → `Start-Process` 重启 ccq；不再依赖「下次启动时自己覆盖自己」。
- **macOS/Linux**：下载成功后用 `rename` 替换目标文件，并 `chmod 755`。
- CLI `ccq update [--check]` 与 TUI 复用同一 core 逻辑；失败必须输出结构化原因。

### P-5 失败不阻断 + P-6 版本相同零网络

- 热更新失败不阻断当前运行，只更新 UI/CLI 错误提示。
- 版本相同跳过下载（零网络写）。

---

## 迁移对照

### 从 Ink 到 OpenTUI

| Ink | OpenTUI | 说明 |
|-----|---------|------|
| `useInput((input, key) => ...)` | `useKeyboard((key) => ...)` | 全局键盘分发，无 `useInput` |
| `useApp().exit()` | `useRenderer().exit()` | 退出应用 |
| `useStdout()` | `useRenderer()` | 访问渲染器 |
| `<Box>` | `<box>` | 小写标签 |
| `<Text>` | `<text>` | 小写标签 |
| `ink-gradient` | `<text fg bold>` | 纯色，无 gradient |
| `react-ink-textarea` | `<textarea>` | 官方组件 |
| `@inkjs/ui` 组件 | 自造或官方 `@opentui-ui/*` | 按需选用 |

### 从 Node 22 到 Bun

| Node 22 | Bun | 说明 |
|---------|-----|------|
| `npm install` | `bun install` | 依赖安装 |
| `node dist/cli.js` | `bun run src/index.tsx` | 直接运行 TS |
| `npm run build` | `bun run build` | 构建 |
| `package-lock.json` | `bun.lock` | 锁文件 |

### 从目录缓存到单文件可执行

| 旧方案（Ink + 目录缓存） | 新方案（OpenTUI + Bun 单文件） |
|----------------------|--------------------------|
| `manage-tui.tgz`（dist + deps + contracts） | 4 个可执行文件（contracts 内嵌） |
| `$TMPDIR/.ccq/manage-tui/`（1h TTL） | `~/.local/bin/ccq[.exe]`（与 Claude Code native installer 同目录） |
| `ManageCore.ps1` / `ManageCore.zsh` 三级解析 | install 末尾确认下载（架构检测） |
| `CCQ_CONTRACTS_DIR` 注入 | `import.meta.dir` 自适应 |
| `node dist/cli.js` | `ccq` 直跑（通过 PATH） |

---

## contracts 目录

TUI 链契约分为运行时内嵌契约与磁盘源契约：
- `providers.json` — 供应商定义（运行时内嵌）
- `mcp-servers.json` — MCP Server 配置（运行时内嵌）
- `claude-config.json` — Claude 配置模板（运行时内嵌）
- `templates/claude-md.base.md` / `templates/claude-md.platform-windows.md` — Claude Code CLAUDE.md 推荐模板（运行时内嵌，按平台拼接）
- `templates/codex-md.md` — Codex AGENTS.md 推荐模板（运行时内嵌，独立维护）
- `ccg-workflow.json` — CCG Workflow 配置（磁盘源契约，未来工具管理迁移用）
- `templates/index.json` — 模板索引（磁盘源契约，installer 合约测试读取）
- `claude-config-drift.js` — 配置漂移检测脚本（磁盘源契约，CI / installer 引用）

---

## 相关文档

- [根目录 AGENTS.md](../AGENTS.md) — 整体架构与 Manage TUI 架构
- [installer/AGENTS.md](../installer/AGENTS.md) — install 链与 ccq 可执行文件管理
- [installer/README.md](../installer/README.md) — 安装器开发入口

---

_本小姐的 OpenTUI 实现完全遵循官方脚手架结构，代码质量有保证！_ (￣▽￣)ノ
