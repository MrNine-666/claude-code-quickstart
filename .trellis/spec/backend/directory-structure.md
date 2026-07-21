# Runtime Directory and Ownership Structure

## Current Layout

```text
tui/src/
├── index.tsx              # argv route, non-TTY guard, OpenTUI bootstrap
├── cli/                   # command parsing, help, confirmation, exit codes
├── core/                  # storage formats, contracts, commands, pure/domain logic
├── services/              # UI-facing orchestration and friendly result mapping
├── state/                 # pure reducer state and shortcut projections
├── hooks/                 # App/view lifecycle integration
├── views/                 # input dispatch and rendering composition
├── components/            # reusable OpenTUI controls
└── config/keybindings.ts  # physical key bindings; single source of truth
```

`tui/contracts/` owns TUI runtime configuration and templates. JSON/TOML/Markdown
loaded at runtime must go through `core/contracts.ts` and the embedded-contract
map; views must not resolve contract paths.

## Ownership Rules

- `cli/` parses raw tokens and maps domain results to stdout/stderr/exit codes.
  It must call existing core/service functions rather than reimplement behavior.
- `core/` owns exact file formats, validation, filesystem mutation, external
  command builders and typed domain results.
- `services/` coordinates multi-step view actions and maps technical failures to
  recoverable user-facing results. It must not invent a second persistence model.
- `state/` reducers are pure. They do not read files, spawn processes, show
  toasts, or mutate caches.
- `views/` own focused input dispatch and render state. File writes and command
  execution stay behind services/core.
- `components/` are reusable controls; they do not know Provider/MCP/Skills
  business rules.

## Adding a Feature

Prefer a vertical slice that reuses these boundaries:

```text
argv/key event -> parser or view -> service -> core contract -> filesystem/CLI
                                    ↓
                              typed result/progress
                                    ↓
                              reducer/view/CLI output
```

Do not add `utils` as a dumping ground. Put shared logic next to the contract it
owns, such as `toml-edit.ts`, `fs-utils.ts`, `tools-lifecycle.ts`, or
`skills-storage.ts`.

## Forbidden Historical Layouts

- No `manage/`, `manage/source/`, `ManageCore.*`, `manage.js`, or installer-side
  TUI business logic.
- No root `contracts/`; install and TUI contracts belong to their consumers.
- No view-local copies of registry arrays, managed field lists, or shortcut maps.
