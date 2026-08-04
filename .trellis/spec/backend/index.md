# Backend and Runtime Guidelines

此层描述 `tui/src` 非渲染运行时代码可复用的工程规则：目录分层、错误模型、
诊断脱敏和质量门禁。ccq CLI、配置、Provider、MCP、Tools、Skills 与自生命周期
等产品合同由 [project/tui](../project/tui/index.md) 统一拥有。

## Guidelines Index

| Spec | Applies to |
|---|---|
| [目录结构](./directory-structure.md) | core/service/CLI/state/view 职责边界 |
| [错误处理](./error-handling.md) | 结构化结果、损坏文件、子进程与 UI 错误 |
| [日志](./logging-guidelines.md) | 进度事件、诊断与机密脱敏 |
| [质量](./quality-guidelines.md) | 验证门禁与审查要求 |

## Pre-Development Checklist

- [ ] 读写持久状态前先确定实现 owner。
- [ ] 原始 argv 解析放在 `cli/`，持久行为放在 `core/`，面向 UI 的编排放在
      `services/`。
- [ ] 复用现有 registry、contract、parser 或 service 边界，不要增加第二个
      事实来源。
- [ ] 用 typed result 表达预期失败，保留主要技术诊断且不得暴露机密。
- [ ] 追踪子进程 argv、TTY/capture 行为、timeout、exit status 与 postflight
      reconciliation。
- [ ] 加载相关 [TUI 产品合同](../project/tui/index.md)，新增或扩展其 focused
      gate，并运行它所路由的更广泛质量检查。

## Baseline Checks

遵循[后端质量](./quality-guidelines.md)和
[TUI 质量工具链](../project/tui/quality-tooling.md)列出的领域门禁。工程层检查
不能替代产品合同验证。
