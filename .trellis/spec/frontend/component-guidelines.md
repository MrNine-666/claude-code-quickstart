# OpenTUI Component and Layout Contract

## Component Ownership

Reusable controls live in `tui/src/components/`:

- `Card`, `ScrollList`, `ListState`, `DetailScreen`, `DetailPanel` for list/detail
  composition.
- `Modal`, `ErrorPanel`, `Spinner`, toast for overlays and feedback.
- `FormPanel` plus `TextField`, `SelectField`, `RadioField`, `KeyValueField` for
  structured forms.
- `SingleLineInput` for page search/filter input and `TextareaEditor` for
  multiline editing.
- `CodePreview` for plain/JSON/TOML previews with source-mode syntax support.

## Focus and Input

- A control receives explicit `active` and `focused` facts. Rendering focus and
  accepting keys are the same ownership decision.
- When a Modal is active, the background list/grid is rendered inactive. Modal
  arrows and Enter must not move or submit the background.
- Controlled OpenTUI `<input>` uses both supported change events through one
  normalizer when necessary; page Enter remains owned by the page handler.
- Secret values may be visible only during explicit editing. Read-only previews,
  labels, toasts and errors remain masked.

## Layout

- Prefer flex layouts with one clear height owner. Do not reintroduce manual
  `terminalHeight - header - footer` arithmetic in each view.
- Stable regions such as card grids, status columns, checkboxes and shortcut bars
  need fixed/min dimensions so labels or hover/focus do not shift layout.
- `titleRight`/status regions stay visible; long titles shrink or clip before
  displacing status/download facts.
- Use semantic colors from `theme/index.ts`; do not hardcode terminal colors in
  views. Source and compiled mode must both have a legible plain-text fallback.
- All loading/empty/no-match/error list states use `ListState`; do not hand-build
  different spinner/empty text in each view.

## Textarea Rule

OpenTUI `<textarea>` scrolls internally but exposes no visible scrollbar.
Never wrap it in `<scrollbox>`: that suppresses internal scrolling. Accept the
cursor-driven scroll behavior and keep the editor in a stable flex region.

## CodePreview Rule

Normalize CRLF and trailing newline handling before counting/rendering lines.
In compiled executables Tree-sitter is disabled because its worker cannot be
resolved from Bun's virtual path; render plain text. Source mode may use syntax
highlighting.

## Global Busy Feedback

- `Spinner` is the single loading component. Use its default `inline` variant
  for local detection/loading rows and `variant="overlay"` for blocking
  install, update and uninstall mutations.
- App owns the current `BusyOverlayState` and renders the overlay at the terminal
  root. Tools and Skills report presentation state through
  `onBusyStateChange`; they must not render a mutation `ProgressLog` at the
  bottom of the page.
- The overlay covers `100%` width/height with a themed semi-transparent
  background, keeps the spinner/content panel opaque, and shows only the latest
  instruction reported by the active mutation.
- While the overlay is visible, App disables both global input dispatch and the
  active background view. Completion clears the overlay; the parent view owns
  the final completion/cancellation toast and domain error presentation.

```tsx
// Wrong: a view-local log leaves the rest of the shell interactive.
{busyAction ? <BottomLog messages={progress} /> : null}

// Correct: the view reports state and App reuses the shared Spinner overlay.
onBusyStateChange?.({title: '正在更新工具', message: latestInstruction, onCancel: cancelBusyTask});
<Spinner variant="overlay" label={busy.title} message={busy.message} onCancel={busy.onCancel} />
```

## Scenario: Overlay Cancellation Contract

### 1. Scope / Trigger

Use this contract for any blocking install, update, inject, topology, or
uninstall action rendered through `Spinner variant="overlay"`.

### 2. Signatures

```ts
type OverlaySpinnerProps = {
  readonly variant: 'overlay';
  readonly onCancel: () => void;
  readonly message?: string;
  readonly terminalWidth?: number;
};

type BusyOverlayState = {
  readonly title: string;
  readonly message?: string;
  readonly onCancel: () => void;
};

type ProgressEvent = {
  readonly level: 'info' | 'success' | 'warning' | 'danger';
  readonly message: string;
  readonly componentId?: string;
  readonly instruction?: string;
};
```

### 3. Contracts

- Overlay is the default blocking presentation for mutation busy state.
- On the first `Esc`, Spinner hides itself immediately and invokes `onCancel`
  exactly once. It must not know about child processes, reducers, or
  `AbortController`.
- The parent view owns cancellation: abort its active controller, dispatch its
  domain `cancel-busy` action, and refresh final facts from the shared cache.
- App passes the parent callback to the root Spinner and disables background
  input while `BusyOverlayState` is present.
- Views project only the structured progress event's latest `instruction` to
  the overlay. A newer command replaces the rendered message; status-only
  events do not hide the command. Completing the current mutation clears the
  overlay and emits one parent-owned toast.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Overlay rendered without `onCancel` | Typecheck failure |
| First Esc while visible | Overlay disappears and parent callback runs once |
| Repeated Esc after callback | No duplicate callback or state transition |
| New progress event arrives | Replace the current instruction; do not append a log |
| Status-only event has no `instruction` | Keep the current command visible; do not replace it with fixed status copy |
| Parent abort rejects the command | No stale success/error dispatch; parent refreshes facts |
| Mutation completes normally | Parent clears busy and shows one final toast |

### 5. Good / Base / Bad Cases

- Good: `Spinner` calls `onCancel`; `ToolsView`/`SkillsView` abort and dispatch
  `cancel-busy` without presenting cancellation as an error.
- Good: core emits `instruction: 'npm install -g package'`; the view projects
  that field while retaining `message` for CLI/status diagnostics.
- Base: a mutation has no active controller; Esc is ignored by the parent and
  does not fabricate a reducer failure.
- Bad: Spinner calls `taskkill`, mutates a domain reducer, or waits for a
  process promise before hiding the overlay.
- Bad: the view projects `event.message`, allowing text such as `正在更新...`
  or a success message to replace the concrete command.

### 6. Tests Required

- `verify-layout-shell.mjs`: render one current instruction, assert the obsolete
  bottom-log component is absent, emit Escape, and assert one callback plus no
  overlay frame after the event.
- Skills/Tools core gates: assert spawned command argv is also exposed through
  `ProgressEvent.instruction`.
- Tools/Skills reducer gates: assert `cancel-busy` clears busy/progress/error
  state and returns to the correct page.
- `verify-core-functions.mjs`: assert a real `AbortSignal` rejects the command
  promptly with `AbortError`.

### 7. Wrong vs Correct

```tsx
// Wrong: rendering owns business cancellation and projects generic status copy.
onProgress(event => dispatch({type: 'progress', message: event.message}));
<Spinner variant="overlay" message={progress.join('\n')} onCancel={() => child.kill()} />

// Correct: the view projects only concrete instructions; the parent owns cancellation.
onProgress(event => {
  if (event.instruction) dispatch({type: 'progress', message: event.instruction});
});
<Spinner variant="overlay" message={latestInstruction} onCancel={cancelBusyTask} />
```

## Wrong vs Correct

```tsx
// Wrong: background remains interactive under the Modal.
<ToolsGrid active={true} />
<Modal active={confirming}>...</Modal>

// Correct
<ToolsGrid active={!confirming} />
<Modal active={confirming}>...</Modal>
```

## Verification

Run `verify-layout-*`, `verify-list-state` coverage within existing gates,
`verify-modal-title.mjs`, `verify-code-preview.mjs`, domain render gates,
`verify-layout-shell.mjs` for global busy feedback, typecheck and full verify.
