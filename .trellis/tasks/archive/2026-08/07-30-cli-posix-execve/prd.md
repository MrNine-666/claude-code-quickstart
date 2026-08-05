# Replace POSIX ccq cc/cx Process Images with execve

## Goal

macOS/Linux 上 `ccq cc` / `ccq cx` 目前用 `Bun.spawn` + `await proc.exited`，
导致 ccq 进程在整个 claude/codex 会话期间常驻。改为 `process.execve` 真替换
进程映像，让 ccq 消失、由目标进程接管 PID 与 TTY。

## Background

`ccq cc` 语义上是「用指定 provider 启动 claude」的快捷方式，不应该在会话期间
挂一个 104MB 的 Bun 二进制当父进程。

现有实现 `tui/src/cli/commands/cc.ts:11-16`：

```typescript
async function runClaudeWithInheritedTty(args: readonly string[]): Promise<number> {
	const proc = Bun.spawn(['claude', ...args], {
		stdio: ['inherit', 'inherit', 'inherit']
	});
	return await proc.exited;
}
```

`tui/src/cli/commands/cx.ts:9-12` 是同一模式（目标换成 `codex`）。

实测的残留进程树：

```
ccq 52300  "ccq.exe cc aether"      ← 常驻 6 小时
└─ cmd.exe 15928  /c claude --settings ...\providers\aether.json
   └─ claude.exe 24412
```

### Platform Capability Evidence

`process.execve` 在 Bun 1.3.14 存在，但平台可用性不同（本机实测）：

```
[parent pid=52928] before execve
[parent pid=52928] execve threw: The feature process.execve is
unavailable on the current platform
ExperimentalWarning: process.execve is an experimental feature
```

Windows 无 `execve` 系统调用，直接抛错。POSIX（macOS/Linux）可用。

因此本任务**只覆盖 POSIX**。Windows 的等价目标由子任务
`07-30-cli-windows-shim` 承接。

## Requirements

- POSIX 平台上 `ccq cc` / `ccq cx` 用 `process.execve` 替换当前进程映像为
  `claude` / `codex`。
- execve 不可用或抛错时，回落到现有 `Bun.spawn` + `await proc.exited` 路径，
  保证行为不退化。Windows 走这条回落分支。
- execve 前必须完成所有既有校验：provider 名称白名单
  （`testProviderKey` / `safeCodexProfileKey`）、provider 存在性、
  profile 路径解析。execve 之后没有回头路，校验不能后置。
- 需要解析 `claude` / `codex` 的可执行文件绝对路径 — `execve` 不做 PATH 查找，
  必须显式解析，解析失败要给出与现有 `ENOENT` 分支一致的友好提示（退出码 127）。
- 环境变量需完整传递给新映像。
- 保持退出码透传语义：execve 成功后退出码天然由目标进程决定。

## Constraints

- `process.execve` 在 Bun 标记为 experimental，可能触发
  `ExperimentalWarning` 输出到 stderr。必须抑制该警告，不能污染用户终端。
- 不改变 `ccq cc` / `ccq cx` 的 CLI 契约（参数、透传、错误文案）。
- 现有依赖注入缝（`ClaudeRunner` / `CodexRunner`）是测试接缝，必须保留，
  新增的 execve 路径也要可注入以便测试。
- Windows 行为在本任务内保持现状（继续 spawn），不得因改动而退化。

## Acceptance Criteria

- [ ] macOS 上 `ccq cc <name>` 执行后，进程列表中不再存在 ccq 进程，
      claude 直接占据原 PID
- [ ] 交互式 claude 会话的 TTY 行为正常（键盘输入、Ctrl+C、终端尺寸变化、
      颜色输出）
- [ ] 退出码正确透传
- [ ] `claude` 不在 PATH 时仍返回 127 并给出现有友好提示
- [ ] provider 名称非法 / 不存在时的错误路径与现行为一致
- [ ] Windows 上行为不变（回落 spawn 路径），无 `ExperimentalWarning` 泄漏
- [ ] `cd tui && bun run typecheck` 通过
- [ ] `cd tui && bun run verify` 通过
- [ ] 新增测试覆盖 execve 路径与回落路径

## Notes

- Linux 支持目前不在项目运行时契约内（见项目架构与 installer 合同），但 `execve` 实现
  天然覆盖 Linux，无需额外分支。
- 本任务与 `07-30-cli-windows-shim` 目标一致（消除 CLI 父进程残留），
  但技术路线完全不同，互不阻塞，可并行。
