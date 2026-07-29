# 提升 TUI 自更新传输可靠性

## Goal

让 Windows 与 macOS 用户在 TUI 内更新 `ccq` 时，以约为当前三分之一的网络
流量可靠取得新版本；重定向故障、短暂断流、慢速网络或 TUI 重启不能迫使
用户反复从零下载，同时继续保证任意已发布旧版可直接升级、最终可执行文件
完整性和既有 Windows 延迟替换/回滚安全边界。

## Background

- 实测 Windows x64 从已安装 `2.4.1` 更新到 `2.4.2` 时，目标 raw asset
  `ccq-windows-x64.exe` 为 `109262848` 字节，TUI 一直显示 `0%`，随后报告
  `The socket connection was closed unexpectedly`。
- `tui/src/core/self-update.ts:309-311` 在 `fetch()` 返回前只报告初始 0%，
  `:340` 只在写入 chunk 后推进进度；`self-update.ts:355-361` 对任意网络或
  body stream 异常立即删除 temp。因此症状发生在下载阶段，尚未进入 EXE
  应用阶段。
- Bun 1.3.14 自动跟随 `github.com -> release-assets.githubusercontent.com`
  的 302 时可复现 abort、socket closed 和 connect timeout；手动取得签名 CDN
  URL 后可得到正确 `206` Range 数据。
- Windows helper 只在 raw 文件完成 size/SHA-256 校验后启动。
  `self-update.ts:478-510` 先写 ready marker、等待父 `ccq` 退出，再以
  `File.Replace` 最多重试 20 次、每次 250ms；现有短锁、长锁、备份恢复和
  校验后重启门禁均通过。
- Windows x64 v2.4.1 实测 gzip 从 `109264384` 降到 `39921618` 字节，减少
  `63.46%`；当前四个平台构建产物的 Deflate 减少率均约 `63%-65%`。Bun
  1.3.14 内置 gzip 解压能力，不需要外部解压器。
- 当前 Release 精确包含两个安装脚本和四个 raw executable，共 6 个 artifact；
  已发布客户端只认识 raw asset 名称。近 23 天存在 9 个带 Windows x64 binary
  的 Release，真差分若覆盖多个源版本会形成平台乘版本矩阵。
- 当前工作区已有用户未提交的 error 屏 Enter 按阶段重试改动，覆盖
  `tui/src/app.tsx`、`tui/src/state/self-update-state.ts` 和
  `tui/scripts/verify-self-update.mjs`；本任务必须保留并兼容这些改动。

## Requirements

### R1. Universal Direct Upgrade

任何已发布 `ccq` 版本都必须能直接升级到最新版，不要求逐级升级。当前四个
raw executable 的名称和内容继续发布，供旧客户端、初次安装和新客户端的
兼容回退使用；压缩或未来差分只能是可选传输优化，不能成为唯一更新路径。

### R2. Exact Raw And Gzip Release Set

Windows x64/arm64、macOS x64/arm64 各发布一个确定性 gzip 完整包：

```text
ccq-windows-x64.exe.gz
ccq-windows-arm64.exe.gz
ccq-macos-x64.gz
ccq-macos-arm64.gz
```

当前 Release artifact 集合从 6 个扩展为精确 10 个：两个安装脚本、四个 raw
executable 和四个 `.gz` 更新资产。gzip 必须从最终 raw artifact 生成，不能
在图标、版本注入或其他改字节步骤之前生成；构建必须证明 gzip 可重复、可
解压且解压结果与 raw 字节一致。四个平台共享同一协议，不能形成 Windows-only
分叉。安装脚本仍下载 raw，不扩大初次安装改造范围。

### R3. Dual-Integrity Update Plan

`SelfUpdatePlan` 必须同时携带最终 raw target 的 asset/size/SHA-256，以及按
优先级排列的 gzip 与 raw transport 的 URL/size/SHA-256/encoding。raw target
缺失或无有效 digest 时检查阶段失败；gzip 缺失或元数据无效时忽略加速资产并
选择 raw。支持新协议的客户端优先 gzip，且不能从文件名猜测未被 Release API
证明的完整性字段。

