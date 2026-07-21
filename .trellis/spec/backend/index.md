# Backend and Runtime Guidelines

这里的 backend 指 `tui/src` 中不直接负责布局的 CLI/core/service 运行时。
安装器脚本规范位于 `../installer/`。

## Guidelines Index

| Spec | Applies to |
|---|---|
| [Directory Structure](./directory-structure.md) | core/service/CLI/state/view ownership boundaries |
| [CLI Contract](./cli-contract.md) | `ccq` argv parsing, spawn and exit behavior |
| [Configuration Ownership](./config-ownership.md) | Claude/Codex/Provider/MCP/Rules/Skills file ownership |
| [Provider Configuration Safety](./provider-config-safety.md) | strict JSON/TOML reads, profile CRUD, redaction and permissions |
| [MCP Runtime](./mcp-runtime.md) | vault definitions, two runtime configs and shared projection |
| [Tool Lifecycle](./tool-lifecycle.md) | registry, detection, install/update/uninstall and injection |
| [ccq Self-Lifecycle](./ccq-self-lifecycle.md) | Release plan/download/apply and self-uninstall |
| [Error Handling](./error-handling.md) | structured results, corrupt files, child processes and UI errors |
| [Logging](./logging-guidelines.md) | progress events, diagnostics and secret redaction |
| [Quality](./quality-guidelines.md) | verification gates and review requirements |
| [TUI Quality Tooling](./tui-quality-tooling.md) | Biome scope, Bun tests, aggregate gate and quality CI |

## Pre-Development Checklist

- [ ] Identify the file owner before reading or writing any user config.
- [ ] Keep raw argv parsing in `cli/`, durable behavior in `core/`, and UI-facing
      orchestration in `services/`.
- [ ] Use the existing registry/contract/parser instead of adding a second list.
- [ ] Model expected failure with a typed result or a documented service result.
- [ ] Preserve TTY for launch commands and preserve non-TTY confirmation rules
      for destructive management commands.
- [ ] Add or extend the domain `verify-*.mjs` gate and run typecheck/full verify.

## Baseline Checks

```sh
cd tui
bun run check
```

Run the narrower verification script first while iterating; the full gate is
still required before integration.
