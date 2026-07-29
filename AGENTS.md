<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call -- the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely -- indexing is the user's decision.
<!-- CODEGRAPH_END -->

# claude-code-quickstart

Windows 10/11 与 macOS 12+ 的 CLI Agent 开发环境安装器。安装入口只负责
NodeJS、Git 和 `ccq`；Claude Code、Codex 及周边工具的生命周期由根级
OpenTUI 管理控制台承接。

## 当前边界

- `tui/`：Bun `>=1.2.0` + OpenTUI，菜单固定为工具管理、供应商、
  配置文件、全局规则、MCP、Skills。
- `installer/`：Windows PowerShell 5.1+ 与 macOS zsh 安装链。
- `installer/contracts/`：安装链步骤、构建和清理契约。
- `tui/contracts/`：TUI 运行时契约；运行所需内容内嵌进单文件可执行产物。
- Release 固定包含两个安装脚本、四个平台 raw 可执行文件和四个对应 gzip
  自更新资产，共十个 artifact。
- Linux 支持尚未实现，不属于当前运行时或 Release 契约。

## 规范导航

长期可执行规范统一存放在 `.trellis/spec/`，`AGENTS.md` 只提供平台
启动与目录导航。

| 修改范围 | 必读入口 |
|---|---|
| TUI core/service/CLI/config | [Backend specs](.trellis/spec/backend/index.md) |
| OpenTUI view/component/state/keybinding | [Frontend specs](.trellis/spec/frontend/index.md) |
| installer/contracts/build/Release | [Installer specs](.trellis/spec/installer/index.md) |
| 功能、修复、重构或跨层决策 | [Development guides](.trellis/spec/guides/index.md) |
| OpenSpec/`.context` 迁移取舍 | [Migration map](.trellis/spec/migration-map.md) |

目录级入口：

- [tui/AGENTS.md](tui/AGENTS.md)
- [installer/AGENTS.md](installer/AGENTS.md)
- [installer/windows/core/AGENTS.md](installer/windows/core/AGENTS.md)
- [installer/windows/steps/AGENTS.md](installer/windows/steps/AGENTS.md)

## 常用命令

```sh
cd tui
bun run dev
bun run typecheck
bun run verify
bun run build
```

```sh
zsh installer/macos/Install.zsh --list-steps
sh installer/build.sh --check
```

```powershell
pwsh -File installer/windows/Install.ps1 -ListSteps
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/build.ps1
```

## 工作区规则

- 修改前先读目标层 spec；有 `.codegraph/` 时先用 CodeGraph 理解代码。
- 常规开发直接使用 `main` checkout；除非用户明确授权，不创建或进入
  git worktree。
- 保留用户已有和无关改动，不做顺手重构。
- 根 `openspec/` 与 `.context/` 已迁移并删除，不再作为当前规范来源。
- 共享 Trellis 规范、任务、工作流和配置纳入版本控制；运行时、缓存和个人
  workspace 保持本地。

## Agent skills

### Issue tracker

Issues 与 PRD 以 GitHub issue 形式存放，通过 `gh` CLI 操作。详见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个标准 triage 标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文布局：根级 `CONTEXT.md` + `docs/adr/`。详见 `docs/agents/domain.md`。

<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
