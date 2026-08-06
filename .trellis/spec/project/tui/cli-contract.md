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
- `cc` 与 `cx` 是 launch-class verb。除第一个 separator `--` 外保留每个 passthrough token，并继承 stdin/stdout/stderr。POSIX 返回 child exit code；Windows 只负责发起 detached Agent，不等待或透传 Agent 最终结果。
- `cc` 使用 `claude --settings ~/.claude/providers/<name>.json`，不持久化默认值；`cx` 使用 `codex --profile <key>` 或裸 `codex`。
- `cc`/`cx` 的默认 runner 通过共享 `runWithInheritedTty()` 启动 Agent：POSIX
  在 `Bun.which()` 解析到绝对路径后尝试 `process.execve()` 替换当前进程映像；
  Windows 只解析真实绝对 `.exe`，以 inherited stdio + `detached: true` 调用
  `Bun.spawn()`，随后 `unref()` 并立即返回 0；不得执行 `.cmd`/`.bat`/shell。
- POSIX 路径解析失败、API 不可用或 `execve` 抛错时回落 inherited-stdio
  `Bun.spawn()`，保留 child exit-code 语义。
- `process.execve` 的 Bun experimental warning 只能由 runner 的局部 warning
  listener 过滤（仅过滤 `ExperimentalWarning` 且消息包含 `process.execve`）；
  不得通过 `NODE_NO_WARNINGS` 改写传给 Agent 的环境。
- `ls`、`use`、`update`、`tools` 与 `uninstall` 是 management-class verb。它们的 flag 属于 ccq，绝不能传给 Agent。
- `ls`/`use` 默认目标为 Claude。Codex 使用 `--tool codex` 与结构化 Codex core；不写入 Claude settings。
- 显式 `tools update` 强制全新的 detection。Tool id、alias 与 help availability 派生自 `TOOL_DEFINITIONS`。
- destructive 命令需要确认。Non-TTY 模式中，在任何 mutation 前必须提供 `--yes`/`-y`。
- 未知 subcommand 的 help 是 error；通用 help 或已知命令 help 是 success。
- 交互式 quit 必须显式执行：App 通过 `onExit` 报告 intent，entrypoint 请求 `renderer.destroy()`，renderer 的 `onDestroy` callback 退出 process。不得依赖 event loop 变空；后台 detection command 可能仍持有 child-process 或 pipe handle。

## Scenario: Launch-Class Process Image Replacement And Detached Windows Launch

### 1. Scope / Trigger

- Trigger: 修改 `tui/src/cli/commands/cc.ts`、`tui/src/cli/commands/cx.ts` 或
  `tui/src/cli/process-runner.ts` 的 Agent 启动、TTY、环境变量与退出码行为。
- Owner: `process-runner.ts` 负责平台 executable 解析、POSIX `execve` 尝试、
  inherited-stdio spawn fallback，以及 Windows direct detached launch；
  provider/profile 校验仍由 `cc.ts`/`cx.ts` 在启动前完成。

### 2. Signatures

