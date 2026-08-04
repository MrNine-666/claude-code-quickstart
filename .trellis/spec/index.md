# Claude Code Quickstart Code Specs

本目录是当前实现的唯一长期项目规范入口。它面向后续实现和审查，不是产品需求
归档，也不是 OpenSpec 历史文档的镜像。

## Fact Priority

发生冲突时按以下顺序判断：

1. 当前源码、`installer/contracts/`、`tui/contracts/` 与可执行验证脚本。
2. 本目录中的 Trellis spec。
3. [迁移历史](./project/migration-history.md)中的 OpenSpec、`.context` 与旧
   Agent 入口记录，仅作历史说明，不能覆盖当前实现或 spec。

## Spec Layers

| Layer | Ownership | Index |
|---|---|---|
| Backend | 运行时目录分层、错误、诊断与质量等工程规则 | [backend/index.md](./backend/index.md) |
| Frontend | OpenTUI 组件、hook、state、类型与渲染质量等工程规则 | [frontend/index.md](./frontend/index.md) |
| Project | ccq/TUI 与 installer/Release 的产品和领域合同 | [project/index.md](./project/index.md) |
| Guides | 修改前、跨层、复用和仓库协作方法 | [guides/index.md](./guides/index.md) |

## Pre-Development Routing

- 修改 `tui/src/cli/**`、core、service 或运行时配置：先读
  [Backend](./backend/index.md)，再读 [TUI 项目合同](./project/tui/index.md)。
- 修改 OpenTUI view、component、hook、state 或 keybinding：先读
  [Frontend](./frontend/index.md)，再读 [TUI 项目合同](./project/tui/index.md)。
- 修改 `installer/**`、构建、Release artifact 或内嵌 contract：读
  [Installer 项目合同](./project/installer/index.md)。
- 修改跨 view/service/core/config/CLI/platform 的行为，或新增共享抽象：读
  [指南](./guides/index.md)。
- 判断 OpenSpec/`.context` 来源和当前规范的关系：读
  [迁移历史](./project/migration-history.md)。

当前产品与平台边界统一见[项目架构](./project/architecture.md)。

## Spec Writing Rule

新增或修改 spec 时必须指向真实源码、契约或验证脚本。不要加入模板占位符、
未来态假设、已删除架构，或仅凭历史计划推导出的行为。
