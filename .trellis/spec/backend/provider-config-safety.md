# Provider Configuration Safety Contract

## Scenario: Mutating Claude and Codex provider profiles

### 1. Scope / Trigger

Apply this contract whenever code under `tui/src/core/`, `services/`, CLI commands, or Provider views reads, writes, lists, activates, edits, or deletes Claude provider JSON or Codex profile TOML. It prevents silent credential/config loss and keeps TUI, CLI, and storage behavior consistent.

### 2. Signatures

```ts
type JsonFileReadResult<T> =
  | {status: 'missing'}
  | {status: 'valid'; value: T}
  | {status: 'invalid'; error: string};

type ProviderServiceResult<T> =
  | {ok: true; data: T; warning?: string}
  | {ok: false; error: string; errorKind?: 'conflict'};

type CodexProfileScanResult = {
  profiles: readonly CodexProfileListItem[];
  failures: readonly {key: string; reason: string}[];
};

type CodexProviderUiTerm = '供应商'; // presentation only; not a protocol rename

atomicWrite(path, content, {mode?: number}): void;
writeJsonAtomic(path, value, {mode?: number}): void;
```

TUI add calls must use Claude `conflictStrategy: 'error'` or an equivalent Codex `codexProfileExists(key)` check. Edit calls target the current key and may overwrite that profile atomically.

### 3. Contracts

- Claude profiles remain settings-compatible single-layer `{env}` JSON files.
- Codex profiles remain `<key>.config.toml`; `key`, top-level `model_provider`, the sole `[model_providers.<key>]` table, and table `name` must agree.
- Add checks only the requested target filename. Another explicit filename in the same builtin family (for example `glm-2.json`) does not block adding `glm.json`.
- TUI add never increments or overwrites an existing target. Edit overwrites the currently edited profile; rename-to-existing remains an error.
- Claude/Codex same-target add failures carry `errorKind: 'conflict'`. `ProviderForm` renders that kind with `toast.error`, clears stale inline errors, and keeps the form open; validation and parse failures remain inline.
- A missing mutable config may be created. An existing invalid `settings.json`, `.claude.json`, `config.toml`, or profile must never be treated as an empty document and overwritten.
- If a profile is saved but activation/onboarding/default sync fails, return `ok: true` with `warning`; refresh the list and do not report full success.
- Provider/config/auth files written by ccq use `SECRET_FILE_MODE` (`0600`) on POSIX. Generic atomic rewrites preserve an existing target mode and retain historical defaults for new non-secret files.
- TOML/JSON error output exposed by TUI or CLI must be redacted and must not include tokens or source content.
- TUI/CLI user-facing copy calls both Claude and Codex entities directly `供应商`; it never adds a `Codex` prefix. Agent context is conveyed by the header, `--tool`, or command context. Internal `CodexProfile*` symbols, `<key>.config.toml`, `codex --profile`, and TOML `profile/profiles` fields retain their protocol names.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Add target exists | `ok: false`, `errorKind: 'conflict'`; show error toast, keep form open, original profile bytes unchanged |
| Add target absent but a sibling builtin filename exists | Save requested target normally |
| Edit current profile | Atomically replace current profile; do not run add conflict handling |
| Rename edit to an existing target | Reject; both files unchanged |
| `settings.json` missing | Create the minimum document needed for activation |
| `settings.json` invalid/non-object or `env` non-object | Reject before profile/settings mutation |
| `.claude.json` invalid | Keep profile save, preserve file bytes, return onboarding warning |
| Profile saved, activation/config sync fails | `ok: true`, saved data present, warning present |
| One Codex profile is invalid | Return other profiles plus `official`; add a redacted failure |
| Codex raw TOML has legacy selectors, extra provider tables, identity mismatch, or forbidden auth fields | Reject before write |
| Secret file write on POSIX | Final mode is `0600` |
| Codex entity shown in TUI/CLI | Display `供应商`; never display `Codex 供应商`, `Codex profile`, or `Codex provider` as the business entity |

### 5. Good / Base / Bad Cases

- Good: `glm-2.json` exists and the user adds filename `glm`; create `glm.json`.
- Base: the user edits `glm`; overwrite `glm.json` and, if active, resync owned env keys.
- Bad: the user adds filename `glm` when `glm.json` exists; reject without producing `glm-3.json` or touching onboarding/settings.
- Good: the rejected add shows an error toast and leaves the edited form values available for changing the filename.
- Bad: parsing a broken file falls back to `{}` and then writes it back.
- Good: scan each Codex profile independently and send failures to `ErrorPanel` / CLI stderr while valid rows remain usable.
- Good: show `编辑供应商` while help still documents the literal command `codex --profile <name>`.
- Bad: rename `CodexProfile`, `.config.toml`, or `--profile` while translating user-facing terminology.

### 6. Tests Required

Use a temporary `CCQ_HOME`; never read or mutate the developer's real home.

- Assert Claude and Codex same-target add rejection preserves original bytes; assert edit replaces the current profile.
- Assert Claude custom/builtin and Codex duplicate-add service results carry `errorKind: 'conflict'`, and ProviderForm routes it to `toast.error` without calling `onSaved`.
- Assert sibling builtin filenames do not cause false conflicts and no implicit increment file is created.
- Assert invalid JSON/TOML remains byte-for-byte unchanged on mutation attempts.
- Assert active Claude edits remove old owned env keys but retain unrelated user env.
- Assert saved-but-not-activated results include a warning and the saved profile remains listed.
- Assert mixed valid/corrupt Codex scans keep valid profiles and redact failure/TUI/CLI output.
- On POSIX, assert provider, settings/config, onboarding, and auth files are `0600`; on Windows, assert writes succeed.
- Run `bun scripts/verify-provider-safety.mjs`, `bun run typecheck`, and `bun run verify`.
- Assert user-facing string literals contain no `Codex 供应商`, `Codex profile(s)`, or `Codex provider`, and assert `codex --profile` remains present in CLI help.

### 7. Wrong vs Correct

#### Wrong

```ts
const config = readJsonFile(path, {}); // corrupt and missing collapse together
addProvider({...payload});             // default increment/overwrite leaks into TUI
```

#### Correct

```ts
const config = readJsonFileStrict(path);
if (config.status === 'invalid') throw new Error('配置损坏，请先修复');

const result = addProvider({...payload, conflictStrategy: 'error'});
// The service maps an existing-target result to errorKind: 'conflict'.
// ProviderForm shows toast.error(result.error) and keeps the form open.
// Edit uses editProvider(currentKey, updates), not addProvider.

// UI copy: "供应商". Protocol symbols remain CodexProfile / --profile.
```
