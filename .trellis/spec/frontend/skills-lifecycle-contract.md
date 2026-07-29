# Skills Multi-Source Lifecycle Contract

## 1. Scope / Trigger

Read this contract before changing Skills installed detection, logical instance identity,
source display, update, Agent management, `.codex` adoption, same-name replacement,
deletion planning, snapshots, or lifecycle reconciliation.

The long-term managed topology is only:

- `.claude/skills/<name>` for Claude-only;
- `.agents/skills/<name>` for Codex-only;
- `.agents/skills/<name>` plus a `.claude/skills/<name>` projection for Shared.

`.codex/skills` is a compatibility input for user-installed Skills reported by the
upstream CLI. New TUI installs never target `.codex`.

## 2. Signatures

```ts
parseSkillsListJson(parsed: unknown): SkillsListParseResult;

groupInstalledSkillItems(
  records: readonly SkillsCliListRecord[]
): readonly InstalledSkillItem[];

detectInstalledSkillItems(
  exec?: ExecFn
): Promise<readonly InstalledSkillItem[]>;

normalizeSkillSourceIdentity(
  rawSource: string | undefined
): string | undefined;

buildSkillsOwnershipIndex(
  items: readonly InstalledSkillItem[]
): SkillsOwnershipIndex;

skillsHomeRows(state: SkillsViewState): readonly SkillsHomeRow[];

selectedOrCurrentInstalled(
  state: SkillsViewState
): readonly InstalledSkillItem[];

updateSkillInstances(
  items: readonly InstalledSkillItem[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn
): Promise<SkillsBatchUpdateOutcome>;

transitionSkillTopology(
  item: InstalledSkillItem,
  target: 'claude-only' | 'codex-only' | 'shared',
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  options?: SkillStorageOptions
): Promise<SkillsAdoptionResult>;

uninstallSkillInstance(
  item: InstalledSkillItem,
  allItems: readonly InstalledSkillItem[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  storageOptions?: SkillStorageOptions
): Promise<SkillsUninstallOutcome>;

uninstallSkillInstances(
  items: readonly InstalledSkillItem[],
  allItems: readonly InstalledSkillItem[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  storageOptions?: SkillStorageOptions
): Promise<SkillsBatchUninstallOutcome>;

installSearchResultsToTargets(
  results: readonly SearchSkillResult[],
  targets: readonly AgentContext[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  options?: SkillsInstallExecutionOptions
): Promise<SkillsBatchExecution>;

cleanupConfirmedReplacementSnapshots(
  replacements: readonly SkillsReplacementExecution[],
  confirmedKeys: readonly string[]
): Promise<void>;
```

The shared domain object is:

```ts
type InstalledSkillItem = {
  readonly id: string;
  readonly name: string;
  readonly provenance: SkillProvenance;
  readonly agents: readonly string[];
  readonly projections: readonly SkillProjection[];
  readonly capabilities: {
    readonly update: boolean;
    readonly manageAgents: boolean;
    readonly migrate: boolean;
    readonly delete: true;
  };
};
```

`SkillsAdoptionResult.outcome` is `complete | partial | restored | failed`.
`SkillsUninstallOutcome.outcome` is `complete | partial | failed`. Both expose
`mutated`; it becomes true once a mutation may have changed external state.
Installed-list reducer state owns `homeLayout: 'flat' | 'grouped'`,
`collapsedSourceKeys`, `pickedInstalledIds`, and `pendingBatchInstanceIds`.

## 3. Contracts

### Detection and identity

- Installed state has one fact source: one successful
  `npx skills list -g --json` JSON array. Detection does not read
  `.skill-lock.json` and does not enumerate `.claude`, `.agents`, or `.codex` to
  add, remove, split, merge, or correct records.
- Non-zero exit, empty output, invalid JSON, non-array top level, or one invalid
  record fails the whole detection. Never silently skip a record or fall back to
  filesystem inspection.
- `agents` alone determines Agent availability. `source` and `sourceUrl` alone
  determine provenance. `path` only classifies a storage projection and supports
  confirmed migration/deletion safety.
- A known instance identity is `(name, normalizedSourceIdentity)`. `sourceUrl`
  is the preferred operation source when present; `source` and `sourceUrl` remain
  separate display fields. GitHub HTTPS, SSH, `github:`, `github.com/`, and
  `owner/repo` equivalents normalize to one identity.
