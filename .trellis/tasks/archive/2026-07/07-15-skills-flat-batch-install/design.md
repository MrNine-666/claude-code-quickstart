# Skills 扁平多选批量安装 — 技术设计

## 1. Summary

本设计在现有扁平 `skills find` 安装页上叠加多选能力，不恢复历史 repo 父子导航。搜索结果、已安装事实和多选状态在纯状态层合成可渲染 item；提交时 service 按 source 在内部生成顺序批次，同一 source 复用现有 `installMultipleSkills()` 单次传多个 `--skill`。所有命令完成后，通过一次可等待的全局检测刷新获得最终安装事实，再由 reducer 对账成功项与失败项，最终始终回到原安装页。

## 2. Existing Boundaries and Evidence

- `tui/src/core/skills.ts` owns `SearchSkillResult`, installed-list parsing, lock metadata and `SkillSharedRow` projection.
- `tui/src/core/skills-actions.ts:206` already owns one-source/many-skills execution through `installMultipleSkills()`.
- `tui/src/services/skills-service.ts` owns view-facing install orchestration; its current `installResultToTargets()` already normalizes the shared-body target rule.
- `tui/src/state/skills-view-state.ts` owns bounded Skills modes, result cursor, install target draft and return-page semantics.
- `tui/src/views/SkillsView.tsx` owns keyboard dispatch, rendering and detection-cache refresh orchestration.
- `tui/src/hooks/use-detection-cache.ts` owns the persistent App-level detection runner; its current `refresh()` is fire-and-forget, so it cannot safely drive post-install item reconciliation.
- `tui/scripts/verify-skills-view.mjs` already covers flat search results, target Modal invariants, multi-`--skill` action arguments and current install success returning to `list`.
- Commit `33df1d7` proves the reducer/list components can support multi-select, but its repo-grouping modes are intentionally obsolete after `2e77afd` and `4c84983`.

## 3. Invariants

1. User-visible search results remain one flat ordered list; no source grouping or reordering is introduced.
2. Global installed state comes from one unfiltered `skills list -g --json`, never from one command per item or Agent.
3. A Skill name is a global installation identity. Two sources with the same child Skill name cannot coexist in one selection or installation result.
4. Codex remains the read-only canonical-body target; Claude Code remains the optional symlink target. One batch uses one target draft.
5. Different source commands execute sequentially and failure-isolated; one failure never stops later sources.
6. Command exit codes describe source-command outcomes, but final installed-list detection owns per-Skill success truth.
7. New-install completion never uses the generic transition that resets the view to `list`; update, uninstall and manage transitions remain unchanged.
8. Busy input remains locked and no cancellation protocol is added.

## 4. Data Flow

```text
skills find <query>
        │
        ▼
flat SearchSkillResult[] ───────────────┐
                                        │
skills list -g --json                   │
        │                               │
        ▼                               ▼
SkillSharedRow[] ───────────────► install-page item projection
                                        │
                              Space / select-all
                                        │
                                        ▼
                              selected result keys
                                        │
                              one target Modal
                                        │
                                        ▼
                    service plans source-preserving batches
                                        │
                  source A: --skill a --skill b
                  source B: --skill c
                                        │ sequential, continue on failure
                                        ▼
                         refreshAndWait(global detection)
                                        │
                                        ▼
                     reducer reconciles submitted keys
                   success → installed + unselected
                   failure → still selected for retry
                                        │
                                        ▼
                              same flat install page
```

## 5. Core Contracts

### 5.1 Search-result identity

Add one shared identity helper next to `SearchSkillResult` ownership in `core/skills.ts`:

```ts
type SearchSkillIdentity = {
  readonly key: string;
  readonly source: string;
  readonly skillName: string;
};

function searchSkillIdentity(result: SearchSkillResult): SearchSkillIdentity | undefined;
```

