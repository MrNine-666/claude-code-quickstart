# Agent Guidance and Spec Inventory

## Trellis Structure Evidence

- `.trellis/config.yaml` 未声明 `packages`，当前是 single-repo 模式。
- `.trellis/scripts/common/packages_context.py::_scan_spec_layers()` 扫描
  `.trellis/spec/` 的一级目录，并仅特殊排除 `guides`。因此新增
  `.trellis/spec/project/` 会成为正常的自定义 layer；其内部可以通过
  `project/index.md` 导航到 `tui/` 与 `installer/` 子目录。
- Trellis 并不保留或强制 `project` 这个名称，但本仓库用它隔离业务合同与
  backend/frontend 工程规则，符合本地 spec 自定义模型。

## Repository Instruction Files

需要迁移并删除：

- `CLAUDE.md`
- `tui/AGENTS.md`
- `tui/CLAUDE.md`
- `installer/AGENTS.md`
- `installer/CLAUDE.md`
- `installer/windows/core/AGENTS.md`
- `installer/windows/core/CLAUDE.md`
- `installer/windows/steps/AGENTS.md`
- `installer/windows/steps/CLAUDE.md`

需要裁剪但保留：

- `AGENTS.md`：只保留原 `<!-- TRELLIS:START -->` / `<!-- TRELLIS:END -->`
  块。

所有 `CLAUDE.md` 当前都只有 `@AGENTS.md`，所以其有效内容来自对应
`AGENTS.md`，不需要单独创建转发 spec。

## Content Ownership

| Existing Content | Target Location |
|---|---|
| 根项目简介、支持平台、TUI/installer/contracts/Release 边界 | `project/architecture.md` |
| 根与 TUI/installer 规范导航 | `.trellis/spec/index.md`、`project/**/index.md` |
| CodeGraph-first、保留工作区改动、main checkout、issue/triage/domain 文档 | `guides/development-workflow.md` |
| TUI 目录边界、固定菜单、开发/编译验证 | `project/tui/index.md` 与现有工程层 index |
| Installer 目录边界、平台职责、调试构建 | `project/installer/index.md` 与业务合同 |
| Windows core 加载顺序、PS5.1/StrictMode/替换规则 | `project/installer/windows-core.md` |
| Windows active steps、Registry fallback、双平台同步 | `project/installer/steps.md` |
| OpenSpec/`.context` 迁移记录 | `project/migration-history.md` |

## Existing Spec Classification

保留在 `backend/`：

- `directory-structure.md`
- `error-handling.md`
- `logging-guidelines.md`
- `quality-guidelines.md`

保留在 `frontend/`：

- `component-guidelines.md`
- `directory-structure.md`
- `hook-guidelines.md`
- `quality-guidelines.md`
- `state-management.md`
- `type-safety.md`

移动到 `project/tui/`：

- `backend/ccq-self-lifecycle.md`
- `backend/cli-contract.md`
- `backend/config-ownership.md`
- `backend/mcp-runtime.md`
- `backend/provider-config-safety.md`
- `backend/tool-lifecycle.md`
- `backend/tui-quality-tooling.md`
- `frontend/manage-shell-and-views.md`
- `frontend/skills-batch-install-contract.md`
- `frontend/skills-lifecycle-contract.md`
- `frontend/tools-view-shortcut-contract.md`

移动到 `project/installer/`：

- `installer/platform-runtime.md`
- `installer/windows-core.md`
- `installer/steps.md`
- `installer/build-release.md`

其他移动：

- `migration-map.md` -> `project/migration-history.md`

## Reference Consumers

- `.trellis/spec/**` 自身 index 与交叉链接。
- `tui/README.md` 的目录规范入口。
- 活跃任务 `07-21-fix-nvm-non-ascii-user-path`、
  `07-22-add-linux-installer-support`、`07-30-installer-locked-file-replace`、
  `07-31-installer-replace-residue-cleanup`。
- `.trellis/tasks/**/implement.jsonl` 与 `check.jsonl` 中的可执行上下文路径，
  包括归档任务 manifest。
- `.github/workflows/tui-quality.yml` 当前仅引用计划保留的 backend/frontend
  quality spec，不需要路径迁移。

归档任务的 PRD/design/implement 正文记录的是当时路径和决策，保留历史原文；
manifest 是后续可加载的路径元数据，应统一迁移到新路径。

## Explicit Exclusions

- `README.md` 中 `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` 用户功能说明。
- `tui/src/**` 中对用户级规则文件的读写逻辑。
- `tui/contracts/templates/**` 中面向安装用户的推荐规则。
- `.agents/skills/trellis-meta/references/platform-files/agents.md` 等小写
  reference 文档。
