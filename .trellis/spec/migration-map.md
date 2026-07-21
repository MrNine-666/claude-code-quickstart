# OpenSpec and `.context` Migration Map

此文件记录迁移时的去重决策。根 `openspec/` 与 `.context/` 已于
2026-07-18 在迁移完成后删除；下列名称仅用于追溯来源和取舍，不取代目标
code spec，也不表示对应源文件仍存在。

## Classification

- **Absorbed**：需求仍由当前源码/契约证明，已整理进对应 Trellis spec。
- **Partially absorbed**：仅迁移当前已经实现并验证的部分。
- **Superseded**：描述的是已经删除的实现，不进入当前规范。
- **Planned only**：仍是 proposal/plan，不写成当前事实。

## OpenSpec Main Specs

| OpenSpec capability | Classification | Trellis destination / decision |
|---|---|---|
| `ccq-executable-distribution` | Absorbed | `installer/build-release.md`, `backend/ccq-self-lifecycle.md` |
| `ccq-multitool-cli` | Absorbed | `backend/cli-contract.md` |
| `codex-profile-management` | Absorbed | `backend/provider-config-safety.md`, `backend/config-ownership.md` |
| `codex-tool-lifecycle` | Absorbed | `backend/tool-lifecycle.md` |
| `config-file-ownership` | Absorbed | `backend/config-ownership.md`, `frontend/manage-shell-and-views.md` |
| `core-runtime-ux` | Partially absorbed | Current process/error/status rules go to backend/installer specs; old Manage/update-manifest flow is superseded |
| `global-rules-multitool` | Absorbed | `backend/config-ownership.md`, `frontend/manage-shell-and-views.md` |
| `install-bootstrap-tools-handoff` | Absorbed | `installer/platform-runtime.md` |
| `macos-support` | Partially absorbed | Current zsh/Homebrew/nvm/install.sh rules go to installer specs; installer-side Agent/Manage steps are superseded |
| `manage-entry` | Superseded in part | Old `Manage.ps1`/`Manage.zsh` lifecycle is deleted; current entry is `tui/src/index.tsx` |
| `manage-tui-shell` | Absorbed | `frontend/manage-shell-and-views.md`, frontend state/component specs |
| `mcp-manager-core` | Partially absorbed | Current vault/runtime semantics go to `backend/mcp-runtime.md`; old menu/rules generation is excluded |
| `mcp-multitool` | Absorbed | `backend/mcp-runtime.md` |
| `mcp-tui` | Absorbed | `backend/mcp-runtime.md`, `frontend/manage-shell-and-views.md` |
| `provider-core` | Superseded in part | Installer-side Provider modules were deleted; current TUI profile rules live in Provider/config specs |
| `provider-manager` | Superseded in part | Atomic writes and field ownership remain; Profile injection/locks, six-provider count, and old shapes are excluded |
| `provider-official-settings` | Absorbed | `backend/provider-config-safety.md` |
| `provider-tui` | Absorbed | Provider safety plus frontend component/state conventions |
| `skills-manager` | Partially absorbed | Current official CLI/search/update/uninstall behavior goes to Skills contracts; catalogue-era behavior is excluded |
| `skills-multitool` | Absorbed | `frontend/skills-lifecycle-contract.md` |
| `skills-tui` | Absorbed | Both frontend Skills contracts |
| `step-modules-alignment` | Partially absorbed | Current NodeJS/Git step interface goes to `installer/platform-runtime.md`; deleted Advanced steps are excluded |
| `testing-documentation` | Absorbed | backend/frontend/installer quality gates |
| `tui-build-runtime` | Partially absorbed | OpenTUI/Bun/single-file behavior goes to installer/frontend specs; `manage/`, `source/`, root `contracts/`, Ink and tgz claims are superseded |
| `update-manager` | Partially absorbed | Current tool snapshots/cache/update flow goes to `backend/tool-lifecycle.md`; old Profile JS, manifest and dry-run manager are excluded |
| `update-stop-config-rules-detection` | Absorbed | `backend/config-ownership.md`, `backend/tool-lifecycle.md` |
| `update-tui` | Absorbed | `backend/tool-lifecycle.md`, frontend state/component specs |
| `windows-structure-migration` | Absorbed | `installer/platform-runtime.md`, `installer/build-release.md` |
| `wrapper-architecture` | Superseded | `manage.js`, remote wrapper cache and Profile `ccq` function were deleted |