- `skillName` uses the current source-prefix-aware extraction logic; the view must not reparse `owner/repo@skill` independently.
- `key` encodes the tuple `(source, skillName)` deterministically, for example with `JSON.stringify([source, skillName])`; a plain concatenation delimiter is avoided.
- The existing `skillNameFromSearchResult` consumer remains compatible through reuse/re-export rather than duplicate parsing.
- Invalid identities are not selectable and surface a friendly source-change error.

### 5.2 Install-page item projection

The Skills state layer derives rows from three facts: flat results, installed rows and selected keys.

```ts
type SearchInstallStatus =
  | 'available'
  | 'installed'
  | 'name-occupied'
  | 'selection-conflict';

type SearchInstallItem = {
  readonly result: SearchSkillResult;
  readonly identity?: SearchSkillIdentity;
  readonly status: SearchInstallStatus;
  readonly selected: boolean;
  readonly selectable: boolean;
};
```

Rules:

- Any installed `SkillSharedRow.name === identity.skillName` disables the result. Known source disagreement may render `name-occupied`; otherwise it renders `installed`. Eligibility does not depend on source comparison because the global destination is name-keyed.
- If another selected result has the same `skillName` but a different key, the unselected duplicate renders `selection-conflict` and cannot be selected.
- Select-all walks current result order and selects the first available result for each distinct Skill name; installed and colliding duplicates are skipped deterministically.
- New `search-done` replaces results and clears all selected/pending keys.

### 5.3 Batch execution result

Add view-independent service types:

```ts
type SkillsInstallBatch = {
  readonly source: string;
  readonly skillNames: readonly string[];
  readonly result: SkillsActionResult;
};

type SkillsBatchExecution = {
  readonly batches: readonly SkillsInstallBatch[];
};
```

The planner groups exact source strings in first-appearance order, deduplicates child names, and rejects global same-name conflicts defensively even if the UI invariant is bypassed.

`installSearchResultsToTargets()` derives the CLI Agent array once:

- Claude Code selected → `['cc', 'cx']` so the existing combined-agent symlink behavior is preserved.
- Claude Code not selected → `['cx']` for canonical body only.

It awaits each `installMultipleSkills()` call in order, records failure, and always continues to the next batch.

## 6. Detection and Reconciliation

### 6.1 Awaitable refresh

Extend `DetectionCache<Result>` additively with:

```ts
refreshAndWait(options?: DetectionRunOptions): Promise<DetectionState<Result> | undefined>;
```

Both `refresh()` and `refreshAndWait()` share one internal refresh routine. Existing fire-and-forget callers remain unchanged; Skills batch orchestration can await the exact runner generation that updates App-level cache state. This avoids:

- running a direct service detection and then a second cache refresh;
- reconciling against the previous `success` state before a new refresh starts;
- keeping a view-local result that becomes stale after remount.

### 6.2 Batch lifecycle

Extend the state machine with install-specific transitions rather than changing generic `action-done`:

```text
install
  └─ open target Modal → select-install-target
       └─ confirm → busy(executing, return=install)
            └─ commands done → busy(reconciling, return=install)
                 ├─ detection success → install
                 └─ detection error   → install
```

State adds:

- `pickedResultKeys`: explicit current-search selection.
- `pendingInstallKeys`: immutable submitted snapshot used through Modal/busy/reconciliation.
- `batchStage?: 'executing' | 'reconciling'`.
- optional source-command outcomes for summary/progress.

Behavior:

- Enter with explicit picks submits those picks; without picks it snapshots the current selectable item as a singleton without creating a hidden selection.
- Target Modal cancel clears only `pendingInstallKeys`; explicit picks remain.
- Successful detection projects the refreshed installed rows, removes submitted names now installed from `pickedResultKeys`, and retains submitted names still absent.
- Detection error returns to `install`, retains submitted keys as selected, and reports that final state could not be confirmed.
- Query, results and cursor are never reset by install-specific completion actions. `ScrollList` derives its visible position from the retained cursor.
- Opening the install page reuses the App-level detection cache and does not start a new command. Initial App detection, explicit `r`, and batch postflight refresh installed facts. While detection is not `success`, selection/submission is blocked, but remote search and list navigation may continue.

