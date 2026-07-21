# Implementation Plan — ccq 自更新与 Windows 自卸载

## Preconditions

- 用户已确认 CLI/TUI restart、显式 refresh 和 digest fail-closed 策略。
- 当前任务保持 planning；通过 artifact review 后才能 task.py start。
- 修改前加载 trellis-before-dev、OpenTUI relevant references 和 backend/frontend spec。
- 所有运行时测试设置临时 CCQ_HOME，禁止触碰真实安装。

## Ordered Checklist

### 1. 红灯：Release plan 与版本

- [x] 为 checkLatestVersion 增加 fetch/currentVersion/platform 注入。
- [x] 覆盖 upgrade/equal/downgrade/prerelease/build metadata。
- [x] 覆盖 asset 缺失、unsupported arch、非法 size/digest。
- [x] 确认旧字符串比较实现无法通过。

### 2. 实现 SelfUpdatePlan

- [x] 扩展 ReleaseAsset size/digest 类型并严格解析 sha256。
- [x] 使用 semver 严格大于判断，禁止 downgrade。
- [x] 返回 plan 而不是松散 version/url 字段。
- [x] 保持 checkOnly 零下载。

### 3. 红灯：下载事务

- [x] 覆盖 unique temp、并发、流式 byte/hash、abort/timeout、HTTP error。
- [x] 覆盖 size/digest mismatch 清理与目标不变。
- [x] 覆盖预置 symlink/同名 temp 不被跟随或覆盖。

### 4. 实现流式下载

- [x] 以排他模式在 target 同目录创建随机 temp。
- [x] 流式写入并累计 size/SHA-256。
- [x] 组合调用方 abort 与内部 timeout。
- [x] 返回 DownloadedSelfUpdate；所有失败关闭并清理本事务文件。

### 5. 红灯并修复 POSIX apply

- [x] 注入 rename/chmod/fsync 失败点，断言 rename 前失败旧目标不变。
- [x] apply 接收 transaction 并最终复核 size/hash。
- [x] temp chmod/fsync 后以 rename 作为最后变更步骤。
- [x] 删除 rename 后外部 chmod。

### 6. Windows update helper

- [x] 提取安全 helper spawn 基础设施并等待 spawn/error。
- [x] helper 增加 RestartAfterApply/ExpectedSize/ExpectedSha256。
- [x] restart=false 零 Start-Process；restart=true 验证成功后启动。
- [x] 扩展 test-windows-helper 覆盖短锁/长锁/hash/restart 两策略。

### 7. Windows self-uninstall

- [x] 先写 core self-uninstall 路由与 CLI 输出失败测试。
- [x] 实现 sameExecutablePath 与 deleted/scheduled/absent 结果。
- [x] 实现 PS5.1 uninstall helper：wait/retry/remove/verify/log/self-clean。
- [x] 修改 cli/commands/uninstall.ts，禁止当前 exe 直接 rmSync。
- [x] 新增 test-windows-uninstall-helper runtime test。

### 8. OpenTUI update state

- [x] UpdateScreen 携带 plan/transaction，删除路径重新推导。
- [x] 仅下载阶段响应 Esc cancel，应用阶段更新 hint。
- [x] Windows TUI apply 传 restart=true；CLI 传 false。
- [x] POSIX restart 前先 renderer.destroy。
- [x] 使用纯 reducer 或 testRender 覆盖 available/downloading/ready/applying/restart。

### 9. CLI/help/docs

- [x] CLI update scheduled/applied 文案准确区分。
- [x] CLI uninstall scheduled/deleted 文案准确区分。
- [x] 更新 HELP_UPDATE、HELP_UNINSTALL 与 tui/AGENTS.md。
- [x] 保持 non-TTY confirmation 与退出码。

### 10. CI 与集成

- [x] verify-self-update 改为运行时断言并进入 package verify。
- [x] 新增 verify-cli-uninstall。
- [x] Windows workflow 安装 Bun 并运行两个 helper test。
- [x] Windows smoke 临时安装编译 exe，执行 uninstall --yes 并轮询删除。
- [ ] 运行四平台 build 与父任务集成验收。

## Validation Commands

    cd tui
    bun scripts/verify-self-update.mjs
    bun scripts/verify-cli-uninstall.mjs
    bun run typecheck
    bun run verify
    bun run build
    git -c core.whitespace=cr-at-eol diff --check

Windows：

    bun scripts/test-windows-helper.mjs
    bun scripts/test-windows-uninstall-helper.mjs

## Risky Files and Rollback

| Area | Files | Risk | Rollback Gate |
|---|---|---|---|
| Release plan | core/update.ts, core/semver.ts | invalid version blocks legitimate update | checkOnly matrix |
| Streaming | core/update.ts | handle/temp 泄漏 | temp directory cleanup assertions |
| POSIX apply | core/update.ts | target corruption | byte/mode failure injection |
| Windows shared helper | new core helper, update.ts | spawn or PS5.1 incompatibility | Windows runtime test |
| Self uninstall | self-uninstall.ts, cli command | helper误删/误报 | temp CCQ_HOME compiled smoke |
| TUI state | app.tsx | modal dead state/terminal corruption | reducer/testRender interaction |
| Workflow | build-and-release.yml | CI duration/ordering | targeted Windows job first |

## Completion Gate

LC1-LC11 全部满足并经父任务集成验收前不得归档。规划不授权实施、task.py start、暂存或提交。

## Acceptance Update - 2026-07-17

- Self-update/uninstall 定向门禁、Windows update/uninstall helper 短锁/长锁/重启实测、`bun run typecheck`、`bun run verify` 和 `git diff --check` 全部通过。
- 验收发现并修复 PS5.1 helper 对 `Get-FileHash` 模块自动加载的隐式依赖，改用 .NET SHA-256；同时增加 ready-file 握手，helper 真正开始执行前不得返回 `scheduled`。
- 无图标 Windows x64 编译成功，版本/help smoke 通过。四平台 `bun run build` 仍受 Bun 1.3.14 metadata/目标 runtime 解压故障阻塞。
- 编译产物自卸载 smoke 在当前沙箱内可正确返回 helper 未就绪失败，但沙箱外 detached helper 实测的自动安全审批连续超时；LC11 仍未满足，任务保持 `in_progress`。
