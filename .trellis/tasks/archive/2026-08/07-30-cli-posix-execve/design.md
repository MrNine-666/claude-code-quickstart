# 技术设计

## 边界与所有权

新增 `tui/src/cli/process-runner.ts` 作为 CLI 启动类命令的 process-image owner。
它只负责三件事：解析 executable 路径、尝试 POSIX `process.execve`、以及在不能
替换时用 inherited-stdio `Bun.spawn` 等待退出码。Provider/Codex profile 校验仍
归 `cc.ts`/`cx.ts` 及现有 core 所有，不能搬到 runner。

`cc.ts` 和 `cx.ts` 的现有 `ClaudeRunner` / `CodexRunner` 类型与第三参数注入
保持不变；它们的默认实现只改为调用共享 runner。这样已有的 CLI 合同测试仍可
注入 fake runner，新增 process-image 行为则通过 runner 的 runtime seam 测试。

## Runtime seam

`process-runner.ts` 暴露一个窄 runtime 依赖：

```ts
type LaunchRuntime = {
  platform: NodeJS.Platform;
  which(command: string): string | null;
  execve?: (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never;
  spawn(argv: string[], options: {stdio: ['inherit', 'inherit', 'inherit']}): {
    exited: Promise<number>;
  };
};
```

生产默认值直接绑定 `process.platform`、`Bun.which`、`process.execve` 和
`Bun.spawn`。测试可以提供 fake runtime，不需要 monkey-patch 全局 `process` 或
真实启动 claude/codex。

## 调用流程

```text
runCc/runCx 已完成 provider/profile 校验
        |
        v
runWithInheritedTty(command, args)
        |
        +-- win32 / 无 execve / which 返回 null ------> Bun.spawn([command, ...args])
        |
        +-- POSIX + absolute executable path
                |
                +-- 安装局部 warning filter
                +-- process.execve(path, [command, ...args], process.env)
                        |
                        +-- 成功：当前 PID/TTY 由 Agent 接管，调用不会返回
                        +-- 抛错：nextTick 移除 filter，再走 Bun.spawn fallback
```

`Bun.which` 的结果作为 execve 的 absolute file；找不到时不自行拼接路径，直接
走 spawn，让现有调用方把 ENOENT 映射成退出码 127 和原有友好文案。execve 的
argv[0] 继续使用 `claude`/`codex`，后续 token 原序透传。显式传入
`process.env`，避免遗漏运行时环境变量。

## Warning 处理

Bun 1.3.14 的 `process.execve` 会产生 experimental warning。runner 在一次
execve 尝试前安装 `process.on('warning')` 监听器，只吞掉名称为
`ExperimentalWarning` 且消息包含 `process.execve` 的事件；其他 warning 仍以
stderr 简短输出。execve 抛错或意外返回后使用 `process.nextTick` 移除监听器，
避免异步 warning 在 fallback 期间泄漏。不会设置 `NODE_NO_WARNINGS`，所以不会
改变目标 Agent 的 warning 行为。

## 错误与兼容性

- 所有 provider/profile 白名单、存在性和路径解析发生在 execve 前，保持现有错误
  文案与退出码。
- POSIX execve 失败不改变用户可用性：spawn fallback 仍继承三路 stdio 并透传
  child exit code。
- Windows 在平台分支中永不访问 `process.execve`，因此行为与当前 spawn 路径
  一致，也不会触发 experimental warning。
- 如果 `which` 或 execve 抛出异常，runner 不覆盖原错误；fallback 的异常由
  `runCc`/`runCx` 继续按既有 ENOENT / generic startup 分支处理。

## 测试设计

扩展 `tui/scripts/verify-cli-subcommands.mjs`：

1. fake POSIX runtime：断言 `which` 返回的绝对路径、argv 顺序、完整 env，execve
   抛错后 spawn 被调用且退出码透传。
2. fake Windows runtime：断言不调用 execve，直接 inherited-stdio spawn，退出码
   原样返回。
3. 非 Windows 的真实替换 probe：父 probe 记录 PID，使用临时 executable 脚本写
   入 PID/argv/env 并返回固定退出码；子 probe 的退出码与脚本记录证明 execve
   成功后没有 Bun 父进程继续等待。
4. 保留已有 `runCc`/`runCx` fake runner 测试，继续覆盖校验、profile 参数和
   passthrough，不把 executable 解析测试混入 provider 事实源。

## 非目标与回滚

不修改 Windows shim、安装器、CLI argv parser、provider/Codex core 或 help 文案。
如果 POSIX probe 或 warning gate 失败，只需回退 `process-runner.ts`、`cc.ts`、
`cx.ts` 和 CLI gate 的本任务改动，现有 fake runner 契约仍可独立运行。
