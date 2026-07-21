# Frontend Type-Safety Contract

## Domain Types

- Model screen state and service results as discriminated unions.
- Mark immutable payloads and registries `readonly`; do not mutate detection
  snapshots in place.
- Parse `unknown` JSON/TOML/CLI output once at the core boundary. Views consume
  typed projections and must not cast raw payload fields locally.
- Keep Agent context as `'cc' | 'cx'` internally and map to full display labels
  only at presentation boundaries.
- Keep protocol names such as `CodexProfile`, `--profile` and TOML fields even
  though visible business text says `供应商`.

## Exhaustiveness

Reducers, storage kinds, service outcomes and sharing kinds must use exhaustive
switches. Adding a union member should create a type error at every unhandled
presentation/lifecycle branch.

```ts
function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${String(value)}`);
}
```

## Props

- Props are explicit `readonly` object types.
- Callbacks communicate intent (`onConfirm`, `onSubModeChange`) rather than
  exposing a component's internal mutable state.
- `active` and `focused` are separate typed facts; do not infer interactivity
  from color or selected index.

## External Data

Do not use `as SomeType` immediately after `JSON.parse`, TOML parse or child
stdout. Validate object shape, identity fields, required arrays and secret
fields in core before constructing the domain type.

## Verification

`bun run typecheck` is mandatory. Runtime parser gates must still cover malformed
input because TypeScript does not validate user files or command output.
