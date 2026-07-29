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
- A failure state carries the context needed to retry the stage that failed. A
  reducer must not narrow a failure to a bare message and discard the plan,
  draft or transaction that produced it.

## Mutation Sequence

```text
intent -> confirm/draft -> started -> service/core mutation
       -> final detection -> reconciled/partial/failed reducer action
```

No reducer action named generically `action-done` may stand in for a domain
postflight contract. Skills install, topology transition, tool injection and
self-update use domain-specific completion actions.

When a list can contain same-name logical instances, every Modal/busy intent
snapshots the domain id, not the display name or cursor index. Skills uses
`InstalledSkillItem.id = (name, normalized source identity)` for known sources
and an exact-path-qualified id for unknown sources. Confirm/delete/update code
resolves `pendingInstanceId` for single-Item topology actions and
`pendingBatchInstanceIds` for update/uninstall before the live cursor. Both are
cleared when their lifecycle settles, and installed state is replaced only with
a complete CLI reconciliation. Name-level optimistic filtering is forbidden
because it can remove a different source.

Installed-list selection uses stable domain ids, never visible row indexes.
`homeLayout`, source-group collapse and filters only change the `SkillsHomeRow`
projection. Switching layout or reconciling detection restores the current row
by Item id/group key when possible, intersects selection with refreshed Item ids,
and preserves valid layout/filter/collapse state. Filtered select-all operates on
the complete filtered Item set, including Items hidden by collapsed groups.
The `toggle-all-source-groups` action is grouped-layout only: if every installed
source group is collapsed it expands all, otherwise it collapses every installed
source group. Its scope is the full installed set rather than the current filter,
and collapsing an Item row moves the cursor to that Item's source-group header.
Skills reports `list-flat` / `list-grouped` presentation submodes to the shell so
layout-specific footer commands can be projected without duplicating key facts.

## Failure Recovery

A multi-stage flow can fail at any stage, so the failure state must record which
stage failed and everything needed to re-run it. Model that as a discriminated
union rather than a retry boolean, so the type system guarantees an apply-stage
failure carries its transaction and a download-stage failure carries its plan:

```typescript
type SelfUpdateRetry =
  | {readonly stage: 'check'}
  | {readonly stage: 'download'; readonly plan: SelfUpdatePlan}
  | {readonly stage: 'apply'; readonly transaction: DownloadedSelfUpdate};

type Screen =
  | /* ... */
  | {readonly kind: 'error'; readonly message: string; readonly retry: SelfUpdateRetry};
```

Every error surface must offer a way forward as well as a way out. Enter retries
the failed stage; Esc closes. Two keys bound to the same close action is the
signature of a dead end: the state has no retry context, so the UI cannot offer
one. Where a status also drives an outer affordance (a sidebar button, a badge),
check that dismissing the error surface does not leave that affordance reopening
the same terminal state — that is the trap loop, not a fixed error screen.

Retrying normally reuses the recorded stage input; it does not restart the whole
flow. Reused artifacts stay safe because the core layer re-validates them (size
and SHA-256 before apply), not because the reducer assumes they are still good.
If core reports that an apply transaction itself is missing or invalid, the
recovery stage is `download` with the transaction's plan; repeatedly applying
the same deterministic invalid temp is a retry trap, not recovery.

## Focus State

Shell focus is bounded to `nav`, `header`, `view`, `form`, and `modal`. Shared
Tools/MCP/Skills views hide the Agent Header; any stale header focus is coerced
to view without changing retained `agentContext`.

## Tests

- Table-test every legal action/mode transition and cancellation.
- Use seeded key sequences for bounds and focus invariants.
- Assert mutation start counts and exactly-once reconciliation.
- Table-test one failure per stage: assert the error state keeps that stage's
  retry input, and assert the flow can leave the error state back into the
  retried stage. Also assert the key handler retries instead of closing.
- A new gate assertion must be verified by inverting the fix and watching it
  fail; an assertion that never fails is not a gate.
- Run `verify-manage-tui-state.mjs`, `verify-shortcuts.mjs` and the relevant
  domain state/render gates.
