# Reducer and View-State Contract

## State Layers

- `manage-state.ts` owns shell focus, selected menu and retained Agent context.
- Domain reducers (`tools-view-state.ts`, `skills-view-state.ts`,
  `self-update-state.ts`) own deterministic multi-step screen state.
- App caches own asynchronous detection results; reducers receive snapshots or
  reconciliation actions rather than reading the cache.
- Toast/progress output is presentation state, not the source of domain success.

## Reducer Rules

- Reducers are pure and exhaustively switch on discriminated actions.
- Modes are explicit. Confirmation, form, downloading, applying, partial and
  error states must not be inferred from several unrelated booleans.
- A Modal draft is separate from persisted/detected facts. Cancel discards the
  draft; confirm computes the delta and then starts mutation.
- Bounds are enforced in the reducer/list helper. Empty arrays and filtered lists
  must not create index `-1` crashes.
- Context/header changes preserve menu order and domain data unless the owning
  contract explicitly requires resetting a draft.

## Mutation Sequence

```text
intent -> confirm/draft -> started -> service/core mutation
       -> final detection -> reconciled/partial/failed reducer action
```

No reducer action named generically `action-done` may stand in for a domain
postflight contract. Skills install, topology transition, tool injection and
self-update use domain-specific completion actions.

## Focus State

Shell focus is bounded to `nav`, `header`, `view`, `form`, and `modal`. Shared
Tools/MCP/Skills views hide the Agent Header; any stale header focus is coerced
to view without changing retained `agentContext`.

## Tests

- Table-test every legal action/mode transition and cancellation.
- Use seeded key sequences for bounds and focus invariants.
- Assert mutation start counts and exactly-once reconciliation.
- Run `verify-manage-tui-state.mjs`, `verify-shortcuts.mjs` and the relevant
  domain state/render gates.
