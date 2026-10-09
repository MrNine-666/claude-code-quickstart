# ccq - OpenTUI Management Console

Claude Code Quickstart 的 **8 页面管理控制台**（工具管理 / 供应商 / 配置文件 / 全局规则 / MCP / Skills / 扩展 / 系统设置），基于 **OpenTUI + Bun**，经 `bun build --compile` 交叉编译为 4 平台单文件可执行产物（`ccq-windows-x64.exe` / `ccq-windows-arm64.exe` / `ccq-macos-x64` / `ccq-macos-arm64`），contracts 内嵌进可执行文件。

> 本文面向开发者。架构与约束详见 [TUI Project Contracts](../.trellis/spec/project/tui/index.md)。用户安装与 CLI 使用说明见根目录 [README.md](../README.md#使用-ccq)；人工安装脚本打包见 [installer README](../installer/README.md#build)。

## Requirements

- 本地开发按 `package.json` 的 Bun engine 要求；复现 stable CI 使用 **Bun 1.3.14**。
- Windows ARM64 正式构建使用原生 runner 上经 revision proof 验证的 Bun canary，普通本机构建不能替代该验证。

## Local Development

```bash
# 从仓库根目录进入 TUI
cd tui

# 安装锁定依赖
bun install --frozen-lockfile

# 开发模式（直接运行 TS 入口）
bun run dev

# 类型检查
bun run typecheck

# 默认构建 4 平台 raw/gzip 到仓库根 ../dist/
bun run build

# 只构建一个目标
bun scripts/build.ts --target=windows-x64
```

默认多目标构建仍受宿主与 Bun 目标支持限制；不能把部分本地产物当作完整 Release。
构建只清理所选目标的 raw/gzip，保留人工生成的四个安装脚本。

## Verification

```bash
# 最小 build 检查：typecheck + test + verify
bun run check

# 分别运行 gzip 确定性/映射测试与四个 build verifier
bun run test
bun run verify
```

`verify` 检查 target/版本/清理行为、真实 compiled embedded-contract probe、raw/gzip
完整性与精确资产集合、隔离 Release API fixtures 和自更新字节/替换保护。
已删除的 UI、parser、业务状态机、迁移和 parity 套件不是现存覆盖；业务修改需按对应合同
做隔离 focused/manual 验证。format/lint 为可选本地工具，不是 Release 门禁。

PR/main 只运行一次最小 `check`；tag 额外构建四目标并执行原生 smoke，Release 仅含八个
raw/gzip 二进制资产。安装脚本由维护者另行打包，不参与 TUI CI。

## Directory Structure

```
tui/
├── src/              # TypeScript 源码（入口 index.tsx + app.tsx + core/services/state/views/components）
├── contracts/        # TUI 链契约（内嵌进可执行文件）：providers / mcp-servers / claude-config / templates
├── scripts/          # 构建（build.ts）与验证脚本（verify-*.mjs）
└── tests/            # 最小 gzip 确定性与资产映射测试
```

构建产物位于仓库根 `dist/`（即从本目录看 `../dist/`），不是 `tui/dist/`。

非交互（non-TTY / 管道 / CI）场景下 `ccq` 只输出只读提示并以退出码 0 退出，不进入交互 TUI。
