# Trellis Spec Reorganization Design

## 1. Target Model

保持 Trellis single-repo 配置，不引入 `packages`。目标树为：

```text
.trellis/spec/
├── index.md
├── backend/                   # 运行时工程层规则
├── frontend/                  # OpenTUI 工程层规则
├── guides/                    # 跨层工作方法
└── project/                   # claude-code-quickstart 业务合同
    ├── index.md
    ├── architecture.md
    ├── migration-history.md
    ├── tui/
    │   ├── index.md
    │   └── <ccq/TUI domain contracts>
    └── installer/
        ├── index.md
        └── <installer/runtime/build contracts>
```

`project` 是自定义 layer，不是 monorepo package。Trellis 会从一级目录自动
发现它；`tui` 与 `installer` 是该 layer 内由 index 管理的业务域。

## 2. Responsibility Boundaries

### Backend Engineering Layer

只描述实现后端/运行时代码时可复用的工程规则：目录与层级职责、错误模型、
诊断/脱敏、质量门禁。Index 可以把具体 ccq 领域修改路由到
`../project/tui/index.md`，但不再拥有业务合同正文。

### Frontend Engineering Layer

只描述 OpenTUI 的组件、布局、hook/effect、reducer、类型与渲染质量规则。
固定六菜单、Tools/Skills 交互和具体产品状态机进入 `project/tui/`。

### Guides Layer

拥有跨层工作方法。根 Agent 指令中的 CodeGraph-first、dirty worktree、main
checkout、任务/issue/triage/domain 文档导航并入 development workflow；
CodeGraph 规则保留“目录存在才使用、理解代码时优先于 grep/read、MCP/CLI
均可、失败后转直接证据”的完整语义。

### Project Business Layer

拥有产品边界和可执行领域合同：

- `architecture.md`：产品目标、平台、TUI/installer/contracts/Release 边界。
- `tui/`：ccq CLI、配置所有权、Provider/MCP/Tools/Skills、自生命周期、
  固定 shell/view 与 TUI 专用质量工具链。
- `installer/`：Windows/macOS runtime、Windows core/steps、build/Release。
- `migration-history.md`：OpenSpec/`.context` 的历史迁移与取舍。

## 3. Path Mapping

| Old Path | New Path |
|---|---|
| `.trellis/spec/backend/ccq-self-lifecycle.md` | `.trellis/spec/project/tui/ccq-self-lifecycle.md` |
| `.trellis/spec/backend/cli-contract.md` | `.trellis/spec/project/tui/cli-contract.md` |
| `.trellis/spec/backend/config-ownership.md` | `.trellis/spec/project/tui/config-ownership.md` |
| `.trellis/spec/backend/mcp-runtime.md` | `.trellis/spec/project/tui/mcp-runtime.md` |
| `.trellis/spec/backend/provider-config-safety.md` | `.trellis/spec/project/tui/provider-config-safety.md` |
| `.trellis/spec/backend/tool-lifecycle.md` | `.trellis/spec/project/tui/tool-lifecycle.md` |
| `.trellis/spec/backend/tui-quality-tooling.md` | `.trellis/spec/project/tui/quality-tooling.md` |
| `.trellis/spec/frontend/manage-shell-and-views.md` | `.trellis/spec/project/tui/manage-shell-and-views.md` |
| `.trellis/spec/frontend/skills-batch-install-contract.md` | `.trellis/spec/project/tui/skills-batch-install-contract.md` |
| `.trellis/spec/frontend/skills-lifecycle-contract.md` | `.trellis/spec/project/tui/skills-lifecycle-contract.md` |
| `.trellis/spec/frontend/tools-view-shortcut-contract.md` | `.trellis/spec/project/tui/tools-view-shortcut-contract.md` |
| `.trellis/spec/installer/index.md` | `.trellis/spec/project/installer/index.md` |
| `.trellis/spec/installer/platform-runtime.md` | `.trellis/spec/project/installer/platform-runtime.md` |
| `.trellis/spec/installer/windows-core.md` | `.trellis/spec/project/installer/windows-core.md` |
| `.trellis/spec/installer/steps.md` | `.trellis/spec/project/installer/steps.md` |
| `.trellis/spec/installer/build-release.md` | `.trellis/spec/project/installer/build-release.md` |
| `.trellis/spec/migration-map.md` | `.trellis/spec/project/migration-history.md` |