### R4. Manual HTTPS Redirects

所有 Release transport 下载必须禁用 Bun 自动重定向，并显式处理最多 5 跳
HTTP 重定向。每一跳都保留 AbortSignal 和 Range header，只接受可解析的 HTTPS
Location；缺失 Location、协议降级、循环或超限必须失败关闭。每次重试从原始
GitHub asset URL 重新取得新签名，不长期缓存易过期 CDN URL。

### R5. Persistent Strict Range Resume

选定 transport（gzip 或 raw）的分片必须保存在 `CCQ_HOME` 可注入的
`~/.ccq/self-update/` 下，身份绑定 schema、版本、平台、asset 名称、encoding、
expected size 和 SHA-256。只有完全匹配当前 plan 且长度合法的分片才能续传；
offset 大于零时必须取得起点/终点/总大小一致的 `206 Content-Range` 才能追加，
不得将 `200`、重叠、空洞或错误总长拼入分片。

网络异常、响应流错误/提前 EOF、408/429 和瞬态 5xx 使用最多 4 次尝试及
250/500/1000ms 可中止退避。连接/读取使用可重置的无进展超时，并保留 60 分钟
总安全上限；慢但持续前进的下载不能被原 5 分钟固定墙钟误杀。网络失败、无
进展/总超时或 TUI 正常退出时安全关闭并保留分片，下次从精确 offset 继续。

### R6. Cache Ownership And Concurrency

显式取消必须删除当前 transport 分片；成功物化 raw transaction 后删除已消费
缓存；新 Release 清理旧 digest，其他无人使用条目最多保留 7 天。损坏、超长、
元数据/digest 不匹配的缓存必须删除。缓存写入必须有 lease/lock 与停滞回收，
两个并发 `ccq` 不能同时追加同一分片，崩溃遗留锁也不能永久阻止更新。

### R7. Gzip Materialization And Raw Fallback

gzip 必须先完整下载并验证 transport size/SHA-256，再流式解压到目标 executable
同目录的唯一 raw transaction temp，同时限制输出不超过 raw expected size 并
计算 raw SHA-256。只有 raw size/digest 完全匹配才能返回
`DownloadedSelfUpdate`；压缩包、解压器或 raw 完整性失败不得触碰目标文件。

gzip 缺失、元数据无效、不可恢复的 transport/解压/完整性失败时，新客户端
自动切换到 raw transport，并明确重置/显示新的网络总量。网络失败或超时留下
的合法 gzip 分片仍应供下一次重试续传；raw fallback 自身也使用同一持久 Range
协议。所有路径最终交付同一种已验证 raw transaction。

### R8. Progress, Cancellation And Manual Retry

UI 进度以当前网络 transport size 为总量。每次公开下载先显示 0；缓存恢复
通过严格响应校验后可跳到已保存 offset，随后在同一 transport 内字节与百分比
单调不减。gzip 切换 raw 是显式 transport 变化，可重置总量/进度并显示回退
提示，不能伪装成同一下载倒退。

caller cancel 必须立即终止当前请求和退避并执行 R6 显式取消清理；超时保留
可续传缓存并保持“下载超时”语义。现有 error 屏 Enter 继续按 check/download/
apply 阶段重试，Esc 关闭行为不变；人工重试复用匹配缓存，而不是重新从零。

### R9. Windows Apply Contract

不得改变 Windows helper 的 ready marker、父进程退出等待、`File.Replace`、
备份恢复、锁重试、postflight 校验或成功后重启协议。TUI 仍只在
`applyUpdate(..., {restartAfterApply: true})` 返回 `scheduled` 后销毁 renderer
并退出；EXE 只能在父进程退出后覆盖。POSIX chmod/fsync/rename 行为继续消费
同一种 raw transaction。

