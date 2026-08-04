# OpenTUI Rendering Structure

## Layout

```text
tui/src/
├── app.tsx                 # shell、活动 view、共享 cache、全局 Modal/update state
├── views/                  # domain screen 与聚焦后的 key dispatch
│   ├── provider/           # Provider Root/Home/Form 与 Agent adapter
│   ├── config/             # 基于 adapter 的 Config root
│   ├── prompts/            # 基于 adapter 的 Global Rules root
│   ├── mcp/                # MCP Root/Home/Form 与 action
│   ├── tools/              # Tools Root/Home/Modal、input、action 与 service adapter
│   └── skills/             # Skills Root/Home/Install/Modal、input、action 与 service adapter
├── components/             # 共享 card、list、form control、editor 与 overlay
│   └── managed-document/   # 共享 Config/Global Rules Home/Form controller
├── hooks/                  # input routing 与 detection 生命周期
├── state/                  # pure reducer 与 shortcut projection
├── config/keybindings.ts   # command-to-binding registry
├── theme/                  # semantic terminal color 与 logo
└── utils/keyboard.ts       # 平台 key normalization/formatting
```

## Placement Rules

- `app.tsx` 拥有 cross-view shell state、当前 Agent context、App-level detection
  cache、update Modal 与 footer composition。
- 一个 view 只拥有自身 domain 的 screen mode、活动 row/form focus 与 key
  routing。它通过 `onSubModeChange` 上报，使 App 能派生 footer。
- Domain root 拥有 reducer/cache/effect wiring，并选择 Home/Form/Modal page。
  Page module 渲染 typed fact 并发出 typed intent；不得 import 面向写入的
  service、读取文件或启动命令。
- 多步骤 mutation、postflight reconciliation 与可复用 patch 放在 domain
  action module。Tools 与 Skills 使用不同 action interface，因为二者的
  topology 与 reconciliation contract 不同。
- 共享视觉和 input behavior 放在 `components/` 下，并从
  `components/index.ts` 导出。
- Pure state transition 放在 `state/` 下。若 reducer 可独立测试，不要把它
  隐藏在 component effect 中。
- Business operation 留在 `core/`/`services/`；view 接收 adapter 或 callback，
  并将结果映射为 reducer action/toast。

## Naming

- 文件只导出一个 React component 时，component 与文件使用 PascalCase。
- Domain module 与 state 文件使用 kebab-case（`skills-view-state.ts`）。
- Command 使用 semantic id（`PRIMARY_ACTION`、`UPDATE_ONE`），而不是物理按键名。
- Mode 描述用户可见状态（`grid`、`form`、`confirm-uninstall`），而不是实现细节。

## Anti-Patterns

- View-local `ShortcutBar` 或重复的 key label array。
- 执行 domain command 的 Card/Modal component。
- 在多个 view 复制固定 terminal height；使用 flex owner 与共享 list/detail shell。
- `FormPanel`、`SingleLineInput`、`TextareaEditor` 或现有 field component 已覆盖
  行为时，再增加第二套 form/input 实现。
- 一个扁平的 `views/*View.tsx` 同时组合 Root、Home/Form rendering、mutation
  orchestration 与 Modal input。

## Domain View Pattern

每个 domain root 遵循小型 orchestration interface。Root 拥有 screen state 与
effect，page 接收 immutable fact 与 intent callback：

```tsx
// Root：只负责 route 与 lifecycle
<SkillsHomeView view={view} active={pageActive} dispatch={dispatch} />
<SkillsInstallView view={view} detection={detection} active={pageActive} dispatch={dispatch} />

// Page：fact 加 typed intent；无 file/process side effect
<McpFormView model={model} onSubmit={submitMcpFormAction} onSaved={onSaved} />
```

Async mutation、progress projection 与 final detection reconciliation 属于
`*-view-actions.ts`（或现有 `services/` adapter）。Page 可以 import pure domain
model 和仅类型的 service result，但运行时不得 import 面向写入的 service，
也不得直接使用 `fs`/`child_process`。

`bun scripts/verify-view-architecture.mjs` 是可执行 topology gate。它检查全部六个
domain root、共享 Config/Rules document 复用、旧扁平入口移除，以及 page-to-service
dependency direction。移动 view 时，必须把此 gate 保留在 `package.json` 的
`verify` 链中。
