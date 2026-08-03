# 构建、内嵌与 Release 合同

## 1. 范围与触发条件

适用于 `installer/build.ps1`、`installer/build.sh`、
`installer/contracts/build.json`、`tui/scripts/build.ts`、内嵌合同、
Release CI、版本注入和 artifact 冒烟测试。

## 2. Artifact 签名

当前 Release artifact 集合必须严格包含以下十个文件：

```text
install.ps1
install.sh
ccq-windows-x64.exe
ccq-windows-x64.exe.gz
ccq-windows-arm64.exe
ccq-windows-arm64.exe.gz
ccq-macos-x64
ccq-macos-x64.gz
ccq-macos-arm64
ccq-macos-arm64.gz
```

四个 `.gz` 文件同时用于自更新和首次安装传输。首次安装器接收 raw asset URL
作为公开输入，先尝试 `<raw>.gz`，并保留 raw asset 作为必需的兼容性回退。
因此，缺少 gzip 或已回滚的 Release 仍然可以安装。

TUI 编译目标为 `bun-windows-{x64,arm64}` 和
`bun-darwin-{x64,arm64}`。安装后的二进制文件必须在没有 Bun 或 Node 的环境中运行。

## 3. 合同

- `build.json` 负责安装器组合和 artifact 名称。CI 期望列表、dist 数量、Release
  正文和合同测试必须与其一致。
- `build.json` 的 `UpdateTransports.GzipAssets` 是唯一的 raw-to-gzip 文件名映射。
  合同测试、`tui/scripts/build.ts`、打包脚本和 CI 都必须使用它；另建独立列表
  即违反合同。
- 安装器传输在运行时从传入的 raw URL 推导 gzip URL。gzip 下载/解压失败（包括
  CRC/trailer 损坏或空输出）属于警告，并启动一次全新的 raw 下载；若两次都失败，
  raw 错误为主错误，同时保留 gzip 阶段作为上下文。只有完整且非空的 raw 临时文件
  才能进入现有的替换或 `chmod +x`/`mv` 路径。
- `.gz` asset 只能在对应的最终 raw 可执行文件存在后生成，也就是版本和图标字节
  已确定之后。打包使用 gzip level 9，并固定 mtime 和 OS header 字节；重复执行
  必须产生逐字节相同的输出，且成功前必须证明 gunzip 往返结果与 raw 文件相等。
- 任一 gzip asset 缺失都会阻止 Release；运行时对缺少 gzip 的容忍仅适用于旧版或
  已回滚的 Release。
- 平台构建开始前，其入口必须清理对应 `BuildEntrypoints.*.Artifacts` 集合列出的
  每个文件。验证必须只观察当前调用产生的文件；旧构建遗留的 raw/gzip 文件不能
  让失败的编译看起来成功。其他平台 artifact 保持不动，以便 Windows 和 macOS
  任务仍可组合构建。
- Windows `install.ps1` 是 ASCII trampoline。真实 UTF-8 脚本以 base64 内嵌并在本地
  解码，因为即使带 BOM，PS5.1 的 `irm | iex` 也可能错误解码 GitHub octet-stream
  字节。
- Release 调用的 PowerShell 脚本没有稳定的 `$PSScriptRoot`。在调用 `Join-Path`、
  `Test-Path`、`Get-Content` 或 dot-sourcing 前必须检查路径是否为空，并使用
  inline/environment 回退。
- `install.sh` 是包裹 macOS 源码链的 bash-to-zsh wrapper。
- TUI 合同通过 Bun 的 `text` loader 导入 `EMBEDDED_CONTRACTS`。source mode 读取
  `tui/contracts/`；executable mode 不得依赖相邻文件。
- 默认不要使用 `bun build --compile --minify`。OpenTUI host 注册和 compiled-mode
  行为要求使用未压缩构建，除非 compiled smoke 已证明压缩构建同样可靠。
- `tui/assets/ccq-icon.ico` 是 Windows 源图标。由于 Bun 不支持交叉编译时使用该
  flag，`tui/scripts/build.ts` 仅在 Windows x64 原生构建时传入 `--windows-icon`；
  其他目标保留默认图标。当可选图标文件或 Bun metadata embedding 不可用时，构建
  仍必须成功。
