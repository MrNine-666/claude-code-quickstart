# Installer gzip Transport Implementation Plan

## Preconditions

- [x] 读取 installer spec index、platform runtime、Windows core 与 build/release 契约。
- [x] 使用 CodeGraph 和源码核对 Windows/macOS 当前 handoff、下载器与 TUI gzip 参照实现。
- [x] 确认 `build.json` 已拥有四组 raw-to-gzip 映射，任务不改 artifact 清单。
- [x] 确认 locked-file 并行改动已存在，gzip 实施必须在其上增量修改，不得覆盖。
- [x] 确认没有需要用户决定的开放问题。

## Implementation Steps

### 1. Add Windows gzip materialization helper

- [ ] 在 `installer/windows/core/Process.ps1` 增加兼容 PS5.1 的 gzip 解压 helper。
- [ ] 完整关闭 input/gzip/output streams，并在异常/空输出时删除 raw partial。
- [ ] 返回结构化结果，保留可用于最终双失败信息的阶段错误。
- [ ] 使用按 PID 隔离、与 target 同目录的 gzip/raw temp，保持 `File.Replace` 同卷约束。

### 2. Integrate Windows gzip-first/raw-fallback

- [ ] 保留 lock preflight 在所有网络 I/O 之前。
- [ ] 从现有 raw `DownloadUrl` 派生 `.gz` URL，先调用 `Invoke-FileDownload` 下载 gzip temp。
- [ ] gzip 下载或解压失败时清理两个 temp、显示 warning，再调用 raw URL。
- [ ] raw 失败时返回 raw 主错误并附 gzip 阶段上下文。
- [ ] 成功后统一使用现有 raw 非空检查、`Replace-CcqExecutable` 与 PATH 逻辑。
- [ ] 更新“下载 104MB”等会随传输变化的旧注释，避免固化过时大小。

### 3. Add macOS download seam and gzip fallback

- [ ] 在 `installer/macos/core/Process.zsh` 提取窄 `URL -> output` helper，保持现有 curl/wget 参数。
- [ ] 在 `ccq_install_executable` 内派生 `.gz` URL，使用独立 gzip/raw temp。
- [ ] 用系统 `gzip -dc` 完整解压；损坏、截断或空输出进入 raw fallback。
- [ ] raw fallback warning 可见；双失败输出 raw 主错误与 gzip 上下文。
- [ ] 只有完整非空 raw temp 才执行 `chmod +x` 与 `mv -f`；所有失败路径保留原 target。

### 4. Add executable contract coverage

- [ ] 在 `installer/contracts/Test-Contracts.ps1` 注册 `Test-CcqGzipTransportContract`。
- [ ] 用生成 fixture 验证 Windows gzip roundtrip 与 gzip-first/fallback URL 顺序。
- [ ] 覆盖 gzip 下载失败、损坏 gzip、双 transport 失败、temp cleanup 与 target preservation。
- [ ] 增加 macOS zsh behavior probe，使用 mock download seam 覆盖同一矩阵与 byte equality。
- [ ] 在 `installer/build.sh --check` 中接入 macOS probe；无 zsh 的平台显式跳过，macOS 必须执行。
- [ ] 保留/增强 source-shape negative assertions，防止实现退回 raw-only 或绕过现有 replace 流程。

### 5. Update durable specs in Phase 3.3

- [ ] `platform-runtime.md`: 记录 installer gzip-first/raw-fallback、进度与失败语义。
- [ ] `windows-core.md`: 记录 gzip/raw temp 边界和 `Replace-CcqExecutable` 只接收 raw temp。
- [ ] `build-release.md`: 把“installers keep downloading raw”改为 gzip 可选传输、raw 必备回退。
- [ ] 保持 `build.json` 十 artifact 与 `UpdateTransports.GzipAssets` 不变。

## Validation Commands

```powershell
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/windows/Install.ps1 -ListSteps
pwsh -File installer/build.ps1
git diff --check
```

```sh
zsh -n installer/macos/core/Process.zsh
zsh -n installer/macos/Install.zsh
zsh installer/macos/Install.zsh --list-steps
sh installer/build.sh --check
```

当已有 cross-platform runtime artifact 时，也使用现有 `--skip-tui-build` path 构建，验证
两个 single-file installer，而不强制新的 Bun cross-compile。完整构建仍是 Release gate；
任何外部 Bun runtime download/extraction failure 都要与 gzip contract result 分开记录。

## Review Gates

- [x] gzip 保持可选；raw fallback 始终保留。
- [x] 初始 installer 不增加 GitHub Release API/digest dependency。
- [x] `Invoke-FileDownload` behavior 和 caller signature 保持不变。
- [x] Windows lock preflight 与 `Replace-CcqExecutable` rollback behavior 保留。
- [x] 不允许任何 partial gzip/raw file 到达 target path。
- [x] 双失败错误保留 gzip context，但以 raw failure 为主。
- [x] 每个 transport 都使用新的 downloader invocation/progress total。
- [x] 保留 PS5.1 syntax 和 macOS system-only dependency。
- [x] 不包含无关 task file、code、generated artifact、staging、commit 或 archive。

## Completion Evidence

- [x] `pwsh -NoProfile -File installer/contracts/Test-Contracts.ps1`
- [x] Windows PowerShell 5.1 `Parser.ParseFile` 语法检查
- [x] `pwsh -File installer/windows/Install.ps1 -ListSteps`
- [x] Windows PowerShell 5.1 `Install.ps1 -ListSteps`
- [x] Windows gzip roundtrip、CRC 损坏和传输回退探针
- [x] `git diff --check`（仅报告工作区 LF/CRLF 转换提示）
- [x] 源码/合同确认 macOS zsh probe 与 `build.sh --check` 已接线

原生 zsh/macOS 行为探针因当前 Windows 环境缺少 zsh 未执行；不能将该环境限制
误报为实现失败。

## Rollback Points

- 由于 raw asset 仍会发布，runtime change 可以独立于 spec/test change 回滚。
- 如果某个平台实现未通过 behavior probe，只回滚该平台 chunk 并保持 task open，不要降低共享
  验收标准。
- 不要回滚或重写重叠 Windows file 中已有的 locked-file change。