```ts
type LaunchRuntime = {
  readonly platform: NodeJS.Platform;
  readonly which: (command: string) => string | null;
  readonly execve?: (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never;
  readonly spawn: (
    argv: string[],
    options: {
      stdio: ['inherit', 'inherit', 'inherit'];
      detached?: boolean;
    }
  ) => {exited: Promise<number>; unref(): void};
  readonly readFile?: (path: string) => string;
  readonly fileExists?: (path: string) => boolean;
  readonly listDirectory?: (path: string) => readonly string[];
  readonly localAppData?: string;
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
- Windows 必须将 `Bun.which()` 或受信任 wrapper/fallback 解析为存在的绝对 `.exe`；
  npm `.cmd` wrapper 只能读取其单一、位于 wrapper 目录内的 `.exe` 引用，
  WindowsApps 受保护入口只能回退到用户目录 native Codex executable。随后调用
  `spawn([absoluteExe, ...args], {stdio: ['inherit', 'inherit', 'inherit'], detached: true})`，
  调用 `unref()` 后立即返回 0；不得等待 `proc.exited`。
- POSIX 中 `which` 返回 `null`/抛错、`execve` 缺失或 `execve` 抛错时，调用
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
| Windows + direct `.exe` 创建成功 | `unref()` 后立即 exit 0，不观察 Agent 后续状态 |
| Windows 只有 `.cmd`/受保护 WindowsApps 入口且无 direct `.exe` | fail closed，不启动 shell，映射为 127 |
| Windows Agent 启动成功后退出非零 | `ccq` 已返回 0；不观察、不透传 Agent 结果 |
| spawn 抛 ENOENT/not found | 保留既有友好错误文案，exit 127 |
| provider/profile 校验失败 | 不调用 runner，不启动任何 Agent，exit 1 |
| 非目标 warning | 不吞掉，按普通 warning 写入 stderr |

### 5. Good / Base / Bad Cases

- Good: `ccq cc glm -- --help` 在 POSIX 上调用
  `execve('/absolute/claude', ['claude', '--settings', profile, '--help'], env)`。
- Base: Windows 解析到 direct `.exe` 后以 inherited-stdio detached spawn 发起并立即
  返回 0；`execve` 不可用时 POSIX 才使用相同 argv 的 inherited-stdio spawn 等待。
- Bad: 把 `claude`/`codex` 这个 PATH 名称直接交给 `execve`，或捕获 stdio 后再
  启动交互式 Agent。
- Bad: 为隐藏 warning 设置 `NODE_NO_WARNINGS=1`，导致目标 Agent 的其他 warning
  也被静默。

### 6. Tests Required

- `tui/scripts/verify-cli-subcommands.mjs`：fake POSIX runtime 断言绝对路径、argv
  顺序、完整 env、fallback 退出码；fake Windows runtime 断言 direct `.exe`、wrapper、
  Codex fallback、缺失/`which` 异常、同步 spawn failure、detached/unref 和永不
  settle 的 `exited` 不阻塞返回。
- 同一 gate 的非 Windows 真实 probe：断言 fixture 退出码、PID 保持、argv 顺序和
  `ExperimentalWarning: process.execve` 不出现在 stderr。Windows 必须明确记录 skip。
- `runCc`/`runCx` contract tests：断言非法/缺失 provider/profile 在 runner 前失败，
  POSIX child non-zero 原样返回，Windows detached runner 不等待 child。
- 变更最终运行 `bun run typecheck`、`bun run lint`、`bun run format:check`、
  `bun run verify`、`bun run check` 和 `git diff --check`。

### 7. Wrong vs Correct

```ts
// Wrong: execve 不做 PATH 查找；传入 command 会把可执行文件解析责任丢失。
process.execve('claude', ['claude', ...args], process.env);

// Correct: POSIX 先解析绝对路径，并在失败时保留既有 spawn/ENOENT 语义；
// Windows 必须另外解析 direct .exe、detached spawn、unref 并立即返回 0。
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
| POSIX child exit 非零 | 返回相同 exit code，不回退到 TUI |
| 请求的 profile 缺失 | Spawn 前失败，返回脱敏错误 |
| `--tool` 无效 | Usage error，不写入 |
| 未知 help target | Exit 1，展示未知 target 与通用 help |
| destructive non-TTY 没有确认 flag | Mutation 前拒绝 |

## 5. Good / Base / Bad Cases

- 良好：`ccq cx dev -m gpt-5 -- --help` 以 inherited TTY 启动
  `codex --profile dev -m gpt-5 --help`。
- 基线：`ccq cx` 启动 native Codex default，不注入 ccq credential。
- 错误：把 `--tool codex` 传给 Claude/Codex，或 POSIX child 返回 non-zero 后进入 TUI；
  Windows detached Agent 的后续 non-zero 不应被 ccq 观察。
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

// 正确（POSIX）：launch command 继承 TTY 并传递 child exit status；Windows
// 使用 direct .exe + detached/unref，不等待 child。
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
