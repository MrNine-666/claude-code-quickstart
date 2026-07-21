# Project Thinking Guides

Guides are short pre-change checklists. Exact file formats, signatures, error
matrices and tests belong in backend/frontend/installer code specs.

## Guides

| Guide | Use when |
|---|---|
| [Development Workflow](./development-workflow.md) | starting a feature, fix, refactor or spec update |
| [Cross-Layer Thinking](./cross-layer-thinking-guide.md) | behavior crosses view/service/core/config/CLI/platform boundaries |
| [Code Reuse Thinking](./code-reuse-thinking-guide.md) | adding constants, registries, builders, parsers, helpers or keybindings |

## Quick Routing

- Config or persistence change: identify exact file owner and field ownership.
- External command change: map argv, TTY/capture, timeout, exit and postflight.
- UI action change: map key registry -> view intent -> service/core -> reducer
  reconciliation -> footer.
- Platform/build change: map source -> contract -> builder -> CI artifact ->
  installed/runtime smoke.
- Historical document claim: verify against current source before promoting it
  into a code spec.
