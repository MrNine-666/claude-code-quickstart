# Code Reuse Thinking Guide

## Search Before Adding

Before adding a constant, list, parser, builder, helper, component or keybinding,
search for the owning source:

- Tools: `TOOL_DEFINITIONS`, `COMPONENT_META`.
- Keys/footer: `config/keybindings.ts`, `state/shortcuts.ts`.
- Contracts: `installer/contracts/`, `tui/contracts/`, `core/contracts.ts`.
- File writes: `fs-utils.ts`, `toml-edit.ts`, Provider/MCP/Skills core modules.
- Inputs/forms: `SingleLineInput`, `TextareaEditor`, `FormPanel` fields.
- Async detection: `use-detection-cache.ts`, detection services.
- Shared list/detail/loading: components exported by `components/index.ts`.

Use CodeGraph impact/call paths when the index is available; verify the returned
source before changing a high-fanout symbol.

## Reuse Rules

- Reuse an executable contract, not just similar syntax.
- Extend an existing registry so derived CLI/help/view/test projections update.
- Put normalization next to the format owner and make every consumer import it.
- Share UI controls and interaction mechanics, but do not force Claude/Codex,
  MCP/Skills, or platform protocols into one fake data model.
- Add an abstraction only when it owns a repeated invariant, not merely because
  two call sites currently look alike.

## Common Duplication Failures

- A view hardcodes tool order while core has `COMPONENT_META`.
- Footer text and key handling maintain separate physical-key arrays.
- CLI and TUI each parse the same profile/MCP/Skills payload differently.
- Source and compiled code use separate contract lists.
- Windows and macOS duplicate business contract data instead of consuming
  `installer/contracts/`, while still needing distinct runtime implementations.

## Checklist

- [ ] Is there already a registry/contract/type guard/builder for this value?
- [ ] Which file should fail typecheck if a new enum/id is not handled?
- [ ] Can all consumers derive from the owner instead of copying it?
- [ ] Does sharing preserve protocol/platform differences?
- [ ] Have focused tests proved the shared path for old and new callers?