- Known records with the same name and normalized source merge into one Item,
  unioning agents and exact-path-deduplicated projections. Content is not read or
  compared. Known records with different sources remain distinct adjacent Items.
- Unknown records have neither `source` nor `sourceUrl`. They merge only when the
  normalized exact path is the same; name alone is never a merge key.
- `(root, name)` is unique per physical root. If different Items claim the same
  pair, ownership is ambiguous and every covering, migration, or direct-delete
  preflight must refuse to guess.

### Capabilities and UI intent

- Known provenance enables update, Agent management, and migration. Unknown
  provenance enables deletion only. Unknown `Enter`/`U` is rejected before any
  command; changing it requires deletion followed by a new install.
- The installed list defaults to a flat single column. `V` toggles a source-grouped
  projection whose headers expand/collapse; all unknown Items share one
  `unknown` display group labelled `未知来源`, but retain their independent
  path-qualified ids and mutation targets.
- The page-level layout/selection summary is independent of the filtered row
  projection. It uses compact `RadioField` copy `布局：平铺 / 分组`, reflects
  `homeLayout`, and keeps `V` as the switching input. It remains visible with the
  total selected Item count when the installed list is empty or the current filter
  matches no rows.
- Every Skill row has exactly three content lines: flat title `name（source）` or
  grouped title `name`; an http/https `sourceUrl` anchor or `无来源链接`;
  and Claude Code plus Codex availability derived only from `agents`. Never
  synthesize a URL from `source`. The link stays clickable/underlined but uses
  the install page's `colors.muted + DIM` source treatment.
- Skill Item rows use the shared themed `Checkbox`; focused or checked boxes use
  the complete primary-colored bracket/checkmark. Group headers render through
  `ScrollList` with `bordered: false`, while Skill Items retain Card borders.
- `Space` toggles the current Item selection and toggles a focused group header;
  `Enter` toggles a group or manages the current Item. `A` selects/deselects all
  Items matched by the current filter, including matches hidden by a collapsed
  group. Existing selections outside the filter remain unchanged.
- `E` is the centralized grouped-layout bulk toggle. If any installed source
  group is expanded it collapses all groups; if every group is collapsed it
  expands all. Filtering does not narrow this scope, flat layout is a no-op, and
  the cursor remains anchored to the current Item's source group when collapse
  hides that Item. Skills reports `list-flat` / `list-grouped` submodes; the
  footer advertises `E 全部展开/收起` only for `list-grouped`.
- `U` and `D` prefer explicitly selected Item ids; with no selection they fall
  back to the current Skill row. A focused group header with no selection has no
  mutation target. `D` snapshots the complete target id set before confirmation;
  `Enter` remains a single-Item Agent-topology action.
- The TUI has no update-all entry. Batch update filters by `capabilities.update`,
  records unknown Items as skipped, stably deduplicates names, and runs one
  `skills update <unique names...> -g -y`. Upstream update is name scoped, so the
  UI never claims source-isolated success.
- Batch uninstall sequentially calls the instance-safe planner for every target,
  always with the same operation-start `allItems` snapshot. One Item failure does
  not stop later Items; `AbortError` stops the batch. Any mutation causes exactly
  one final full detection after the batch, while all-`mutated=false` preflight
  failures cause no refresh.

### Migration and deletion

- `.codex` known instances can be adopted to Claude-only, Codex-only, or Shared.
  Confirming Codex-only is still a migration because the managed destination is
  `.agents`, not `.codex`.
- Migration order is snapshot source/occupied targets -> create and validate the
  managed target -> delete the old source -> complete list reconciliation.
  Target failure restores overwritten targets. If target creation succeeds but
  source deletion is incomplete, report partial success and preserve the facts
  for reconciliation.
- Prefer official `skills remove` only when the current full Item list proves the
  name-level removal cannot affect another same-name source. Otherwise direct
  deletion is the narrow safety exception.
- Direct deletion must first validate every candidate atomically: supported root,
  direct `<root>/<name>` child, safe basename, no traversal, never the root or a
  parent, and no cross-Item ownership ambiguity. A symlink/junction is unlinked;
  it is never recursively followed. If any candidate fails preflight, delete none.

### Same-name replacement and reconciliation

