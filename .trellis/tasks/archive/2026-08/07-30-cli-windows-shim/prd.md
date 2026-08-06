# Windows Direct Detached Agent Launch

## Goal

Windows 上执行 `ccq cc` / `ccq cx` 时，`ccq.exe` 只完成既有
provider/profile 校验、解析真实 Agent executable 并发起一次 detached 启动。目标
进程创建后 `ccq.exe` 立即返回，不等待 Claude/Codex 结束，也不透传最终退出码。

目标进程树是：

```text
ccq.exe
└─ claude.exe / codex.exe
```

`ccq.exe` 发起启动后立即退出，Agent 会话期间不得保留 `ccq.exe`、`cmd.exe`
或其他 ccq-owned 中间进程，从而避免长期占用约百 MB 内存并锁住已安装 executable。

## Background

- 当前 `runWithInheritedTty()` 在 Windows 使用 `Bun.spawn()` 后等待
  `proc.exited`，所以 `ccq.exe` 在整个 Agent 会话中常驻。
- POSIX 已使用 `process.execve()` 替换进程映像，本任务只改变 Windows 分支。
- Windows 不支持 `process.execve()`；已验证 Bun 1.3.14 的
  `Bun.spawn({detached:true})` 配合 `unref()` 可以让父进程立即退出而 child
  继续存活。
- 本机 `Bun.which('claude')` 返回 npm 的 `claude.cmd`，但 wrapper 指向可直接
  启动的 `@anthropic-ai/claude-code/bin/claude.exe`。
- 本机 `Bun.which('codex')` 返回受保护的 WindowsApps 路径，直接 spawn 会报
  `EPERM`；用户目录 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` 中存在
  可直接启动的 native executable。
- 用户明确接受 Windows launch-class 命令只负责发起启动，不负责 Agent 最终结果，
  并明确禁止使用 `cmd.exe`。

## Requirements

### R1. Windows fire-and-forget

- Windows `ccq cc` / `ccq cx` 在成功创建目标进程后调用 `unref()` 并立即返回
  `0`。
- Windows 分支不得读取或等待 `proc.exited`，不得因 Agent 后续失败、退出或返回
  非零而改变 `ccq` 的结果。
- 目标进程继续继承 stdin/stdout/stderr；`ccq` 不再承诺其退出后的 TTY 生命周期、
  Ctrl+C 归属或最终退出码。

### R2. Direct executable only

- `Bun.spawn()` 的 argv[0] 必须是已解析且存在的绝对 `.exe` 路径。
- 不得启动 `cmd.exe`、PowerShell、`.cmd`、`.bat`、`.ps1`、shell shim、
  resolver process 或 launch-plan process。
- 可以读取标准 npm wrapper 来解析其明确引用的 `.exe`，但不得执行 wrapper。
- Codex 优先使用可直接创建进程的 native executable；WindowsApps 路径不可直接
  使用时，可查找用户目录下的 Codex native executable。找不到真实 `.exe` 时
  fail closed，不得回退 shell。

### R3. Existing validation remains

- `cc.ts` 继续拥有 Claude provider 白名单、存在性、token 有效性、可用供应商
  列表及 `--settings` path。
- `cx.ts` 继续拥有 official login、profile key 白名单、存在性及
  `--profile` 参数。
- 所有 provider/profile 校验必须在启动 Agent 前完成；本任务不得复制 JSON/TOML
  解析或配置路径事实源。

### R4. Immediate launch failures

- 真实 executable 不存在、无法解析或进程创建同步失败时，仍沿用 `cc.ts` /
  `cx.ts` 当前友好错误文案和 `127` / `1` 映射。
- 一旦 `Bun.spawn()` 成功返回 process handle，`ccq` 只报告“已发起”，立即返回
  `0`；后续状态不属于 `ccq` 合同。

### R5. Compatibility boundaries

- `ccq cc <name> [args...]` 与 `ccq cx [name] [args...]` 的 argv grammar、
  第一个 `--` separator 丢弃规则和 token 顺序保持不变。
- macOS/POSIX 的 execve、fallback spawn、TTY 与 child exit-code 语义保持不变。
- management-class 命令、installer、PATH、self-update 和 self-uninstall 不在本任务
  中改变。

## Out Of Scope

- 不生成或安装任何 `.cmd` / shim / resolver / launch plan。
- 不修改 Windows PATH、installer 或 Release artifact 集合。
- 不关闭、轮询或回收 Claude/Codex 进程。
- 不保证 Windows 上透传 Agent 最终退出码。
- 不为仅能通过 shell 或受保护入口启动的 Agent 增加 shell fallback。

## Acceptance Criteria

- [x] Windows `ccq cc` / `ccq cx` 只直接 spawn 一个绝对
      `claude.exe` / `codex.exe`。
- [x] spawn options 包含 inherited stdio 与 `detached: true`，并在返回前调用
      `unref()`。
- [x] Windows runner 不读取或等待 `proc.exited`；process handle 创建成功后立即
      返回 `0`。
- [x] Agent 存活期间不存在 `ccq.exe` 或本任务新增的 `cmd.exe` / helper
      进程。
- [x] Claude npm wrapper 被解析为真实 `claude.exe`，wrapper 本身不被执行。
- [x] Codex WindowsApps 入口不可直接使用时，能解析用户目录内可运行的
      `codex.exe`；无可用 native executable 时返回友好错误且不启动 shell。
- [x] provider/profile 无效时不调用 executable resolver 或 spawn，保持现有文案和
      exit `1`。
- [x] 直接 executable 不存在或同步 spawn 失败时保持现有 `127` / `1` 语义。
- [x] POSIX execve 与 fallback 的 argv、TTY 和 child exit code 合同无回归。
- [x] focused gate、typecheck、lint、verify/check 和 Windows compiled smoke 通过。

## Open Questions

无。用户已明确选择 direct detached launch，接受不等待结果，并拒绝任何
`cmd.exe` fallback。
