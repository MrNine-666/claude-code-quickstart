# OpenTUI Component and Layout Contract

## Component Ownership

可复用控件位于 `tui/src/components/`：

- `Card`、`ScrollList`、`ListState`、`DetailScreen`、`DetailPanel` 用于
  list/detail 组合。
- `Modal`、`ErrorPanel`、`Spinner`、toast 用于 overlay 与反馈。
- `FormPanel` 配合 `TextField`、`SelectField`、`RadioField`、`KeyValueField`
  实现结构化表单。
- `SingleLineInput` 用于页面搜索/过滤 input，`TextareaEditor` 用于
  多行编辑。
- `CodePreview` 用于纯文本/JSON/TOML 预览，并在 source mode 支持语法高亮。

## Focus and Input

- 控件接收显式 `active` 与 `focused` fact。渲染焦点和接受按键属于同一个
  所有权决策。
- Modal 活动时，背景 list/grid 以 inactive 状态渲染。Modal 的 arrow 与 Enter
  不得移动或提交背景内容。
- 受控 OpenTUI `<input>` 必要时通过一个 normalizer 处理两种受支持 change
  event；页面 Enter 仍由 page handler 拥有。
- Secret value 只可在显式编辑期间可见。只读预览、label、toast 与 error 始终保持
  masked。

## Layout

- 优先使用只有一个明确 height owner 的 flex layout。不得在每个 view 中重新
  引入 `terminalHeight - header - footer` 手工运算。
- Card grid、status column、checkbox 与 shortcut bar 等稳定区域需要固定或最小
  dimension，使 label 或 hover/focus 不会造成布局位移。
- 共享 `Checkbox` 使用 `colors.muted` 渲染未选中 idle bracket/content；focused
  或 checked 时，完整 bracket 与 checkmark 都使用 `colors.primary`。不得只为
  bracket 着色或让 checkmark 使用 terminal default color；Skills install 与
  installed list 共用该组件。
- `RadioField compact` 复用相同的 option selection color，但不显示宽 form
  label/frame。只读 page summary 的 input 仍由页面 shortcut 拥有时使用它；
  普通 editable form 保留默认 framed variant。
- `ScrollListItem.bordered` 传给 `Card.bordered`，默认是普通 rounded Card。
  Expandable source-group header 等轻量 structural row 使用 `bordered: false`；
  实际 domain Item 保留 border。
- `titleRight`/status region 始终可见；长 title 应先 shrink 或 clip，不得挤走
  status/download 事实。
- 使用 `theme/index.ts` 的 semantic color；view 中不得硬编码 terminal color。
  Source 与 compiled mode 都必须有清晰可读的纯文本 fallback。
- 所有 loading/empty/no-match/error list state 使用 `ListState`；不得在每个 view
  中分别手写 spinner/empty text。

## Textarea Rule

OpenTUI `<textarea>` 在内部滚动，但不暴露可见滚动条。绝不能用
`<scrollbox>` 包裹，否则会抑制内部滚动。接受 cursor-driven scroll behavior，
并将 editor 放在稳定 flex region 中。

## CodePreview Rule

统计和渲染行前，先统一 CRLF 与 trailing newline。Compiled executable 中禁用
Tree-sitter，因为 Bun virtual path 无法解析其 worker；改为渲染 plain text。
Source mode 可以使用语法高亮。

## Global Busy Feedback

- `Spinner` 是唯一 loading component。局部 detection/loading row 使用默认
  `inline` variant；阻塞 install、update 与 uninstall mutation 使用
  `variant="overlay"`。
- App 拥有当前 `BusyOverlayState`，并在 terminal root 渲染 overlay。Tools 与
  Skills 通过 `onBusyStateChange` 上报 presentation state；不得在页面底部渲染
  mutation `ProgressLog`。
- Overlay 以主题化半透明背景覆盖 `100%` width/height，
  spinner/content panel 保持不透明，只显示活动 mutation 上报的最新
  instruction。
- Overlay 可见时，App 同时禁用 global input dispatch 与活动背景 view。
  Completion 清除 overlay；parent view 拥有最终 completion/cancellation toast
  与 domain error presentation。

```tsx
// 错误：view-local log 使 shell 其他部分仍可交互。
{busyAction ? <BottomLog messages={progress} /> : null}

// 正确：view 上报 state，App 复用共享 Spinner overlay。
onBusyStateChange?.({title: '正在更新工具', message: latestInstruction, onCancel: cancelBusyTask});
<Spinner variant="overlay" label={busy.title} message={busy.message} onCancel={busy.onCancel} />
```

## Scenario: Overlay Cancellation Contract

### 1. Scope / Trigger

