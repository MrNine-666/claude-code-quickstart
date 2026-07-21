# OpenTUI Rendering Structure

## Layout

```text
tui/src/
├── app.tsx                 # shell, active view, shared caches, global Modal/update state
├── views/                  # domain screens and focused key dispatch
│   ├── mcp/                # MCP list/detail/form screens
│   └── *-view-services.ts  # view adapters around service implementations
├── components/             # shared cards, lists, form controls, editors and overlays
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
