# Domain Docs

本文说明工程技能在探索代码库时应如何使用本仓库的领域文档。

## Before Exploring, Read These

- 仓库根目录的 **`CONTEXT.md`**；或者
- 如果根目录存在 **`CONTEXT-MAP.md`**，它会为每个 context 指向一份
  `CONTEXT.md`。读取与当前主题相关的每一份文件。
- **`docs/adr/`**：读取涉及即将修改区域的 ADR。在多 context 仓库中，还要检查
  `src/<context>/docs/adr/` 中限定于该 context 的决策。

如果其中任何文件不存在，**直接继续**。不要把缺失报告为问题，也不要预先建议创建；
`/domain-modeling` 技能（可由 `/grill-with-docs` 与
`/improve-codebase-architecture` 进入）会在术语或决策真正确定后按需创建它们。

## File Structure

单 context 仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多 context 仓库（根目录存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the Glossary's Vocabulary

输出中提到领域概念时（例如 issue 标题、重构提案、假设或测试名称），使用
`CONTEXT.md` 定义的术语。不要改用 glossary 明确排除的同义词。

如果需要的概念尚未出现在 glossary 中，这本身就是一个信号：要么你正在创造项目
并未使用的语言（应重新考虑），要么确实存在缺口（记录给 `/domain-modeling`）。

## Flag ADR Conflicts

如果输出与现有 ADR 冲突，应明确指出，不得静默覆盖：

> _与 ADR-0007（event-sourced orders）冲突，但值得重新打开，因为……_
