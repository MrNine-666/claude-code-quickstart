# TUI View Architecture Implementation Plan

## Preconditions And Review Gates

1. Review `prd.md`, `design.md` and `research/view-architecture-audit.md` top to bottom; confirm the six-module scope and behavior-preserving constraint.
2. Keep `bun run check` baseline recorded as passing before edits.
3. Before each stage, inspect `git status --short` and preserve unrelated changes. Work directly on `main`; do not create a worktree.

## Stage 1: Shared Document Module, Config And Global Rules

- [x] Extract the common preview/edit/recommendation state and stable editor tree into `src/components/managed-document/`.
- [x] Implement separate `DocumentHomeView` and `DocumentFormView` modules using existing `ListEmptyState`, `ThemedScrollbox`, `CodePreview` and `TextareaEditor`.
- [x] Define the adapter contract and wire `config/ConfigView.tsx` and `prompts/PromptsView.tsx` to their existing core/service operations.
- [x] Update `app.tsx` imports and Config/Rules/layout/shortcut gates to the new owners.
- [x] Run `bun run typecheck`, `verify-config-view.mjs`, `verify-prompts-view.mjs`, `verify-config-rules-reuse.mjs`, `verify-layout-shell.mjs`, `verify-code-preview.mjs`.

## Stage 2: Provider And MCP Home/Form Separation

- [x] Move Provider files into `views/provider/`; split list/home rendering and input from the root route; preserve Claude/Codex form adapters and official-login safety behavior.
- [x] Move `ProviderFormAdapter` and related shared type aliases out of `views/`; update `services/codex-service.ts` and all imports.
- [x] Split MCP list/home rendering from `McpView`; keep `McpFormView` as the form page and inject submit callbacks; move service-backed action mapping to `mcp-view-actions.ts`.
- [x] Update App imports and Provider/MCP static gates to the new owners without removing any safety assertion.
- [x] Run `bun run typecheck`, provider form/migration/parity/switch/TUI/safety gates and MCP parity/template/multitool/shared-projection/official gates.

## Stage 3: Tools And Skills Controller/Page/Action Split

- [x] Move service factories and public view contracts under `views/tools/` and `views/skills/`; update App and dependent imports.
- [x] Extract Tools actions/patch helpers, input routing, home grid/card page and Modals. Keep reducer/cache/busy overlay ownership in `ToolsView`.
- [x] Extract Skills actions/progress/reconciliation helpers, input routing, installed home page, install/search page and Modals. Keep reducer/cache/busy overlay ownership in `SkillsView`.
- [x] Preserve all named helper exports used by contract scripts through a documented domain barrel; update source-path assertions to the actual owners.
- [x] Run Tools install/manage/view/context/shared-projection gates and Skills adoption/render/view/agent/shared-projection gates.

## Stage 4: Architecture Gate And Integration

- [x] Add `tui/scripts/verify-view-architecture.mjs` for domain directories, root/page ownership, shared document reuse and forbidden service-to-view type imports.
- [x] Update `tui/package.json` `verify` chain and any docs/spec navigation that names old paths.
- [x] Run `cd tui; bun run check` and `git diff --check`.
- [x] Inspect narrow layout, empty/loading/error, Modal background inactivity, textarea focus/remount, Agent context switch and busy cancellation paths through existing gates.
- [x] Re-read all changed files for accidental core/service behavior changes and ensure no unrelated files are staged.

## Risk Files And Rollback Points

- `tui/src/app.tsx`: import and props wiring; rollback by restoring entry imports only after domain files are verified.
- `tui/src/components/managed-document/*`: shared focus/editor behavior; rollback Stage 1 as a unit if dirty/save/remount gates fail.
- `tui/src/views/tools/*` and `skills/*`: largest extraction surface; preserve exported pure helpers and rollback each domain independently.
- `tui/scripts/verify-*.mjs`: update source owners, never weaken the assertions; a failing gate blocks the next stage.

## Completion Criteria

All Stage 1-4 checkboxes are complete, `bun run check` and `git diff --check` pass, no old flat view path is imported, and the final diff contains only the planned view/component/type/gate/spec changes.
