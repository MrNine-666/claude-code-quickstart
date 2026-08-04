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
- `ls`、`use`、`update`、`tools` 与 `uninstall` 是 management-class verb。它们的 flag 属于 ccq，绝不能传给 Agent。
- `ls`/`use` 默认目标为 Claude。Codex 使用 `--tool codex` 与结构化 Codex core；不写入 Claude settings。
- 显式 `tools update` 强制全新的 detection。Tool id、alias 与 help availability 派生自 `TOOL_DEFINITIONS`。
- destructive 命令需要确认。Non-TTY 模式中，在任何 mutation 前必须提供 `--yes`/`-y`。
- 未知 subcommand 的 help 是 error；通用 help 或已知命令 help 是 success。
- 交互式 quit 必须显式执行：App 通过 `onExit` 报告 intent，entrypoint 请求 `renderer.destroy()`，renderer 的 `onDestroy` callback 退出 process。不得依赖 event loop 变空；后台 detection command 可能仍持有 child-process 或 pipe handle。

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