- Selected install Agents map to target roots: Codex-only -> `agents`; Shared ->
  `agents` plus `claude`. Other roots are outside the replacement transaction.
- A replacement confirmation lists every different-source Item occupying a
  target root, with its own source and only the projections that will be
  overwritten. Multiple old Items can correspond to one new search identity.
- Before spawning add, collect all target-root occupants. Every occupant must be
  known and provably different, and each Item receives a snapshot from its own
  target-root projection. If any validation/snapshot fails, clean prepared
  snapshots and do not spawn add.
- A successful add retains every old snapshot until the final list detection
  confirms the new identity. One confirmed new key cleans all snapshots attached
  to that replacement; failed/unconfirmed replacement entries retain
  `recoveryPath`.
- Filesystem inspection, manifests, and snapshots are transaction-safety tools
  only. They never feed installed identity, provenance, Agent badges, or final UI
  state.
- Every started install, update, migration, or delete performs one complete
  `list -g --json` refresh even when the command/result reports failure. A safe
  preflight/no-op with `mutated=false` does not refresh. Exit code and local
  optimistic filtering never define final state.
- Lifecycle mutation commands use the unpinned `skills@latest` package contract,
  while list/search commands remain unpinned `npx skills`; never restore a fixed
  minor package reference.

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| List command fails, output is empty/bad JSON, or one record is malformed | Fail the complete detection; no filesystem fallback |
| `source` and `sourceUrl` both absent | Show `未知来源`; allow only delete |
| `sourceUrl` missing, invalid, or non-http(s) | Show `无来源链接`; click and `O` perform no open |
| Installed `sourceUrl` is safe | Render clickable URL with the same muted/dim source color as the install page |
| Installed list is empty or filter matches no rows | Keep compact `布局：平铺 / 分组` Radio and selected count visible above the empty state |
| `E` in grouped layout | Collapse all installed source groups unless all are already collapsed; then expand all |
| Flat layout footer / `E` input | Do not advertise `E`; direct input remains a no-op |
| Same name and normalized known source across paths | Merge Item; union agents/projections; do not compare content |
| Same name with different known sources | Keep separate Items with stable ids |
| Unknown same-name records on different paths | Keep separate Items |
| Different Items claim one `(root, name)` | Mark ownership ambiguous; block mutation preflight |
| `.codex` known Item confirms Codex-only | Migrate to `.agents`; not a no-op |
| Official remove can affect another same-name Item | Use validated direct-delete plan or refuse |
| Any direct-delete candidate fails validation | Delete nothing; `failed`, `mutated=false` |
| Some validated targets delete before a later runtime failure | `partial`, `mutated=true`; full refresh |
| Official remove starts and exits non-zero | `failed`, `mutated=true`; full refresh |
| Selection contains known and unknown Items | Update known unique names once; report unknown Item ids as skipped |
| Selection contains only unknown Items | Start no update command; remain recoverable with an explicit error |
| One batch-uninstall Item fails before mutation | Continue later Items using the original full `allItems` snapshot |
| Batch uninstall has any mutation | Reconcile once after the complete batch; never once per Item |
| Shared replacement covers different Items in `.agents` and `.claude` | Show and snapshot both before add |
| One replacement occupant is unknown/same-source/unrecoverable | Do not add; clean any prepared snapshots |
| Mutation succeeds but final list does not confirm it | Do not claim success; retain diagnostics/recovery snapshots |
| Mutation command fails after possible writes | Preserve diagnostic and reconcile the full list |

## 5. Good / Base / Bad Cases

- Good: CLI returns `pdf` from source A in `.agents` and source B in `.claude`;
  both appear as separate Items. Installing source C to Shared shows two conflicts,
  snapshots both old roots, writes the new topology, and cleans both snapshots
  only after source C is detected.
- Good: CLI returns two equivalent GitHub forms for the same name; they merge
  without reading either directory.
- Good: an unknown `.codex` Item can be deleted through a validated exact path but
  cannot be updated or adopted.
- Good: filtering to `pdf`, collapsing its source group, then pressing `A` still
  selects every matching `pdf` Item; unrelated prior selections remain selected.
- Good: selecting two sources of `pdf`, one `docs`, and one unknown Item invokes
  one `update pdf docs -g -y`, then one full list reconciliation.
