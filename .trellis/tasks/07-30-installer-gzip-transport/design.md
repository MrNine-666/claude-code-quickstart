# Installer gzip Transport Design

## 1. Design Boundary

调用方继续构造并传入 raw asset URL：

- Windows: `Confirm-CcqExecutableDownload -> Install-CcqExecutable(DownloadUrl)`
- macOS: `ccq_confirm_executable_download -> ccq_install_executable(download_url)`

两个安装函数在内部通过追加 `.gz` 派生首选传输 URL。这样不改变版本选择、架构映射、
旧 Release raw URL、手动安装提示或 `build.json` 文件名契约，也不需要访问 GitHub
Release API。

预计修改边界：

- `installer/windows/core/Process.ps1`
- `installer/macos/core/Process.zsh`
- `installer/contracts/Test-Contracts.ps1`
- macOS 行为 probe 及其 `installer/build.sh --check` 接线（若采用独立 zsh probe）
- Phase 3.3 更新 `.trellis/spec/project/installer/{platform-runtime,windows-core,build-release}.md`

明确不改：`installer/windows/core/Net.ps1`、`installer/contracts/build.json`、TUI
self-update、`Replace-CcqExecutable` 的替换/回滚语义。

## 2. Shared Transport State Machine

```text
rawUrl
  -> gzipUrl = rawUrl + ".gz"
  -> download gzip to gzipTemp
       -> success: decompress completely to rawTemp
            -> non-empty: selected = gzip
            -> corrupt/empty: clean gzipTemp + rawTemp, warn, continue
       -> failure: clean gzipTemp + rawTemp, warn, continue
  -> download rawUrl directly to rawTemp
       -> success + non-empty: selected = raw
       -> failure: clean all temps, return raw error + gzip context
  -> existing platform install/replace path consumes rawTemp
```

关键不变量：最终替换函数只接触完整的 raw temp。gzip 字节永远不写入最终路径。

## 3. Windows Design

### 3.1 Placement and paths

保留 locked-file 任务已落地的顺序：先执行占用预检，再创建目标目录，再进行任何下载。
在目标目录使用两个独立临时路径：

```text
rawTemp  = <ccqPath>.download.<PID>
gzipTemp = <rawTemp>.gz
```

raw 临时文件继续与 target 同目录，以满足后续 `File.Replace` 同卷约束。进入新传输前先只
清理本事务的两个 temp，不碰 target/backup。

### 3.2 Decompression helper

在 `Process.ps1` 增加一个窄 helper，例如 `Expand-CcqGzipFile`：

- 输入 gzip temp 和 raw temp；输出结构化 `Success/ErrorMessage/OutputSize`。
- 用 `FileStream` 打开输入，`GzipStream(Decompress)` 完整复制到以 `CreateNew` 创建的
  raw temp。
- 所有 stream 在 `finally` 中关闭；异常不向外泄漏未关闭句柄。
- 完整读取后检查 raw temp 存在且长度大于 0。截断、CRC 错误、写入失败或空输出均
  返回失败并删除 raw temp。
- helper 不负责下载、warning 或替换，避免把 transport policy 藏进解压工具。

`System.IO.Compression.GzipStream` 与 `Stream.CopyTo` 可用于 PowerShell 5.1/.NET
Framework，不使用 `Expand-Archive` 或 PowerShell 7 API。

### 3.3 Download and fallback

`Install-CcqExecutable` 仍调用现有 `Invoke-FileDownload`：

1. 用 `$gzipUrl`、`$gzipTemp` 调一次，description 明确为 gzip 传输资产。
2. 下载成功后调用解压 helper；成功则删除 gzip temp，并继续现有非空校验。
3. gzip 下载或解压失败时记录阶段与错误，清理两个 temp，输出 warning。
4. 用原始 `$DownloadUrl`、`$rawTemp` 再调一次 `Invoke-FileDownload`。
5. raw 失败时抛出以 raw 错误为主、附带 gzip 上下文的安装错误。
6. raw temp 成功后不分来源，统一进入现有 `Replace-CcqExecutable`。

`Invoke-FileDownload` 每次从当前 HTTP response 读取 `ContentLength`，因此第二次调用
会自然把进度重置为 raw transport；无需修改通用下载器。

## 4. macOS Design

### 4.1 Download seam

从当前 `ccq_install_executable` 内联 curl/wget 块提取一个仅负责“URL -> 指定 temp”的
私有 helper，例如 `ccq_download_file`。它保持现有选择顺序和参数：

- 优先 `curl -fL --progress-bar --connect-timeout 20 --max-time 600`
- 否则 `wget --show-progress --progress=bar:force --timeout=20 --tries=3`
- 两者都不存在时失败
- 失败时只删除本次 output，不修改 target

