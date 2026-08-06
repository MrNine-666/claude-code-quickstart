# Technical Design

## 1. Decision

Windows launch-class 命令使用单进程 fire-and-forget：

```text
parseCli
  -> runCc / runCx validation
  -> resolveWindowsAgentExecutable(command)
  -> Bun.spawn([absoluteExe, ...args], {
       stdio: ['inherit', 'inherit', 'inherit'],
       detached: true
     })
  -> process.unref()
  -> return 0
```

不增加 shim、resolver、launch-plan、installer 或 PATH 层。目标 Agent 启动后，
`ccq.exe` 立即退出。

## 2. Ownership Boundaries

| Concern | Owner |
|---|---|
| argv grammar 与 `--` separator | `tui/src/cli/argv.ts`，保持不变 |
| Claude provider 校验与 `--settings` | `tui/src/cli/commands/cc.ts` |
| Codex profile 校验与 `--profile` | `tui/src/cli/commands/cx.ts` |
| 平台启动策略与 direct executable 解析 | `tui/src/cli/process-runner.ts`；解析复杂时拆到同目录窄模块 |
| Windows direct-launch regression | `tui/scripts/verify-cli-subcommands.mjs` |
| 持久 CLI 合同 | `.trellis/spec/project/tui/cli-contract.md` |

Installer、self-update、self-uninstall 和 PATH 不属于本设计。

## 3. Runtime Contract

`LaunchRuntime` 扩展 Windows direct-launch 所需 seam：

```ts
type LaunchProcess = {
  readonly exited: Promise<number>;
  unref(): void;
};

type LaunchOptions = {
  readonly stdio: ['inherit', 'inherit', 'inherit'];
  readonly detached?: boolean;
};

type LaunchRuntime = {
  readonly platform: NodeJS.Platform;
  readonly which: (command: string) => string | null;
  readonly execve?: (...args) => never;
  readonly spawn: (argv: string[], options: LaunchOptions) => LaunchProcess;
  readonly readTextFile: (path: string) => string;
  readonly fileExists: (path: string) => boolean;
  readonly localAppData?: string;
};
```

具体 seam 可以按现有 TypeScript 风格收窄，但必须让 focused gate 能证明：

- Windows argv[0] 是绝对 `.exe`；
- options 含 `detached: true` 和 inherited stdio；
- `unref()` 被调用一次；
- 一个永不 settle 的 `exited` Promise 不会阻止 runner 返回 `0`。

POSIX 分支保持当前 `which -> execve -> inherited spawn fallback -> await exited`
流程。

## 4. Windows Executable Resolution

解析器只返回存在的绝对 `.exe`：

1. 读取 `Bun.which(command)` 的结果。
2. 若结果是普通可用的 `.exe`，作为首选候选。
3. 若结果是标准 npm `.cmd` wrapper，只读取文本并解析其中明确引用的
   `.exe`；仅展开 wrapper 目录占位符，规范化后验证目标存在且扩展名为
   `.exe`。wrapper 永不执行。
4. 对 Codex 的 WindowsApps 受保护候选，查找
   `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` 等用户可执行目录，使用
   确定性顺序选择存在的 native executable。
5. 所有候选都不可用时抛出 command-not-found 风格错误，由现有 `cc.ts` /
   `cx.ts` 映射为 `127`。

解析器不启动探测进程，不调用 `where.exe`、`cmd.exe`、PowerShell、
`ShellExecuteEx` 或 `Start-Process`。同步 `Bun.spawn` 是唯一启动尝试。

为避免把任意 batch 内容变成可执行路径，wrapper 解析只接受已知的 npm launcher
形状、单一 `.exe` 引用、wrapper 目录内或其 descendant 的规范化目标；不满足
约束即拒绝并继续下一个 direct candidate。

## 5. Launch And Exit Semantics

Windows：

```ts
const executable = resolveWindowsAgentExecutable(command, runtime);
const child = runtime.spawn([executable, ...args], {
  stdio: ['inherit', 'inherit', 'inherit'],
  detached: true
});
child.unref();
return 0;
```

- `spawn()` 同步抛错表示连发起都没有完成，由调用方保留现有错误映射。
- `spawn()` 返回后不访问 `child.exited`、`exitCode` 或 signal。
- 不注册 exit handler，不保存 PID，不在 `ccq` 退出时 kill child。
- stdin/stdout/stderr 继续继承当前 console handles；父进程退出后的会话行为由
  Agent 和 Windows console 管理，不再是 `ccq` 的结果合同。

POSIX 继续使用 execve；execve fallback 继续等待 child 并返回真实 code。

## 6. Error Matrix

| Condition | Result |
|---|---|
| provider/profile 校验失败 | 不解析 executable、不 spawn，exit 1 |
| direct executable 无法解析 | 现有“未检测到命令”文案，exit 127 |
| `Bun.spawn` 同步抛 ENOENT/EPERM | 现有启动失败映射，exit 127/1 |
| process handle 创建成功 | 调用 `unref()`，立即 exit 0 |
| Agent 随后启动失败或退出非零 | `ccq` 不观察、不改写结果 |
| only shell/WindowsApps entry available | fail closed；不生成 shell fallback |
| POSIX execve 失败 | 保持当前 inherited spawn fallback 和 child code |

## 7. Verification Design

### Focused gate

扩展 `verify-cli-subcommands.mjs`：

- fake Windows runtime 返回永不 settle 的 `exited`，断言 runner 仍立即返回 0；
- 断言 `detached: true`、三路 inherited stdio、absolute `.exe` argv 和一次
  `unref()`；
- direct `.exe`、Claude npm wrapper、Codex user-local fallback 和完全缺失矩阵；
- 断言 resolver 不调用 shell process；
- 保留 POSIX execve/fallback/exit-code 断言。

### Native Windows smoke

- 使用真实 `claude.exe --version` 和可用的 user-local `codex.exe --version`
  验证 direct spawn；
- 使用阻塞 native fixture 验证 `ccq.exe` 先退出、child 继续存活；
- 检查进程树中没有 `cmd.exe` 或 ccq helper；
- compiled `ccq.exe` 运行同一 smoke，避免 source-only 假通过。

## 8. Compatibility And Rollback

- 不改变公共 argv、provider/profile storage、installer 或 Release artifact。
- Windows child exit code 是有意移除的兼容性变化，已由用户明确接受。
- 若 native smoke 证明 inherited console handles 在目标环境不可用，本任务停止并
  报告；不得偷偷恢复 `cmd.exe`。
- 回滚只需恢复 `process-runner.ts` 的 Windows spawn-and-wait 分支和相应
  gate/spec；POSIX execve 路径不受影响。
