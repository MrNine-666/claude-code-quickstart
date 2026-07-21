# OpenTUI Quality Guidelines

## Required Checks

- Test state and key behavior through exported reducers/registries first.
- Render through real OpenTUI controls when input, focus, paste, clipping or
  compiled host-component behavior is part of the contract.
- Keep visible shortcut text derived from the same command registry as input.
- Verify narrow layouts, long CJK/ASCII values, empty/loading/no-match/error and
  Modal-over-background states.
- Preserve source mode and compiled executable fallbacks.

## Focused Gates

| Change | Gates |
|---|---|
| Shell/focus/menu | `verify-manage-tui-state.mjs`, `verify-agent-context.mjs` |
| Key/footer | `verify-shortcuts.mjs` plus domain gate |
| Components/layout | `verify-layout-utils.mjs`, `verify-layout-shell.mjs`, `verify-modal-title.mjs` |
| Code preview/editor | `verify-code-preview.mjs`, domain render/config/prompts gate |
| Config/Rules | `verify-config-view.mjs`, `verify-config-rules-reuse.mjs`, `verify-prompts-view.mjs` |
| Provider/MCP/Tools/Skills | Run the relevant backend/contract matrix |

## Bun Test Layers

- Put isolated runtime tests under `tests/core/` and import the owning pure
  function directly.
- Put real OpenTUI render/interaction tests under `tests/components/`; use fixed
  terminal dimensions and destroy `setup.renderer` inside `act()` in `finally`.
- Keep broad filesystem, CLI, compiled and cross-layer contracts in
  `scripts/verify-*.mjs`; do not duplicate them in `bun:test` without a migration
  task.

Always finish with `bun run check`. The command includes typecheck, Bun tests and
the complete legacy verify chain; its format/lint scope is defined in the
[TUI Quality Tooling](../backend/tui-quality-tooling.md) spec.

## Review Red Flags

- A key is handled but absent from footer, or shown but not handled.
- A hidden Header still consumes layout or retains interactive focus.
- A Modal moves the background cursor.
- A mutation reports success before awaited reconciliation.
- A view reads/writes a home-directory config path directly.
- A textarea is wrapped by a scrollbox.
- Compiled mode tries to construct Tree-sitter workers.
- A new loading/empty state bypasses `ListState`.

## Scope Control

Keep visual refactors independent from lifecycle/config changes unless one is
required to implement the other. Preserve existing component APIs or migrate all
callers and verification in the same change.
