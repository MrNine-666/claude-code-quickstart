# Skills Flat Multi-Source Install Contract

## 1. Scope / Trigger

Read this contract before changing the Skills search/install page, search identity,
multi-select reducer state, target Modal, source batches, same-name conflict flow,
replacement snapshot cleanup, or post-install reconciliation.

The visible result list stays flat. Internal execution may group selections by
source, but new installs only target the managed `.agents` / `.claude` topology.

## 2. Signatures

```ts
searchSkillIdentity(
  result: SearchSkillResult
): SearchSkillIdentity | undefined;

planSkillInstallBatches(
  results: readonly SearchSkillResult[]
): readonly SkillsInstallPlanBatch[];

searchInstallItems(
  state: SkillsViewState
): readonly SearchInstallItem[];

pendingSourceReplacements(
  state: SkillsViewState
): readonly SourceReplacementItem[];

targetRootsOfDraft(
  draft: InstallDraft
): readonly SkillsStorageRoot[];

installSearchResultsToTargets(
  results: readonly SearchSkillResult[],
  targets: readonly AgentContext[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  options?: {
    readonly installed?: readonly InstalledSkillItem[];
    readonly storage?: SkillStorageOptions;
  }
): Promise<SkillsBatchExecution>;

DetectionCache<Result>['refreshAndWait']:
  (options?: DetectionRunOptions) =>
    Promise<DetectionState<Result> | undefined>;
```

Reducer-owned install fields are `pickedResultKeys`, `pendingInstallKeys`, and
`batchStage`. `SourceReplacementItem` carries the new result/identity, the old
`InstalledSkillItem`, and only that Item's projections intersecting target roots.

## 3. Contracts

### Selection and planning

- Preserve the existing flat multi-select UI. `SearchSkillIdentity.key` is
  `JSON.stringify([source, skillName])`; selection always distinguishes source.
- Installed matching uses `(skillName, normalizedSourceIdentity)`, preferring
  installed `sourceUrl` identity when available. Equivalent GitHub URL, SSH,
  `github:`, and `owner/repo` forms count as one source.
- Same name plus same source is installed and not selectable. Same name plus a
  provably different known source is selectable as `已有同名`; actual overwrite
  scope is decided only after the Agent target draft is known.
- Unknown installed Items cannot be inferred as a different source or adopted.
  A target-root preflight that encounters unknown provenance blocks add.
- The planner preserves first-seen source order, coalesces names from the same
  source into repeated `--skill`, and deduplicates exact identities. Selecting
  different sources for the same `skillName` in one submission is rejected before
  spawn because they would compete for one target-root name.
- Different source batches execute sequentially and continue after one batch
  fails. They must not execute concurrently or read a hidden Header Agent context.

### Targets and replacement confirmation

- The target Modal keeps multi-select behavior. Codex remains selected for a new
  install; Claude can be toggled. Codex-only maps to `agents`; Shared maps to
  `agents` plus `claude`. No new install writes `.codex`.
- `pendingInstallKeys` is an immutable submission snapshot. Cancelling clears the
  snapshot but keeps explicit picks.
- For each pending search identity, `pendingSourceReplacements()` returns every
  different-source Item that occupies at least one selected target root. It must
  not use `.find()`: `.agents` and `.claude` may contain same-name Items from two
  different sources.
- Each confirmation row shows the old source/sourceUrl, new source, and only the
  occupied target projections that will be overwritten. Its render key includes
  both new search identity and old Item id.
- Service preflight mirrors the confirmation: collect every target-root occupant,
  reject same/unknown/unrecoverable owners, and snapshot every old Item from its
  own target-root projection before add. A failure cleans prepared snapshots and
  spawns no add.

### Execution and reconciliation

- One source batch uses one explicit target set. Shared uses ordered
  `--agent codex --agent claude-code` without `--copy`; Codex-only uses
  `--agent codex --copy`.
- Action commands use unpinned `skills@latest`. Scoped child env keeps
  `HOME`/`USERPROFILE` and `CLAUDE_CONFIG_DIR`; Codex-targeted adds set
  `CODEX_HOME=<home>/.agents`, so the managed body does not land in `.codex`.
- After all commands, call the shared cache's `refreshAndWait()` exactly once,
  including command failures that may have mutated state. Final installed Items
  come only from the refreshed `list -g --json` result.
- A submitted result is confirmed only when refreshed Items match source identity
  and cover the requested Agent/root projection. Exit zero or name-only presence
  is insufficient.
- Return to the install page with query, flat results, and cursor preserved.
  Confirmed results are unselected; missing/partial/unconfirmed results remain
  selected for retry.
