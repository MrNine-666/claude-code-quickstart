# OpenTUI Quality Guidelines

## Required Checks

- 优先通过导出的 reducer/registry 测试 state 与 key behavior。
- Input、focus、paste、clipping 或 compiled host-component behavior 属于合同
  一部分时，通过真实 OpenTUI control 渲染测试。
- 可见 shortcut text 必须从 input 使用的同一 command registry 派生。
- 验证窄布局、长 CJK/ASCII 值、empty/loading/no-match/error，以及
  Modal-over-background 状态。
- 保留 source mode 与 compiled executable fallback。

## Focused Gates

| Change | Gates |
|---|---|
| Shell/焦点/菜单 | `verify-manage-tui-state.mjs`、`verify-agent-context.mjs` |
| 按键/footer | `verify-shortcuts.mjs` 加 domain gate |
| 组件/布局 | `verify-layout-utils.mjs`、`verify-layout-shell.mjs`、`verify-modal-title.mjs` |
| 代码预览/编辑器 | `verify-code-preview.mjs`、domain render/config/prompts gate |
| 配置/规则 | `verify-config-view.mjs`、`verify-config-rules-reuse.mjs`、`verify-prompts-view.mjs` |
| Provider/MCP/Tools/Skills | 运行相关 backend/contract matrix |

## Bun Test Layers

- 隔离的 runtime test 放在 `tests/core/`，直接 import 拥有该行为的 pure
  function。
- 真实 OpenTUI render/interaction test 放在 `tests/components/`；使用固定
  terminal dimension，并在 `finally` 中的 `act()` 内销毁 `setup.renderer`。
- 广泛的 filesystem、CLI、compiled 与 cross-layer contract 留在
  `scripts/verify-*.mjs`；没有 migration task 时不要在 `bun:test` 中复制。

最终始终运行 `bun run check`。该命令包含 typecheck、Bun test 与完整旧版
verify 链；其 format/lint scope 定义在
[TUI 质量工具链](../project/tui/quality-tooling.md) spec 中。

## Review Red Flags

- Key 已处理但 footer 未显示，或 footer 已显示但没有处理。
- 隐藏的 Header 仍占用布局或保留交互焦点。
- Modal 移动背景 cursor。
- Mutation 在 awaited reconciliation 前报告 success。
- View 直接读写 home-directory config path。
- Textarea 被 scrollbox 包裹。
- Compiled mode 尝试构造 Tree-sitter worker。
- 新 loading/empty state 绕过 `ListState`。

## Scope Control

除非一方是实现另一方的必要条件，否则 visual refactor 与 lifecycle/config 变更
保持独立。保留现有 component API，或在同一变更中迁移所有 caller 与
verification。
