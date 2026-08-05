# 实施计划

## 1. 共享 runner

- [x] 新增 `tui/src/cli/process-runner.ts`，定义可注入 `LaunchRuntime` 与生产
      默认依赖。
- [x] 实现 `Bun.which` absolute path 解析；缺失时保留 spawn/ENOENT 语义。
- [x] 实现 POSIX `process.execve(file, [command, ...args], process.env)`。
- [x] 为 execve experimental warning 添加局部过滤器，并在 fallback 的下一个
      tick 移除。
- [x] 保留 inherited `stdin`/`stdout`/`stderr` 与 child exit code 透传。

## 2. CLI 接入

- [x] 将 `cc.ts` 默认 Claude runner 改为共享 runner。
- [x] 将 `cx.ts` 默认 Codex runner 改为共享 runner。
- [x] 不改变 `runCc`/`runCx` 的校验顺序、第三参数注入 seam、错误文案或返回类型。

## 3. 回归门禁

- [x] 扩展 `tui/scripts/verify-cli-subcommands.mjs` 覆盖 fake POSIX execve、
      execve 抛错 fallback、Windows spawn fallback、绝对路径/argv/env 和真实
      POSIX 子进程替换 probe（Windows 上显式 skip）。
- [x] 如 warning 过滤需要额外断言，在同一门禁中使用子进程捕获 stderr，确认
      `ExperimentalWarning: process.execve` 不泄漏。

## 4. 验证顺序

在任务启动并实现后依次执行：

```powershell
cd tui
bun scripts/verify-cli-subcommands.mjs
bun run typecheck
bun run lint
bun run format:check
bun run verify
bun run check
git diff --check
```

POSIX 环境额外确认真实替换 probe 的 PID、TTY 和退出码；Windows 环境确认
`process.platform === 'win32'` 分支不触发 execve warning。完整 four-target build
若受外部 Bun runtime 下载阻塞，单独记录为环境限制，不降低 focused CLI gate。

本次 Windows 验证已确认 Windows 分支、warning 不泄漏和全部 Bun 门禁；POSIX 真实
替换 probe 在当前主机因没有 zsh/Linux runtime 未执行，需在 macOS/Linux 环境补跑。

## 风险点与回滚点

- `process.execve` 是 Bun experimental API：先验证类型和 warning 过滤，再接入
  默认 runner；若 API 行为变化，保留 spawn fallback 即可回滚到旧行为。
- `Bun.which` 返回 null 或目标在解析后消失时，必须让 fallback 的 ENOENT 继续走
  现有 127 分支，不新增第二套错误文案。
- 任何 provider/profile 校验回归都应只撤回 CLI 接入，不修改 core 解析逻辑。
