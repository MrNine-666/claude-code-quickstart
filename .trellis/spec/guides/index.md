# Project Thinking Guides

指南是修改前的简短检查清单。可复用实现模式归 backend/frontend 工程规范所有；
精确的 ccq/TUI/installer 行为归[项目合同](../project/index.md)所有。

## Guides

| Guide | Use when |
|---|---|
| [开发工作流](./development-workflow.md) | 开始 feature、fix、refactor 或 spec 更新时 |
| [跨层思考](./cross-layer-thinking-guide.md) | 行为跨越 view/service/core/config/CLI/platform 边界时 |
| [代码复用思考](./code-reuse-thinking-guide.md) | 新增 constant、registry、builder、parser、helper 或 keybinding 时 |

## Quick Routing

- Config 或 persistence 变更：确定精确的文件 owner 与字段所有权。
- 外部命令变更：映射 argv、TTY/capture、timeout、exit 与 postflight。
- UI action 变更：映射 key registry -> view intent -> service/core -> reducer
  reconciliation -> footer。
- Platform/build 变更：映射 source -> contract -> builder -> CI artifact ->
  installed/runtime 冒烟测试。
- 历史文档声明：提升为当前 spec 前先对照当前源码验证。