- Tree-sitter 仅用于 source-mode；编译后的可执行文件使用纯文本回退。
- `tui/package.json` 保持 `0.0.0-dev`。Git tag 是 Release 版本来源；CI 在构建前
  注入它，`src/version.ts` 将其内嵌。
- 本地 `tui/scripts/build.ts` 可以报告 arm64 交叉编译限制，但 Release 不得发布
  不完整的 artifact 集合。

## 4. 验证与错误矩阵

| 条件 | 必需结果 |
|---|---|
| artifact 名称/数量与构建合同不同 | Contract/CI failure |
| Windows remote entry 含非 ASCII 正文 | Build/encoding failure |
| `$PSScriptRoot` 缺失 | 使用回退路径；不得传入空的 `-Path` 参数 |
| compiled mode 缺少磁盘合同 | Embedded loader 成功 |
| 内嵌 key 缺失/格式错误 | 输出命名失败，不得静默使用空配置 |
| tag 版本与 `ccq --version` 不同 | Release 构建失败 |
| Release 构建中有目标失败 | 不发布不完整 Release |
| 当前平台 raw/gzip 仅来自旧构建 | 编译前清理；若当前构建未重新产生则失败 |
| 可选 Windows 图标无法内嵌 | 保持可执行文件构建有效，并报告跳过图标 |
| 实现前出现 Linux artifact | Contract failure |
| 重复 gzip 打包逐字节不同 | Packaging failure |
| gzip 往返结果与 raw 可执行文件不同 | Packaging failure |
| 安装器 gzip 传输失败但 raw 成功 | 警告，重新开始 raw 进度，然后成功安装 |
| 安装器 gzip 与 raw 传输都失败 | 先报告 raw 错误并保留 gzip 上下文；不得触碰现有目标 |
| Release 少于或多于 10 个文件 | CI failure |

## 5. 良好、基线与错误案例

- 正确：source 和 compiled contract probe 解析出的 providers 与 templates 相同。
- 正确：安装器先请求 `<raw>.gz`，gzip 缺失或损坏后再独立请求 raw；最终字节与
  raw fixture 相同。
- 基线：main branch smoke 报告 `0.0.0-dev`。
- 错误：在编译二进制中相对 `process.cwd()` 读取 `tui/contracts/providers.json`。
- 错误：让 gzip 成为首次安装的硬依赖，或把 gzip 字节传给可执行文件替换路径。
- 错误：只在 `build.ts` 中增加两个 Linux artifact，却没有同步合同/CI/安装支持。
- 错误：仅因为向 Bun 传入 `--windows-icon` 就让交叉编译的 arm64 构建失败。

## 6. 必需测试

```sh
cd tui
bun run typecheck
bun run verify
bun scripts/verify-gzip-assets.mjs
bun run build

cd ..
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/build.ps1
sh installer/build.sh --check
```

`Test-Contracts.ps1` 必须覆盖 Windows gzip 往返、损坏/空 gzip、raw 回退、双失败
上下文、临时文件清理和目标保留。macOS probe
`installer/contracts/Test-MacOSGzipTransport.zsh` 已接入 `build.sh --check`；系统
存在 `zsh` 时覆盖相同的 URL 顺序和字节相等场景。

还要对每个可用的 compiled target 执行 `--version`、help 和无参数 non-TTY smoke。
Windows 同时验证 `pwsh -File` source mode 与等价于 `irm | iex` 的 Release
trampoline 执行。

## 7. 错误与正确对比

```powershell
# 错误：UTF-8 正文直接通过 PS5.1 octet-stream 管道发送。
Get-Content installer/windows/Install.ps1

# 正确：构建生成 ASCII trampoline，在本地解码内嵌的 UTF-8 正文。
```

```text
# 错误：首次安装只下载 raw asset，或把 gzip 当作最终输出。
# 正确：推导 raw.gz，校验并解压到 raw 临时文件；gzip 失败时重新传输 raw，
# 现有交接流程只消费 raw。
```
