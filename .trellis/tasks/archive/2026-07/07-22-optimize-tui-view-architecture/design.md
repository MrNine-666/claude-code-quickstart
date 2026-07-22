# TUI View Architecture Design

## 1. Intent And Invariants

This is a behavior-preserving refactor. The six menu ids, Agent context model, footer submodes, key registry, CLI/core contracts, file ownership, busy overlay and final detection reconciliation remain unchanged. The seam moves only rendering composition and view-local orchestration.

The target is a set of deep modules:

- Root views expose a small interface to App (`props`, `subMode`, busy state and exit callbacks) and coordinate screen state.
- Home/form modules expose typed intent callbacks and render facts; they do not read user files, spawn commands, or choose Agent storage paths.
- Domain action modules hide multi-step mutation and patch/reconciliation details behind the existing service result types.
- Shared document modules hide the duplicated preview/editor/focus lifecycle behind two real adapters (Config and Global Rules).

## 2. Target Topology

```text
tui/src/
├── components/
│   └── managed-document/
│       ├── ManagedDocumentView.tsx       # deep preview/edit controller
│       ├── DocumentHomeView.tsx           # preview/empty page
│       ├── DocumentFormView.tsx           # stable editor + recommendation split
│       └── document-types.ts              # adapter, snapshot and result types
├── types/
│   └── provider-form-adapter.ts           # shared UI/service type; no view import
└── views/
    ├── provider/
    │   ├── ProviderView.tsx                # screen union, selected row, route
    │   ├── ProviderHomeView.tsx            # list/detail header and list intents
    │   ├── ProviderFormView.tsx            # generic add/edit form implementation
    │   └── provider-view-adapter.ts        # Claude/Codex service adapters
    ├── mcp/
    │   ├── McpView.tsx                     # screen union and route
    │   ├── McpHomeView.tsx                 # shared list + toggle/delete modal view
    │   ├── McpFormView.tsx                 # add/edit form; submit is injected
    │   └── mcp-view-actions.ts             # service-backed action mapping
    ├── config/
    │   ├── ConfigView.tsx                  # Config adapter wrapper
    │   └── config-document-adapter.ts
    ├── prompts/
    │   ├── PromptsView.tsx                 # Rules adapter wrapper
    │   └── prompts-document-adapter.ts
    ├── tools/
    │   ├── ToolsView.tsx                   # reducer/cache/effect/controller
    │   ├── ToolsHomeView.tsx               # detection + grid/card page
    │   ├── ToolsModals.tsx                # inject/uninstall Modal views
    │   ├── tools-view-actions.ts           # async flows and pure patches
    │   ├── tools-view-input.ts             # key-to-intent routing
    │   ├── tools-view-services.ts          # service adapter factory
    │   └── tools-view-types.ts             # props/service/action types
    └── skills/
        ├── SkillsView.tsx                  # reducer/cache/effect/controller
        ├── SkillsHomeView.tsx              # installed grid/list page
        ├── SkillsInstallView.tsx           # search/results/multi-select page
        ├── SkillsModals.tsx                # target/topology/replacement/uninstall Modal views
        ├── skills-view-actions.ts          # async flows and progress/reconcile mapping
        ├── skills-view-input.ts            # list/install/Modal key routing
        ├── skills-view-services.ts         # service adapter factory
        └── skills-view-types.ts            # props/service/action types
```

The shared document module is the deliberate exception to one-file-per-domain-page symmetry. Config and Global Rules have the same state machine and rendering contract; thin domain wrappers only construct different adapters. Adding duplicate `ConfigHomeView`/`PromptsHomeView` wrappers would be shallow pass-through modules and would reintroduce the DRY violation.

This remains one Trellis task rather than a parent with child tasks. The stages are not independently integrable: they share `app.tsx` imports, the managed-document implementation, old-path removal and source-reading verify gates. The implementation plan instead uses three focused, independently rollbackable checkpoints and one final integration gate.

## 3. Interfaces And Data Flow

### 3.1 App to root view

