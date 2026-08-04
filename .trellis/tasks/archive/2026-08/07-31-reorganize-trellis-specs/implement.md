# Trellis Spec Reorganization Implementation Plan

## Preconditions

- 当前合并任务已获得用户批准并处于 `in_progress`；后续实现继续使用此 task。
- 实施由 Trellis implement agent 执行；开始时加载本任务 PRD、design、
  inventory、根 spec index 与 development workflow。
- 在任何移动前重新检查 `git status` 与两份已修改 installer spec 的 diff。

## 1. Establish Migration Baseline

- [x] 提取并保存根 `AGENTS.md` 的完整 Trellis 管理块用于最终逐字比较。
- [x] 记录全部大写 `AGENTS.md` / `CLAUDE.md`、spec 文件和旧路径引用。
- [x] 记录 `.trellis/spec/installer/platform-runtime.md` 与
      `windows-core.md` 的未提交增量，确认迁移后可逐项比较。

回滚点：此阶段只读，不改变工作区。

## 2. Create Project Layer And Move Business Contracts

- [x] 新建 `project/index.md`、`project/architecture.md`、
      `project/tui/index.md`。
- [x] 按 design 的映射移动 TUI 业务合同，保留正文后修复相对链接。
- [x] 将整个 installer 业务合同移动到 `project/installer/`，保留两份用户
      未提交增量。
- [x] 将 `migration-map.md` 移到 `project/migration-history.md`，更新目标路径。

回滚点：新旧路径映射是一对一的；不要在确认新文件完整前删除旧文件。

## 3. Rebuild Spec Navigation And Merge Agent Rules

- [x] 重写根 spec index 的 layer 表与 pre-development routing。
- [x] 精简 backend/frontend index，只保留工程层规则并链接 project 业务入口。
- [x] 更新 guides index/development workflow，合并 CodeGraph、工作区、issue、
      triage、domain 与开发流程规则。
- [x] 将根、TUI、installer、Windows core/steps Agent 指令中的项目边界、
      目录职责、命令和验证要求合并到唯一 owner，消除重复。

## 4. Remove Repository Agent Entrypoints

- [x] 将根 `AGENTS.md` 精确裁剪为迁移前 Trellis 管理块。
- [x] 删除根 `CLAUDE.md`。
- [x] 删除 `tui/`、`installer/`、`installer/windows/core/`、
      `installer/windows/steps/` 下的 `AGENTS.md` 与 `CLAUDE.md`。
- [x] 更新 `tui/README.md` 等当前导航，不修改用户全局规则功能说明或模板。

## 5. Migrate Executable References

- [x] 更新活跃任务中旧 spec path、已删除 Agent 入口和 `relatedFiles`。
- [x] 对全部 task `implement.jsonl` / `check.jsonl` 更新业务 spec path，随后
      验证每个 `file` 存在。
- [x] 保留 archive PRD/design/implement 正文的历史路径，不做无关历史重写。
- [x] 扫描当前文档、CI 与脚本，只有确实指向仓库 Agent/spec 入口的引用才改；
      用户级 `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` 保持不变。

## 6. Verify Migration

- [x] 文件扫描确认只剩根 `AGENTS.md`，且根内容与保存的 Trellis 块一致。
- [x] 运行 `python ./.trellis/scripts/get_context.py --mode packages`，确认 layer
      为 `backend, frontend, project`。
- [x] 验证 spec Markdown 相对链接、index 文件集和 task context manifest 路径。
- [x] 扫描 placeholder、旧 live path 和已删除 Agent 导航引用。
- [x] 运行当前任务 validate，并对受影响活跃任务做 context/path 检查。
- [x] 运行 `trellis update --dry-run` 与 `git diff --check`。
- [x] 比较 installer 两份用户改动在新路径中的 diff，确认无内容损失。
- [x] 最终审查仅包含本次文档/任务路径迁移与用户原有改动。

## 7. Normalize Document Language And Persist Rule

- [x] 将 `.trellis/spec/**/*.md` 的 H1-H6 和结构性表头恢复为 Trellis 英文，
      将标题以下的叙述正文改为简体中文，保持文件路径、标题层级、链接、代码块
      和结构性检查清单不变。
- [x] 将当前合并 task 的 `prd.md`、`design.md`、`implement.md`、`research/*.md`
      以及所有未归档 task、workspace、`docs/`、README 和 ADR（若存在）的正文
      改为简体中文，标题保持英文；不批量改写归档历史。
- [x] 在 `.trellis/spec/guides/development-workflow.md` 的
      `Project Documentation Language` 章节实际增加项目文档正文默认使用简体中文
      的长期规则，明确英文标题、技术标识、原文引用和上游托管块例外。
- [x] 扫描英文叙述残留并人工分类；不得用禁止 ASCII 的机械规则误报技术标识。
- [x] 重新运行 spec 链接、task manifest、Trellis layer、task validate、lint、
      typecheck、`trellis update --dry-run` 与 `git diff --check` 验证。
- [ ] 完成 TUI `bun run check`；该门禁通过后才能关闭完整质量检查。

环境限制：当前 Windows 环境没有 `zsh`/`sh`，因此 macOS shell probe 未执行；Windows
合同测试、lint、typecheck 与仓库级文档/路径门禁已通过；TUI `bun run check`
在 `tui/scripts/verify-self-update.mjs:544` 失败，断言持续收到字节时应重置无进展
计时器（`slowDownload.ok === false`）。该脚本与本任务没有文件变更，当前保留任务为
`in_progress`，不据此归档。

回滚点：中文化只改文案；如结构或可执行标识发生变化，恢复该文件翻译前正文，
保留已验证的路径迁移。

## Completion Gate

只有 PRD 的全部 acceptance criteria 都有文件扫描、路径验证和 Trellis/Git
命令证据时才完成。仅删除 Agent 文件或仅新建 `project/` 都不算完成。
