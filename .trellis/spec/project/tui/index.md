# ccq And OpenTUI Product Contracts

此领域适用于 `tui/`：Bun `>=1.2.0`、TypeScript、OpenTUI、非交互 CLI 命令、
内嵌 runtime contract 与四个 Windows/macOS 单文件可执行产物。

## Engineering Layers

- Runtime、CLI、service、persistence 与 process 实现还必须遵循
  [Backend 工程指南](../../backend/index.md)。
- View、component、hook、reducer、keybinding 与 rendering 还必须遵循
  [Frontend 工程指南](../../frontend/index.md)。
- 跨层与复用决策必须遵循[指南](../../guides/index.md)。

## Contract Index

| Contract | Applies to |
|---|---|
| [CLI 合同](./cli-contract.md) | `ccq` argv parsing、spawn、TTY 与 exit 行为 |
| [配置所有权](./config-ownership.md) | Claude/Codex/Provider/MCP/Rules/Skills 文件所有权 |
| [Provider 配置安全](./provider-config-safety.md) | 严格 JSON/TOML 读取、profile CRUD、脱敏与权限 |
| [MCP Runtime](./mcp-runtime.md) | vault definition、runtime config 与 shared projection |
| [工具生命周期](./tool-lifecycle.md) | registry、detection、install/update/uninstall 与 injection |
| [ccq 自生命周期](./ccq-self-lifecycle.md) | Release plan/download/apply 与 self-uninstall |
| [管理 Shell 与 View](./manage-shell-and-views.md) | 六菜单、Agent context、editor 与 view 行为 |
| [Tools 主操作](./tools-view-shortcut-contract.md) | Tools Enter/u/d 与 footer invariant |
| [Skills 批量安装](./skills-batch-install-contract.md) | 扁平 selection 与 source batch |
| [Skills 拓扑](./skills-lifecycle-contract.md) | shared storage、projection、adoption 与 replacement |
| [TUI 质量工具链](./quality-tooling.md) | Biome scope、Bun test、aggregate gate 与 quality CI |

Build composition、embedded contract、executable naming、icon 与 Release artifact 行为由 [Build 与 Release](../installer/build-release.md) 负责。

## Directory Boundaries

- `src/cli/`：`cc`、`cx`、`ls`、`use`、`update`、`tools`、`uninstall` 及其他
  非交互命令。
- `src/core/`：config、外部命令、Provider/MCP/Skills/Tools 与 self-lifecycle
  事实。
- `src/services/`：面向 view 的编排与业务 service。
- `src/components/`、`src/views/`、`src/hooks/`：OpenTUI 交互层。
- `contracts/`：由 `src/core/embedded-contracts.ts` 内嵌的 TUI 链 contract。
- `scripts/`：build 与 verification gate；`assets/ccq-icon.ico` 是 Windows x64
  native build 的可选 icon。

左侧导航始终精确为：工具管理、供应商、配置文件、全局规则、MCP、Skills。

## Pre-Development Checklist

- [ ] 加载匹配的 backend/frontend 工程清单和上面每份受影响的 contract。
- [ ] 使用现有 registry、parser、component、keybinding 与 reducer owner；不要
      创建 view-local 或 domain-local 的重复事实来源。
- [ ] 运行时所需 contract 保持内嵌；边界变化时同时测试 source 与 compiled
      behavior。
- [ ] 在 aggregate check 前扩展最近的 `verify-*.mjs` gate。
- [ ] 保留 non-TTY 的只读行为，以及 destructive management command 的显式确认。

## Development And Verification

```sh
cd tui
bun install
bun run dev
bun run typecheck
bun run verify
bun run build
```

编译产物必须验证 `--version`、help、无参数 non-TTY 行为与 embedded contract。
安装后的 executable 不得依赖 Bun、Node 或相邻 contract 文件。使用
`bun run check` 作为 TUI aggregate quality gate。
