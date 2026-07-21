# Skills 扁平多选批量安装 — 实施计划

## 1. Preconditions and Safety

- [ ] Confirm the active Trellis task is `07-15-skills-flat-batch-install` and remains `planning` until artifact review is approved.
- [ ] Re-read `tui/AGENTS.md`, `.context/prefs/coding-style.md`, `.context/prefs/workflow.md`, and the relevant Trellis frontend/cross-layer indexes before code edits.
- [ ] Inspect `git diff` for every overlapping target file. Preserve the current dirty worktree, especially existing changes in `tui/AGENTS.md`; do not modify unrelated CLI/provider/self-update work.
- [ ] Load `trellis-before-dev` before the first code edit.

## 2. Red Tests First

- [ ] Extend `tui/scripts/verify-skills-view.mjs` with failing tests for:
  - flat result order retained with no repo grouping;
  - `(source, skillName)` selection identity;
  - Space toggle and deterministic selectable-only select-all;
  - installed rows and same-name conflicts cannot enter selection;
  - new search clears selection;
  - Enter singleton fallback versus explicit multi-selection;
  - target Modal snapshots one shared target draft;
  - install success, failure, partial success and detection failure all return to `install` with the required selection reconciliation.
- [ ] Add failing service tests asserting same-source coalescing, repeated `--skill`, first-seen source ordering, sequential execution, failure continuation, explicit target arrays and defensive duplicate-name rejection.
- [ ] Extend `tui/scripts/verify-async-detection.mjs` with a failing test for one awaited refresh updating and returning the same runner state.
- [ ] Extend `tui/scripts/verify-shortcuts.mjs` for the contextual Skills toggle/select-all/footer entries without hardcoded view hints.
- [ ] Run the focused red tests and record the expected failures before implementation.

## 3. Core Identity and Existing Action Reuse

- [ ] In `tui/src/core/skills.ts`, add the single owner for search-result identity and source-prefix-aware child-name extraction; keep existing consumers compatible.
- [ ] Add or expose typed helpers needed to match installed global names without duplicating parsing in state, service and view.
- [ ] Keep `tui/src/core/skills-actions.ts::installMultipleSkills()` as the one-source execution primitive; only adjust its exported input/result types if required.
- [ ] Preserve `installSkill`, update, uninstall, lock enrichment and shared projection behavior.

## 4. Batch Service Orchestration

- [ ] In `tui/src/services/skills-service.ts`, add a pure batch planner that groups exact sources in first-seen order and deduplicates names.
- [ ] Add the target-aware sequential executor that reuses `installMultipleSkills()`, applies one normalized Agent target set to every batch, records per-source outcomes, and continues after failure.
- [ ] Reject empty inputs, invalid identities and cross-source same-name conflicts without spawning commands.
- [ ] Reuse/extract the existing combined-agent target normalization used by `installResultToTargets()`; do not maintain two copies of the shared-body rule.
- [ ] Expose the batch method through `tui/src/views/skills-view-services.ts` without reading global `agentContext`.

## 5. Awaitable Detection Refresh

- [ ] In `tui/src/hooks/use-detection-cache.ts`, factor the current reset/run sequence into one internal async operation.
- [ ] Keep `refresh()` behavior compatible and add `refreshAndWait()` returning the final `DetectionState` for that run.
- [ ] Confirm Tools and existing Skills refresh callers continue to work when ignoring the new awaited method.
- [ ] Make batch postflight use this shared cache path exactly once; do not add a parallel direct `getInstalledSkills()` call.

## 6. Skills State Machine

- [ ] Add explicit picked and pending key collections, plus executing/reconciling batch stages, to `tui/src/state/skills-view-state.ts`.
- [ ] Add pure selectors for rendered install items, eligible selection, selected results and source/name conflicts.
- [ ] Make `search-done` clear previous choices while preserving the flat results contract.
- [ ] Implement Space toggle, selectable-only select-all and singleton Enter fallback.
- [ ] Snapshot the effective batch when opening the existing target Modal; Modal cancel must preserve explicit picks.
- [ ] Add install-specific execution-done, reconciled and reconcile-failed actions that always return to `install` and preserve query/results/cursor.
- [ ] On successful reconciliation, remove installed submitted items and keep still-missing submitted items selected.
- [ ] Leave generic `action-done`, update, uninstall and manage-install transitions unchanged.

## 7. Skills View and Shortcuts

