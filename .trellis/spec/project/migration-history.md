# OpenSpec and `.context` Migration Map

此文件记录迁移时的去重决策。根 `openspec/` 与 `.context/` 已于
2026-07-18 在迁移完成后删除；下列名称仅用于追溯来源和取舍，不取代目标
code spec，也不表示对应源文件仍存在。

## Classification

- **已吸收**：需求仍由当前源码/契约证明，已整理进对应 Trellis spec。
- **部分吸收**：仅迁移当前已经实现并验证的部分。
- **已取代**：描述的是已经删除的实现，不进入当前规范。
- **仅计划**：仍是 proposal/plan，不写成当前事实。

## OpenSpec Main Specs

| OpenSpec capability | Classification | Trellis destination / decision |
|---|---|---|
| `ccq-executable-distribution` | 已吸收 | `project/installer/build-release.md`、`project/tui/ccq-self-lifecycle.md` |
| `ccq-multitool-cli` | 已吸收 | `project/tui/cli-contract.md` |
| `codex-profile-management` | 已吸收 | `project/tui/provider-config-safety.md`、`project/tui/config-ownership.md` |
| `codex-tool-lifecycle` | 已吸收 | `project/tui/tool-lifecycle.md` |
| `config-file-ownership` | 已吸收 | `project/tui/config-ownership.md`、`project/tui/manage-shell-and-views.md` |
| `core-runtime-ux` | 部分吸收 | 当前 process/error/status 规则归入工程与项目合同；旧 Manage/update-manifest 流程已取代 |
| `global-rules-multitool` | 已吸收 | `project/tui/config-ownership.md`、`project/tui/manage-shell-and-views.md` |
| `install-bootstrap-tools-handoff` | 已吸收 | `project/installer/platform-runtime.md` |
| `macos-support` | 部分吸收 | 当前 zsh/Homebrew/nvm/install.sh 规则归入 installer spec；installer 侧 Agent/Manage 步骤已取代 |
| `manage-entry` | 部分取代 | 旧 `Manage.ps1`/`Manage.zsh` 生命周期已删除；当前入口为 `tui/src/index.tsx` |
| `manage-tui-shell` | 已吸收 | `frontend/manage-shell-and-views.md`、frontend state/component spec |
| `mcp-manager-core` | 部分吸收 | 当前 vault/runtime 语义归入 `project/tui/mcp-runtime.md`；旧菜单/规则生成排除 |
| `mcp-multitool` | 已吸收 | `project/tui/mcp-runtime.md` |
| `mcp-tui` | 已吸收 | `project/tui/mcp-runtime.md`、`project/tui/manage-shell-and-views.md` |
| `provider-core` | 部分取代 | installer 侧 Provider 模块已删除；当前 TUI profile 规则归入 Provider/config spec |
| `provider-manager` | 部分取代 | 原子写入和字段所有权保留；Profile injection/locks、六 Provider 数量和旧结构排除 |
| `provider-official-settings` | 已吸收 | `project/tui/provider-config-safety.md` |
| `provider-tui` | 已吸收 | Provider 安全与 frontend component/state 约定 |
| `skills-manager` | 部分吸收 | 当前官方 CLI/search/update/uninstall 行为归入 Skills 合同；catalogue 时代行为排除 |
| `skills-multitool` | 已吸收 | `project/tui/skills-lifecycle-contract.md` |
| `skills-tui` | 已吸收 | 两份 frontend Skills 合同 |
| `step-modules-alignment` | 部分吸收 | 当前 NodeJS/Git step 接口归入 `project/installer/platform-runtime.md`；已删除 Advanced steps 排除 |
| `testing-documentation` | 已吸收 | backend/frontend/installer 质量门禁 |
| `tui-build-runtime` | 部分吸收 | OpenTUI/Bun/单文件行为归入 installer/frontend spec；`manage/`、`source/`、根 `contracts/`、Ink 与 tgz 声明已取代 |
| `update-manager` | 部分吸收 | 当前 tool snapshot/cache/update 流程归入 `project/tui/tool-lifecycle.md`；旧 Profile JS、manifest 与 dry-run manager 排除 |
| `update-stop-config-rules-detection` | 已吸收 | `project/tui/config-ownership.md`、`project/tui/tool-lifecycle.md` |
| `update-tui` | 已吸收 | `project/tui/tool-lifecycle.md`、frontend 工程 spec |
| `windows-structure-migration` | 已吸收 | `project/installer/platform-runtime.md`、`project/installer/build-release.md` |
| `wrapper-architecture` | 已取代 | `manage.js`、remote wrapper cache 与 Profile `ccq` function 已删除 |

