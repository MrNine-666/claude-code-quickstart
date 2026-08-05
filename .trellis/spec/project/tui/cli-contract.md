# ccq CLI Contract

## 1. Scope / Trigger

修改 `tui/src/index.tsx`、`tui/src/cli/**`、命令帮助、spawn behavior、alias 或 exit code 前阅读此合同。

## 2. Signatures

```text
ccq                                  # interactive TUI only
ccq cc <provider> [claude-args...]
ccq cx [profile] [codex-args...]
ccq ls [--tool claude|codex]
ccq use <name> [--tool claude|codex]
ccq update [--check]
ccq tools update [name]
ccq tools uninstall <name> [--yes|-y]
ccq uninstall [--yes|-y]

createTuiExitController(exitProcess?): TuiExitController
```

`parseCli()` 只选择 verb；每个 verb parser 负责后续 token grammar。

## 3. Contracts

- 在应用 no-argument non-TTY guard 前先解析 argv。management 命令必须在 CI/pipe 中可用。
- `cc` 与 `cx` 是 launch-class verb。除第一个 separator `--` 外保留每个 passthrough token，继承 stdin/stdout/stderr，并返回 child exit code。
- `cc` 使用 `claude --settings ~/.claude/providers/<name>.json`，不持久化默认值；`cx` 使用 `codex --profile <key>` 或裸 `codex`。
- `cc`/`cx` 的默认 runner 通过共享 `runWithInheritedTty()` 启动 Agent：POSIX
  在 `Bun.which()` 解析到绝对路径后尝试 `process.execve()` 替换当前进程映像；
  Windows、路径解析失败、API 不可用或 `execve` 抛错时回落 inherited-stdio
  `Bun.spawn()`，不改变原有参数、TTY 或退出码语义。
- `process.execve` 的 Bun experimental warning 只能由 runner 的局部 warning
  listener 过滤（仅过滤 `ExperimentalWarning` 且消息包含 `process.execve`）；
  不得通过 `NODE_NO_WARNINGS` 改写传给 Agent 的环境。
- `ls`、`use`、`update`、`tools` 与 `uninstall` 是 management-class verb。它们的 flag 属于 ccq，绝不能传给 Agent。
- `ls`/`use` 默认目标为 Claude。Codex 使用 `--tool codex` 与结构化 Codex core；不写入 Claude settings。
- 显式 `tools update` 强制全新的 detection。Tool id、alias 与 help availability 派生自 `TOOL_DEFINITIONS`。
- destructive 命令需要确认。Non-TTY 模式中，在任何 mutation 前必须提供 `--yes`/`-y`。
- 未知 subcommand 的 help 是 error；通用 help 或已知命令 help 是 success。
- 交互式 quit 必须显式执行：App 通过 `onExit` 报告 intent，entrypoint 请求 `renderer.destroy()`，renderer 的 `onDestroy` callback 退出 process。不得依赖 event loop 变空；后台 detection command 可能仍持有 child-process 或 pipe handle。

## Scenario: Launch-Class Process Image Replacement

### 1. Scope / Trigger

- Trigger: 修改 `tui/src/cli/commands/cc.ts`、`tui/src/cli/commands/cx.ts` 或
  `tui/src/cli/process-runner.ts` 的 Agent 启动、TTY、环境变量与退出码行为。
- Owner: `process-runner.ts` 只负责 executable 解析、POSIX `execve` 尝试和
  inherited-stdio spawn fallback；provider/profile 校验仍由 `cc.ts`/`cx.ts` 在
  启动前完成。

### 2. Signatures

```ts
type LaunchRuntime = {
  readonly platform: NodeJS.Platform;
  readonly which: (command: string) => string | null;
  readonly execve?: (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never;
  readonly spawn: (
    argv: string[],
    options: {stdio: ['inherit', 'inherit', 'inherit']}
  ) => {exited: Promise<number>};
};

function runWithInheritedTty(
  command: string,
  args: readonly string[],
  runtime?: LaunchRuntime
): Promise<number>;
```

### 3. Contracts

- POSIX 且 `runtime.execve` 存在时，先调用 `runtime.which(command)`；返回的路径
  作为 `file`，不得把未解析的 `command` 直接传给 `execve`。
- execve 的 argv 必须是 `[command, ...args]`，并显式传入当前完整
  `process.env`。成功后 runner 不返回，目标 Agent 继承原 PID 与三路 TTY。
- Windows、`which` 返回 `null`/抛错、`execve` 缺失或 `execve` 抛错时，必须调用
  `spawn([command, ...args], {stdio: ['inherit', 'inherit', 'inherit']})` 并等待
  `proc.exited`。
- `cc.ts`/`cx.ts` 必须在 runner 之前完成 provider/profile 白名单、存在性和路径
  解析；execve 失败不能重新执行或绕过这些校验。
