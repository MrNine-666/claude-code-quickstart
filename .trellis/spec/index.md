# Claude Code Quickstart Code Specs

本目录是当前实现的开发规范入口。它面向后续实现和审查，不是产品需求
归档，也不是 OpenSpec 历史文档的镜像。

## 事实优先级

发生冲突时按以下顺序判断：

1. 当前源码、`installer/contracts/`、`tui/contracts/` 与可执行验证脚本。
2. 本目录中的 Trellis code spec。
3. 根与目录级 `AGENTS.md` 仅作为平台启动和 spec 导航入口，不覆盖前两项。
4. `migration-map.md` 中记录的 OpenSpec/`.context` 迁移来源，仅作历史说明，
   不能覆盖当前源码或 code spec。

旧根 `openspec/` 与 `.context/` 已在迁移完成后删除。迁移时未实现的 proposal
不会仅因曾经写得完整就成为当前契约；例如 Linux 支持仍未落地，当前 Release
仍只有 Windows/macOS 四个可执行目标，以及两个安装脚本、四个 raw 和四个
gzip 自更新资产组成的十个 artifact。

## Spec Layers

| Layer | Ownership | Index |
|---|---|---|
| Backend | TUI core/services/CLI、配置文件、外部命令和生命周期 | [backend/index.md](./backend/index.md) |
| Frontend | OpenTUI 组件、状态机、快捷键、视图与交互 | [frontend/index.md](./frontend/index.md) |
| Installer | Windows/macOS 安装运行时、构建、Release 单文件边界 | [installer/index.md](./installer/index.md) |
| Guides | 修改前、跨层与复用检查清单 | [guides/index.md](./guides/index.md) |

已删除 OpenSpec 与 `.context` 来源的逐项去重结果见
[migration-map.md](./migration-map.md)。

## Pre-Development Routing

- 修改 `tui/src/cli/**`：读 `backend/cli-contract.md`。
- 修改配置、Provider、MCP、规则或 contracts：读
  `backend/config-ownership.md`，并按领域追加 Provider/MCP spec。
- 修改 Tools 检测、安装、更新、卸载或共享投影：读
  `backend/tool-lifecycle.md` 和 `frontend/tools-view-shortcut-contract.md`。
- 修改 Skills：同时读 `frontend/skills-batch-install-contract.md` 和
  `frontend/skills-lifecycle-contract.md`。
- 修改 OpenTUI view/component/hook/state/keybinding：读 `frontend/index.md`
  的 checklist 与 `frontend/manage-shell-and-views.md`。
- 修改 `installer/**`、构建、Release artifact 或内嵌 contract：读
  `installer/index.md` 的全部 checklist。
- 修改 `ccq` 自更新/自卸载：读 `backend/ccq-self-lifecycle.md`，并同时
  检查 Windows helper 与编译产物 smoke。

## Current Product Boundary

- 安装器只安装 Basic 的 `NodeJS` / `Git`，末尾安装 `ccq`；Agent 和周边工具
  生命周期由 TUI 工具管理承接。
- TUI 是 Bun `>=1.2.0` + OpenTUI 的四平台单文件可执行产物。
- 左侧始终六个菜单：工具管理、供应商、配置文件、全局规则、MCP、Skills。
- 当前正式平台是 Windows 10/11 与 macOS 12+。Linux 方案尚未实现。
- `installer/contracts/` 只归 install 链；`tui/contracts/` 只归 TUI 链。

## Spec Writing Rule

新增或修改 spec 时必须指向真实源码、契约或验证脚本。不要加入模板占位符、
未来态假设、已删除架构，或仅凭历史计划推导出的行为。