## OpenSpec Changes at Migration Time

| Change | Current state | Migration decision |
|---|---|---|
| `add-trellis-tool` | 进行中；registry/lifecycle gate 已实现，手动/构建验收仍待完成 | 源码证明的 registry 与 `fully-shared-no-inject` 行为写入 `project/tui/tool-lifecycle.md`；不把待验收内容声明为完成 |
| `shared-resource-injection-ui` | 进行中；大部分 projection/UI task 已实现 | 仅将当前源码和 verify script 可见的行为写入 Tools/MCP/Skills spec |
| `add-linux-platform-support` | 仅 proposal，没有 task | 仅保留计划状态。Installer/Release spec 明确保持 Windows/macOS 当前范围 |

归档 change 的 delta spec 在主规范已覆盖或已被源码取代时不重复复制；原目录现已删除。

## Migrated `.context` Sources

| Source | Migration decision |
|---|---|
| `prefs/coding-style.md` | scope control、显式错误、PS/shell/TS 规则、测试与机密处理迁移到 layer quality spec 和 `guides/development-workflow.md` |
| `prefs/workflow.md` | red/green 修复流程、修改前问题、回归检查与无假设规则迁移到 `guides/development-workflow.md` |
| `current/plans/ccq-cli-subcommands.md` | 当前 launch/management verb 行为迁移到 `project/tui/cli-contract.md` |
| `current/plans/simplify-nodejs-remove-fnm.md` | 仅当前 runtime-first provider 行为迁移到 `project/installer/platform-runtime.md`；过时迁移目标排除 |
| `current/branches/main/plan-tui-revamp.md` | 当前 shell、共享组件与 footer 所有权迁移到 frontend spec |
| `plan-flex-height-unify.md` | 当前 flex 所有权与禁止手算高度迁移到 component/view spec |
| `plan-prompts-view-first.md`、`plan-prompts-workspace.md` | 当前 Global Rules 文件所有权、内嵌 editor 与 dirty-edit protection 迁移到 config/view spec |
| `plan-provider-form-radio-json.md` | 当前 FormPanel/Radio/textarea 与严格保存行为迁移到 component/provider spec |
| `plan-skills-symlink-install.md`、`plan-skills-view-revamp.md` | 由较新的可执行 Skills batch/topology 合同取代 |
| `plan-terminal-theme-adaptive.md` | 仅当前 theme-token 与 source/compiled 行为迁移到 frontend spec |
| `history/commits.*`, `current/**/session.log*` | 未复制进 code spec；按用户要求随旧 `.context/` 一并删除 |

## AGENTS.md Bootstrap Consolidation

2026-07-18 首次将各级 `AGENTS.md` 中仍有效的长期约束迁入 Trellis。2026-07-31
完成唯一入口收敛：根 `AGENTS.md` 只保留 Trellis 管理块，根和目录级
`CLAUDE.md` 以及目录级 `AGENTS.md` 删除；CodeGraph、工作区协作和仓库导航
由 current specs 直接拥有。

| Original entry | Trellis destination |
|---|---|
| 根 `AGENTS.md` 的 Trellis 块外内容 | `spec/index.md`、`spec/project/architecture.md`、`spec/guides/development-workflow.md` |
| 历史 `tui/AGENTS.md` | `spec/project/tui/index.md`、backend/frontend 工程索引 |
| 历史 `installer/AGENTS.md` | `spec/project/installer/index.md` |
| 历史 `installer/windows/core/AGENTS.md` | `spec/project/installer/windows-core.md` |
| 历史 `installer/windows/steps/AGENTS.md` | `spec/project/installer/steps.md` |

## Explicitly Excluded Historical Claims

- Root `manage/` 或 `manage/source/` 作为当前 TUI 实现。
- Ink、Node-run TUI、`manage-tui.tgz`、`ManageCore.*`、`manage.js` 或远程 wrapper 缓存。
- 根 `contracts/`；所有权已拆分到 `installer/contracts/` 与 `tui/contracts/`。
- 由 installer 管理 Provider/MCP/Skills/Claude Code 生命周期。
- 注入 Profile 的 `ccq` 函数或带版本的 wrapper URL。
- 在实现落地前加入 Linux 二进制、Linux installer runtime 或八个 Release artifact。
