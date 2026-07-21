# Design — ccq 自更新与 Windows 自卸载

## 1. Architecture

    GitHub Release API
      -> checkLatestVersion()
      -> SelfUpdatePlan(version, asset, size, sha256)
      -> downloadUpdate(plan, signal)
      -> DownloadedSelfUpdate(plan, targetPath, unique tempPath)
      -> applyUpdate(transaction, restartPolicy)
           ├─ POSIX: validate/mode/fsync -> atomic rename
           └─ Windows: detached helper -> wait parent -> copy/verify -> optional restart

    ccq uninstall
      -> confirm
      -> uninstallSelfExecutable(target)
           ├─ non-current target / POSIX: direct delete
           └─ Windows current exe: detached delete helper

## 2. Data Contracts

    type SelfUpdatePlan = {
      readonly version: string;
      readonly assetName: string;
      readonly downloadUrl: string;
      readonly expectedSize: number;
      readonly expectedSha256: string;
    };

    type DownloadedSelfUpdate = {
      readonly plan: SelfUpdatePlan;
      readonly targetPath: string;
      readonly tempPath: string;
    };

    type ApplySelfUpdateResult =
      | {ok: true; state: "applied" | "scheduled"; targetPath: string}
      | {ok: false; error: SelfUpdateError};

    type SelfUninstallResult =
      | {ok: true; state: "absent" | "deleted" | "scheduled"; targetPath: string; helperPath?: string}
      | {ok: false; error: SelfUninstallError};

download/apply 不再通过隐式固定路径耦合；事务对象是唯一 apply capability。

## 3. Release and Semver

- 复用 semver 模块比较 latest 与 current；invalid semver 返回 check error，不以字符串不等代替升级判断。
- ReleaseAsset 类型增加 size/digest。
- digest 只接受 sha256:HEX，规范化为小写 64 hex。
- 平台映射只接受 win32/darwin 与 x64/arm64；其他组合返回 unsupported。

## 4. Download Transaction

- temp 位于 dirname(target)，名称包含 basename、pid、randomBytes。
- 以排他模式创建，避免跟随预置 symlink。
- response.body 逐块写入，同时累计 byte count 和 createHash("sha256")。
- 组合调用方 AbortSignal 与内部超时；任何异常关闭 handle 并删除本事务 temp。
- 成功前比较 expectedSize/expectedSha256，并将 temp chmod 0755（POSIX）。

## 5. POSIX Apply

1. 确认 transaction target/temp 仍位于预期目录且 temp 存在。
2. 复核 size/hash，防止下载后被替换。
3. chmod temp 0755 并 fsync。
4. rename temp -> target。
5. 返回 applied；rename 后无外部命令或其他可失败步骤。

同目录 rename 保证 macOS/Linux 原子替换；运行中的旧 inode 可继续执行到进程结束。

## 6. Windows Deferred Operations

新增轻量 core/windows-deferred-operation.ts，负责：

- 唯一 helper 文件创建。
- node:child_process.spawn 参数化调用 powershell.exe。
- 等待 spawn/error 事件后返回。
- 共用 retry 常量、日志路径与脱敏错误。

动作脚本分离：

- update helper：Copy-Item、size/hash 验证、可选 RestartAfterApply。
- uninstall helper：Remove-Item、存在性验证、永不 restart。

不把动作拼接为用户输入；所有动态值经 PowerShell 参数传入并使用 LiteralPath。

## 7. Path Identity

抽取或新增 shared executable path helper：

- getCcqExecutablePath 继续表示安装目标。
- getSelfUpdateTargetPath 继续优先当前 ccq 编译产物。
- sameExecutablePath 使用 realpath/native resolve；Windows 归一化大小写与分隔符。
- update.ts 可 re-export 旧函数，避免现有导入破坏。

源码 Bun 进程执行 uninstall 时，process.execPath 是 Bun，不等于安装 ccq，允许直接删除安装目标。

## 8. TUI State

UpdateScreen 调整为：

    checking
    latest
    available(plan)
    downloading(plan)
    cancelling(plan)
    readyToApply(transaction)
    applying(transaction)
    updated(version)
    error(message)

- available -> downloading 需要用户确认。
- readyToApply -> applying 需要第二次确认。
- Esc 只在 downloading/cancelling 触发 AbortController。
- applying 不显示可取消操作。
- Windows scheduled 后 destroy renderer 并退出；helper 依据 restart=true 启动新 TUI。
- POSIX applied 后进入 updated，用户 Enter 时 destroy renderer 再 restart。

## 9. Error Semantics

SelfUpdateError 增加可选 version/asset/digest 诊断，但不得输出二进制内容或用户凭据。scheduled 与 completed 分离：

- CLI Windows update：输出已安排替换，返回 0。
- TUI Windows update：helper scheduled 后退出，最终失败写日志。
- Windows uninstall：输出已安排删除，返回 0。
- spawn 未成功：立即返回 1。

## 10. Test Strategy

### Cross-platform unit/runtime

- fake fetch Release response 与流式 asset。
- semver/asset validation matrix。
- 真实临时文件下载、hash、unique temp、cleanup、POSIX rename/mode。
- dependency injection 捕获 spawn/restart policy。
- OpenTUI testRender 或提取纯 update state reducer 验证交互。

### Windows runtime

- update helper：短锁成功、长锁失败、restart true/false、hash mismatch。
- uninstall helper：当前锁释放后删除、长锁失败、helper cleanup、无 Start-Process。
- 编译产物临时安装后执行 uninstall --yes。

## 11. Compatibility and Rollback

- 公开 CLI 动词与 flags 不变。
- core/update.ts 对必要旧路径函数做 re-export；调用方在同一变更内迁移到事务参数。
- 没有用户数据迁移；失败前旧 binary 不变。
- helper 失败保留日志和必要 temp，用户可重试或手工处理。
