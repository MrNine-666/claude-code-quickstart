# Skills Single-Entity Topology and Source Replacement Contract

## 1. Scope / Trigger

Read this contract before changing Skills detection, physical storage classification, the installed-list management Modal, Claude projection repair, same-name source replacement, or postflight reconciliation.

This contract complements `skills-batch-install-contract.md`: the batch contract owns flat search selection and ordinary new installs; this file owns existing-content preservation and replacement safety.

## 2. Signatures

```ts
inspectSkillStorage(
  name: string,
  options?: SkillStorageOptions
): Promise<SkillStorageInspection>;

createSkillSnapshot(
  sourcePath: string,
  name: string,
  options?: SkillStorageOptions
): Promise<SkillSnapshot>;

transitionSkillTopology(
  skill: SkillSharedRow,
  target: 'claude-only' | 'codex-only' | 'shared',
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  options?: SkillStorageOptions
): Promise<SkillsAdoptionResult>;

runSkillsAdd(input: {
  source: string;
  skillNames: readonly string[];
  agents: readonly AgentContext[];
  copy?: boolean;
  env?: NodeJS.ProcessEnv;
}, onProgress?: ProgressCallback, exec?: SkillsExecFn): Promise<SkillsCommandDiagnostic>;

runSkillsRemove(input: {
  skillNames: readonly string[];
  agents: readonly AgentContext[];
  env?: NodeJS.ProcessEnv;
}, onProgress?: ProgressCallback, exec?: SkillsExecFn): Promise<SkillsCommandDiagnostic>;

repairClaudeProjection(
  skill: SkillSharedRow,
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  options?: SkillStorageOptions
): Promise<SkillsAdoptionResult>;

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

`SkillStorageKind` is:

```ts
'shared-symlink' | 'shared-copy' | 'claude-only' | 'canonical-only'
| 'invalid-link' | 'conflict' | 'invalid' | 'missing'
```

`SkillSnapshot` contains `{root, skillPath, manifest}`. `SkillsAdoptionResult.outcome` is `complete | partial | restored | failed`. `partial` and `restored` are non-success results. Its `mutated` flag is true once an official add/remove may have started, regardless of the final outcome. Replacement entries with a retained snapshot include `recoveryPath`.

## 3. Contracts

- Detection runs one `skills list -g --json` command, then performs read-only filesystem inspection. It must not run a second list command or mutate storage.
- When storage inspection is present, `projectSharedSkills()` derives Codex availability from a valid `~/.agents/skills/<name>` canonical and Claude availability from a valid Claude path. CLI `agents` is only the compatibility fallback when storage is absent.
- Official `skills` may return only `Claude Code` in `agents` after a successful two-Agent local add, even though canonical exists. Never hide Codex availability solely because the badge omitted Codex.
- Strict Claude-only means a valid real Claude directory and no physical canonical object. A CLI badge alone is only a candidate.
- Browsing, page entry, automatic detection, and `r` refresh never adopt, copy, move, link, or repair Skills.
- The only successful topologies are C = Claude real directory only, X = canonical real directory only, and B = canonical real directory plus Claude symlink/junction projection. Two real copies are never B.
- C/X/B and recoverable `shared-copy` rows initialize two editable management targets. A non-no-op draft enters `confirm-topology-change`; zero targets are rejected with guidance to use `d`; exact C/X/B no-op closes without snapshot, process, or refresh.
- ccq may copy validated content into an OS temp directory. Only the official CLI may create, replace, or remove objects below `.agents/skills` or `.claude/skills`.
- Every target-tree mutation uses official `skills@latest` (no pinned minor). C materialization uses Claude Code plus `--copy`; X uses Codex plus `--copy`; B uses ordered Codex then Claude Code without `--copy`.
- All topology child processes set `HOME`, `USERPROFILE`, and `CLAUDE_CONFIG_DIR=<home>/.claude`. Codex add and every topology targeted remove also set `CODEX_HOME=<home>/.agents`. This includes `remove --agent claude-code`: without `CODEX_HOME`, the official CLI may decide canonical is unused and delete it during B -> X.
- Transition order is fixed:

  | Transition | Official CLI sequence |
  |---|---|
  | C -> X | remove Claude; require `missing`; add Codex `--copy` |
  | C -> B | ordered add `[codex, claude-code]` |
  | X -> C | remove Codex; require `missing`; add Claude `--copy` |
  | X -> B | ordered add `[codex, claude-code]` |
  | B -> C | remove `[claude-code, codex]`; require `missing`; add Claude `--copy` |
  | B -> X | remove Claude only with scoped Codex env; do not add/rewrite X |

- A valid canonical plus Claude real copy is `partial`, not complete. Keep both copies and offer projection repair.
- After a mutation failure, perform at most one official-CLI recovery: targeted cleanup of C/X, then rebuild the original topology from the same snapshot. Manifest-equivalent recovery returns non-success `restored` and cleans the snapshot; failed recovery retains `recoveryPath`.
- `SkillSharedRow` preserves raw `agents` plus `otherAgents`. A target C transition is blocked before spawn when explicit third-party agents remain; other transitions only target Claude Code/Codex.
- Local-source adoption must not invent remote provenance. Real CLI smoke leaves global lock absent for local sources; the UI therefore exposes no remote update source.
- Same-source or unknown-source rows stay disabled regardless of whether storage is Claude-only, canonical-only, shared-copy, or fully shared; physical shape alone never enables install-page migration. Only a valid recoverable row with a known, provably different source becomes `source-replacement` and displays exactly `已有同名`; invalid/conflict rows remain blocked.
- Source replacement order is snapshot old content -> direct official add -> filesystem and lock postflight -> optional Claude-only remove. Never remove first.
- Add or postflight failure must not run the optional remove. Preserve the old-content snapshot and report its path.
- Re-read storage and lock after the optional targeted remove; its successful exit may still delete the global lock.
- A successful service postflight does not clean the old-content snapshot. Only keys confirmed by the final shared detection may call `cleanupConfirmedReplacementSnapshots()`.
- Every result with `mutated=true`, including failed adoption or repair, uses the shared detection cache's `refreshAndWait()` once. Preflight/no-op results with `mutated=false` do not refresh. Exit code alone never confirms success.
- Raw Skills CLI stdout/stderr remains available only in `SkillsCommandDiagnostic`; normal TUI error text must use the structured friendly error or a fixed fact-reconciliation fallback because the CLI can write its normal interactive renderer to stderr even on exit 0.
- New-install and replacement X targets use `--copy` with scoped `CODEX_HOME=~/.agents`; they must not materialize under `~/.codex/skills`. Rows without final lock/source cannot run single-item remote update.
- The installed filter and remote search use the shared `SingleLineInput`: stable real OpenTUI `<input>`, controlled `value`, reducer synchronization, no `onSubmit`. OpenTUI 0.4.2 emits live edits through `onInput` and committed changes through `onChange`, so both feed the same normalizer while Enter remains owned by the page handler exactly once.

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Unsafe name or invalid/missing `SKILL.md` frontmatter | Return `invalid`; spawn nothing |
| Broken or root-escaping internal symlink | Return `invalid`; snapshot/install blocked |
| Claude real valid directory, canonical absent | `claude-only`; management may offer Codex adoption |
| Canonical valid, Claude absent | `canonical-only`; repair may stage canonical without lock source |
| Canonical valid, Claude points to canonical | `shared-symlink`; complete |
| Canonical and Claude real directories with equal manifests | `shared-copy`; partial and retryable |
| Two real directories with different manifests | `conflict`; no automatic write |
| Search name absent from CLI rows but physical path exists | Reject before add; do not overwrite orphan storage |
| Installed source equals normalized search source | Disabled installed row |
| Installed source missing | Disabled; never guess replacement eligibility |
| Known old/new sources differ and old storage is recoverable | Selectable `source-replacement`; require strong confirmation |
| Replacement add fails | Keep old projections and recovery snapshot; continue later source batches |
| Replacement lock/filesystem postflight fails | Do not remove Claude projection; keep recovery snapshot |
| Targeted remove succeeds but deletes the new lock | Mark replacement unconfirmed and keep recovery snapshot |
| Windows link creation falls back to copy | `partial`; Codex remains installed and Claude copy remains usable |
| Both target trees lose valid content during adoption | `failed` with retained `recoveryPath` |
| Command exits non-zero but required intermediate/final facts and manifest match | Continue/complete by facts; retain command output as diagnostics |
| Command exits zero but storage/manifest does not match | Fail target and attempt one recovery |
| Recovery restores original topology and manifest | `restored`, `success=false`, clean snapshot |
| Recovery cannot prove original topology and manifest | `failed`, keep snapshot and expose path |
| Target C with explicit third-party Agent | Block before snapshot/spawn |
| B -> X remove without scoped `CODEX_HOME` | Forbidden; official CLI can delete canonical as apparently unused |

## 5. Good / Base / Bad Cases

- Good: a hand-maintained Claude-only Skill is staged outside both target trees, installed through the official CLI, verified as canonical plus Claude symlink, then reconciled once.
- Good: replacing `old/repo@same` with `new/repo@same` snapshots old content, adds `new/repo`, verifies new lock source, then removes Claude only when Claude was not selected.
- Good: B -> X calls only targeted Claude removal with `CODEX_HOME=~/.agents`, then proves X manifest is unchanged.
- Good: Windows/Linux input keymap adds Ctrl+A/Z/Y/Shift+Z while macOS uses native Command bindings; copy/cut reuse OSC52 feedback.
- Base: a normal missing Skill still follows the flat batch install contract and does not enter adoption or replacement confirmation.
- Base: cancelling the management Modal, topology confirmation, or replacement confirmation spawns no process and writes no file.
- Bad: treating `agents.includes('Codex')` as the only canonical fact.
- Bad: direct `rename`, `rm`, `symlink`, or copy under either target tree from ccq code.
- Bad: `remove` before replacement `add`, or cleanup after a failed postflight.
- Bad: treating two same-name rows as replaceable when the old source is unknown.
- Bad: omitting `CODEX_HOME` because the remove target contains only Claude Code.
- Bad: rebuilding B -> X with another add, which unnecessarily rewrites canonical content.

## 6. Tests Required

- `verify-skills-adoption.mjs`:
  - all storage kinds, invalid frontmatter, broken/escaping links;
  - temp-root containment and snapshot byte/manifest verification;
  - exact two-Agent add arguments and absence of `--copy`;
  - complete, partial, failed, and retained recovery snapshot outcomes;
  - canonical-only repair without lock source;
  - six directed C/X/B transitions, three no-ops, ordered commands, scoped env, and manifest preservation;
  - exit/fact quadrants, one-shot restored/failed recovery, snapshot cleanup/retention, third-party blocking;
  - replacement add -> postflight -> remove ordering, post-remove lock loss, detection-confirmed snapshot cleanup, orphan preflight.
- `verify-skills-shared-projection.mjs`:
  - one CLI call plus storage enhancement;
  - physical canonical overrides a missing Codex badge;
  - compatibility projections without storage still use `agents`.
- `verify-skills-view.mjs`:
  - disabled same/unknown-source rows and selectable `source-replacement`;
  - exact `已有同名` text;
  - `confirm-topology-change` and `confirm-source-replacement` cancellation paths;
  - C/X/B/shared-copy editable drafts, zero-target rejection, and no-op closure;
  - old/new source, target, canonical, and lock impact text.
- `verify-skills-render.mjs`: drive both real OpenTUI inputs for cursor insertion, newline-stripped paste, selection/cut, undo/redo, single Enter ownership, and narrow layout.
- Run `verify-skills-agent.mjs`, `verify-shortcuts.mjs`, TypeScript typecheck, and the full `bun run verify` gate.
- `test-skills-topology-smoke.mjs`: isolated temporary HOME against official `skills@latest`, all six transitions, all no-ops, X canonical location, and B single entity.

## 7. Wrong vs Correct

### Wrong

```ts
if (row.agents.includes('Claude Code') && !row.agents.includes('Codex')) {
  await rename(row.path, canonicalPath);
  await symlink(canonicalPath, claudePath);
}
```

This mutates during detection, trusts badges as physical facts, bypasses Windows fallback, and duplicates upstream storage behavior.

### Correct

```ts
const storage = await inspectSkillStorage(row.name);
if (storage.kind !== 'claude-only') return blocked(storage.error);

// Only after explicit management intent and strong confirmation:
const target = targetTopologyOfDraft(draft);
if (target === 'empty') return blocked('use d for full uninstall');
const result = await transitionSkillTopology(row, target, onProgress);
const finalState = result.mutated ? await cache.refreshAndWait() : undefined;
```

The inspector is read-only, the service stages content outside target trees, the official CLI owns target writes, and final UI state comes from postflight facts.
