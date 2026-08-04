# Code Reuse Thinking Guide

## Search Before Adding

添加 constant、list、parser、builder、helper、component 或 keybinding 前，先搜索
拥有它的事实来源：

- Tools：`TOOL_DEFINITIONS`、`COMPONENT_META`。
- Key/footer：`config/keybindings.ts`、`state/shortcuts.ts`。
- Contract：`installer/contracts/`、`tui/contracts/`、`core/contracts.ts`。
- 文件写入：`fs-utils.ts`、`toml-edit.ts`、Provider/MCP/Skills core module。
- Input/form：`SingleLineInput`、`TextareaEditor`、`FormPanel` field。
- Async detection：`use-detection-cache.ts`、detection service。
- 共享 list/detail/loading：由 `components/index.ts` 导出的 component。

索引可用时使用 CodeGraph impact/call path；修改高 fan-out symbol 前验证返回的
source。

## Reuse Rules

- 复用 executable contract，而不只是相似语法。
- 扩展现有 registry，使派生的 CLI/help/view/test projection 自动更新。
- Normalization 放在 format owner 附近，并让每个 consumer import 它。
- 共享 UI control 与 interaction mechanic，但不要把 Claude/Codex、MCP/Skills
  或 platform protocol 强塞进一个虚假的 data model。
- 只有 abstraction 拥有重复 invariant 时才添加它；不能仅因为两个 call site
  当前看起来相似就抽象。

## Common Duplication Failures

- Core 已有 `COMPONENT_META`，view 却硬编码 tool order。
- Footer text 与 key handling 各自维护独立 physical-key array。
- CLI 与 TUI 分别以不同方式解析同一 profile/MCP/Skills payload。
- Source 与 compiled code 使用不同 contract list。
- Windows 与 macOS 不消费 `installer/contracts/`，而是复制 business contract
  data；两端仍应保留不同 runtime 实现。

## Checklist

- [ ] 该值是否已有 registry/contract/type guard/builder？
- [ ] 新 enum/id 未处理时，哪个文件应当 typecheck 失败？
- [ ] 所有 consumer 能否从 owner 派生，而不是复制？
- [ ] 共享是否保留 protocol/platform 差异？
- [ ] Focused test 是否证明旧 caller 与新 caller 都经过共享路径？
