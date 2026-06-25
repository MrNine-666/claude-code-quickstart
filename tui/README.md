# ccq — OpenTUI 管理控制台

Claude Code Quickstart 的 **6 菜单管理控制台**（供应商 / MCP / Skills / 提示词 / 配置文件 / 工具管理），基于 **OpenTUI + Bun**，经 `bun build --compile` 交叉编译为 4 平台单文件可执行产物（`ccq-windows-x64.exe` / `ccq-windows-arm64.exe` / `ccq-darwin-x64` / `ccq-darwin-arm64`），contracts 内嵌进可执行文件。

> 架构与约束详见 [tui/CLAUDE.md](CLAUDE.md)。

## 环境要求

- **Bun** `>=1.2.0`（安装：`curl -fsSL https://bun.sh/install | bash`）

## 本地开发

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

## 验证

```bash
# parity 验证（与旧实现行为对齐）
bun run verify:parity

# smoke 测试
bun run smoke
```

## 目录结构

```
tui/
├── src/              # TypeScript 源码（入口 index.tsx + app.tsx + core/services/state/views/components）
├── contracts/        # TUI 链契约（内嵌进可执行文件）：providers / mcp-servers / claude-config / templates
├── scripts/          # 构建（build.ts）与验证脚本（verify-*.mjs）
└── dist/             # 构建产物（4 个单文件可执行文件）
```

非交互（non-TTY / 管道 / CI）场景下 `ccq` 只输出只读提示并以退出码 0 退出，不进入交互 TUI。