### R10. Durable Contracts And Verification

`installer/contracts/build.json`、Release CI expected list/count/body、构建脚本、
根/TUI 导航与 installer build-release spec 必须一致声明 10 个 artifact。
`ccq-self-lifecycle.md` 必须记录双 transport、手动重定向、持久 Range、超时、
cache、双重完整性和 fallback 契约。门禁必须覆盖真实 gzip roundtrip、严格
Release plan、跨调用续传、并发/TTL/取消清理、fallback、进度、四平台选择和
既有 Windows helper。

## Acceptance Criteria

- [ ] AC1 (R1-R3): Release API fixture 中 raw 为必需 target，gzip 为优先
      transport；任意旧客户端 raw 名称保持不变，新客户端在 gzip 缺失/无效时
      仍可直升，不要求逐版本升级。
- [ ] AC2 (R2, R10): 构建从最终四个 raw executable 生成确定性 `.gz`，重复
      构建字节一致且 roundtrip 等于 raw；contracts、CI、Release body 和 dist
      硬校验且只允许精确 10 个 artifact。
- [ ] AC3 (R4): fixture 证明 manual 302/HTTPS 跟随成功；缺失/无效/非 HTTPS/
      循环/超过 5 跳均失败，Range 和 AbortSignal 在每跳保留。
- [ ] AC4 (R5): 首次调用在 stream error/提前 EOF 后保留分片；新调用从精确
      offset 发出 Range，只有匹配 `206 Content-Range` 才追加并完成，408/429/
      5xx 与退避有界。
- [ ] AC5 (R5, R8): 无进展超时与 60 分钟总上限可中止，持续收到字节不会在
      5 分钟被误杀；恢复进度单调，gzip→raw 回退明确重置 transport 与总量。
- [ ] AC6 (R6): 显式取消、成功、新 Release、损坏/不匹配和超过 7 天分别按
      契约清理；网络失败/超时/TUI 退出保留；并发 lease 阻止交叉写且可回收
      崩溃遗留锁。
- [ ] AC7 (R7): gzip transport 与解压后 raw 分别验证 size/SHA-256；损坏 gzip、
      解压超长/失败、raw digest 不符均不产生 transaction，并可安全回退 raw；
      目标 executable 始终字节不变。
- [ ] AC8 (R8): 当前 error 屏 Enter 按阶段重试改动保留；download retry 复用
      匹配缓存，显式 Esc 取消清理，错误/回退提示不泄露签名 CDN URL。
- [ ] AC9 (R9): POSIX apply 门禁继续通过；Windows helper 的短锁、长锁、
      backup restore、ready handshake 和 restart=true 场景全部通过。
- [ ] AC10 (R10): `bun scripts/verify-self-update.mjs`、installer contract/build
      checks、`bun run check`、`bun run build` 和 `git diff --check` 全部通过，
      durable specs 与 source/gates 一致且不覆盖用户无关改动。

## Out Of Scope

- 当前任务不发布或应用 bsdiff、zstd `--patch-from` 等真差分补丁。
- MSIX/App Installer、Sparkle、包管理器迁移或拆分 Bun runtime/app payload。
- 改变 GitHub Release API、SemVer 优先级或 GitHub digest 格式。
- 使用 PowerShell、curl、BITS 或其他外部下载器替换 Bun fetch。
- 并行分片、多镜像/CDN 或后台静默更新。
- 修改 Windows helper 的原子替换/回滚协议，或重写现有 error 屏交互。

## Deferred

真差分作为独立后续研究/实施任务。先对至少 3 组连续正式最终产物、四个平台
生成 gzip-full、bsdiff 和 zstd `--patch-from` 基准；只有差分包中位数不超过
对应 gzip 的 25%，并证明 patch runtime/内存/回退可接受，才进入产品规划。
无论是否达标，raw 与 gzip 完整包回退继续保留。
