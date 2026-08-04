# Project Architecture And Product Boundaries

## Product Goals

Claude Code Quickstart 为 Windows 10/11 与 macOS 12+ 提供 CLI Agent 开发
环境。安装入口 bootstrap NodeJS、Git 与 `ccq`；根级 OpenTUI 控制台负责
Claude Code、Codex 及周边工具的生命周期管理。

## Repository Boundaries

| Path | Ownership |
|---|---|
| `tui/` | Bun `>=1.2.0` + OpenTUI 控制台、非交互 `ccq` 命令和四平台单文件可执行产物 |
| `installer/` | Windows PowerShell 5.1+ 与 macOS zsh 安装链 |
| `installer/contracts/` | installer step、composition、cleanup 与 artifact contract |
| `tui/contracts/` | 内嵌到每个可执行产物的 TUI runtime contract |
| `.trellis/spec/project/tui/` | 当前 ccq 与 OpenTUI 产品合同 |
| `.trellis/spec/project/installer/` | 当前 installer、build 与 Release 合同 |

TUI 菜单固定为工具管理、供应商、配置文件、全局规则、MCP 与 Skills。目录职责与
领域专用检查由 [TUI 合同](./tui/index.md)和
[Installer 合同](./installer/index.md)路由。

## Platform And Release Boundaries

正式可执行目标是 Windows x64/arm64 与 macOS x64/arm64。Release 精确包含十个
artifact：两个 installer script、四个 raw ccq executable 以及对应的四个 gzip
self-update asset。Linux 支持尚未实现，不属于当前 runtime 或 Release contract。

Installer 不拥有 Agent、Provider、MCP、Skills 或周边工具的生命周期。即使归档
计划或历史 installer 文件描述过旧安排，这些能力仍归 TUI 所有。
