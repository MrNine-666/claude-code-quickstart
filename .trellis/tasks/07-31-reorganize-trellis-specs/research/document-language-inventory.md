# Project Document Inventory

## Scan Context

扫描日期为 2026-08-03，仓库根目录为
`D:\SynologyDrive\project\claude-code-quickstart`。扫描使用 PowerShell 文件
枚举与 Markdown heading 匹配，并排除 `.git`、依赖、构建产物和 Trellis 备份。

## In-Scope Baseline

| Group | Count | Current evidence |
|---|---:|---|
| `.trellis/spec/**/*.md` | 37 | 包含根索引、`backend`、`frontend`、`guides` 和 `project` |
| 未归档 `.trellis/tasks/**/*.md` | 20 | 包含现有 planning/in-progress task 和本任务 |
| `.trellis/workspace/**/*.md` | 3 | workspace index、developer index、journal |
| `docs/**/*.md` | 3 | `docs/agents/` 协作说明 |
| Root/product README | 3 | `README.md`、`installer/README.md`、`tui/README.md` |
| `docs/adr/**/*.md` | 0 | 当前不存在 ADR 目录 |
| `CONTEXT.md` | 0 | 当前不存在根或子目录 domain context 文件 |

## Historical Or Managed Documents

- `.trellis/tasks/archive/**` 当前有 47 份 Markdown，其中包含 5 份历史 research；
  它们属于归档事实，本任务不追溯改写。
- `.agents/**`、`.claude/**`、`.trellis/workflow.md`、`.trellis/agents/**` 和
  `.trellis/.backup-*` 是 Trellis 托管内容，遵循各自 owner 的语言约束。
- `tui/contracts/templates/**` 是产品生成模板，不能把面向最终用户的规则文本
  当作本仓库 Agent 文档翻译。
- 根 `AGENTS.md` 当前只有 `<!-- TRELLIS:START -->` 到
  `<!-- TRELLIS:END -->` 的托管块，块内容作为不可变快照。

## Known Risks

- 上一轮 spec 移动和中文化是未提交工作区改动，Git HEAD 与当前文件集合不同；
  标题基线必须按旧路径/迁移记录恢复，不能用 HEAD 的文件存在性判断当前结构。
- Markdown 中的代码注释、shell 注释、表格分隔线和链接 fragment 可能被简单的
  正则误判；结构扫描必须跳过 fenced code block，并分别验证链接目标。
- 技术名和状态字面量中可能含有英文或 CJK；语言门禁必须允许明确列出的例外，
  不采用全文件 ASCII 比例作为通过条件。

## Planned Evidence

实施完成后应把最终文件清单、heading signature 对照、链接/围栏结果和 Trellis
命令输出追加到本任务记录或 session journal，保证后续任务可以复核范围而不是
依赖本次对话记忆。
