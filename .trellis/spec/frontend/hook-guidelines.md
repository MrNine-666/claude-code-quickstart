# Hook and Effect Guidelines

## App-Level Detection

`use-detection-cache.ts` owns shared asynchronous detection state. A view entry
must reuse the App cache and must not automatically launch a duplicate request.

Refresh is allowed on:

- the initial App detection;
- explicit user refresh;
- a lifecycle mutation that may have started;
- postflight reconciliation.

Use `refreshAndWait()` when the reducer result depends on final detected facts.
Do not dispatch success from a stale closure and refresh later.

## Input Routing

`use-manage-input.ts` integrates renderer key events with shell/view focus.
Views expose a handler for their active mode; global handling must not steal keys
from an active input, textarea, form or Modal.

Normalize platform modifiers in `utils/keyboard.ts`. Do not check raw key fields
differently in every view.

## Effect Rules

- Effects synchronize external state, detection or renderer capabilities; pure
  derived values remain calculations/reducer selectors.
- Every async effect guards stale completion or cancellation before dispatching.
- Cleanup only owns resources created by that effect (abort controller, timer,
  listener). Do not cancel another view's shared request.
- Tree-sitter initialization exits before constructing a worker in compiled mode.
- Background update checking updates UI state without blocking initial render.

## Anti-Patterns

```ts
// Wrong: every page entry bypasses the shared cache.
useEffect(() => { void cache.refresh(); }, []);

// Correct: App owns initial detection; mutation awaits final facts.
const finalState = await cache.refreshAndWait();
dispatch({type: 'install-reconciled', finalState});
```

## Tests

Use deterministic injected detectors/timers and cover stale response, refresh
coalescing, mutation reconciliation and unmount cleanup. Run
`verify-async-detection.mjs` plus the affected view/domain gates.