所有通过 `Spinner variant="overlay"` 渲染的阻塞 install、update、inject、
topology 或 uninstall action 都使用此合同。

### 2. Signatures

```ts
type OverlaySpinnerProps = {
  readonly variant: 'overlay';
  readonly onCancel: () => void;
  readonly message?: string;
  readonly terminalWidth?: number;
};

type BusyOverlayState = {
  readonly title: string;
  readonly message?: string;
  readonly onCancel: () => void;
};

type ProgressEvent = {
  readonly level: 'info' | 'success' | 'warning' | 'danger';
  readonly message: string;
  readonly componentId?: string;
  readonly instruction?: string;
};
```

### 3. Contracts

- Overlay 是 mutation busy state 的默认阻塞式 presentation。
- 第一次按下 `Esc` 时，Spinner 立即隐藏，并精确调用一次 `onCancel`。它不得
  了解 child process、reducer 或 `AbortController`。
- Parent view 拥有 cancellation：abort 活动 controller、dispatch 领域
  `cancel-busy` action，并从共享 cache refresh 最终 fact。
- App 将 parent callback 传给 root Spinner，并在 `BusyOverlayState` 存在时
  禁用 background input。
- View 只把 structured progress event 的最新 `instruction` 投影到 overlay。
  新 command 替换已渲染 message；仅 status 的 event 不得隐藏 command。当前
  mutation 完成时清除 overlay，并发出一个 parent-owned toast。

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Overlay 渲染时没有 `onCancel` | Typecheck 失败 |
| 可见时第一次按 Esc | Overlay 消失，parent callback 运行一次 |
| Callback 后重复按 Esc | 不重复 callback 或 state transition |
| 新 progress event 到达 | 替换当前 instruction；不得追加 log |
| 仅 status event 没有 `instruction` | 保留当前 command；不得用固定 status 文案替换 |
| Parent abort 导致 command reject | 不 dispatch 过期 success/error；parent refresh fact |
| Mutation 正常完成 | Parent 清除 busy，并显示一个最终 toast |

### 5. Good / Base / Bad Cases

- 良好：`Spinner` 调用 `onCancel`；`ToolsView`/`SkillsView` abort 并 dispatch
  `cancel-busy`，且不把 cancellation 展示为 error。
- 良好：core 发出 `instruction: 'npm install -g package'`；view 投影该 field，
  同时保留 `message` 供 CLI/status diagnostic 使用。
- 基线：mutation 没有活动 controller；parent 忽略 Esc，且不伪造 reducer
  failure。
- 错误：Spinner 调用 `taskkill`、修改 domain reducer，或等 process promise
  settle 后才隐藏 overlay。
- 错误：view 投影 `event.message`，使 `正在更新...` 或 success message 替换
  具体 command。

### 6. Tests Required

- `verify-layout-shell.mjs`：渲染一个 current instruction，断言旧 bottom-log
  component 不存在，发出 Escape，并断言 callback 只执行一次且事件后无 overlay
  frame。
- Skills/Tools core gate：断言 spawned command argv 也通过
  `ProgressEvent.instruction` 暴露。
- Tools/Skills reducer gate：断言 `cancel-busy` 清除 busy/progress/error state，
  并返回正确页面。
- `verify-core-functions.mjs`：断言真实 `AbortSignal` 立即以 `AbortError`
  reject command。

### 7. Wrong vs Correct

```tsx
// 错误：rendering 拥有业务 cancellation，并投影通用 status 文案。
onProgress(event => dispatch({type: 'progress', message: event.message}));
<Spinner variant="overlay" message={progress.join('\n')} onCancel={() => child.kill()} />

// 正确：view 只投影具体 instruction；parent 拥有 cancellation。
onProgress(event => {
  if (event.instruction) dispatch({type: 'progress', message: event.instruction});
});
<Spinner variant="overlay" message={latestInstruction} onCancel={cancelBusyTask} />
```

## Wrong vs Correct

```tsx
// 错误：Modal 下方背景仍可交互。
<ToolsGrid active={true} />
<Modal active={confirming}>...</Modal>

// 正确
<ToolsGrid active={!confirming} />
<Modal active={confirming}>...</Modal>
```

```tsx
// 错误：source-group header 在视觉上被当成另一张 domain Card。
{key: group.key, title: group.label}

// 正确：保留 ScrollList focus/scroll behavior，但不显示 Card border。
{key: group.key, title: group.label, bordered: false}
```

## Verification

运行 `verify-layout-*`、现有 gate 中的 `verify-list-state` coverage、
`verify-modal-title.mjs`、`verify-code-preview.mjs`、domain render gate、用于全局
busy feedback 的 `verify-layout-shell.mjs`、typecheck 与完整 verify。
