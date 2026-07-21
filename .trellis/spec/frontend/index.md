# OpenTUI Frontend Guidelines

此层适用于 `tui/src/app.tsx`、`views/`、`components/`、`hooks/`、`state/`、
`theme/` 和 `config/keybindings.ts`。

## Guidelines Index

| Spec | Applies to |
|---|---|
| [Directory Structure](./directory-structure.md) | rendering-layer ownership and placement |
| [Manage Shell and Views](./manage-shell-and-views.md) | six menus, Agent context, editor/view behavior |
| [Components](./component-guidelines.md) | shared OpenTUI controls, layout and focus |
| [Hooks](./hook-guidelines.md) | detection/input/effect lifecycle |
| [State Management](./state-management.md) | reducers, modes, mutations and reconciliation |
| [Type Safety](./type-safety.md) | discriminated unions, parsed input and exhaustive state |
| [Quality](./quality-guidelines.md) | rendering/state/shortcut verification |
| [Tools Primary Action](./tools-view-shortcut-contract.md) | Tools Enter/u/d and footer invariants |
| [Skills Batch Install](./skills-batch-install-contract.md) | flat selection and source batches |
| [Skills Topology](./skills-lifecycle-contract.md) | C/X/B storage, adoption and replacement |

## Pre-Development Checklist

- [ ] Confirm whether the feature belongs in App, a view, a shared component,
      a reducer or a service; do not put persistence in rendering code.
- [ ] Reuse a component from `components/index.ts` before adding a view-local one.
- [ ] Register physical keys in `config/keybindings.ts` and derive footer text
      through `state/shortcuts.ts`.
- [ ] Make Modal/background focus ownership explicit; inactive background views
      must not react to keys.
- [ ] Use reducer modes for multi-step actions and reconcile final facts after a
      mutation.
- [ ] Check narrow terminal, long CJK/secret values, empty/loading/error states,
      source mode and compiled executable behavior.

## Baseline Checks

```sh
cd tui
bun scripts/verify-shortcuts.mjs
bun scripts/verify-manage-tui-state.mjs
bun run typecheck
bun run verify
```

Add the domain-specific gates listed in the relevant contract.