这不是通用下载框架重构；helper 只为同一安装函数的 gzip/raw 两次传输消除重复，并提供
可替换的行为测试缝。

### 4.2 Decompression and fallback

使用同目录 `rawTemp=<ccqPath>.download.$$` 与 `gzipTemp=<rawTemp>.gz`：

1. `ccq_download_file "${download_url}.gz" "${gzip_temp}"`。
2. 下载成功后执行系统 `gzip -dc -- "${gzip_temp}" > "${raw_temp}"`，完整读取并依赖
   gzip 的 CRC/尾部校验退出码。
3. 解压失败或 raw temp 为空时，删除两个 temp，记录 gzip 阶段错误，显示 raw 回退提示。
4. `ccq_download_file "${download_url}" "${raw_temp}"` 执行 raw fallback。
5. 双失败时输出 raw 主错误和 gzip 上下文，删除所有本事务 temp，返回 1。
6. 只有 raw temp 非空时执行现有 `chmod +x` 与 `mv -f`。

curl/wget 的每次调用各自显示当前 response 进度；切换 raw 时自然开始新的进度，不缓存
gzip 百分比。

## 5. Integrity Model

初始安装器只有直接 asset URL，没有 TUI `checkLatestVersion` 阶段取得的 raw/gzip
size 与 SHA-256 元数据。因此本任务不复制 TUI 的 Release metadata 信任模型：

- transport 层：现有下载器的 HTTP 成功与 Content-Length 完整性（Windows），或
  curl/wget 成功退出（macOS）；
- gzip 层：完整解压并让 CRC/尾部错误失败；
- raw temp 层：存在且非空；
- build/contract 层：生成的 gzip fixture 解压后必须与 raw fixture 逐字节相等；现有
  `verify-gzip-assets.mjs` 继续证明 Release 打包 roundtrip。

如果未来要求运行时 SHA-256，应另立任务引入可信 metadata/digest 来源；不能从 gzip
字节或 Content-Length 推断最终 raw digest。

## 6. Error and Cleanup Matrix

| Condition | Result | Cleanup |
|---|---|---|
| gzip 下载成功且解压结果非空 | 继续使用 raw temp | 删除 gzip temp |
| gzip 下载失败 | 显示 warning 并尝试 raw | 删除 gzip/raw 部分文件 |
| gzip 损坏、截断或为空 | 显示 warning 并尝试 raw | 删除 gzip/raw 部分文件 |
| raw 回退成功 | 安装成功 | 执行平台正常清理 |
| gzip 与 raw 均失败 | 以 raw 错误为主并附 gzip 上下文 | 删除两个 temp；保留 target |
| 最终替换/安装失败 | 沿用现有平台错误/回滚合同 | 清理传输 temp；保留 target/backup 规则 |

清理操作必须幂等，并限制在包含当前 PID 的路径内。不得使用 wildcard 或目录级删除。

## 7. Contract Tests

### Windows / shared PowerShell gate

新增 `Test-CcqGzipTransportContract`：

- AST/source assertion 确认 gzip URL 从 raw 以 `.gz` 派生、gzip 先于 raw 尝试、存在 fallback
  warning，且 `Invoke-FileDownload` 保持不变。
- 生成 raw fixture，用 .NET 压缩后调用真实解压 helper，逐字节比较结果。
- mock `Invoke-FileDownload`，覆盖 gzip 成功且不调用 raw、gzip 下载失败后 raw 成功、gzip
  损坏后 raw 成功，以及两个 transport 都失败但现有 target 保持不变的场景。
- 断言独立 output path 和 URL 调用顺序；这也通过两次 downloader invocation 保证进度会重新计算。
- 保持现有 locked-file behavior probe 通过，证明 gzip 工作没有绕过 `Replace-CcqExecutable`。

### macOS probe

在 `installer/contracts/` 增加小型 zsh behavior probe；有 zsh 时从 `installer/build.sh --check`
运行。它生成 raw/gzip fixture，替换窄 download helper，并覆盖相同的 success/fallback/corrupt/
double-failure matrix。`Test-Contracts.ps1` 还要断言 probe 仍已接线，避免 Windows 侧 contract
运行时静默丢失 macOS 覆盖。

## 8. Compatibility, Rollout, and Rollback

- 旧版/无 gzip 的 Release：第一次请求失败后，显示提示并成功回退 raw。
- 当前 Release：优先 gzip，但不改变 artifact name。
- PowerShell 5.1 和 macOS system tools 仍是唯一 runtime dependency。
- 发布需要 installer source test 和两个构建 installer structure check。外部 Bun runtime
  extraction 导致的完整 TUI cross-compilation failure 单独报告，不降低 source/contract gate。
- 代码回滚移除 gzip selection 和 helper，恢复 raw-only 传输；raw Release asset 仍会发布，
  因此无需数据或 artifact migration。