- Base: a known Codex-only `.agents` Item selects the same topology; it is a no-op
  and does not refresh. The same logical topology under `.codex` requires adoption.
- Bad: enriching a list record from `.skill-lock.json`, overriding `agents` from
  `inspectSkillStorage()`, or filtering a name locally after delete.
- Bad: using `.find()` for target-root replacement occupants; Shared may overwrite
  two old sources and lose the un-snapshotted one.
- Bad: using official name-level remove when another source has the same name.
- Bad: treating collapsed Items as outside select-all scope, synthesizing a link
  from `source`, or refreshing after each Item in a batch uninstall.

## 6. Tests Required

- `verify-skills-installed-domain.mjs`: strict parser, source normalization,
  known/unknown grouping, stable ids, capabilities, root classification, and
  ownership ambiguity.
- `verify-skills-instance-state.mjs`: same-name cursor behavior, selected/current
  fallback, pending single/batch instance snapshots, unknown capability gates,
  and full reconciliation.
- `verify-skills-deletion-safety.mjs` and
  `verify-skills-uninstall-planner.mjs`: path matrix, links, atomic preflight,
  official/direct-delete choice, complete/partial/failed, and mutation flags.
- `verify-skills-update-action.mjs`: exact deduplicated batch argv plus full refresh on
  command success and failure; stable name dedupe, unknown skip, no update-all
  TUI seam, and exactly one refresh.
- `verify-skills-adoption.mjs`: `.codex` adoption, C/X/B transitions, rollback,
  target-root replacement, multiple old-source snapshots, and confirmed cleanup.
- `verify-skills-shared-projection.mjs`: one list call, no lock enrichment, no
  directory scan, agents-only badges, and path-only storage labels.
- `verify-skills-view.mjs` and `verify-skills-render.mjs`: source/sourceUrl/unknown
  display, default flat single column, source grouping/collapse, unified unknown
  display group with distinct ids, filtered selection including collapsed Items,
  grouped `E` bulk collapse/expand over the full installed group set plus cursor anchoring,
  flat/grouped footer projection with `E` absent from `list-flat`,
  page-level layout/selection summary preserved across empty filtered projections,
  exact target-root conflict list, unique Modal/row keys, D vs Enter copy,
  cancellation, shared themed Checkbox, muted/dim clickable link, borderless
  group headers, both Agent badges, and narrow layout.
- `test-skills-topology-smoke.mjs`: isolated HOME against official
  `skills@latest`; network or permission failure is reported as an external block,
  never replaced by a mock success.
- Finish with `bun run check` and repository-level `git diff --check`.

## 7. Wrong vs Correct

### Wrong

```ts
const installed = installedItems.find(item => item.name === skillName);
const storage = await inspectSkillStorage(skillName);
const snapshot = await createSkillSnapshot(preferredSkillContentPath(storage)!, skillName);
await addNewSource();
dispatch({type: 'action-done'});
```

This collapses different sources by name, snapshots at most one target-root owner,
uses filesystem inspection as an identity oracle, and claims success before the
CLI list is reconciled.

### Correct

```ts
const occupants = installedItems.filter(item =>
  item.name === skillName &&
  item.projections.some(projection => targetRoots.includes(projection.root))
);

const prepared = await snapshotEveryOccupantFromItsTargetProjection(occupants);
const action = await addNewSource();
const finalState = await cache.refreshAndWait();
await cleanupConfirmedReplacementSnapshots(
  preparedResults(action),
  confirmedSourceKeys(finalState)
);
```

The Item list remains CLI-derived, every overwritten logical owner is protected,
and the final UI state is replaced only by the complete refreshed list.

### Installed-list batch actions

```ts
// Wrong: collapse changes operation scope; update pretends source isolation.
const visible = skillsHomeRows(state).filter(row => row.kind === 'skill');
for (const row of visible) await updateSkills([row.item.name]);

// Correct: selection scope comes from filtered Items, and upstream names run once.
const targets = selectedOrCurrentInstalled(state);
const result = await updateSkillInstances(targets);
const finalState = await cache.refreshAndWait();
dispatch({type: 'lifecycle-reconciled', installed: finalState.result});
```

The display projection may hide collapsed rows, but it never narrows selection or
mutation identity. Name-scoped update executes once and final facts reconcile once.