## OpenSpec Changes at Migration Time

| Change | Current state | Migration decision |
|---|---|---|
| `add-trellis-tool` | In progress; registry/lifecycle gates implemented, manual/build acceptance remains | Source-proven registry and `fully-shared-no-inject` behavior included in `backend/tool-lifecycle.md`; pending acceptance is not declared complete |
| `shared-resource-injection-ui` | In progress; most projection/UI tasks implemented | Only behavior visible in current source and verify scripts is included in Tools/MCP/Skills specs |
| `add-linux-platform-support` | Proposal only, no tasks | Planned only. Installer/Release specs explicitly retain Windows/macOS current scope |

归档 change 的 delta spec 未在主规范已覆盖或源码已替代时重复复制；原目录现已删除。

## Migrated `.context` Sources

| Source | Migration decision |
|---|---|
| `prefs/coding-style.md` | Scope control, explicit errors, PS/shell/TS rules, tests and secret handling moved into layer quality specs and `guides/development-workflow.md` |
| `prefs/workflow.md` | Red/green fix flow, pre-change questions, regression checks and no-assumption rule moved to `guides/development-workflow.md` |
| `current/plans/ccq-cli-subcommands.md` | Current launch/management verb behavior moved to `backend/cli-contract.md` |
| `current/plans/simplify-nodejs-remove-fnm.md` | Only current runtime-first provider behavior moved to `installer/platform-runtime.md`; obsolete migration goals excluded |
| `current/branches/main/plan-tui-revamp.md` | Current shell, shared components and footer ownership moved to frontend specs |
| `plan-flex-height-unify.md` | Current flex ownership and no manual height arithmetic moved to component/view specs |
| `plan-prompts-view-first.md`, `plan-prompts-workspace.md` | Current Global Rules file ownership, embedded editor and dirty-edit protection moved to config/view specs |
| `plan-provider-form-radio-json.md` | Current FormPanel/Radio/textarea and strict save behavior moved to component/provider specs |
| `plan-skills-symlink-install.md`, `plan-skills-view-revamp.md` | Replaced by the newer executable Skills batch/topology contracts |
| `plan-terminal-theme-adaptive.md` | Only current theme-token and source/compiled behavior moved to frontend specs |
| `history/commits.*`, `current/**/session.log*` | 未复制进 code spec；按用户要求随旧 `.context/` 一并删除 |

## AGENTS.md Bootstrap Consolidation

2026-07-18 将各级 `AGENTS.md` 中仍有效的长期约束迁入 Trellis；入口文件保留
目录范围、平台启动说明、CodeGraph 规则和 spec 路由。所有同级 `CLAUDE.md`
继续只包含 `@AGENTS.md`，不复制第二份规则正文。

| Original entry | Trellis destination |
|---|---|
| root `AGENTS.md` | `spec/index.md`, backend/frontend/installer indexes, `guides/development-workflow.md` |
| `tui/AGENTS.md` | `spec/backend/**`, `spec/frontend/**`, `spec/installer/build-release.md` |
| `installer/AGENTS.md` | `spec/installer/platform-runtime.md`, `spec/installer/build-release.md` |
| `installer/windows/core/AGENTS.md` | `spec/installer/windows-core.md` |
| `installer/windows/steps/AGENTS.md` | `spec/installer/steps.md` |

## Explicitly Excluded Historical Claims

- Root `manage/` or `manage/source/` as the current TUI implementation.
- Ink, Node-run TUI, `manage-tui.tgz`, `ManageCore.*`, `manage.js`, or remote wrapper caching.
- Root `contracts/`; ownership is split between `installer/contracts/` and `tui/contracts/`.
- Installer-managed Provider/MCP/Skills/Claude Code lifecycle.
- Profile-injected `ccq` functions or versioned wrapper URLs.
- Linux binaries, Linux installer runtime, or eight Release artifacts before implementation lands.