`app.tsx` imports the new root entry points and continues to pass the current props. Tools/Skills service factories move with their domains; their public `ReturnType` contracts remain equivalent. App still owns detection caches and the busy overlay.

### 3.2 Root to page

Root views pass immutable rows/state and callbacks named by intent (`onMove`, `onOpenForm`, `onToggle`, `onConfirm`, `onCancel`, `onExit`). Page modules own active/focused rendering facts and local keyboard subscriptions only where the page has an input or Modal. Background pages receive `active={false}` when a Modal is open.

### 3.3 Config/Rules adapter

`ManagedDocumentView` consumes one `ManagedDocumentAdapter` containing:

- `load()` returning the current preview snapshot and whether an empty file exists;
- `recommendation()` and stable copy/path metadata;
- `createInitial(snapshot)` and `importInto(editorText, recommendation)` returning typed results;
- `save(editorText)` returning `{ok, error?, warning?}`;
- editor/preview filetype and title metadata.

The module owns Mode/Panel/Focus/dirty state, target reset, scroll refs, keyboard intent routing, stable editor parent/key, and home/form rendering. Config's adapter keeps fill-missing-only semantics and TOML/JSON projection; Rules' adapter keeps managed-block preservation and Markdown semantics.

### 3.4 Provider adapter

`provider-view-adapter.ts` provides the root with one interface for list, switch, add/edit model construction, save and remove. Claude and Codex are the two real adapters. The generic `ProviderFormView` keeps the existing `ProviderFormAdapter` behavior, but the adapter contract moves to `src/types/provider-form-adapter.ts` so `services/codex-service.ts` no longer imports a view.

### 3.5 Tools/Skills actions

Action modules retain current exported pure helpers and service result semantics. Their public surface is intentionally small:

- Tools: `injectChangesAction`, `successfulInstallPatch`, `successfulUpdatePatch`, `settleBatchUpdateComponents`, `uninstallSuccessPatch`, `toolStatusDot`, plus the existing async runners used only by the root input controller.
- Skills: search/install/topology/update/uninstall runners and progress/reconciliation helpers used by the root input controller.

Reducers remain in `state/`; actions dispatch domain-specific started/progress/reconciled/failed/cancelled actions and await final cache refresh exactly as today.

## 4. Verification Migration

Update `app.tsx`, service imports, and every verify script that reads/imports old paths. Source-shape assertions move to the file that owns the behavior (for example action assertions to `tools-view-actions.ts`, grid/layout assertions to `ToolsHomeView.tsx`, and document shell assertions to `ManagedDocumentView.tsx`/`DocumentFormView.tsx`). Add `verify-view-architecture.mjs` to assert:

- all six domain directories and root entries exist;
- root entries import their page modules;
- Home/Form modules do not import `core/*` or write-oriented services directly;
- `services/codex-service.ts` has no import path under `views/`;
- shared document implementation is referenced by both Config and Prompts.

No gate is weakened; assertions are relocated to the new owner.

## 5. Compatibility And Rollback

- Update all in-repo imports in one change. No legacy flat-file shim is required because the files are internal and every consumer is migrated; compatibility is provided by unchanged exported component/type names from the new entry paths.
- Preserve existing props and named exports used by scripts, moving named pure helpers through a domain barrel if needed.
- Migrate one stage at a time and run its focused gates before starting the next stage. If a stage fails, revert only that stage's file moves/extractions while keeping the previous stage's verified changes.
- Do not touch core/service behavior except the type-only dependency move and existing adapter imports.

## 6. Trade-offs

- A shared document module reduces roughly two copies of a 250-line state/rendering shell, at the cost of an adapter contract that must carry domain-specific copy and import/save results. Two production adapters justify this seam.
- Tools/Skills remain separate despite similar lifecycle words because their reducers, topology, target semantics and reconciliation contracts differ. A generic lifecycle module would be shallow and would hide important domain invariants.
- More files and updated static gates increase migration churn, but the new ownership is explicit and future page changes become local.
