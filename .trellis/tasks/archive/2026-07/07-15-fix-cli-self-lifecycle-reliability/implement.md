# Implementation Plan — CLI 与 ccq 自生命周期可靠性父任务

## Preconditions

- 三项用户可见策略已确认：CLI update 不启动 TUI、显式 tools update 强制刷新、digest fail closed。
- 当前供应商任务保持 active；本父任务及子任务保持 planning，用户审阅后才能 task.py start。
- 实施继续在 main checkout，禁止创建常规 worktree。
- 开始任何代码修改前加载 trellis-before-dev，并保护现有未提交修改。

## Parent Checklist

### 1. 子任务 1：CLI 命令契约

- [ ] 先补 cc/cx 混合双横线透传失败测试。
- [ ] 补未知 help、非法 flag 和退出码测试。
- [ ] 将工具 canonical id/alias/可用列表改为 registry 单一派生。
- [ ] 补 Trellis 解析并让显式 tools update 强制刷新。
- [ ] 同步 CLI help 与定向 verify。

### 2. 子任务 2：自生命周期

- [ ] 先补 semver 防降级、digest、size、唯一事务和原子替换失败测试。
- [ ] 引入 Release plan 与 DownloadedUpdate 事务。
- [ ] 实现流式下载、超时/取消、size/SHA-256 校验与事务清理。
- [ ] 修复 POSIX apply 和 Windows update restart policy。
- [ ] 实现 Windows 延迟自卸载 helper 与 scheduled 结果。
- [ ] 修复 OpenTUI apply/cancel/restart 时序。

### 3. 父任务集成

- [ ] 合并两子任务的 help、AGENTS 和 package verify 变更，消除重复事实源。
- [ ] 接入 Windows update/uninstall helper runtime test。
- [ ] 接入 Windows 编译产物 update/uninstall smoke。
- [ ] 对照父任务 AC1-AC10 做逐项人工验收。

## Validation Commands

    cd tui
    bun run typecheck
    bun scripts/verify-cli-subcommands.mjs
    bun scripts/verify-cli-uninstall.mjs
    bun scripts/verify-self-update.mjs
    bun run verify
    bun run build
    git -c core.whitespace=cr-at-eol diff --check

Windows CI 额外执行：

    bun scripts/test-windows-helper.mjs
    bun scripts/test-windows-uninstall-helper.mjs

并用编译后的临时 CCQ_HOME/.local/bin/ccq.exe 执行 uninstall --yes，轮询确认目标消失且没有新 TUI。

## Risk and Rollback Points

| Step | Risk | Gate | Rollback |
|---|---|---|---|
| CLI parser | 透传分隔符处理改变底层 argv | fake runner 精确数组断言 | 回滚 parsePassthrough |
| Tool registry | import/alias 循环或帮助漂移 | 8 组件矩阵 + typecheck | 保留 registry 字段，回滚 CLI 消费 |
| Download transaction | 大文件流/取消留下临时文件 | 临时目录真实文件测试 | 不调用 apply，清理事务 |
| POSIX apply | rename 前后时序错误 | 旧/新目标字节与 mode 断言 | 旧目标未动即可重试 |
| Windows helper | 父进程等待、锁释放或 spawn 失败 | Windows runtime test | 保留目标与日志 |
| TUI restart | renderer 清理后重启失败 | OpenTUI interaction test | 输出手动重启提示 |

## Completion Gate

只有两个子任务各自 acceptance 全部通过、父任务 AC1-AC10 全部验证、四平台构建与 Windows smoke 通过后，才能进入 Trellis Phase 3。规划批准不等于实施授权，本文件不授权 task.py start、暂存或提交。
