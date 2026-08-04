# Migrate Agent Guidance, Reorganize Trellis Specs, and Normalize Project Documents

## Goal

将仓库级和目录级 `CLAUDE.md` / `AGENTS.md` 中的长期规则迁移到
`.trellis/spec/`，让 Trellis 成为唯一的项目规范来源。迁移完成后只保留根
`AGENTS.md`，且其内容精确为现有 `<!-- TRELLIS:START -->` 至
`<!-- TRELLIS:END -->` 管理块。

同时重组 spec：保留 Trellis 通用的 `backend/`、`frontend/`、`guides/`
层，将 ccq、OpenTUI 产品行为和 installer/Release 等项目业务契约集中到新增
`project/` layer。

## Background

- 仓库处于 Trellis single-repo 模式；`get_context.py --mode packages` 当前
  识别 `backend`、`frontend`、`installer` 三个 layer，并将 `guides` 作为共享
  指南排除在 layer 列表之外。
- Trellis 的 layer 扫描会识别 `.trellis/spec/` 下的一级目录，因此
  `project/` 是受支持的自定义 layer，不需要把它配置成 monorepo package。
- 仓库当前有 5 个大写 `AGENTS.md` 和 5 个大写 `CLAUDE.md`；所有
  `CLAUDE.md` 仅包含 `@AGENTS.md`。
- `backend/` 与 `frontend/` 混合了通用工程规则和 ccq 业务合同，另有独立的
  `installer/` layer。现有 Agent 指令又重复了一部分产品边界、目录职责和
  验证命令。
- 两份 installer spec 当前有用户未提交改动：
  `installer/platform-runtime.md` 与 `installer/windows-core.md`。迁移必须逐字
  保留这些工作区改动，再调整新位置下的链接。
- TUI 运行时管理的 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md` 及
  `tui/contracts/templates/` 是产品功能，不是本仓库 Agent 指令文件。

## Requirements

- R1: 删除根 `CLAUDE.md`、所有目录级 `CLAUDE.md` 和所有目录级
  `AGENTS.md`；根 `AGENTS.md` 只保留原有完整 Trellis 管理块，不保留
  CodeGraph、项目介绍、导航或其他正文。
- R2: 被删除指令文件中的有效规则必须在 `.trellis/spec/` 中有唯一、可发现的
  归属；不得通过复制制造新的冲突来源。
- R3: 新建 `.trellis/spec/project/` layer，并按 `tui/`、`installer/` 业务域
  组织 ccq 产品合同；`backend/`、`frontend/` 只保留跨业务功能可复用的层级
  工程规则，`guides/` 保留跨层工作方法。
- R4: 更新 `.trellis/spec/index.md` 和各层 index，使 Pre-Development
  Checklist 能从工程层规则路由到相应 `project/` 业务合同。
- R5: 保留所有现有 spec 的有效内容，包括未提交 installer 契约；移动后修复
  相对链接、旧路径描述和迁移映射，不借机改写产品行为。
- R6: 更新当前文档、CI、活跃任务和所有 `implement.jsonl` / `check.jsonl`
  中作为可执行上下文使用的旧 spec 路径。归档任务的叙述性 PRD/design/
  implement 文本保留为历史记录，不做语义重写。
- R7: `README.md` 中描述用户全局规则文件的内容、TUI 规则管理源码和
  `tui/contracts/templates/` 保持不变；它们不属于本次仓库指令迁移。
- R8: 不修改 `.trellis/config.yaml` 的 package 配置；single-repo 下新增
  `project` layer 应由现有扫描逻辑自动发现。
- R9: 保留用户所有无关工作区改动，不创建 worktree，不进行顺手重构。
- R10: 在不改变目录层级、索引职责、检查清单和链接结构的前提下，将
  `.trellis/spec/**/*.md` 的标题和结构性标签恢复为 Trellis 英文，将叙述正文改为
  简体中文。
- R11: 当前未归档的项目 Markdown（包括 task、research、workspace journal、
  `docs/`、README 和 ADR（若存在））正文使用简体中文，标题保留 Trellis/既有
  英文；归档任务正文继续作为历史记录，不追溯改写。
- R12: 在 `.trellis/spec/guides/development-workflow.md` 实际增加项目文档语言
  约束：以后新增或修改的项目自有文档正文默认使用简体中文，包括但不限于
  spec、task、research、journal 和 ADR；标题与结构性标签保持 Trellis 英文。
- R13: 文件名、路径、命令、代码块、类型/API/协议名、CLI 参数和必要的原文
  引用保持原样；上游托管块按其所有者要求保留，其中根 `AGENTS.md` 的 Trellis
  管理块必须逐字不变。

## Acceptance Criteria

- [x] 仓库中排除依赖/缓存后，大写指令文件只剩根 `AGENTS.md`。
- [x] 根 `AGENTS.md` 与迁移前的 Trellis 管理块逐字一致，块外无内容。
- [x] `.trellis/spec/` 只暴露 `backend`、`frontend`、`project` 三个
  single-repo layer 和共享 `guides`；旧 `installer` layer 不再存在。
- [x] `project/index.md` 能路由到 `project/tui/index.md`、
  `project/installer/index.md`、项目架构与迁移历史。
- [x] ccq CLI/config/Provider/MCP/Tools/Skills/self-lifecycle/OpenTUI shell
  等业务合同位于 `project/tui/`；installer/runtime/build/Release 合同位于
  `project/installer/`。
- [x] Backend/frontend index 只列工程层规则，并明确链接对应 project 业务入口。
- [x] Agent 指令中的 CodeGraph、工作区、issue/triage/domain、目录职责、开发
  命令、平台边界和验证规则均已合并到唯一 spec owner，没有丢失有效约束。
- [x] 两份已有未提交 installer spec 改动在新路径中完整保留。
- [x] 活跃任务和全部任务 context manifest 不引用已删除的 spec/Agent 路径；
  当前仓库文档也不把被删除的目录级 Agent 文件当作入口。
- [x] `python ./.trellis/scripts/get_context.py --mode packages` 输出包含
  `project` layer。
- [x] Markdown 相对链接和 context manifest 文件路径均存在，且无模板占位符。
- [x] `trellis update --dry-run`、相关 task validate、`git diff --check` 通过。
- [x] `.trellis/spec/**/*.md` 的 H1-H6 和表格表头保持 Trellis 英文，叙述正文为
  简体中文；技术标识和原文例外不被误译。
- [x] 当前未归档项目 Markdown（task、research、workspace、`docs/`、README、ADR
  若存在）的标题保持英文、正文使用简体中文；归档任务历史正文未被批量改写。
- [x] `.trellis/spec/guides/development-workflow.md` 直接包含后续项目自有文档
  正文使用简体中文的约束，覆盖 spec、task、research、journal 和 ADR，并且
  没有第二个冲突 owner。
- [x] 翻译前后的 In Scope 文件集合、标题层级、代码块、链接目标、表格列数和
  结构性检查清单保持一致，Trellis layer 发现与 task context 加载仍通过。

## Out Of Scope

- 修改 ccq/TUI/installer 的运行时代码或用户可见行为。
- 删除或改写 `tui/contracts/templates/` 中面向最终用户的全局规则模板。
- 把当前 single-repo 人为改造成 Trellis monorepo packages。
- 重写归档任务的历史需求、设计结论或完成记录。
- 处理本任务开始前已有的 installer 代码问题或其他活跃任务。
- 追溯翻译其他既有或归档任务、Trellis 自带 workflow/skill 模板及第三方文档。
- 翻译可能影响执行含义的文件名、路径、命令、代码、类型/API/协议名、CLI
  参数或上游托管块。
