# tui/ — OpenTUI 管理控制台

> 面包屑：[根目录](../CLAUDE.md) › tui/
> 生成时间：2026-06-24（Manage TUI 从 Ink 迁移到 OpenTUI + Bun 单文件可执行分发）

---

## 项目概述

**OpenTUI + Bun 单文件可执行 TUI**，实现 Claude Code Quickstart 的 6 菜单管理控制台（工具管理 / 供应商 / 配置文件 / 全局规则 / MCP / Skills），通过 `bun build --compile` 交叉编译为 4 平台单文件可执行产物（`ccq-windows-x64.exe` / `ccq-windows-arm64.exe` / `ccq-darwin-x64` / `ccq-darwin-arm64`），运行时消费契约以内联文本形式内嵌进可执行文件，安装后通过 `ccq` 命令天然可达（**不注入 Profile**）。

---

## 技术栈

| 层次 | 技术选型 | 版本要求 |
|------|---------|---------|
| 运行时 | Bun | `>=1.2.0` |
| 渲染引擎 | OpenTUI | `@opentui/core@0.4.1` + `@opentui/react@0.2.3` |
| UI 框架 | React | `19.0.0` |
| 构建工具 | Bun | `bun build --compile` 交叉编译 |
| 类型系统 | TypeScript | `5.x` |
| UI 组件 | `@opentui-ui/toast`、`opentui-spinner` | 可选依赖 |

---

## 目录结构

```
tui/
├── src/
│   ├── index.tsx              # 入口：createCliRenderer + non-TTY 守卫 + CCQ_VERSION
│   ├── app.tsx                # 双栏布局 + 6 菜单路由
│   ├── core/                  # 业务逻辑（从 manage/source/core 零改写迁移）
│   │   ├── contracts.ts       # 运行时契约内嵌读取（Bun text loader + 源码 fallback）
│   │   ├── settings.ts        # settings.json 读写
│   │   ├── providers.ts       # 供应商 Profile 管理
│   │   ├── mcp.ts             # MCP vault + server 管理
│   │   ├── skills.ts          # Skills 安装 / 更新 / 卸载
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
快捷键说明**唯一**由 footer `ShortcutBar`（`app.tsx:178`）展示，按键文本从 `@opentui/keymap`（`config/keybindings.js` 绑定定义）经 `state/shortcuts.ts` 的 `formatCommandBindings` 动态解析——**单一数据源**。
- **禁止**在视图/组件内硬编码键位字面量（`[I]`、`[Tab]`、`Ctrl+S` 等）；新增/改键一律走 `config/keybindings.js` 注册 + `shortcuts.ts` 映射，footer 自动同步。
- 页面内 `ActionHint`（`components/action-hint.tsx`）**仅承载操作说明文字 + disabled 状态**（footer label 容纳不下的详细描述/禁用提示），**禁止带 `[hotkey]` 前缀**重复展示键位。
- **理由**：键位变更只改 `keybindings.js` 一处，杜绝页面内硬编码与 footer 分裂（历史教训：PromptsView / ConfigView / SkillsView / provider-view 曾用 ActionHint `[hotkey]` 与 footer 双显重复）。

### HC-LIST-STATE-COMPONENT
列表空状态与加载状态统一使用 `components/list-state.tsx` 组件（`ListEmptyState` / `ListLoadingState`），禁止在视图内重复实现空状态/加载状态布局。
- **ListEmptyState**：展示「暂无数据」等空状态提示 + 可选操作提示（hint），自动居中布局 + muted 配色。
- **ListLoadingState**：展示「加载中」提示 + Spinner 动画，自动居中布局。
- **理由**：统一视觉风格，减少重复代码，简化视图实现（历史教训：ConfigView / PromptsView / SkillsView 曾各自实现空状态布局，代码重复且样式不一致）。

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
bun build --compile --target bun-darwin-x64 --outfile dist/ccq-darwin-x64 src/index.tsx
bun build --compile --target bun-darwin-arm64 --outfile dist/ccq-darwin-arm64 src/index.tsx
```

### contracts 内嵌策略

运行时消费的契约通过 Bun `with { type: "text" }` 以内联字符串形式内嵌进可执行文件：
- **打包后**：`providers.json` / `mcp-servers.json` / `claude-config.json` / `templates/claude-md.*.md` 从 `EMBEDDED_CONTRACTS` Map 读取，不依赖 Bun 虚拟文件系统路径。
- **源码模式**：`contracts.ts` 通过相对路径上溯读取 `tui/contracts/`，零网络。
- **磁盘源契约**：`ccg-workflow.json` / `templates/index.json` / `claude-config-drift.js` 保留在 `tui/contracts/`，供 CI、installer 合约测试或后续迁移使用，不再作为 TUI 运行时内嵌 entry。

