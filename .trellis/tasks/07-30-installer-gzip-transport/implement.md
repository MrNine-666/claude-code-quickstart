# 执行计划 - installer-gzip-transport

## Preconditions

- [x] 读取 installer spec index、platform runtime、Windows core 与 build/release 契约。
- [x] 使用 CodeGraph 和源码核对 Windows/macOS 当前 handoff、下载器与 TUI gzip 参照实现。
- [x] 确认 `build.json` 已拥有四组 raw-to-gzip 映射，任务不改 artifact 清单。
- [x] 确认 locked-file 并行改动已存在，gzip 实施必须在其上增量修改，不得覆盖。
- [x] 确认没有需要用户决定的开放问题。

## Implementation Steps

### 1. Add Windows gzip materialization helper

- [ ] 在 `installer/windows/core/Process.ps1` 增加 PS5.1-compatible gzip 解压 helper。
- [ ] 完整关闭 input/gzip/output streams，并在异常/空输出时删除 raw partial。
- [ ] 返回结构化结果，保留可用于最终双失败信息的阶段错误。
- [ ] 用 PID-scoped、target 同目录的 gzip/raw temp，保持 `File.Replace` 同卷约束。

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

When cross-platform runtime artifacts are already available, also build with the existing `--skip-tui-build` path to
verify both single-file installers without forcing a new Bun cross-compile. A full build remains the Release gate; any
external Bun runtime download/extraction failure must be recorded separately from gzip contract results.

## Review Gates

- [ ] gzip remains optional; raw fallback is always retained.
- [ ] no GitHub Release API/digest dependency is added to initial installers.
- [ ] `Invoke-FileDownload` behavior and caller signature remain unchanged.
- [ ] Windows lock preflight and `Replace-CcqExecutable` rollback behavior are preserved.
- [ ] no partial gzip/raw file can reach the target path.
- [ ] both-failure errors retain gzip context but make raw failure primary.
- [ ] each transport gets a fresh downloader invocation/progress total.
- [ ] PS5.1 syntax and macOS system-only dependencies are preserved.
- [ ] no unrelated task files, code, generated artifacts, staging, commits, or archives are included.

## Rollback Points

- Runtime changes can be reverted independently from spec/test changes because raw assets remain published.
- If a platform implementation fails its behavior probe, revert only that platform chunk and keep the task open; do not
  weaken the shared acceptance criteria.
- Do not revert or rewrite the existing locked-file changes in overlapping Windows files.
