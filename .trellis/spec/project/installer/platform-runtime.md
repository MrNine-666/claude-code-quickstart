# Installer 平台 Runtime 合同

## 1. 范围与触发条件

适用于 `installer/windows/**`、`installer/macos/**`、`steps.json`、bootstrap
流程、平台检测、NodeJS/Git 处理和最终 ccq 安装。

## 2. 签名与 Step 合同

每个活动安装步骤都提供等价于以下内容的平台函数：

```text
Test-<Step>Installed / test equivalent
Install-<Step>
Verify-<Step>
```

当前 `installer/contracts/steps.json` 将 Basic 严格定义为：

```text
NodeJS (Order 10, no dependencies)
Git    (Order 20, no dependencies)
```

Windows 使用 `StepFile`，macOS 使用 `MacOSStepFile`。

## 3. 合同

- 安装流程先 bootstrap NodeJS/Git，然后提供/下载 `ccq`。Claude Code、Codex、
  Provider、MCP、Skills 及周边工具由 TUI 管理。
- 每次运行都重新检测状态；不存在持久化的安装状态文件。
- Windows 使用一个 PowerShell 5.1+ runtime。不得重新执行到 pwsh，也不得使用
  PS7 语法（`-AsHashtable`、`$PSStyle`、三元表达式、`??`、`&&`、`||`、并行
  foreach）。
- 在 StrictMode 下，读取 `.Count` 的命令/函数/管道结果必须通过 `@(...)` 赋值；
  返回数组的函数使用 `return ,$array`。
- Windows core 按以下顺序 dot-source：`Json.ps1` -> `Ui.ps1` ->
  `Process.ps1` -> `Profile.ps1` -> `Update.ps1` -> `Admin.ps1` -> `Net.ps1`
  -> `Registry.ps1` -> `Bootstrap.ps1`。`Json.ps1` 负责 PS5.1 hashtable 转换，
  `Update.ps1` 在 Profile helpers 之后加载。
- macOS 使用 bash wrapper -> `/bin/zsh`、Homebrew 官方安装行为和 nvm 官方回退。
  它绝不调用 winget、registry、MSI/EXE 或 Windows Profile API。
- 两个平台的 NodeJS 都遵循 runtime-first：复用足够版本的活动 node/npm；可行时
  原地修复当前 nvm/fnm provider；否则使用平台回退。不得迁移 provider、清理 PATH
  或移动全局 npm 包。
- macOS 不手写 nvm 初始化；由官方 installer 负责。
- 安装步骤使用 `[PASS]`、`[FAIL]`、`[SKIP]`；macOS 还可使用 `[UNSUPPORTED]`/
  `[MANUAL]`，两者都不计为成功。
- 最终 `ccq` 位于 Windows 的 `~/.local/bin/ccq.exe` 或 macOS 的
  `~/.local/bin/ccq`。不得注入 `function ccq` Profile wrapper。
- 最终 `ccq` 交接会先规范化已安装的 `ccq --version` 和安装器 Release tag
  (`vX.Y.Z` -> `X.Y.Z`) 再比较。版本相同则无菜单跳过；版本不同显示覆盖/保留
  选项，默认保留，只有明确覆盖才继续原子替换。source mode 没有可比较的 Release
  tag 时，保留可用的可执行文件并报告无法比较。Windows 目标通常是运行中的映像，
  “原子替换”是特殊且仅部分原子的合同；操作该路径前先阅读
  [Windows Core](./windows-core.md) 的替换章节。

### ccq transport 合同

公开的安装器交接仍然使用 raw asset URL：
`Install-CcqExecutable -DownloadUrl <raw-url>` on Windows and
`ccq_install_executable <raw-url>`。每个函数通过追加 `.gz` 推导首选 gzip URL；
不查询 Release API，也不要求 digest metadata。

- 首先尝试 gzip，使用独立的临时输出和进度响应。下载失败、流损坏/截断或解压为空
  时，删除两个事务临时文件并发出可见的 raw 回退警告。
- raw 回退使用原始 URL 发起新的 downloader 调用，并独立计算响应大小/进度。只有
  完整且非空的 raw 临时文件才能进入现有 Windows 替换或 macOS `chmod +x`/`mv`
  交接。
