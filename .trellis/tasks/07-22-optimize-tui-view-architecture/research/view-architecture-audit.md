# TUI View Architecture Audit

## Method

- Read the frontend/backend directory and ownership specs and the code-reuse and cross-layer guides.
- Used CodeGraph before direct source inspection because `.codegraph/` is present.
- Compared current view symbol clusters, App imports, service imports, and verify-script source paths.
- Established a baseline with `cd tui; bun run check` on 2026-07-22.

## Baseline

`bun run check` passed: format boundary, Biome lint, strict typecheck, 3 Bun tests, and the complete `bun run verify` chain.

## Findings

| Area | Evidence | Architectural issue | Proposed seam |
|---|---|---|---|
| MCP | `views/mcp/McpView.tsx:47-241`, `McpFormView.tsx:35-278` | Already has a domain directory and a form page, but root/form still call service mutations directly and the root also owns list, modal, input and form routing. | Keep MCP as the reference shape; add a home page and domain action adapter, pass submit callbacks into the form. |
| Provider | `views/provider-view.tsx:76-336`, `provider-form.tsx:136-430` | Root screen switch, Agent-specific service selection, list rendering, list/delete input and form construction are mixed. The generic form module also owns mutable text state and save mapping. | `provider/ProviderView`, `ProviderHomeView`, `ProviderFormView`, and a two-adapter provider view adapter. Move `ProviderFormAdapter` out of `views/` so services do not import a view type. |
| Config / Global Rules | `ConfigView.tsx:34-313`, `PromptsView.tsx:30-303` | Same Mode/Panel/Focus state, keyboard routing, preview scroll, split recommendation pane, editor lifecycle and save/cancel transitions are duplicated with small domain differences. | One deep `ManagedDocumentView` module under `components/managed-document/`, with Config and Prompts adapters for load/import/save/copy. Its implementation contains separate home/editor page modules. |
| Tools | `ToolsView.tsx:82-1334` | Root, input routing, install/update/uninstall orchestration, patch projection, Modal and card/grid rendering are in one file. Several exported pure helpers are consumed by verify scripts. | Keep reducer/cache/controller in `tools/ToolsView.tsx`; move actions/patch helpers to `tools-view-actions.ts`, key routing to `tools-view-input.ts`, grid to `ToolsHomeView.tsx`, and Modal/presentation to `ToolsModals.tsx`. |
| Skills | `SkillsView.tsx:79-1440` | Root, list/install key routing, search/install/topology/update/uninstall async flows, Modal rendering and installed/install page rendering are in one file. | Keep reducer/cache/controller in `skills/SkillsView.tsx`; move async flows to `skills-view-actions.ts`, input to `skills-view-input.ts`, list to `SkillsHomeView.tsx`, install page to `SkillsInstallView.tsx`, and Modal/presentation to `SkillsModals.tsx`. |
| Service dependency | `services/codex-service.ts:32` imports `ProviderFormAdapter` from `views/provider-form.tsx`. | Backend-facing service depends on rendering-layer module, violating directory ownership and making file moves unsafe. | Move the adapter contract to `src/types/provider-form-adapter.ts` (or an equivalent domain type module) and update both service and view imports. |
| Verification | Many scripts read or import old flat paths, e.g. `verify-layout-shell.mjs`, `verify-shortcuts.mjs`, `verify-tools-shared-projection.mjs`, `verify-skills-render.mjs`, `verify-provider-safety.mjs`. | A mechanical file move would make the contract suite fail or silently stop checking the owning implementation. | Update each gate to read the new owner file(s); add one architecture gate for topology and forbidden view-to-view/service type dependencies. |

## Reuse Decisions

1. Reuse existing `FormPanel`, `TextareaEditor`, `ListState`, `Modal`, `StatusDot`, `ThemedScrollbox`, and keyboard helpers. No view-local replacements are justified.
2. The Config/Rules shared module is a real seam because there are two production adapters with different storage/import semantics. Its interface is an adapter object, not a collection of per-key callbacks spread through the page.
3. Tools and Skills keep domain-specific action modules instead of a generic lifecycle framework. Their state machines, target topology, progress contracts and reconciliation semantics differ materially.
4. MCP and Provider get explicit home/form files because their list and form behavior are distinct and user-visible. No new generic CRUD abstraction is introduced.

## Risks To Carry Into Design

- Textarea remounting can discard user edits when the split editor tree changes; the shared document module must preserve the existing stable editor parent/key rule.
- Static verify scripts currently encode file paths and source-shape assertions; migration must update their source owner, not weaken assertions.
- Tools/Skills exports used by verify scripts must remain public from their new action module or through a documented barrel.
- App detection caches, `active`/focus ownership, busy overlay cancellation and final reconciliation must remain at the same lifecycle layer.
