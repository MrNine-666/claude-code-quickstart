# Error Handling Contract

## Expected Failure Shapes

Use discriminated results when callers need to branch on a recoverable failure:

```ts
type OperationResult<T, E> =
  | {readonly ok: true; readonly data: T; readonly warning?: string}
  | {readonly ok: false; readonly error: E};
```

Existing examples include `CheckLatestVersionResult`, `DownloadUpdateResult`,
`ApplySelfUpdateResult`, Provider service results and Skills adoption results.
Do not collapse `partial`, `restored`, `scheduled`, `applied`, and `deleted`
into a boolean success.

## File Read Rules

Missing and corrupt are different states. A missing mutable file may be created;
an existing malformed JSON/TOML file must be preserved and reported.

```ts
const result = readJsonFileStrict(path);
if (result.status === 'invalid') return {ok: false, error: result.error};
```

Never catch a parse error, replace the value with `{}`, and write it back.
Atomic writes use `fs-utils.ts`/`toml-edit.ts`, preserve unrelated fields, and
use `0600` for secret files on POSIX.

## Child Process Rules

- Use `core/exec.ts` for captured management commands and always inspect
  `code`, `stdout`, `stderr`, timeout and spawn failure.
- Launch-class `cc`/`cx` commands use inherited stdio and return the child code.
- ENOENT for a launched Agent is exit `127`.
- A timeout must settle the caller even when a descendant keeps stdio handles.
- A command exit code is diagnostic, not proof of a filesystem fact. Skills,
  MCP, tool injection and self-update must reconcile final state.

## Presentation

- TUI default errors are friendly and concise; technical detail belongs in
  `ErrorPanel` and the `D` expansion path.
- CLI errors go to stderr and keep stdout machine-readable where applicable.
- Use domain redactors before formatting JSON/TOML or child stderr.
- A successful first step followed by activation failure returns success with a
  warning when the saved object remains usable.

## Cleanup

Best-effort cleanup may use a narrow empty `catch` only when the primary typed
result already carries the failure and cleanup cannot change it. The catch must
be scoped to that transaction's temp/helper path. Never swallow the primary
operation error.

## Error Matrix

| Condition | Required behavior |
|---|---|
| Missing optional file | Return `missing` or create minimal owned structure |
| Existing malformed file | Reject mutation; preserve bytes; redact output |
| External command non-zero | Friendly error plus retained diagnostic |
| Command zero but postflight fact absent | Failure/partial, never success |
| Mutation completed but follow-up sync failed | Success with warning when data is usable |
| Destructive action in non-TTY without `--yes` | Refuse before mutation |
| Cleanup failure after primary failure | Preserve primary error; do not broaden deletion |

## Scenario: Abortable Child Operations

### 1. Scope / Trigger

Use this contract when a TUI mutation can be interrupted by the parent view,
especially when the command is a shell-backed Windows process tree.

### 2. Signatures

```ts
type ExecOptions = {
  readonly timeout?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
};

function execCommand(
  command: string,
  args: readonly string[],
  options?: ExecOptions
): Promise<ExecResult>;

function bindExecSignal(signal: AbortSignal): typeof execCommand;
```

### 3. Contracts

- `execCommand` rejects promptly with `OperationAbortedError` (`name:
  'AbortError'`) when `signal` aborts; it does not wait for `close`.
- Aborting terminates the complete child process tree (`taskkill /T /F` on
  Windows, signal termination elsewhere), removes the settlement listener and
  normal timeout, and may retain a force-kill cleanup timer until child close.
- Services pass the bound executor through their existing dependency seam; they
  do not create a second process runner.
- Parent views suppress stale completion dispatches, clear busy state, and
  refresh detection facts after cancellation.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Signal already aborted before spawn | Immediate `AbortError`, no command work |
| Signal aborts during command | Prompt `AbortError`, process tree termination requested |
| Descendant keeps stdio after abort/timeout | Caller promise is already settled |
| Aborted mutation promise settles later | Parent ignores success/failure dispatch |
| Final fact refresh fails after cancellation | Keep cancellation state; surface refresh failure through normal detection state |

### 5. Good / Base / Bad Cases

- Good: `ToolsView`/`SkillsView` own one controller per mutation and call
  `finish(signal)` in `finally`.
- Base: a non-mutating detection command omits `signal` and keeps existing
  timeout/error semantics.
- Bad: catching `AbortError` and dispatching `item-failed`/`action-failed`, or
  treating a cancelled command's partial stdout as success.

### 6. Tests Required

- `verify-core-functions.mjs`: timeout and real AbortSignal tests assert prompt
  settlement and error name.
- Domain reducer gates: assert `cancel-busy` clears busy/progress/error state.
- Tool/Skills lifecycle gates: assert postflight fact refresh remains the source
  of final state after a cancelled mutation.

### 7. Wrong vs Correct

```ts
// Wrong: operation layer owns UI cancellation semantics.
try {
  await execCommand(command, args, {signal});
} catch {
  dispatch({type: 'item-failed', error: '取消'});
}

// Correct: core rejects typed cancellation; the parent owns reducer policy.
const exec = bindExecSignal(signal);
try {
  await serviceMutation(exec);
} catch (error) {
  if (!signal.aborted) dispatch({type: 'item-failed', error: friendlyError(error)});
}
```