## 4. Instruction Migration

先以迁移前根 `AGENTS.md` 中的 Trellis 块作为不可变快照，再执行：

1. 将块外规则合并进上面的唯一 owner。
2. 将根 `AGENTS.md` 替换为该快照本身。
3. 删除根/目录 `CLAUDE.md` 和目录 `AGENTS.md`。
4. 更新 `tui/README.md` 等当前入口到 `.trellis/spec/`。

不保留 redirect `AGENTS.md` 或旧 spec stub，因为它们会继续形成第二入口并让
过时路径长期存在。

## 5. Reference Migration

- 更新 `.trellis/spec/**` 中全部 Markdown 相对链接。
- 更新当前文档、活跃任务的未来执行指令、`task.json.relatedFiles`。
- 对 `.trellis/tasks/**/implement.jsonl` 和 `check.jsonl` 做确定性的旧路径到新
  路径替换，包括 archive，以保证 context manifest 仍可加载。
- 归档 PRD/design/implement 正文保持历史原文；其旧路径是历史事实而非当前
  导航。
- 现有 CI 仅引用保留的 quality spec 时不产生无意义改动。

## 6. Compatibility And Safety

- 迁移只改文档、Trellis 任务元数据和导航，不改产品源码。
- 移动前记录 `git diff`；移动后比较两份未提交 installer spec 的正文，确保
  原有增量仍存在。
- `.trellis/.template-hashes.json` 不管理当前 spec 或仓库 Agent 文件，因此
  不需要修改哈希状态；`trellis update --dry-run` 用于确认平台托管文件没有
  意外漂移。
- `.trellis/config.yaml` 保持 single-repo；若 `get_context --mode packages`
  未识别 `project`，视为迁移失败，不通过增加 package 配置规避。

## 7. Verification

1. 文件集合：大写 `AGENTS.md` / `CLAUDE.md` 只剩根 `AGENTS.md`。
2. 根文件：与预先提取的 Trellis 块逐字一致，块外为空。
3. Trellis 发现：packages context 显示 `backend, frontend, project`。
4. 链接：扫描 `.trellis/spec/**/*.md` 的相对 Markdown 链接并验证目标存在。
5. Context：扫描所有 task JSONL 的 `file` 字段并验证目标存在。
6. 引用：当前文档、活跃任务和 manifest 不含旧 spec/Agent 路径。
7. 内容：新树无 placeholder；installer 未提交契约增量仍可在新路径 diff 中
   看到。
8. Trellis/Git：task validate、`trellis update --dry-run`、
   `git diff --check`。

## 8. Rollback

这是纯文档/路径迁移。若验证失败，回滚本任务新建/移动的路径映射和入口修改，
不触碰本任务开始前的 installer spec 与代码改动；根 Trellis 块快照用于恢复
入口文件，不依赖手工重写。

## 9. Document Language

- 保持 `.trellis/spec/` 的目录结构、文件名、英文标题层级、索引职责、相对链接
  和检查清单语义；只将标题以下的人类可读正文改为简体中文。
- Trellis 结构性标题和表格表头保持英文，例如 `Pre-Development Checklist`、
  `Quality Check`、`Goal` 和 `Acceptance Criteria`；不得把它们改成中文标题。
- 当前未归档的 task、research、workspace journal、`docs/`、README 和 ADR（若
  存在）沿用同一规则；归档 task/research 保留历史正文，不追溯批量翻译。
- 文件名、路径、命令、代码块、类型/API/协议名、CLI 参数和必要原文引用不
  翻译，避免改变可执行合同或检索关键字。
- 项目文档语言约束必须实际写入 `.trellis/spec/guides/development-workflow.md`
  的 `Project Documentation Language` 章节，并由该文件作为唯一长期 owner；
  根 `AGENTS.md` 的 Trellis 管理块属于上游托管内容，保持逐字不变。
