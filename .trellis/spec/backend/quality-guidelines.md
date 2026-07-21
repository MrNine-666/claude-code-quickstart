# Runtime Quality Guidelines

## Required Patterns

- Keep changes scoped to the owning domain; do not combine cleanup refactors
  with behavior changes.
- Search current registries/contracts before adding constants or helper logic.
- Use explicit names and discriminated unions; avoid untyped cross-layer casts.
- Keep trust-boundary validation in core/parser code and reuse it from CLI/TUI.
- Test a bug with a failing regression before applying the fix when the behavior
  can be isolated.
- Never reduce coverage by deleting a verification assertion just to make a
  change pass.

## Forbidden Patterns

- Duplicate tool/MCP/Provider/Skills lists in views or help text.
- Parse JSON/TOML with regex or ad hoc line replacement when a structural parser
  already owns the format.
- Direct config writes from React views.
- Empty catches around primary operations.
- Logging raw secrets or child-process credential arguments.
- Assuming exit code zero proves final filesystem/runtime state.

## Verification Matrix

| Area | Minimum focused gate |
|---|---|
| CLI argv/help/exit | `bun scripts/verify-cli-subcommands.mjs` |
| Provider/Codex config | `verify-provider-safety.mjs`, `verify-codex-*.mjs`, `verify-toml-edit.mjs` |
| MCP | `verify-mcp-parity.mjs`, `verify-mcp-multitool.mjs`, `verify-mcp-shared-projection.mjs` |
| Tools | `verify-tools-*.mjs`, `verify-codegraph-lifecycle.mjs`, `verify-ccgworkflow-codex.mjs` |
| Skills | gates listed in both Skills contracts |
| Self lifecycle | `verify-self-update.mjs`, `verify-cli-uninstall.mjs`, Windows native/helper smoke |

All runtime changes finish with:

```sh
cd tui
bun run check
```

`bun run check` owns format check, lint, TypeScript, Bun tests and the complete
legacy `verify` chain. Run focused checks while iterating, but do not replace the
aggregate gate with a hand-picked subset. See
[TUI Quality Tooling](./tui-quality-tooling.md) for its executable contract.

Run `git diff --check` for tracked source changes. Build all four executable
targets when changing compile, embedded asset, platform or Release behavior.

## Review Checklist

- [ ] The spec/contract owner is clear and there is no second source of truth.
- [ ] Missing, corrupt, partial, cancelled and non-TTY cases are covered.
- [ ] Final state is reconciled after mutation.
- [ ] User-owned fields and unrelated files are preserved.
- [ ] Secrets are absent from error/progress/CLI/helper output.
- [ ] Focused and full gates pass without weakening assertions.