无需 `CCQ_CONTRACTS_DIR` 环境变量注入（旧 Ink + 目录缓存方案的遗留）。禁止把 Bun `file` loader 当作契约内容使用；`file` loader 返回路径字符串，会导致编译产物下 JSON 解析失败。

### 产物验证

```sh
# 验证运行时契约内嵌（运行编译产物契约探针，断言加载的是内容而非路径）
bun scripts/verify-compiled-contracts.mjs

# 验证 non-TTY 行为
echo | ./dist/ccq-darwin-arm64
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
| 工具管理 | `views/tools-view.tsx` | ClaudeCode + 5 工具全生命周期（安装/更新/卸载 + 卡片范式 + 2D 导航） |
| 供应商 | `views/provider-view.tsx` + `provider-form.tsx` | 供应商 Profile CRUD + 设置默认 + extraEnv JSON 编辑 |
| 配置文件 | `views/config-view.tsx` | 配置文件页（view-first，对齐 PromptsView）+ 字段级（settings.json 多页共享）：进入先渲染只读当前 settings.json（**手动 JSON 着色**：key/string/数字/布尔/标点分色，opentui 无 json grammar 的回退），标题标注「已排除供应商配置」（供应商 env 剥离展示，归供应商页管，HC-12；保存时自动合并保留）；无内容则空状态提示按 `a` 新建；`a`（空白新建 `{}`）/ `e`（编辑现有）进编辑器，`Ctrl+T` 开推荐边栏（带注释 JSONC 对照·注释行分色），`Ctrl+O` fill-missing 灌缓冲（仅补缺失）/ `Ctrl+S` 保存（合并保留供应商 env）/ `Esc` 取消回只读态 |
| 全局规则 | `views/prompts-view.tsx` | 全局规则页（view-first）：进入先渲染只读本地 CLAUDE.md（`<markdown>`），无内容则空状态提示按 `a` 新建；`a`（空白新建）/ `e`（编辑现有）进编辑器，`Ctrl+T` 开源码推荐边栏（未渲染·语法高亮对照），`Ctrl+I` 推荐灌缓冲 / `Ctrl+S` 保存 / `Ctrl+P` 预览 / `Esc` 取消回只读态（有脏先确认） |
| MCP | `views/mcp/McpView.tsx` + `mcp-view-model.ts` | MCP Server 启用/禁用 + 凭据管理 + 字段↔JSON 双向联动 |
| Skills | `views/skills-view.tsx` | Skills 安装 / 更新 / 卸载 |

---

## 热更新机制（Phase 7.5-7.8）

### 方案 1：临时文件 + rename 原子替换

1. **启动后台检查**：`src/index.tsx` 入口启动后台任务，查 GitHub Release latest tag vs 内嵌版本号（`CCQ_VERSION`）
2. **下载到临时文件**：新版下载到 `<bin>/.ccq-update.tmp`
3. **校验完整性**：SHA256 校验（从 Release 获取）
4. **原子替换**：`rename .ccq-update.tmp ccq[.exe]`
   - **Windows 文件锁**：运行中可执行文件无法替换，走「退出/下次启动替换」
   - **macOS/Linux**：直接 rename 生效

### 应用内手动入口（优先）

工具管理视图或独立菜单「检查 ccq 更新」：
- 立即查最新版 + 下载 + 提示「重启 ccq 生效」
- 不可行（交互受限）则仅保留后台自动

### P-5 失败不阻断 + P-6 版本相同零网络

- 热更新失败不阻断当前运行
- 版本相同跳过下载（零网络写）

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

详见 [tui/contracts/README.md](contracts/README.md)。

TUI 链契约分为运行时内嵌契约与磁盘源契约：
- `providers.json` — 供应商定义（运行时内嵌）
- `mcp-servers.json` — MCP Server 配置（运行时内嵌）
- `claude-config.json` — Claude 配置模板（运行时内嵌）
- `templates/claude-md.*.md` — CLAUDE.md 推荐模板（运行时内嵌）
- `ccg-workflow.json` — CCG Workflow 配置（磁盘源契约，未来工具管理迁移用）
- `templates/index.json` — 模板索引（磁盘源契约，installer 合约测试读取）
- `claude-config-drift.js` — 配置漂移检测脚本（磁盘源契约，CI / installer 引用）

---

## 相关文档

- [根目录 CLAUDE.md](../CLAUDE.md) — 整体架构与 Manage TUI 架构
- [installer/CLAUDE.md](../installer/CLAUDE.md) — install 链与 ccq 可执行文件管理
- [tui/contracts/README.md](contracts/README.md) — TUI 链契约边界

---

_本小姐的 OpenTUI 实现完全遵循官方脚手架结构，代码质量有保证！_ (￣▽￣)ノ
