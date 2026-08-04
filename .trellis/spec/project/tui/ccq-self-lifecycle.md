# ccq Self-Lifecycle Contract

## 1. Scope / Trigger

当代码检查、下载、替换、重启或卸载 `ccq` executable 时适用此合同。流程跨越外部 Release API、filesystem、CLI/TUI 调用方及平台特定的进程语义。

被修改的 executable 可能就是当前进程。进程存活期间，绝不要假设可写路径同时可替换或可删除。

## 2. Signatures

```typescript
checkLatestVersion(deps?): Promise<CheckLatestVersionResult>
downloadUpdate(
  plan: SelfUpdatePlan,
  signal?: AbortSignal,
  deps?: DownloadUpdateDeps
): Promise<DownloadUpdateResult>
applyUpdate(transaction: DownloadedSelfUpdate, options?): Promise<ApplySelfUpdateResult>
restartExecutable(targetPath?, spawnProcess?): Promise<ApplySelfUpdateResult>

uninstallSelfExecutable(targetPath, deps?): Promise<SelfUninstallResult>
```

CLI 策略：

```text
ccq update [--check]       # CLI passes restartAfterApply=false
ccq uninstall [--yes|-y]  # Windows current exe returns scheduled
```

TUI 策略：应用已下载 transaction 时传入 `restartAfterApply=true`；在 process exit 或 POSIX restart spawn 前必须完成 renderer cleanup。

## 3. Contracts

`SelfUpdatePlan` 是不可变的 Release capability。最终 executable 完整性与网络传输完整性是独立信任边界，不得相互推断，也不得从文件名推断。

```typescript
type SelfUpdateAsset = {
  readonly assetName: string;
  readonly downloadUrl: string;
  readonly expectedSize: number;
  readonly expectedSha256: string; // normalized 64 lowercase hex
};

type SelfUpdateTransport = SelfUpdateAsset & {
  readonly encoding: 'gzip' | 'identity';
};

type SelfUpdatePlan = {
  readonly version: string;
  readonly target: SelfUpdateAsset;              // always the raw executable
  readonly transports: readonly SelfUpdateTransport[]; // priority order
};
```

没有有效 raw asset 时，`checkLatestVersion` fail closed，并从它合成 `identity` transport。有效的 `<asset>.gz` 成为第一传输；缺失或格式错误的 gzip 条目会被忽略，以便旧版和回滚 Release 仍可直接升级。Apply 代码只从 `plan.target` 读取完整性事实，绝不接触压缩文件。

`DownloadedSelfUpdate` 将已验证 plan 绑定到唯一 temp file 及其 target。`applyUpdate` 必须消费此对象；调用方不得重建 temp path，也不得在阶段间传递裸 URL。

```typescript
type DownloadedSelfUpdate = {
  readonly plan: SelfUpdatePlan;
  readonly targetPath: string;
  readonly tempPath: string;
};

type DownloadUpdateProgress = {
  readonly downloadedBytes: number;
  readonly totalBytes: number;   // current transport.expectedSize
  readonly percentage: number;   // integer, clamped to 0..100
  readonly assetName: string;    // which transport is on the wire
  readonly encoding: 'gzip' | 'identity';
};

type DownloadUpdateDeps = {
  // Other test seams omitted here.
  readonly onProgress?: (progress: DownloadUpdateProgress) => void;
};
```

### Transport Layer

