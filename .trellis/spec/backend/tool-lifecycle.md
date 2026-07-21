# Managed Tool Lifecycle Contract

## 1. Scope / Trigger

Read before changing tool registration, grouping, context visibility, detection,
install/update/uninstall commands, Agent injection or Tools CLI/TUI output.

## 2. Signatures

```ts
const TOOL_DEFINITIONS: readonly ToolDefinition[];
const COMPONENT_META: Readonly<Record<ComponentId, ComponentMeta>>;

projectSharedToolComponents(detected): readonly SharedManagedComponent[];
installComponent(id, onProgress?, deps?): Promise<ComponentInstallOutcome>;
updateComponents(components, onProgress?, deps?): Promise<...>;
uninstallComponent(id, options?): Promise<...>;
injectComponent(id, target): Promise<...>;
ejectComponent(id, target): Promise<...>;
```

Current registry ids are `ClaudeCode`, `CodexCli`, `AntigravityCli`, `Ccline`,
`OpenSpec`, `Trellis`, `CcgWorkflow`, and `CodeGraph`.

## 3. Contracts

- `TOOL_DEFINITIONS` owns id/name/kind/command/package/docs and CLI aliases.
  `COMPONENT_META` owns group, supported contexts, sharing kind and display key
  order. Do not duplicate either list in views/help/tests beyond assertions.
- Shared list projection always returns the eight components in deterministic
  group order: Agent, companion/statusLine, third-party tools.
- Sharing kinds drive lifecycle and presentation:
  - `agent-exclusive`: ClaudeCode, CodexCli, Ccline.
  - `fully-shared-no-inject`: AntigravityCli, OpenSpec, Trellis.
  - `shared-cli-per-agent-inject`: CcgWorkflow, CodeGraph.
- Trellis is a global npm CLI only. ccq never runs `trellis init` or fabricates
  Agent injection state.
- Explicit tool update bypasses detection cache. Normal App detection may reuse
  its cache. Snapshot creation occurs before update mutation.
- Install/update/uninstall runs serially where global npm locks or ordered Agent
  injection matters; one component failure does not corrupt another component's
  final facts.
- CodeGraph install means ensure global CLI then run official
  `codegraph install --target=<claude|codex> --location=global --yes` and verify
  runtime MCP integration. Uninstall never deletes project `.codegraph/`.
- CcgWorkflow Agent files are owned by its official commands. ccq preserves the
  Claude MCP snapshot around init and never hand-deletes Codex config.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Registry id lacks metadata | Typecheck/verification failure |
| Detected list omits an id | Shared projection emits installed=false placeholder |
| `fully-shared-no-inject` item | No Agent toggle snapshot or management Modal |
| Inject item CLI installed, one side missing | Preserve independent side facts |
| Explicit update command | Force fresh version detection |
| Snapshot creation fails | Run no update command |
| Injection command exits zero but runtime config absent | Failure after postflight |
| Full CodeGraph uninstall | Remove both integrations and CLI when unused; preserve `.codegraph/` |
| Trellis install | Generic npm lifecycle; never `trellis init` |

## 5. Good / Base / Bad Cases

- Good: adding an npm-only tool extends the registry and metadata; generic
  detection/install/update/uninstall paths work without a new branch.
- Base: an installed up-to-date non-inject tool reports latest and Enter only
  shows a status hint.
- Bad: ToolsView hardcodes a ninth id, group or alias.
- Bad: treating CcgWorkflow as a real shared CLI or deleting a CodeGraph project
  index during global uninstall.

## 6. Tests Required

- `verify-tools-install.mjs`, `verify-tools-manage.mjs`,
  `verify-tools-view.mjs`, `verify-tools-context.mjs`,
  `verify-tools-shared-projection.mjs`.
- Domain gates: `verify-codegraph-lifecycle.mjs` and
  `verify-ccgworkflow-codex.mjs`.
- CLI alias/help changes also run `verify-cli-subcommands.mjs`.
- Finish with typecheck and full verify.

## 7. Wrong vs Correct

```ts
// Wrong: second source of truth in a view.
const toolOrder = ['ClaudeCode', 'CodeGraph', 'Trellis'];

// Correct: project and sort the authoritative registries.
const rows = projectSharedToolComponents(detected);
```
