# ToolsView Primary Action Contract

## 1. Scope / Trigger

Read this spec before changing ToolsView grid keybindings, footer shortcuts, primary-action routing, or the inject-management Modal entry.

The contract prevents three sources of truth from drifting:

- `src/config/keybindings.ts` owns physical key bindings.
- `src/state/shortcuts.ts` derives contextual footer labels.
- `src/views/ToolsView.tsx` executes the selected component action.

## 2. Signatures

```ts
TOOLS_COMMANDS.PRIMARY_ACTION = 'tools:primary-action'; // Enter
TOOLS_COMMANDS.UPDATE_ONE = 'tools:update-one';         // u, inject tools only

type ToolsPrimaryAction = 'manage' | 'install' | 'update' | 'latest';

function resolveToolsPrimaryAction(
  component: ManagedComponent
): ToolsPrimaryAction;
```

## 3. Contracts

| Selected component facts | `Enter` | `u` |
|---|---|---|
| CodeGraph / CcgWorkflow, any install or update state | Open the existing management Modal | Attempt single-item update |
| Non-inject, `installed === false` | Install current item | No-op |
| Non-inject, `installed === true && hasUpdate === true` | Update current item | No-op |
| Non-inject, installed without a known update | Show “already latest”; do not enter busy state | No-op |

The management Modal keeps its own input contract: Space changes the local draft, Enter applies the draft, and Escape cancels without writes.

Footer contract:

- `grid`: `Enter 安装/更新`; do not show `i`, `m`, or `u`.
- `grid-inject`: `Enter 管理开关` and `u 更新`.
- Keep `a` update-all, `d` uninstall, `o` docs, and `r` refresh unchanged.

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| No selected component | Ignore the key |
| Selected item is busy | Ignore Enter and `u` |
| Non-inject item receives `u` | Ignore the key |
| Inject item has no update and receives `u` | Show the existing “already latest” message |
| Management draft has no changes | Keep the existing no-change message and perform no lifecycle call |

## 5. Good / Base / Bad Cases

- Good: an outdated OpenSpec card updates directly when Enter is pressed.
- Base: an up-to-date OpenSpec card only reports that it is current.
- Good: an outdated CodeGraph card still opens the management Modal on Enter; `u` remains available for its update.
- Bad: update state takes precedence over the CodeGraph/CcgWorkflow management Modal.
- Bad: the footer advertises `i`, `m`, or `u` for a non-inject card while the view handles Enter.

## 6. Tests Required

- `bun scripts/verify-shortcuts.mjs`
  - Assert `PRIMARY_ACTION` binds to Enter.
  - Assert `grid` and `grid-inject` footer contents.
  - Assert ToolsView wires Enter to the primary dispatcher and `u` to the inject-only updater.
- `bun scripts/verify-tools-shared-projection.mjs`
  - Assert `resolveToolsPrimaryAction()` returns install, update, latest, and manage for representative facts.
  - Assert manage wins when an inject component also has an update.
- `bun run typecheck`, or an equivalent strict affected-file TypeScript check when unrelated workspace changes block the full command.

## 7. Wrong vs Correct

### Wrong

```ts
if (key === 'i') installCurrent();
if (key === 'm') openManagement();
if (key === 'u') updateCurrent();
```

This makes the user choose an action that the detected component facts already determine.

### Correct

```ts
if (key === 'enter') {
  runPrimaryAction(view, services, dispatch, cache);
}

if (key === 'u' && isInjectableComponent(component.id)) {
  updateCurrent();
}
```

`runPrimaryAction()` delegates precedence to `resolveToolsPrimaryAction()`, while the key registry and footer remain synchronized.
