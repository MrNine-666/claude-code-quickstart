# OpenTUI Rendering Structure

## Layout

```text
tui/src/
├── app.tsx                 # shell, active view, shared caches, global Modal/update state
├── views/                  # domain screens and focused key dispatch
│   ├── provider/           # Provider Root/Home/Form and Agent adapters
│   ├── config/             # Config adapter-backed root
│   ├── prompts/            # Global Rules adapter-backed root
│   ├── mcp/                # MCP Root/Home/Form and actions
│   ├── tools/              # Tools Root/Home/Modal, input, actions and service adapter
│   └── skills/             # Skills Root/Home/Install/Modal, input, actions and service adapter
├── components/             # shared cards, lists, form controls, editors and overlays
│   └── managed-document/   # shared Config/Global Rules Home/Form controller
├── hooks/                  # input routing and detection lifecycle
├── state/                  # pure reducers and shortcut projections
├── config/keybindings.ts   # command-to-binding registry
├── theme/                  # semantic terminal colors and logo
└── utils/keyboard.ts       # platform key normalization/formatting
```

## Placement Rules

- `app.tsx` owns cross-view shell state, current Agent context, App-level
  detection caches, update Modal and footer composition.
- A view owns only its domain's screen mode, active row/form focus and key
  routing. It reports `onSubModeChange` so App can derive the footer.
- Domain roots own reducer/cache/effect wiring and select Home/Form/Modal pages.
  Page modules render typed facts and emit typed intents; they do not import
  write-oriented services, read files or launch commands.
- Multi-step mutation, postflight reconciliation and reusable patches live in
  the domain action module. Tools and Skills keep separate action interfaces
  because their topology and reconciliation contracts are different.
- Shared visuals and input behavior live under `components/`; export them from
  `components/index.ts`.
- Pure state transitions live under `state/`. Do not hide a reducer inside a
  component effect when it is independently testable.
- Business operations remain in `core/`/`services/`; views receive adapters or
  callbacks and map results into reducer actions/toasts.

## Naming

- React components and files use PascalCase when the file exports one component.
- Domain modules and state files use kebab-case (`skills-view-state.ts`).
- Commands are semantic ids (`PRIMARY_ACTION`, `UPDATE_ONE`) rather than physical
  key names.
- Modes describe user-visible state (`grid`, `form`, `confirm-uninstall`) rather
  than implementation details.

## Anti-Patterns

- View-local `ShortcutBar` or duplicated key label arrays.
- A Card/Modal component that executes a domain command.
- Fixed terminal heights copied across views; use flex ownership and shared
  list/detail shells.
- A second form/input implementation when FormPanel, SingleLineInput,
  TextareaEditor or existing field components cover the behavior.
- A flat `views/*View.tsx` entry that combines Root, Home/Form rendering,
  mutation orchestration and Modal input in one file.

## Domain View Pattern

Each domain root follows a small orchestration interface. The root owns screen
state and effects, while pages receive immutable facts and intent callbacks:

```tsx
// Root: route and lifecycle only
<SkillsHomeView view={view} active={pageActive} dispatch={dispatch} />
<SkillsInstallView view={view} detection={detection} active={pageActive} dispatch={dispatch} />

// Page: facts plus typed intent; no file/process side effects
<McpFormView model={model} onSubmit={submitMcpFormAction} onSaved={onSaved} />
```

Async mutation, progress projection and final detection reconciliation belong
in `*-view-actions.ts` (or an existing `services/` adapter). A page may import
pure domain models and type-only service results, but must not import a
write-oriented service at runtime or use `fs`/`child_process` directly.

`bun scripts/verify-view-architecture.mjs` is the executable topology gate. It
checks all six domain roots, shared Config/Rules document reuse, removal of old
flat entries, and the page-to-service dependency direction. Keep this gate in
the `package.json` `verify` chain when moving a view.
