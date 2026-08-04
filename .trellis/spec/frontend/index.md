# OpenTUI Frontend Guidelines

此层适用于 `tui/src/app.tsx`、`views/`、`components/`、`hooks/`、`state/`、
`theme/` 和 `config/keybindings.ts` 的可复用工程规则。固定菜单、Tools/Skills
交互和具体产品状态机由 [project/tui](../project/tui/index.md) 统一拥有。

## Guidelines Index

| Spec | Applies to |
|---|---|
| [目录结构](./directory-structure.md) | 渲染层职责与文件放置 |
| [组件](./component-guidelines.md) | 共享 OpenTUI 控件、布局与焦点 |
| [Hook](./hook-guidelines.md) | detection/input/effect 生命周期 |
| [状态管理](./state-management.md) | reducer、mode、mutation 与 reconciliation |
| [类型安全](./type-safety.md) | discriminated union、解析后输入与穷尽状态 |
| [质量](./quality-guidelines.md) | 渲染、状态与快捷键验证 |

## Pre-Development Checklist

- [ ] 确认功能属于 App、view、共享 component、reducer 还是 service；不要把
      persistence 放进渲染代码。
- [ ] 新增 view-local 组件前先复用 `components/index.ts` 导出的组件。
- [ ] 在 `config/keybindings.ts` 注册物理按键，并通过 `state/shortcuts.ts`
      派生 footer 文案。
- [ ] 明确 Modal 与背景的焦点所有权；非活动背景 view 不得响应按键。
- [ ] 多步骤 action 使用 reducer mode，mutation 后根据最终事实完成
      reconciliation。
- [ ] 加载相关 [TUI 产品合同](../project/tui/index.md)，并按需测试窄终端、长
      CJK/机密值、empty/loading/error 状态、source mode 与编译后可执行行为。

## Baseline Checks

遵循[前端质量](./quality-guidelines.md)以及
[TUI 质量工具链](../project/tui/quality-tooling.md)路由的 focused gate。
