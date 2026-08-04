# Development Workflow Guide

本指南统一拥有仓库级开发与协作的长期规则。它不依赖已删除的 `.context/` 或
目录级 Agent 指令文件。

## Before Any Change

先提问并验证：

1. 这是真实的当前问题，还是历史问题或假设？
2. 哪个现有 contract、registry、parser、component 或 service 拥有它？
3. 哪些 caller、config field、platform 和用户工作流可能受到影响？

写入前先阅读相关工程层与项目层索引。

## CodeGraph First

仓库根目录存在 `.codegraph/` 时，在定位或理解代码前先使用 CodeGraph，而不是
直接使用 grep/find 或广泛读取文件。优先使用 `codegraph_explore` MCP 工具；
对应的 shell 命令为：

```sh
codegraph explore "<symbol names or question>"
```

需要当前带行号源码时，在查询中点名文件或 symbol。CodeGraph 能展示文本搜索
无法发现的 call path 与 dynamic-dispatch hop。目录不存在时跳过 CodeGraph。
探索失败时只诊断一次，随后改用直接源码、contract 与验证证据，不得依据旧计划
猜测。

## Repository Working Tree

- 常规开发直接在仓库的 `main` checkout 上进行。
- 未经用户明确授权，不得创建或进入 git worktree。
- 编辑重叠文件前检查当前 status 与 diff。
- 保留所有用户拥有、已有和无关的改动。不得因当前任务还原、覆盖、stage 或
  refactor 它们。
- 修改范围应聚焦请求所指向的 owner；只有拥有该行为的合同要求时才同步更新
  mirror contract 或 gate。

## Issue, Triage, And Domain Records

- Issue 与 PRD 存放在 GitHub issue 中，通过 `gh` 操作；遵循
  [`docs/agents/issue-tracker.md`](../../../docs/agents/issue-tracker.md)。
- 使用 [`docs/agents/triage-labels.md`](../../../docs/agents/triage-labels.md)
  记录的五个标准 triage label：`needs-triage`、`needs-info`、
  `ready-for-agent`、`ready-for-human`、`wontfix`。
- 领域记录采用一个根 `CONTEXT.md` 加 `docs/adr/`；遵循
  [`docs/agents/domain.md`](../../../docs/agents/domain.md)。

## Project Documentation Language

- 项目自有文档的叙述正文默认使用简体中文，包括但不限于 spec、task、
  research、journal 与 ADR。
- 文件名、路径、命令、代码、type/API/protocol 名、CLI flag 和其他技术标识
  保持其合同所需的原文；必要的上游原文引用也可保留。
- 上游托管 block 按其 owner 的要求保持原样，不得为了统一语言而改写。例如根
  `AGENTS.md` 的 Trellis 管理块必须逐字保留。
- Trellis 结构性标题和表格表头保持英文，例如 `Pre-Development Checklist`、
  `Quality Check`、`Goal` 与 `Acceptance Criteria`；正文说明使用简体中文。

## Feature

- 定义当前行为、目标行为与 non-goal。
- 追踪完整数据流与所有权边界。
- 使用现有模式实现最小且连贯的变更。
- 先添加 focused verification，再运行 typecheck 与完整领域门禁。
- contract 或 convention 发生变化时更新拥有它的 spec。

## Bug Fix

- 复现症状并确定根因。
- 行为可独立测试时先添加失败的 regression。
- 修复 owner，而不是下游展示症状。
- 运行 focused regression 与相关的更广泛门禁。
- 根因和预防规则可复用时，将其写入拥有该行为的 spec。

## Refactor

- 先建立通过的行为门禁。
- 保持步骤小且外部行为不变。
- 除非正确性要求，否则不要把广泛 rename/layout cleanup 与
  lifecycle/config 变更混在一起。

## Language And Safety Checks

- PowerShell：兼容 PS5.1、数组在 StrictMode 下安全、不使用仅 PS7 支持的语法。
- zsh/bash：引用展开值，沿用平台既有 condition/error 风格，不引入 Windows
  机制。
- TypeScript：使用 `const`/`let`、async/await 与显式结果，不吞掉主错误。
- Security：验证 trust boundary，日志和错误不得暴露 token、key 或机密 config
  source。

## Completion

- Focused test 通过。
- TUI 变更通过 `cd tui && bun run check`；本地运行前只 stage 预期的已跟踪
  `src/tests` 文件，或设置 `CCQ_FORMAT_BASE`，使 formatter 与 CI 检查同一边界。
- 与影响范围匹配的 typecheck、完整 verify、build 和 contract gate 通过。
- 已跟踪变更的 `git diff --check` 无错误。
- 用户拥有和无关的改动得到保留。
- Spec 与 index 匹配已实现合同；不得把未来 proposal 描述成当前行为。
