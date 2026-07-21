# ccq CLI Contract

## 1. Scope / Trigger

Read this before changing `tui/src/index.tsx`, `tui/src/cli/**`, command help,
spawn behavior, aliases or exit codes.

## 2. Signatures

```text
ccq                                  # interactive TUI only
ccq cc <provider> [claude-args...]
ccq cx [profile] [codex-args...]
ccq ls [--tool claude|codex]
ccq use <name> [--tool claude|codex]
ccq update [--check]
ccq tools update [name]
ccq tools uninstall <name> [--yes|-y]
ccq uninstall [--yes|-y]

createTuiExitController(exitProcess?): TuiExitController
```

`parseCli()` only chooses the verb. Each verb parser owns its subsequent token
grammar.

## 3. Contracts

- Parse argv before applying the no-argument non-TTY guard. Management commands
  must work in CI/pipes.
- `cc` and `cx` are launch-class verbs. Preserve every passthrough token except
  the first separator `--`, inherit stdin/stdout/stderr, and return the child
  exit code.
- `cc` uses `claude --settings ~/.claude/providers/<name>.json`; it does not
  persist a default. `cx` uses `codex --profile <key>` or bare `codex`.
- `ls`, `use`, `update`, `tools`, and `uninstall` are management-class verbs.
  Their flags belong to ccq and are never passed to an Agent.
- `ls`/`use` default to Claude. Codex uses `--tool codex` and the structural
  Codex core; it never writes Claude settings.
- Explicit `tools update` forces fresh detection. Tool ids, aliases and help
  availability derive from `TOOL_DEFINITIONS`.
- Destructive commands require confirmation. In non-TTY mode they require
  `--yes`/`-y` before any mutation.
- Help for an unknown subcommand is an error; general or known-command help is
  success.
- Interactive quit is explicit: App reports the intent through `onExit`, the
  entrypoint requests `renderer.destroy()`, and the renderer `onDestroy`
  callback exits the process. Do not rely on the event loop becoming empty;
  background detection commands may still own child-process or pipe handles.

## 4. Validation & Error Matrix

| Input / condition | Result |
|---|---|
| No args + TTY | Render six-menu TUI |
| `q` from an exit-capable TUI focus | Restore terminal state, then exit 0 even when background handles remain |
| No args + non-TTY | Read-only message, exit 0 |
| `cc` without provider | Usage error, no spawn |
| Missing `claude`/`codex` executable | Exit 127 |
| Child exits non-zero | Return same exit code, no fallback TUI |
| Missing requested profile | Fail before spawn, redacted error |
| Invalid `--tool` | Usage error, no write |
| Unknown help target | Exit 1 and show unknown target plus general help |
| Destructive non-TTY without confirmation flag | Refuse before mutation |

## 5. Good / Base / Bad Cases

- Good: `ccq cx dev -m gpt-5 -- --help` launches
  `codex --profile dev -m gpt-5 --help` with inherited TTY.
- Base: `ccq cx` launches native Codex defaults without ccq credential injection.
- Bad: sending `--tool codex` through to Claude/Codex or entering TUI after a
  child returns non-zero.
- Bad: maintaining a CLI alias list separately from the tool registry.
- Bad: calling only `renderer.destroy()` on normal quit and waiting for Bun to
  exit naturally.

## 6. Tests Required

- Extend `tui/scripts/verify-cli-subcommands.mjs` for token order, help, aliases,
  ENOENT and child exit propagation.
- Extend `verify-cli-uninstall.mjs` for confirmation and scheduled/deleted text.
- Extend `verify-manage-tui-state.mjs` for renderer-destroy/explicit-exit
  ordering and entrypoint wiring.
- Run `bun run typecheck` and `bun run verify`.

## 7. Wrong vs Correct

```ts
// Wrong: captured stdio breaks interactive Agent sessions.
await execCommand('codex', args);

// Correct: launch commands inherit TTY and propagate the exit status.
const child = Bun.spawn(['codex', ...args], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
});
return await child.exited;
```

```ts
// Wrong: a stuck background detector can keep ccq.exe alive.
if (state.shouldExit) renderer.destroy();

// Correct: exit only from the renderer's post-cleanup onDestroy callback.
exitController.requestExit(renderer);
```