- Replacement snapshots are retained until refreshed Items confirm the new key.
  One confirmed key cleans every snapshot tied to old owners for that new Item.
- Outcome summaries are parent-owned toasts; do not add a persistent page-local
  bottom summary.

### View behavior

- Entering the install page reuses the App detection cache and does not refresh.
  Refresh occurs on initial App detection, explicit `r`, or lifecycle
  reconciliation.
- Rows use `focusIndicator="leading"`; focused Checkbox brackets/title use the
  primary color without a full-card background. Disabled/installed/conflict titles
  keep normal text color, and fixed `titleRight` status/download content remains
  visible under long titles.
- Installed filter and remote search use the shared `SingleLineInput`; reducer
  synchronization handles both `onInput` and `onChange`, while page input owns
  Enter exactly once.

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Empty selection or empty targets | Reject before spawn |
| Search result cannot produce `source@skillName` | Disabled in UI and rejected defensively |
| Same source/name already installed | Show installed; not selectable |
| Different known source/name exists only outside selected target roots | No replacement confirmation for that Item; preserve it |
| Different known sources occupy both Shared target roots | Show two confirmation rows and create two snapshots |
| Target root is occupied by unknown provenance | Block automatic overwrite; require delete/reinstall |
| Two selected sources use one `skillName` | Reject whole submission before spawn |
| Unreported physical target path exists | Reject orphan overwrite before spawn |
| One source command fails | Record failure; continue later source batches; full refresh |
| Codex-only target | One Codex agent, `--copy`, `CODEX_HOME=.agents`; never `.codex` |
| Shared target | Ordered Codex then Claude Code, no `--copy` |
| Command exits zero but refreshed source/topology is incomplete | Keep selected and report unconfirmed |
| Refresh fails | Do not claim install/replacement success; retain retry selection/snapshots |

## 5. Good / Base / Bad Cases

- Good: `org/a@one`, `org/a@two`, and `org/b@three` become two sequential
  batches; the second still runs if the first fails.
- Good: source C to Shared finds source A in `.agents` and source B in `.claude`;
  confirmation lists both old instances and the service snapshots both before add.
- Good: source B to Codex-only finds source A in `.agents` and source C in
  `.claude`; only source A is in the transaction and source C stays unchanged.
- Base: Enter with no explicit picks snapshots the current selectable result as a
  one-item submission and opens one target Modal.
- Bad: disabling every same-name different-source search row before the target is
  known, or treating same name alone as installed.
- Bad: grouping visible rows by repo, running sources concurrently, using
  `.find()` for conflicts, or dispatching `action-done` before full detection.

## 6. Tests Required

- `verify-skills-view.mjs`: flat order, tuple identity, normalized source matching,
  explicit/select-all/singleton selection, snapshot cancellation, target-root
  conflict expansion, unique old-item keys, source batch order, failure
  continuation, and source/topology reconciliation.
- `verify-skills-adoption.mjs`: orphan preflight, same/unknown source blocking,
  other-root preservation, all-target preflight, multiple replacement snapshots,
  retained recovery paths, and confirmed cleanup.
- `verify-skills-render.mjs`: focused/disabled colors, leading/titleRight layout,
  source and target projection copy, Modal scrolling, shared input behavior, and
  narrow terminals.
- `verify-skills-installed-domain.mjs` and
  `verify-skills-shared-projection.mjs`: the installed facts consumed by this
  contract remain CLI-only and source-aware.
- `verify-async-detection.mjs`: awaited refresh returns the same final state sent
  to the cache sink.
- `verify-shortcuts.mjs`: Space/select-all/confirm/cancel bindings and footer text
  derive from `SKILLS_COMMANDS`.
- Finish with `bun run check` and `git diff --check`.

## 7. Wrong vs Correct

### Wrong

```ts
const occupied = installed.find(item => item.name === result.skillName);
if (occupied) showOneConflict(occupied);

await installSearchResultsToTargets(selected, targets);
dispatch({type: 'action-done'});
cache.refresh();
```

This collapses source identity, hides a second target-root owner, protects only one
old instance, and reports completion before refresh.

### Correct

```ts
const conflicts = pendingSourceReplacements(state); // one entry per old Item
dispatch({type: 'confirm-source-replacement'});

const execution = await installSearchResultsToTargets(
  pendingInstallResults(state),
  selectedTargets(state.installDraft),
  onProgress,
  exec,
  {installed: state.installed}
);

const finalState = await cache.refreshAndWait();
dispatch(reconcileInstallExecution(execution, finalState));
```

The UI and service use the same target-root ownership model, and only the complete
CLI refresh decides which selections and snapshots are confirmed.
