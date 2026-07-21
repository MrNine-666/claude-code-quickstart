# Skills Flat Batch Install Contract

## 1. Scope / Trigger

Read this contract before changing the Skills search/install page, search-result identity, batch service, detection cache, install reducer actions, or install-page shortcuts. The user-visible list stays flat even though execution may be split internally by source.

## 2. Signatures

```ts
searchSkillIdentity(result: SearchSkillResult): SearchSkillIdentity | undefined;
skillSourcesEquivalent(left: string, right: string): boolean;
planSkillInstallBatches(results: readonly SearchSkillResult[]): readonly SkillsInstallPlanBatch[];
installSearchResultsToTargets(
  results: readonly SearchSkillResult[],
  targets: readonly AgentContext[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn
): Promise<SkillsBatchExecution>;

DetectionCache<Result>['refreshAndWait']:
  (options?: DetectionRunOptions) => Promise<DetectionState<Result> | undefined>;

ScrollListProps['focusIndicator']?: 'card' | 'leading';
```

Reducer-owned install fields are `pickedResultKeys`, `pendingInstallKeys`, and `batchStage`. Install completion uses `install-execution-done`, `install-reconciled`, or `install-reconcile-failed`; it must not use generic `action-done`.

## 3. Contracts

- `SearchSkillIdentity.key` is `JSON.stringify([source, skillName])`; selection identity includes source, while global installation occupancy is keyed by `skillName`.
- Entering the install page reuses the current App-level detection cache and must not call `refresh()`. Refresh only on initial App detection, explicit `r`, a real lifecycle mutation, or batch postflight reconciliation.
- Skills install rows set `focusIndicator="leading"`. Active state colors the Checkbox `[` / `]` and title with `colors.primary`, but must not apply a focused card background. Non-active titles use `colors.text`, including disabled, installed, and conflict rows; the leading marker is fixed to the first title line.
- `Card` with `leading` must render the same fixed `titleRight` region as the non-leading layout. The title region may shrink, but status and download count must remain visible.
- Installed status compares sources through `skillSourcesEquivalent()`: GitHub HTTPS/SSH forms and `owner/repo` shorthand for the same repo are equivalent. Preserve the original lock `sourceUrl` for reinstall; only the comparison is canonicalized.
- The planner preserves first-seen source order, coalesces same-source names into repeated `--skill` arguments, and deduplicates exact identities.
- Different source batches execute sequentially and continue after a failed batch. One batch uses one explicit target set; no hidden Header context is read.
- Batch target B uses ordered `--agent codex --agent claude-code` without `--copy`; target X uses `--agent codex --copy`. Both run with scoped `HOME`/`USERPROFILE`, `CLAUDE_CONFIG_DIR=<home>/.claude`, and `CODEX_HOME=<home>/.agents`, so X always materializes at canonical `~/.agents/skills` rather than `~/.codex/skills`.
- The install target Modal snapshots the effective selection into `pendingInstallKeys`. Cancelling clears only the snapshot; explicit picks remain.
- After all commands, call the shared cache's `refreshAndWait()` exactly once. Final installed rows, not process exit codes, determine per-Skill success.
- Every install outcome returns to `install` with query, flat results, and cursor preserved. Confirmed successes are unselected; missing or unconfirmed items remain selected.
- Installation outcome summaries are parent-owned toasts; the Skills page does not render a persistent bottom summary line.
- Replaying `installed-loaded` with the same name/source/topology facts is selection-idempotent. The cache effect must not erase retry selections retained by `install-reconciled`; a later topology change may reconcile them normally.

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Empty selection or empty targets | Reject before spawning a command |
| Result cannot produce `source@skillName` identity | Render disabled and reject defensively in service |
| Same `skillName` from different sources | UI marks conflict; service rejects before spawn |
| Installed name already exists | Keep the row traversable, mark installed/occupied, and disable selection |
| Detection is idle/loading/error | Search/navigation remain available; selection and submission are blocked |
| Re-entering with a successful App cache | Render cached installed facts without a new `skills list` request |
| Active row | Color Checkbox brackets and title with the theme color; add no card background; keep leading on the title line |
| Non-active disabled, installed, or conflict row | Keep title on normal text color |
| Leading Checkbox plus long title | Shrink/clip the title region and preserve the fixed status/download `titleRight` region |
| Lock source `https://github.com/owner/repo.git`, search source `owner/repo` | Treat as the same source and show installed |
| Same Skill name from different normalized repos | Show name occupied and keep disabled |
| One source command fails | Record the failure and continue later source batches |
| Codex-only target | One Codex agent, explicit `--copy`, scoped `CODEX_HOME=~/.agents`; final storage must be `canonical-only` |
| Claude + Codex target | Ordered Codex then Claude Code, no `--copy`; final storage must be `shared-symlink`, while `shared-copy` remains non-success partial |
| Postflight detection fails | Do not claim success; return to install and preserve submitted selection |

## 5. Good / Base / Bad Cases

- Good: `org/a@one`, `org/a@two`, `org/b@three` becomes two sequential calls; the first has two `--skill` arguments and the second still runs if the first fails.
- Base: Enter with no explicit picks snapshots the current selectable item as a one-item batch and opens one target Modal.
- Good: lock source `https://github.com/langchain-ai/langchain-skills.git` matches search source `langchain-ai/langchain-skills` and renders `已安装`.
- Bad: grouping the visible list by repo, using a full-card active background, bottom-aligning the leading marker, muting disabled titles, comparing raw source strings, dropping `titleRight` from a leading Card, installing different sources concurrently, reading `agentContext` inside the batch service, or dispatching `action-done` after a new install.

## 6. Tests Required

- `verify-skills-view.mjs`: flat order, tuple identity, installed/conflict disabling, active/non-active title colors, top-aligned leading focus, GitHub source equivalence, leading `titleRight` status/download rendering, Space/select-all, singleton Enter, Modal snapshot, sequential source execution, B/X command arguments and scoped env, failure continuation, and all success/failure/partial/detection-error reconciliation.
- `verify-async-detection.mjs`: awaited refresh returns the same final state object written by the runner sink.
- `verify-shortcuts.mjs`: Space/select-all bindings and footer labels derive from `SKILLS_COMMANDS`.
- Regression gates: `verify-skills-agent.mjs`, `verify-skills-shared-projection.mjs`, `verify-manage-tui-state.mjs`, `verify-agent-context.mjs`, and TypeScript typecheck.

## 7. Wrong vs Correct

### Wrong

```ts
for (const result of selected) {
  await installSkill(result);
}
dispatch({type: 'action-done'});
cache.refresh();
```

This repeats fetches, leaks source grouping into execution order, resets to the installed-list page, and claims success before final detection.

### Correct

```ts
const execution = await installSearchResultsToTargets(selected, targets, onProgress);
dispatch({type: 'install-execution-done'});
const finalState = await cache.refreshAndWait();
dispatch(finalState?.status === 'success'
  ? {type: 'install-reconciled', installed: projectSharedSkills(finalState.result ?? [])}
  : {type: 'install-reconcile-failed', error: finalState?.error ?? '检测未完成'});
```
