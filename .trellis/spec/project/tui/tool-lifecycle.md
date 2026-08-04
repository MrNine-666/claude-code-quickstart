# Managed Tool Lifecycle Contract

## 1. Scope / Trigger

修改工具注册、分组、上下文可见性、检测、install/update/uninstall 命令、Agent 注入或 Tools CLI/TUI 输出前阅读此合同。

## 2. Signatures

```ts
const TOOL_DEFINITIONS: readonly ToolDefinition[];
const COMPONENT_META: Readonly<Record<ComponentId, ComponentMeta>>;

projectSharedToolComponents(detected): readonly SharedManagedComponent[];
installComponent(id, onProgress?, deps?): Promise<ComponentInstallOutcome>;
updateComponents(components, onProgress?, deps?): Promise<...>;
uninstallComponent(id, options?): Promise<...>;
injectComponent(id, target): Promise<...>;
ejectComponent(id, target): Promise<...>;
```

当前 registry id 为 `ClaudeCode`、`CodexCli`、`AntigravityCli`、`Ccline`、
`OpenSpec`、`Trellis`、`CcgWorkflow` 和 `CodeGraph`。

## 3. Contracts

- `TOOL_DEFINITIONS` 持有 id/name/kind/command/package/docs 与 CLI aliases；`COMPONENT_META` 持有 group、supported contexts、sharing kind 和 display key 顺序。除断言外，不得在 View/help/test 中复制任一列表。
- 共享列表投影始终按确定的分组顺序返回八个组件：Agent、companion/statusLine、第三方工具。
- sharing kind 决定生命周期与呈现：
  - `agent-exclusive`: ClaudeCode, CodexCli, Ccline.
  - `fully-shared-no-inject`: AntigravityCli, OpenSpec, Trellis.
  - `shared-cli-per-agent-inject`: CcgWorkflow, CodeGraph.
- Trellis 仅是全局 npm CLI。ccq 绝不运行 `trellis init`，也不伪造 Agent 注入状态。
- 显式工具更新绕过 detection cache；普通 App detection 可以复用缓存。更新 mutation 前先创建 snapshot。
- 涉及全局 npm 锁或有序 Agent 注入时，install/update/uninstall 必须串行执行；一个组件失败不得污染其他组件的最终事实。
- CodeGraph 安装先确保全局 CLI，再运行官方 `codegraph install --target=<claude|codex> --location=global --yes` 并验证运行时 MCP 集成。卸载绝不删除项目 `.codegraph/`。
- CcgWorkflow Agent 文件由其官方命令持有。ccq 在 init 前后保留 Claude MCP snapshot，绝不手工删除 Codex 配置。

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Registry id 缺少 metadata | Typecheck/verification 失败 |
| Detection 列表缺少某个 id | Shared projection 生成 `installed=false` 占位项 |
| `fully-shared-no-inject` 项 | 不创建 Agent toggle snapshot 或 management Modal |
| Inject 项的 CLI 已安装但一侧缺失 | 保留两侧独立事实 |
| 显式 update 命令 | 强制执行全新的版本 detection |
| Snapshot 创建失败 | 不运行 update 命令 |
| Injection 命令退出码为零但 runtime config 缺失 | postflight 后报告失败 |
| 完整卸载 CodeGraph | 未被使用时删除两个 integration 和 CLI；保留 `.codegraph/` |
| 安装 Trellis | 使用通用 npm 生命周期；绝不运行 `trellis init` |

## 5. Good / Base / Bad Cases

- 良好：新增仅 npm 工具时扩展 registry 与 metadata；通用 detection/install/update/uninstall 路径无需新分支即可工作。
- 基线：已安装且最新的 non-inject 工具报告 latest，Enter 仅显示状态提示。
- 错误：ToolsView 硬编码第九个 id、group 或 alias。
- 错误：把 CcgWorkflow 当作真实 shared CLI，或全局卸载时删除 CodeGraph 项目索引。

## 6. Tests Required

- `verify-tools-install.mjs`、`verify-tools-manage.mjs`、`verify-tools-view.mjs`、`verify-tools-context.mjs`、`verify-tools-shared-projection.mjs`。
- 领域 gate：`verify-codegraph-lifecycle.mjs` 和 `verify-ccgworkflow-codex.mjs`。
- CLI alias/help 变更还要运行 `verify-cli-subcommands.mjs`。
- 最后运行 typecheck 和完整 verify。

## 7. Wrong vs Correct

```ts
// 错误：View 中出现第二个事实来源。
const toolOrder = ['ClaudeCode', 'CodeGraph', 'Trellis'];

// 正确：投影并排序权威 registry。
const rows = projectSharedToolComponents(detected);
```