- 两种传输都失败时，raw 失败是主错误，同时保留 gzip 阶段（下载或解压）作为诊断
  上下文。任何传输失败都不得触碰现有 `ccq` 字节。

## 4. 验证与错误矩阵

| 条件 | 必需结果 |
|---|---|
| 已有 Node/npm 满足最低版本 | 跳过且不迁移 provider |
| 活动 provider 可更新到 LTS | 在该 provider 内更新并验证 |
| provider 无法安全修复 | 使用文档规定的平台回退 |
| 步骤安装成功但验证失败 | 步骤失败，提供友好消息和详细信息 |
| 单文件执行无法取得合同路径 | 使用 inline/env 回退或安全跳过；不得调用空路径 |
| 用户拒绝下载 ccq | Bootstrap 仍有效；报告已跳过 |
| 已安装 ccq 与 Release tag 匹配 | 跳过下载；报告版本匹配 |
| 已安装 ccq 与 Release tag 不同 | 显示覆盖/保留菜单；默认保留 |
| 已安装 ccq 存在但目标 tag 未知 | 明确警告并保留已有 ccq |
| Gzip 传输失败且 raw 成功 | 显示回退警告，重新开始传输进度，然后正常继续 |
| Gzip 与 raw 传输都失败 | 先报告 raw 错误并附带 gzip 上下文；保留已有 ccq |
| 不支持的 OS/版本/架构 | 明确失败或标记手动/不支持；不得假报成功 |
| Linux 调用 | 当前平台不支持；proposal 不属于 runtime 行为 |

## 5. 良好、基线与错误案例

- 正确：macOS 已有 fnm Node LTS 时直接复用，不清理 Profile。
- 正确：已安装 `ccq 1.2.2`、安装器为 `v1.2.3` 时显示两个版本，仅在用户选择
  覆盖后下载。
- 基线：Git 已存在，步骤报告跳过并继续 ccq。
- 基线：已安装 `ccq 1.2.3`、安装器为 `v1.2.3` 时按当前版本跳过。
- 正确：当前 Release 从 `.gz` 安装，缺少 gzip 的旧 Release 在无需配置变化的
  情况下回退 raw URL。
- 错误：不比较版本，仅因 `ccq` 有响应就视为当前版本。
- 错误：raw 重试共享 gzip 的进度总量，或让 gzip 成为旧 Release 的硬依赖。
- 错误：因旧 README 或 OpenSpec 仍描述旧流程，就把 Claude Code 作为第三个
  Basic 步骤安装。
- 错误：在 StrictMode 下使用 `$result = Some-Command; $result.Count`。

## 6. 必需测试

- `pwsh -File installer/contracts/Test-Contracts.ps1`。
- Windows source：`pwsh -File installer/windows/Install.ps1 -ListSteps` 以及相关
  PS5.1 语法/runtime 测试。
- macOS source：`zsh -n installer/macos/Install.zsh` 以及
  `zsh installer/macos/Install.zsh --list-steps`。
- Node provider 矩阵覆盖满足、可修复和回退状态，且不产生迁移副作用。
- 任何 remote-entry 改动都要运行 `build-release.md` 描述的 built artifact 模式。
- `pwsh -File installer/contracts/Test-Contracts.ps1` 运行 Windows gzip 合同并
  验证 macOS probe 已接入。存在 `zsh` 时，`sh installer/build.sh --check` 运行
  `zsh -n` 及 `installer/contracts/Test-MacOSGzipTransport.zsh`。
- `Test-CcqVersionHandoffContract` 断言规范化、同版本跳过、不匹配时默认保留、
  明确覆盖后继续，以及对应的 macOS source 合同。

## 7. 错误与正确对比

```powershell
# 错误：命令返回 $null 时在 StrictMode 下会失败。
$items = Get-Items
if ($items.Count -gt 0) { }

# 正确
$items = @(Get-Items)
if ($items.Count -gt 0) { }
```

```text
错误：ccq 存在 -> return
正确：比较已安装版本 + Release tag -> 相同：跳过；不同：默认保留菜单；覆盖：原子替换
```

```text
错误：只下载 raw URL，并将 gzip 字节发送到替换流程。
正确：尝试 raw.gz，完整生成非空 raw 临时文件；gzip 失败后重新传输 raw，替换
流程和 macOS chmod/mv 只接收 raw 字节。
```
