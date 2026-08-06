# Implementation Plan

## 1. Lock The New Contract In Focused Tests

- [x] 更新 `tui/scripts/verify-cli-subcommands.mjs` 的 fake Windows runtime：
      `exited` 永不 settle，runner 仍立即返回 `0`。
- [x] 断言 Windows spawn 只收到 absolute `.exe`、完整 args、
      `detached: true` 与 inherited stdio，并且 `unref()` 恰好调用一次。
- [x] 增加 direct `.exe`、Claude npm `.cmd` 解析、Codex user-local fallback、
      无 direct executable 和同步 spawn failure 矩阵。
- [x] 保留并运行现有 POSIX execve、fallback 和 child exit-code 断言。

## 2. Implement Direct Executable Resolution

- [x] 在 `tui/src/cli/process-runner.ts` 附近实现 Windows-only resolver；逻辑足够
      独立时使用同目录窄模块，不扩散到 core/installer。
- [x] 复用 `Bun.which()`，普通 `.exe` 直接作为候选。
- [x] 对标准 npm wrapper 只读解析其明确的 `.exe` target，规范化并验证存在；
      不执行 `.cmd` / `.bat` / `.ps1`。
- [x] 对 WindowsApps Codex 候选查找 user-local native `codex.exe`，以确定性规则
      选择；无 direct candidate 时 fail closed。
- [x] 确保 resolver 不调用 `cmd.exe`、PowerShell、`where.exe`、
      `ShellExecuteEx` 或任何探测 child。

## 3. Change Windows Launch Semantics

- [x] 扩展 `LaunchRuntime` / process seam，支持 `detached` 与 `unref()`。
- [x] Windows 分支直接
      `spawn([absoluteExe, ...args], {stdio: inherit, detached: true})`。
- [x] process handle 返回后调用 `unref()` 并立即返回 `0`；不得访问或 await
      `exited`。
- [x] 同步 resolver/spawn error 继续由 `runCc` / `runCx` 映射为现有友好
      `127` / `1`。
- [x] 更新 `cc.ts` / `cx.ts` 的注释和测试描述，保留所有启动前校验与 args。

## 4. Native Windows Verification

- [x] 运行 source-mode focused gate 和 typecheck。
- [x] 用真实 Claude npm wrapper 证明解析后的 `claude.exe --version` 直接启动，
      进程树无 `cmd.exe`。
- [x] 用 user-local native `codex.exe --version` 证明 WindowsApps fallback
      选择正确，进程树无 shell。
- [x] 使用阻塞 native fixture 验证父 `ccq.exe` 先退出、child 继续存活，且
      `ccq.exe` 不再锁住自身映像。临时 `ping.exe` native fixture 作为
      `codex.exe` 运行时观测到 parent exit、child PID/path 存活，并成功覆盖
      临时 `ccq.exe` 映像；系统既有 `cmd.exe` 不作为全局进程断言。
- [x] 构建 Windows x64 compiled executable 后重复 launch smoke；真实 compiled
      `cx -- --version` 返回 0 并输出 Codex 版本，detached native fixture smoke
      也确认 parent 先退出、child 仍运行。compiled smoke 使用 user-local
      `LOCALAPPDATA` fallback，避免 Bun 重写 PATH 造成误测。

## 5. Synchronize Durable Contract

- [x] 更新 `.trellis/spec/project/tui/cli-contract.md`：Windows direct
      executable resolution、detached/unref、immediate `0` 和不透传最终结果。
- [x] 更新 `.trellis/spec/backend/error-handling.md` 中 launch-class 规则：POSIX
      透传 child code，Windows 只报告同步发起失败。
- [x] 确认 `.trellis/spec/project/tui/ccq-self-lifecycle.md` 不需要本任务改动；
      installer/self-update 仍只受“会话期间不再锁定 ccq.exe”的结果影响。

## 6. Quality Gates

```powershell
Set-Location tui
bun scripts/verify-cli-subcommands.mjs
bun run typecheck
bun run lint
bun run format:check
bun run verify
bun run check
Set-Location ..
git diff --check
```

Windows compiled smoke 另外记录 Bun version、解析到的 absolute Agent executable、
`ccq.exe` 退出时序、child 存活和该 child 父链中无本次新增的 `cmd.exe`；系统中
预先存在的无关 `cmd.exe` 不作为失败依据。

## Risk And Rollback Points

- 最高风险是 Windows console handle 在 detached parent 退出后的交互行为；native
  smoke 未通过时停止，不允许以 `cmd.exe` 兜底。
- Wrapper 解析只接受窄的 npm launcher 形状；任何不确定内容都 fail closed，不执行
  wrapper。
- WindowsApps 仅有受保护入口且无 user-local native executable 时返回错误，这是
  “no shell” 决策的显式兼容性边界。
- 不触碰 installer、PATH、uninstall 或 self-update；发现需要这些改动时返回规划
  阶段，不扩大本子任务。
