# tui/ — OpenTUI 管理控制台

> 面包屑：[根目录](../CLAUDE.md) › tui/
> 生成时间：2026-06-24（Manage TUI 从 Ink 迁移到 OpenTUI + Bun 单文件可执行分发）

---

## 项目概述

**OpenTUI + Bun 单文件可执行 TUI**，实现 Claude Code Quickstart 的 6 菜单管理控制台（工具管理 / 供应商 / 配置文件 / 全局规则 / MCP / Skills），通过 `bun build --compile` 交叉编译为 4 平台单文件可执行产物（`ccq-windows-x64.exe` / `ccq-windows-arm64.exe` / `ccq-darwin-x64` / `ccq-darwin-arm64`），contracts 内嵌进可执行文件，安装后通过 `ccq` 命令天然可达（**不注入 Profile**）。

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
│   │   ├── contracts.ts       # contracts 内嵌读取（Bun asset + 源码 fallback）
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
│   │   └── ...
│   ├── hooks/                 # 自定义 hooks
│   │   ├── use-keyboard.ts    # 全局键盘分发（替代 Ink useInput）
│   │   └── use-detection-cache.ts
│   └── theme/                 # 主题配置
│       ├── index.ts           # 颜色 / 边框
│       └── logo.ts            # Logo（纯色 `<text>`，无 gradient）
├── contracts/                 # TUI 链契约（内嵌进可执行文件）
│   ├── providers.json         # 供应商定义
│   ├── mcp-servers.json       # MCP Server 配置
│   ├── claude-config.json     # Claude 配置模板
│   ├── ccg-workflow.json      # CCG Workflow 配置
│   ├── templates/             # 模板目录
│   └── claude-config-drift.js # 配置漂移检测脚本
├── scripts/                   # 构建 / 验证脚本
│   ├── build.ts               # 构建脚本（4 平台交叉编译）
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

### HC-SHORTCUT-SINGLE-SOURCE（新增）
快捷键说明**唯一**由 footer `ShortcutBar`（`app.tsx:178`）展示，按键文本从 `@opentui/keymap`（`config/keybindings.js` 绑定定义）经 `state/shortcuts.ts` 的 `formatCommandBindings` 动态解析——**单一数据源**。
- **禁止**在视图/组件内硬编码键位字面量（`[I]`、`[Tab]`、`Ctrl+S` 等）；新增/改键一律走 `config/keybindings.js` 注册 + `shortcuts.ts` 映射，footer 自动同步。
- 页面内 `ActionHint`（`components/action-hint.tsx`）**仅承载操作说明文字 + disabled 状态**（footer label 容纳不下的详细描述/禁用提示），**禁止带 `[hotkey]` 前缀**重复展示键位。
- **理由**：键位变更只改 `keybindings.js` 一处，杜绝页面内硬编码与 footer 分裂（历史教训：PromptsView / ConfigView / SkillsView / provider-view 曾用 ActionHint `[hotkey]` 与 footer 双显重复）。

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

contracts 通过 Bun `import.meta.dir` 内嵌进可执行文件：
- **打包后**：`import.meta.dir` 指向可执行文件内部虚拟路径，自动读取内嵌 contracts
- **源码模式**：`import.meta.dir` 指向 `tui/src/`，通过相对路径上溯读取 `tui/contracts/`

无需 `CCQ_CONTRACTS_DIR` 环境变量注入（旧 Ink + 目录缓存方案的遗留）。

### 产物验证

```sh
# 验证 contracts 内嵌（删除源 contracts/ 目录后仍可运行）
rm -rf tui/contracts/
./dist/ccq-darwin-arm64  # macOS ARM64 示例

# 验证 non-TTY 行为
echo | ./dist/ccq-darwin-arm64
```

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

TUI 链契约（6 项 + templates/）：
- `providers.json` — 供应商定义
- `mcp-servers.json` — MCP Server 配置
- `claude-config.json` — Claude 配置模板
- `ccg-workflow.json` — CCG Workflow 配置
- `templates/` — 模板目录
- `claude-config-drift.js` — 配置漂移检测脚本

---

## 相关文档

- [根目录 CLAUDE.md](../CLAUDE.md) — 整体架构与 Manage TUI 架构
- [installer/CLAUDE.md](../installer/CLAUDE.md) — install 链与 ccq 可执行文件管理
- [tui/contracts/README.md](contracts/README.md) — TUI 链契约边界

---

_本小姐的 OpenTUI 实现完全遵循官方脚手架结构，代码质量有保证！_ (￣▽￣)ノ