## 7. View and Keyboard Behavior

- Reuse the current `ScrollList`; do not add a grouped list or extra page.
- Add an additive disabled presentation to the shared `Checkbox` or render an equivalent shared leading marker:
  - available: `[ ]` / selected `[✓]`;
  - installed or conflict: `[—]` in muted color.
- Skills install rows use `ScrollList`'s leading-only focus indicator: active changes the `[` / `]` and title to the theme color without applying a card background. Non-active titles always use normal text color, including disabled/conflict rows; the leading marker stays on the first title line.
- `Card`'s leading layout must retain a shrinkable title region plus fixed `titleRight`; `titleRight` shows `● 已安装` or `● 同名已占用` together with download count, while descriptions and source text remain visible.
- Installed-source comparison canonicalizes GitHub repo URL/SSH forms and `owner/repo` shorthand before deciding `installed` versus `name-occupied`; raw lock `sourceUrl` remains unchanged for reinstall.
- Space toggles the current eligible result.
- A contextual select-all command selects only eligible, name-distinct results. It is registered in `SKILLS_COMMANDS` and footer shortcuts; query input focus continues to consume printable characters first.
- Enter opens one target Modal for the effective selection and includes the item count in its title. The existing two Agent rows and Codex no-op toggle are unchanged.
- Busy continues to ignore all keyboard input.

## 8. Error and Outcome Presentation

- Existing progress callback events remain the only command-progress channel; no direct `console.log` is introduced.
- Each source batch emits a source-scoped start and final message.
- The final summary distinguishes installed-after-refresh, still-missing, and unconfirmed items.
- A nonzero command followed by an installed final row counts as per-Skill success; a zero command without the final row counts as failure.
- On detection failure, command outcomes may be shown as diagnostic context but are not promoted to per-Skill success.
- Existing friendly network/permission/not-found messages and bounded progress history remain in force.

## 9. Compatibility and Documentation

- Keep `installSkill()` and the current installed-list management API for existing callers.
- Replace or redirect the dormant `installMultipleSkillsForView(agentContext)` adapter; the batch view path must accept explicit target arrays and never read hidden Header context.
- Do not restore `groupByRepo()`/`listRepoSkills()` into the view. They may remain as tested compatibility helpers unless a later cleanup proves zero consumers.
- Update `tui/AGENTS.md` Skills constraints and current verification comments to document flat multi-select, internal source batching and install-page retention.
- Do not broaden this task into correcting unrelated historical OpenSpec drift or the existing dirty provider/CLI/self-update worktree changes.

## 10. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Same-name results overwrite a global Skill identity | Block installed names and mutually exclude same-name selections across sources; service validates defensively. |
| A source command partially writes before returning failure | Reconcile against one final unfiltered installed detection rather than exit code. |
| Detection refresh races with stale cache success | Await the exact shared runner refresh via `refreshAndWait()`. |
| One source failure prevents unrelated installs | Sequential loop records failure and continues. |
| Successful install resets the page | Dedicated batch-completion actions preserve install state; generic actions stay unchanged. |
| Shared detection-cache API affects Tools | Add a new method while retaining existing `refresh()` behavior; cover async detection regression. |
| Dirty worktree overlaps docs/shared files | Inspect each diff before editing, patch only task-owned hunks, and avoid package-script churn where existing verify entries suffice. |

## 11. Rollback Shape

The feature stores no persistent TUI selection state and introduces no migration. Rollback consists of removing the new state/actions/view bindings and batch adapter while leaving the pre-existing one-source `installMultipleSkills()` helper intact. The additive detection-cache method can also be removed without changing stored data or external CLI formats.
