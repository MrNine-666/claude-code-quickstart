# Runtime Quality Guidelines

## Required Patterns

- 变更范围保持在拥有该行为的 domain；不要把 cleanup refactor 与 behavior
  change 混在一起。
- 添加 constant 或 helper logic 前搜索当前 registry/contract。
- 使用明确名称与 discriminated union；避免无类型的 cross-layer cast。
- Trust-boundary validation 留在 core/parser code，并由 CLI/TUI 复用。
- 行为可隔离时，修复 bug 前先用失败的 regression 覆盖它。
- 绝不能仅为通过变更而删除 verification assertion、降低 coverage。

## Forbidden Patterns

- 在 view 或 help text 中复制 tool/MCP/Provider/Skills list。
- 已有 structural parser 拥有格式时，用 regex 或临时行替换解析 JSON/TOML。
- 从 React view 直接写 config。
- 在 primary operation 周围使用空 catch。
- 记录原始 secret 或 child-process credential argument。
- 假设 exit code zero 能证明最终 filesystem/runtime state。

## Verification Matrix

| Area | Minimum focused gate |
|---|---|
| CLI argv/help/exit 行为 | `bun scripts/verify-cli-subcommands.mjs` |
| Provider/Codex 配置 | `verify-provider-safety.mjs`、`verify-codex-*.mjs`、`verify-toml-edit.mjs` |
| MCP | `verify-mcp-parity.mjs`、`verify-mcp-multitool.mjs`、`verify-mcp-shared-projection.mjs` |
| Tools | `verify-tools-*.mjs`、`verify-codegraph-lifecycle.mjs`、`verify-ccgworkflow-codex.mjs` |
| Skills | 两份 Skills contract 中列出的 gate |
| 自生命周期（Self lifecycle） | `verify-self-update.mjs`、`verify-cli-uninstall.mjs`、Windows native/helper smoke |

所有 runtime 变更最终运行：

```sh
cd tui
bun run check
```

`bun run check` 统一负责 format check、lint、TypeScript、Bun test 与完整旧版
`verify` 链。迭代时运行 focused check，但不得用手选子集替代 aggregate gate。
其可执行合同见 [TUI 质量工具链](../project/tui/quality-tooling.md)。

已跟踪 source 变更运行 `git diff --check`。修改 compile、embedded asset、
platform 或 Release 行为时，构建全部四个 executable target。

## Review Checklist

- [ ] Spec/contract owner 明确，且没有第二个事实来源。
- [ ] Missing、corrupt、partial、cancelled 与 non-TTY 案例均已覆盖。
- [ ] Mutation 后根据事实完成 final state reconciliation。
- [ ] 保留用户拥有的字段与无关文件。
- [ ] Error/progress/CLI/helper output 不包含 secret。
- [ ] Focused 与 full gate 通过，且没有削弱 assertion。
