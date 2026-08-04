# ccq - OpenTUI Management Console

Claude Code Quickstart 的 **6 菜单管理控制台**（工具管理 / 供应商 / 配置文件 / 全局规则 / MCP / Skills），基于 **OpenTUI + Bun**，经 `bun build --compile` 交叉编译为 4 平台单文件可执行产物（`ccq-windows-x64.exe` / `ccq-windows-arm64.exe` / `ccq-macos-x64` / `ccq-macos-arm64`），contracts 内嵌进可执行文件。

> 架构与约束详见 [TUI Project Contracts](../.trellis/spec/project/tui/index.md)。CLI 使用说明见根目录 [README.md](../README.md) 的「Manage 管理控制台（ccq）」章节。

## Requirements

- **Bun** `>=1.2.0`（安装：`curl -fsSL https://bun.sh/install | bash`）

## Local Development

```bash
# 安装依赖
bun install

# 开发模式（直接运行 TS 入口）
bun run dev

# 类型检查
bun run typecheck

# 构建 4 平台可执行文件到 dist/
bun run build
```

## Verification

```bash
# 运行全部 verify 门禁（parser / 状态机 / 迁移 / parity，bun 直跑 src）
bun run verify
```

## Directory Structure

```
tui/
├── src/              # TypeScript 源码（入口 index.tsx + app.tsx + core/services/state/views/components）
├── contracts/        # TUI 链契约（内嵌进可执行文件）：providers / mcp-servers / claude-config / templates
├── scripts/          # 构建（build.ts）与验证脚本（verify-*.mjs）
└── dist/             # 构建产物（4 个单文件可执行文件）
```

非交互（non-TTY / 管道 / CI）场景下 `ccq` 只输出只读提示并以退出码 0 退出，不进入交互 TUI。