- runner 只吞掉目标 experimental warning；其他 warning 仍输出到 stderr。
  fallback 清理 listener 至少延迟到下一个 tick，避免异步 warning 泄漏。

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| POSIX + `which` 得到绝对路径 + execve 成功 | 当前 PID/TTY 由 Agent 接管，runner 不返回 |
| POSIX + `execve` 抛错 | 回落 inherited-stdio spawn，透传 child exit code |
| POSIX + `which` 返回 null 或抛错 | 直接 spawn；命令缺失继续由 `cc`/`cx` 映射为 127 |
| Windows 或没有 `execve` | 不调用 `which`/`execve`，直接 spawn，无 execve warning |
| spawn 抛 ENOENT/not found | 保留既有友好错误文案，exit 127 |
| provider/profile 校验失败 | 不调用 runner，不启动任何 Agent，exit 1 |
| 非目标 warning | 不吞掉，按普通 warning 写入 stderr |

### 5. Good / Base / Bad Cases

- Good: `ccq cc glm -- --help` 在 POSIX 上调用
  `execve('/absolute/claude', ['claude', '--settings', profile, '--help'], env)`。
- Base: Windows 或 `execve` 不可用时使用相同 argv 的 inherited-stdio spawn。
- Bad: 把 `claude`/`codex` 这个 PATH 名称直接交给 `execve`，或捕获 stdio 后再
  启动交互式 Agent。
- Bad: 为隐藏 warning 设置 `NODE_NO_WARNINGS=1`，导致目标 Agent 的其他 warning
  也被静默。

### 6. Tests Required

- `tui/scripts/verify-cli-subcommands.mjs`：fake POSIX runtime 断言绝对路径、argv
  顺序、完整 env、fallback 退出码；fake Windows runtime 断言不调用 `which` 或
  `execve`；断言 inherited stdio 选项原样传递。
- 同一 gate 的非 Windows 真实 probe：断言 fixture 退出码、PID 保持、argv 顺序和
  `ExperimentalWarning: process.execve` 不出现在 stderr。Windows 必须明确记录 skip。
- `runCc`/`runCx` contract tests：断言非法/缺失 provider/profile 在 runner 前失败，
  以及 child non-zero 原样返回。
- 变更最终运行 `bun run typecheck`、`bun run lint`、`bun run format:check`、
  `bun run verify`、`bun run check` 和 `git diff --check`。

### 7. Wrong vs Correct

```ts
// Wrong: execve 不做 PATH 查找；传入 command 会把可执行文件解析责任丢失。
process.execve('claude', ['claude', ...args], process.env);

// Correct: 先解析绝对路径，并在失败时保留既有 spawn/ENOENT 语义。
const file = runtime.which('claude');
if (file) {
  try {
    runtime.execve?.(file, ['claude', ...args], process.env);
  } catch {
    // fall through to inherited-stdio spawn
  }
}
return await spawnAndWait(['claude', ...args]);
```

## 4. Validation & Error Matrix

| Input / condition | Result |
|---|---|
| 无参数 + TTY | 渲染六菜单 TUI |
| 可退出 TUI focus 中的 `q` | 恢复 terminal state，再 exit 0，即使后台 handle 仍存在 |
| 无参数 + non-TTY | 显示只读消息，exit 0 |
| 没有 provider 的 `cc` | Usage error，不 spawn |
| `claude`/`codex` executable 缺失 | Exit 127 |
| Child exit 非零 | 返回相同 exit code，不回退到 TUI |
| 请求的 profile 缺失 | Spawn 前失败，返回脱敏错误 |
| `--tool` 无效 | Usage error，不写入 |
| 未知 help target | Exit 1，展示未知 target 与通用 help |
| destructive non-TTY 没有确认 flag | Mutation 前拒绝 |

## 5. Good / Base / Bad Cases

- 良好：`ccq cx dev -m gpt-5 -- --help` 以 inherited TTY 启动
  `codex --profile dev -m gpt-5 --help`。
- 基线：`ccq cx` 启动 native Codex default，不注入 ccq credential。
- 错误：把 `--tool codex` 传给 Claude/Codex，或 child 返回 non-zero 后进入 TUI。
- 错误：脱离 tool registry 单独维护 CLI alias list。
- 错误：正常 quit 只调用 `renderer.destroy()`，等待 Bun 自然退出。

## 6. Tests Required

- 扩展 `tui/scripts/verify-cli-subcommands.mjs`，覆盖 token order、help、alias、
  ENOENT 与 child exit propagation。
- 扩展 `verify-cli-uninstall.mjs`，覆盖 confirmation 与 scheduled/deleted 文案。
- 扩展 `verify-manage-tui-state.mjs`，覆盖 renderer-destroy/explicit-exit 顺序与
  entrypoint wiring。
- 运行 `bun run typecheck` 与 `bun run verify`。

## 7. Wrong vs Correct

```ts
// 错误：captured stdio 会破坏交互式 Agent session。
await execCommand('codex', args);

// 正确：launch command 继承 TTY 并传递 exit status。
const child = Bun.spawn(['codex', ...args], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
});
return await child.exited;
```

```ts
// 错误：卡住的后台 detector 可能让 ccq.exe 保持运行。
if (state.shouldExit) renderer.destroy();

// 正确：只从 renderer cleanup 后的 onDestroy callback 退出。
exitController.requestExit(renderer);
```