- [ ] Update `tui/src/views/SkillsView.tsx` keyboard handling so query input, flat navigation, Space multi-select, contextual select-all, Enter batch target selection and `r` detection refresh remain unambiguous.
- [ ] Reuse the App-level installed-state cache when entering the install page; do not refresh on page entry. Keep initial App detection, explicit `r`, and batch postflight refresh, and block selection/submission until detection reaches success without blocking remote search/navigation.
- [ ] Render every result in original order with checkbox/disabled marker, source, description, selection state and installed/conflict badge.
- [ ] Use leading-only focus styling on the install list: active colors Checkbox brackets and title without a card background; keep non-active titles on normal text color, including disabled/conflict items, and top-align the leading marker.
- [ ] Ensure the shared Card leading layout renders `titleRight` with fixed width so Skills status/download count remains visible beside a shrinkable title.
- [ ] Normalize GitHub URL/SSH/`owner/repo` source forms only for installed-status comparison; preserve the lock source used by reinstall and keep true cross-repo same-name conflicts disabled.
- [ ] Reuse the current install-target Modal once per batch, showing the selected count while preserving Codex read-only/Claude Code toggle behavior.
- [ ] Await sequential execution, then await shared-cache refresh and dispatch atomic reconciliation.
- [ ] Keep the install page as the busy underlay and as the final page for all command/detection outcomes.
- [ ] Add an additive disabled state to the shared Checkbox only if the existing component cannot express the required marker without view-local duplication.
- [ ] Register new commands/bindings in `tui/src/config/keybindings.ts` and derive footer text through `tui/src/state/shortcuts.ts`.

## 8. Documentation and Decision Records

- [ ] Update only the Skills sections of `tui/AGENTS.md`, preserving unrelated dirty hunks.
- [ ] Ensure user-facing wording uses 已安装/未安装 and 安装/卸载; do not introduce 注入/解除 or cc/cx labels.
- [ ] Keep `.context/current/branches/main/session.log` decision entry aligned if implementation research changes the selected architecture.
- [ ] Do not change package scripts unless a genuinely new verification file is added; existing focused scripts are already part of `bun run verify`.

## 9. Focused Validation

- [ ] `cd tui && bun run scripts/verify-skills-view.mjs`
- [ ] `cd tui && bun run scripts/verify-skills-agent.mjs`
- [ ] `cd tui && bun run scripts/verify-skills-shared-projection.mjs`
- [ ] `cd tui && bun run scripts/verify-async-detection.mjs`
- [ ] `cd tui && bun run scripts/verify-shortcuts.mjs`
- [ ] `cd tui && bun run scripts/verify-manage-tui-state.mjs`
- [ ] `cd tui && bun run scripts/verify-agent-context.mjs`
- [ ] `cd tui && bun run typecheck`

## 10. Full Quality Gate and Manual Smoke

- [ ] Run `cd tui && bun run verify` after focused tests pass.
- [ ] Run `git diff --check` and inspect only task-owned diffs.
- [ ] Manual TTY smoke with one query containing multiple sources:
  - installed items remain visible and disabled;
  - Space and select-all affect only eligible items;
  - same-name cross-source choices cannot coexist;
  - one target Modal controls the whole batch;
  - source batches execute sequentially and continue after a failure;
  - all-success, all-failure and partial outcomes remain on the same install page;
  - successes become installed/unselected and failures remain selected;
  - new search clears old selection;
  - `r` refresh reconciles external changes.
- [ ] Review that no command output, error detail or progress message exposes credentials.

## 11. Review, Activation and Rollback Gate

- [x] Run the PRD convergence pass and verify `prd.md`, `design.md` and `implement.md` are mutually consistent.
- [ ] Obtain user review/approval of all planning artifacts.
- [ ] Only after approval, run the Trellis activation step (`task.py start`) and enter Phase 2.
- [ ] If implementation reveals a contract defect, return to Phase 1 and update artifacts before continuing.
- [ ] Rollback is file-level removal of the new selection/batch/awaited-refresh paths; no persistent migration or user data rollback is required.

## Context Mode

This Codex session uses the inline Trellis workflow. `implement.jsonl` and `check.jsonl` are not required before activation; Phase 2 must load `trellis-before-dev` instead.

## Execution Result - 2026-07-17

- 实现保持扁平结果、跨 source 多选、同 source 合并、串行失败隔离、单次目标 Modal 和 `refreshAndWait()` 最终对账。
- `verify-skills-view.mjs`、`verify-async-detection.mjs`、`verify-shortcuts.mjs`、Skills 回归门禁、`bun run typecheck` 和 `bun run verify` 全部通过。
- 安装页状态、窄终端布局与同名冲突已由纯状态和 OpenTUI 离屏门禁覆盖。
- 用户已授权完成并归档只剩验收的任务。
