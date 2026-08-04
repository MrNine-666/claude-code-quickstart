# Claude Code Quickstart Project Contracts

此层拥有产品边界与可执行领域合同。Backend 和 frontend 层描述可复用工程规则；
本层规定 ccq、OpenTUI 控制台、installer 与 Release artifact 必须如何工作。

## Domain Index

| Domain | Ownership | Index |
|---|---|---|
| 架构 | 支持的平台、仓库边界与 artifact 拓扑 | [architecture.md](./architecture.md) |
| TUI | ccq CLI/config、OpenTUI shell、Tools、Skills、MCP、Provider 与自生命周期 | [tui/index.md](./tui/index.md) |
| Installer | Windows/macOS runtime、contract、build 与 Release 行为 | [installer/index.md](./installer/index.md) |
| 迁移历史 | OpenSpec、`.context` 与旧 Agent 入口的整合 | [migration-history.md](./migration-history.md) |

## Pre-Development Checklist

- [ ] 在[架构](./architecture.md)中确认当前 platform 与 product boundary。
- [ ] 加载相关领域 index 及其列出的每份 contract。
- [ ] runtime 实现还要加载 [Backend](../backend/index.md)，OpenTUI rendering/state
      工作还要加载 [Frontend](../frontend/index.md)。
- [ ] 将 `installer/contracts/`、`tui/contracts/` 与 focused verification script
      视为可执行事实来源。
- [ ] 在 source、contract 和 gate 一起落地前，不得把计划中的 Linux 行为或历史
      迁移记录写进当前 runtime contract。

## Quality Check

先运行 focused domain gate，再运行相关领域 index 中更广泛的命令。变更跨越该
边界时，source-mode 成功不能替代 compiled 或 built-artifact smoke。
