# Frontend Type-Safety Contract

## Domain Types

- 将 screen state 与 service result 建模为 discriminated union。
- Immutable payload 与 registry 标记为 `readonly`；不得原地修改 detection
  snapshot。
- 在 core boundary 只解析一次 `unknown` JSON/TOML/CLI output。View 消费 typed
  projection，不得在本地 cast 原始 payload field。
- Agent context 内部保持 `'cc' | 'cx'`，只在 presentation boundary 映射到完整
  display label。
- 即使可见业务文案使用“供应商”，仍保留 `CodexProfile`、`--profile` 和 TOML
  field 等 protocol name。

## Exhaustiveness

Reducer、storage kind、service outcome 与 sharing kind 必须使用 exhaustive
switch。添加 union member 时，每个未处理的 presentation/lifecycle branch
都应产生 type error。

```ts
function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${String(value)}`);
}
```

## Props

- Props 使用显式 `readonly` object type。
- Callback 传达 intent（`onConfirm`、`onSubModeChange`），而不是暴露 component
  内部 mutable state。
- `active` 与 `focused` 是分离的 typed fact；不得从 color 或 selected index
  推断 interactivity。

## External Data

不得在 `JSON.parse`、TOML parse 或 child stdout 后立即使用 `as SomeType`。
构造 domain type 前，在 core 中验证 object shape、identity field、required
array 与 secret field。

## Verification

必须运行 `bun run typecheck`。Runtime parser gate 仍需覆盖 malformed input，
因为 TypeScript 不会验证用户文件或命令输出。