- 每个 Release transport download 都禁用自动重定向，并自行跟随最多五个 HTTPS hop。Bun 从 `github.com` 到 `release-assets.githubusercontent.com` 的自动重定向会在首个 body chunk 前中止，因此每个 hop 都必须显式发起，同时保留 Range header 和 AbortSignal。缺失 `Location`、无法解析的值、协议降级、循环或超限链均 fail closed。每次重试都从原始 GitHub URL 重新开始，以获取新的签名 CDN 地址。
- Transport partials 位于 `selfUpdateCacheDir()`（`~/.ccq/self-update`，可注入 `CCQ_HOME`）。每项按 transport digest 建键，并包含 `metadata.json`、`payload.part` 和 `lease.json`。Metadata 绑定 schema、version、platform、asset name、encoding、transport size/digest 与 target digest；任何不匹配、超大 payload 或格式错误条目都会丢弃。追加前重新计算已有字节的 hash，使最终 digest 保持权威。
- offset 为零时接受成功的完整响应。offset > 0 时，响应必须为 `206`，且 `Content-Range` start 等于 offset、end 等于 `expectedSize - 1`、total 等于 `expectedSize`；可选的 `Content-Length` 必须等于剩余范围。忽略 Range 的 `200` 会使 partial 失效，并从零重新开始，而不是追加。
- 网络错误、body-stream 错误、提前 EOF、408/429 和临时 5xx 最多重试四次，退避为可中止的 250/500/1000ms。调用方取消、无效 redirect/range、永久 4xx 和完整性失败不得在同一 transport 内重试。可重置的无进度计时器加 60 分钟总上限取代固定 wall clock，因此缓慢但持续推进的下载不会被杀死。
- Cache lease 创建具有排他性，并带 heartbeat 与过期回收；两个并发 `ccq` 进程绝不会向同一 partial 追加，崩溃的 owner 也不会永久阻塞更新。Writer 持有 lease 直到最终 transport 验证、raw materialization 和 cache cleanup；cleanup 绝不删除仍由存活进程拥有的条目。显式取消删除当前条目；网络失败、超时和正常退出保留条目以便恢复。新 Release 丢弃非当前 digest，空闲条目七天后过期。
- 完成的 transport 必须先按自身 size/SHA-256 验证，再物化到
  `uniqueTempUpdatePath(targetPath)`：gzip 通过 gunzip 流式处理，identity 直接流式
  写入。输出上限为 `plan.target.expectedSize`，只有与 target size 和 SHA-256
  完全一致后才返回 `DownloadedSelfUpdate`。只有有效 raw transaction 存在后才删除
  已消费的 cache；物化失败时删除 raw temp 和无效 transport entry，下一步选择 raw
  transport。不会提取 archive path，因此 gzip 不增加 path-traversal 面。
- 进度报告当前网络 transport 字节，而不是解压后的字节，并携带 transport asset
  name 与 encoding。验证通过的 resume 报告 cached offset，并在单个 transport 内
  保持单调；gzip-to-raw fallback 是显式的 transport 变化，会重置 total。

- 临时文件位于 target 目录，使用排他创建，并包含 pid 与密码学随机值。
- 下载以流式方式进行，同时计算字节数和 SHA-256。
- 进度从零开始，在单个 transport 内不下降，并限制为整数百分比变化。只有严格
  验证 `206 Content-Range` 后才发布 resumed offset。`100%` 事件仅表示声明的
  字节已全部写入；size 和 SHA-256 验证完成前不能视为成功。TUI 在下载和取消期间
  都在 `self-update-state.ts` 保留最新进度，并渲染固定宽度进度条及
  已下载/总字节数。
- POSIX 在同目录 `rename` 前执行 `chmod(0755)` 和 `fsync`。
- Windows 写入 ASCII-compatible PS5.1 helper，等待 parent pid，重新验证 size/hash，
  重试操作并自删除。target 存在时使用同目录
  `[System.IO.File]::Replace(temp, target, backup, true)` 替换；绝不能对运行中的
  target 使用 `Copy-Item -Force`。替换失败保留旧 target 和诊断 temp；替换后验证
  失败时先恢复 backup 再报告失败，成功时删除 backup。哈希通过文件流上的
  `System.Security.Cryptography.SHA256` 计算；helper script 不得依赖 `Get-FileHash`
  或 PowerShell module 自动加载。
- Windows 上 Bun 1.3.14 会把 `detached: true` child 保留在 close 时终止的 job 中
  通过 `cmd.exe /d /c start "" /b` 启动 helper，并等待 cmd bootstrap，不依赖 Bun/`node:child_process` 的 detached 语义。将 PowerShell 调用作为 UTF-16LE `-EncodedCommand` 传递，避免用户路径以原始元字符穿过 cmd parser。
