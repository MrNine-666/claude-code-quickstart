# tui/ -- OpenTUI 管理控制台

本目录是 `ccq` 的 TUI 与 CLI 子项目，使用 Bun `>=1.2.0`、TypeScript
和 OpenTUI。源码编译为 Windows/macOS x64/arm64 四个单文件可执行产物。

## 目录边界

- `src/cli/`：`cc`、`cx`、`ls`、`use`、`update`、`tools`、
  `uninstall` 等非交互命令。
- `src/core/`：配置、外部命令、Provider/MCP/Skills/Tools 与自生命周期。
- `src/services/`：视图编排和业务服务。
- `src/components/`、`src/views/`、`src/hooks/`：OpenTUI 交互层。
- `contracts/`：TUI 链契约；运行时所需内容由
  `src/core/embedded-contracts.ts` 内嵌。
- `scripts/`：构建与 verify 门禁；`assets/ccq-icon.ico` 是 Windows
  x64 原生构建的可选图标资源。

菜单固定为：工具管理、供应商、配置文件、全局规则、MCP、Skills。

## 必读规范

| 修改范围 | Spec |
|---|---|
| CLI、core、service、配置所有权、外部命令 | [Backend index](../.trellis/spec/backend/index.md) |
| view、component、hook、state、keybinding | [Frontend index](../.trellis/spec/frontend/index.md) |
| 编译、内嵌、图标、Release artifact | [Build and release](../.trellis/spec/installer/build-release.md) |
| 跨层或复用决策 | [Guides](../.trellis/spec/guides/index.md) |

修改前从对应 index 的 Pre-Development Checklist 继续读取具体 spec。不要把
长期约束重新堆回本文件。

## 开发命令

```sh
cd tui
bun install
bun run dev
bun run typecheck
bun run verify
bun run build
```

编译产物必须验证 `--version`、help、无参 non-TTY 行为和内嵌 contract；
安装后不依赖 Bun、Node 或相邻 contract 文件。详细门禁以 Trellis spec 和
`package.json` 脚本为准。
