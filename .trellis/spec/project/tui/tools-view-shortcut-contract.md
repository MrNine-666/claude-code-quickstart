# ToolsView Primary Action Contract

## 1. Scope / Trigger

修改 ToolsView 网格 keybindings、footer 快捷键、主操作路由或注入管理 Modal 入口前阅读此规范。

本合同防止三个事实来源发生漂移：

- `src/config/keybindings.ts` 拥有物理按键绑定。
- `src/state/shortcuts.ts` 派生上下文相关的 footer 文案。
- `src/views/tools/tools-view-input.ts` 解析按键 intent，
  `src/views/tools/tools-view-actions.ts` 执行选中组件的 action。

## 2. Signatures

```ts
TOOLS_COMMANDS.PRIMARY_ACTION = 'tools:primary-action'; // Enter
TOOLS_COMMANDS.UPDATE_ONE = 'tools:update-one';         // u, inject tools only

type ToolsPrimaryAction = 'manage' | 'install' | 'update' | 'latest';

function resolveToolsPrimaryAction(
  component: ManagedComponent
): ToolsPrimaryAction;
```

## 3. Contracts

| Selected component facts | `Enter` | `u` |
|---|---|---|
| CodeGraph / CcgWorkflow，任意 install 或 update 状态 | 打开现有 management Modal | 尝试单 Item update |
| Non-inject，`installed === false` | 安装当前 Item | No-op |
| Non-inject，`installed === true && hasUpdate === true` | 更新当前 Item | No-op |
| Non-inject，已安装但没有已知 update | 显示“已经是最新”；不进入 busy 状态 | No-op |

管理 Modal 保持独立输入合同：Space 修改本地草稿，Enter 应用草稿，Escape 取消且不写入。

Footer 合同：

- `grid`：`Enter 安装/更新`；不显示 `i`、`m` 或 `u`。
- `grid-inject`：`Enter 管理开关` 和 `u 更新`。
- 保持 `a` update-all、`d` uninstall、`o` docs 和 `r` refresh 不变。

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| 未选中组件 | 忽略按键 |
| 选中 Item 正处于 busy 状态 | 忽略 Enter 和 `u` |
| Non-inject Item 收到 `u` | 忽略按键 |
| Inject Item 没有 update 却收到 `u` | 显示已有的“已经是最新”消息 |
| management draft 没有变更 | 保留已有的 no-change 消息，不执行 lifecycle 调用 |

## 5. Good / Base / Bad Cases

- 良好：过期的 OpenSpec 卡片按下 Enter 后直接更新。
- 基线：最新的 OpenSpec 卡片仅报告当前已是最新。
- 良好：过期的 CodeGraph 卡片按下 Enter 仍打开管理 Modal；`u` 继续用于更新。
- 错误：更新状态优先于 CodeGraph/CcgWorkflow 管理 Modal。
- 错误：View 处理 Enter 时，footer 却为 non-inject 卡片显示 `i`、`m` 或 `u`。

## 6. Tests Required

- `bun scripts/verify-shortcuts.mjs`
  - 断言 `PRIMARY_ACTION` 绑定 Enter。
  - 断言 `grid` 和 `grid-inject` 的 footer 内容。
  - 断言 ToolsView 将 Enter 接到 primary dispatcher，并将 `u` 接到 inject-only updater。
- `bun scripts/verify-tools-shared-projection.mjs`
  - 断言 `resolveToolsPrimaryAction()` 针对代表性事实返回 install、update、latest 或 manage。
  - 断言 inject component 同时存在 update 时由 manage 优先。
- 运行 `bun run typecheck`；如果无关工作区改动阻塞完整命令，可运行等价的严格受影响
  文件 TypeScript 检查。

## 7. Wrong vs Correct

### Wrong

```ts
if (key === 'i') installCurrent();
if (key === 'm') openManagement();
if (key === 'u') updateCurrent();
```

这会让用户选择一个组件事实已经确定的操作。

### Correct

```ts
if (key === 'enter') {
  runPrimaryAction(view, services, dispatch, cache);
}

if (key === 'u' && isInjectableComponent(component.id)) {
  updateCurrent();
}
```

`runPrimaryAction()` 将优先级委托给 `resolveToolsPrimaryAction()`，同时保持 key registry
与 footer 同步。