- 只有在 cmd bootstrap 以零退出且 helper 在等待父进程前写入 ready file 后才报告 `scheduled`。缺失 ready file 是启动失败，不是尽力而为的警告。
- Windows update 仅在存在 `RestartAfterApply` 时重启。Windows uninstall 绝不启动进程。
- Helper 日志不得包含 target/temp 路径或原始异常消息。

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| current/latest 是无效 SemVer | `check` error；零下载 |
| latest 版本相等或优先级更低 | `hasUpdate=false`；零下载 |
| 不支持的平台/架构 | 结构化 `check` error |
| 缺失 asset、非正整数 size、缺失/无效 SHA-256 | `check` 中 fail closed |
| 可重试 HTTP/network/body failure 或 timeout | `download` error；保留有效 transport partial 以便恢复 |
| 调用方取消 | `download` cancellation；删除当前 transport cache entry |
| 磁盘写入/fsync、无效 redirect/range 或完整性失败 | permanent transport failure；绝不追加或重试不安全字节 |
| 下载 size/hash 不匹配 | `download` error；target 字节保持不变 |
| progress callback 到达 `100%` 后哈希不匹配 | `download` error；绝不转为 ready/apply |
| temp path 不属于 target directory/prefix | 在修改 target 前返回 `apply` error |
| apply 时 size/hash 不匹配 | `apply` error；保留 target 和诊断 temp |
| 修改前 apply transaction temp 缺失/无效 | 带 `retryStage=download` 的 `apply` error；UI 不得无限重试同一无效 transaction |
| Windows helper spawn 发出异步 `error` | failure，绝不报告 `scheduled` |
| Windows helper bootstrap 非零退出或缺少 ready | failure，绝不报告 `scheduled` |
| `Get-FileHash` 缺失或未自动加载 | helper 仍通过 .NET SHA-256 实现验证两个文件 |
| Windows target 在所有重试期间保持锁定 | 旧 target 与已验证 temp 保持逐字节一致 |
| Windows 替换成功但 postflight 失败 | 恢复 backup；不要重启 target |
| 卸载 Windows 当前 exe | `scheduled`；target 保留到父进程退出 |
| 非当前进程或 POSIX uninstall | `deleted` 或结构化 error |

## 5. Good / Base / Bad Cases

- 良好：匹配平台 asset 的稳定版 `2.5.0` 在流式 size/hash 验证后将 `2.4.0` 升级，TUI 显示单调递增的真实字节进度。
- 基线：`2.4.0+build-b` 不升级 `2.4.0+build-a`；build metadata 没有优先级。`2.4.0-beta.10` 比 `2.4.0-beta.2` 新。
- 错误：没有 `digest` 的 Release、固定共享 `.ccq-update.tmp` 或 Windows `rmSync(process.execPath)` 必须让测试失败。
- 错误：使用 `Copy-Item -Force` 原地覆盖 `ccq.exe`，复制中断或 postflight 验证失败可能留下截断 executable。
- 错误：helper 仅被调度却打印“updated”或“deleted”，这是用户可见合同违规。

## 6. Tests Required

- Release 矩阵：升级/相等/降级/prerelease/build metadata、无效 SemVer、asset/size/digest/platform failures，以及零下载 check-only。
- Download runtime：100 MiB 分块响应、并发唯一 temp path、取消/HTTP/size/hash 清理、
  target 不变断言，以及初始零值、字节单调和最终 100 的进度断言。
- OpenTUI progress render：在固定终端尺寸使用真实 headless renderer，断言进度条、
  百分比和 downloaded/total byte 文本。
- POSIX apply：验证成功时的字节/权限，以及 rename 前验证失败仍保留 target bytes。
- Spawn unit test：在 `spawn()` 返回后发出 `error` 并断言失败。
- Windows native update helper：短锁、长锁、哈希验证、原子替换、重试耗尽后保留旧
  target/temp、`restart=false` 和 `restart=true` marker 执行。通过
  `powershell.exe -NoProfile -File` 运行生成的 helper，断言其源码包含 .NET
  SHA-256/`File.Replace` 路径，且不依赖 `Get-FileHash` 或原地 `Copy-Item -Force`。
- Windows native uninstall helper：短锁删除、长锁失败、helper 清理以及不使用
  `Start-Process`。
- Compiled Windows smoke：复制到临时 `CCQ_HOME/.local/bin/ccq.exe`，运行
  `uninstall --yes`，轮询 target/helper 消失，不依赖 TUI 文本。

所有测试必须使用临时 `CCQ_HOME`，绝不修改真实安装。

## 7. Wrong vs Correct

### Wrong

```typescript
await downloadUpdate(downloadUrl); // writes a fixed shared temp path
await applyUpdate();               // re-derives paths and may consume another run
rmSync(process.execPath);          // fails for a running Windows image
Get-FileHash $TempPath;            // relies on module auto-loading in the helper
Copy-Item $TempPath $TargetPath -Force; // can corrupt the old target in place
```

### Correct

```typescript
const downloaded = await downloadUpdate(info.plan, signal, {
  onProgress: progress => dispatch({type: 'downloadProgress', progress})
});
if (!downloaded.ok) return downloaded;

const applied = await applyUpdate(downloaded.transaction, {
  restartAfterApply: caller === 'tui'
});

const uninstalled = await uninstallSelfExecutable(targetPath);
// Report scheduled separately from deleted/applied.

// Generated PS5.1 helper: stream the file through
// System.Security.Cryptography.SHA256 and dispose both objects in finally.
// After the parent exits and temp verifies:
// [System.IO.File]::Replace($TempPath, $TargetPath, $BackupPath, $true)
// Verify the target, restore $BackupPath on failure, then restart if requested.
```
