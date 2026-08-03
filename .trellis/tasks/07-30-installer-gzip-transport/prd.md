# 安装脚本对齐 gzip 传输资产

## Goal

Windows 与 macOS 首次安装器优先传输 Release 已有的 gzip 可执行资产，并在 gzip
路径不可用时自动回退 raw 资产。用户在正常 Release 上应显著减少下载量，同时旧
Release、回滚 Release 和 gzip 损坏场景仍可完成安装。

## Background

- `installer/contracts/build.json` 已声明四组 `Raw -> Gzip` 映射，Release 固定发布
  raw 与 gzip 两套可执行资产。
- TUI 自更新在 `tui/src/core/self-update.ts:305` 已采用 gzip 优先、raw 回退；初始
  安装器没有同步这项传输策略。
- Windows 调用方在 `installer/windows/Install.ps1:473` 构造 raw URL，当前
  `Install-CcqExecutable` 位于 `installer/windows/core/Process.ps1:2010`，并通过
  `installer/windows/core/Net.ps1:76` 的 `Invoke-FileDownload` 直接下载 raw 字节。
- macOS 调用方在 `installer/macos/Install.zsh:574` 构造 raw URL，当前
  `ccq_install_executable` 位于 `installer/macos/core/Process.zsh:753`，直接使用
  `curl` 或 `wget` 下载 raw 字节。
- 一次历史实测中，raw 为 109,264,384 B，gzip 为 40,174,995 B，传输量减少约
  63%。具体大小随 Release 变化，不作为固定字节契约。
- `.trellis/spec/project/installer/build-release.md` 当前仍写明安装器只下载 raw；任务完成后
  必须同步修正该长期规范。

## Requirements

### R1. gzip 优先

- Windows 和 macOS 安装函数接收现有 raw URL 后，必须先尝试对应的 `<raw>.gz`。
- gzip 是可选加速路径，raw URL 仍是安装所需的最终兼容入口。
- 不改变上层版本比较、用户确认、架构选择和目标路径行为。

### R2. raw 回退

- gzip 下载失败、响应不完整、gzip 流损坏或解压结果为空时，必须清理该次临时
  文件并自动尝试 raw URL。
- 回退必须有用户可见提示，明确说明 gzip 路径失败并正在改用 raw 资产。
- 旧 Release 没有 gzip 资产时，不得要求额外配置或人工重试。

### R3. 进度语义

- 每次下载的进度总量必须来自当前实际传输响应；gzip 与 raw 不共享百分比或总字节数。
- 从 gzip 切换到 raw 时，进度必须作为一次新的传输重新开始。

### R4. 完整性与落盘安全

- gzip 路径只有在下载成功、完整解压且解压结果非空后才可进入现有替换流程。
- gzip 解压必须完整读取流，使 gzip CRC/尾部错误表现为失败；不得吞掉解压异常。
- 契约测试必须用生成的 raw/gzip fixture 证明解压字节与原始 raw 完全一致。
- 运行时不新增 GitHub Release API、digest 或 raw size 查询；安装器继续使用当前直接
  asset URL 边界。最终 raw 的非空检查与现有替换安全契约保留。
- 任一失败路径不得把 gzip 字节、部分解压输出或部分 raw 下载落到最终目标，也不得
  删除原有可用的 `ccq`。

### R5. 错误可诊断性

- gzip 路径失败但 raw 成功时，安装整体成功。
- gzip 与 raw 都失败时，最终错误以 raw 失败为主，并保留 gzip 失败阶段或原因，便于
  区分“加速路径失败”与“所有传输均失败”。

### R6. 平台兼容

- Windows 保持 PowerShell 5.1 兼容，只使用可用的
  `System.IO.Compression.GzipStream` / .NET Framework API。
- macOS 只依赖系统自带 zsh 与 `gzip`/`gunzip`，不引入包管理器或第三方解压工具。
- 保留 `07-30-installer-locked-file-replace` 已完成的占用预检、同目录 raw temp 和
  `Replace-CcqExecutable` 流程。

## In Scope

- Windows `Install-CcqExecutable` 的 gzip 下载、解压、清理、raw 回退和错误上下文。
- macOS `ccq_install_executable` 的等价 gzip/raw 双传输流程。
- 两个平台所需的窄辅助函数与行为测试缝。
- `installer/contracts/` 的 gzip 优先、raw 回退、损坏 gzip 和 roundtrip 契约测试。
- 与新运行时行为冲突的 installer spec 更新。

## Out of Scope

- 改动 `installer/contracts/build.json`、Release artifact 名称或十 artifact 数量。
- 为初始安装器接入 GitHub Release API、asset digest、断点续传或缓存。
- 重构 Windows 通用 `Invoke-FileDownload` 或改变其超时、重试、代理和进度算法。
- 修改 TUI 自更新实现。
- 修改 locked-file 替换、CLI 父进程、Windows shim 或残留清理策略。
- 把 gzip 设为强依赖，或在 gzip 失败后禁止 raw 安装。

## Acceptance Criteria

- [ ] AC1: Windows 行为探针确认首次请求 `<raw>.gz`；gzip fixture 成功时不请求 raw，
      安装输入与原始 raw fixture 字节完全一致。
- [ ] AC2: macOS 行为探针确认相同的 gzip-first 顺序与 roundtrip 字节一致性。
- [ ] AC3: 两个平台在 gzip 下载失败和损坏 gzip 两种场景下，均清理部分文件、显示
      raw 回退提示，并使用 raw fixture 成功完成安装。
- [ ] AC4: gzip 与 raw 都失败时返回失败，错误同时包含 raw 主错误和 gzip 失败上下文，
      已有目标保持不变。
- [ ] AC5: gzip 与 raw 两次传输分别使用各自下载器调用和响应大小，回退时进度从新传输
      开始，不复用 gzip 总量。
- [ ] AC6: Windows 解压与下载临时文件始终位于目标同目录，成功后交给现有
      `Replace-CcqExecutable`；macOS 仅在完整 raw temp 上执行 `chmod +x` 和 `mv`。
- [ ] AC7: `pwsh -File installer/contracts/Test-Contracts.ps1` 通过。
- [ ] AC8: `pwsh -File installer/windows/Install.ps1 -ListSteps`、
      `zsh -n installer/macos/Install.zsh`、
      `zsh installer/macos/Install.zsh --list-steps` 与
      `sh installer/build.sh --check` 通过。
- [ ] AC9: Windows 与 macOS 单文件 installer 构建/结构检查通过；若完整 TUI
      交叉编译受外部 Bun runtime 下载阻塞，必须单独记录环境失败，不能误报为本任务通过。

## Blocking Open Questions

无。
