# Linux Installer Support Design

## 1. Design Summary

将当前双平台安装器扩展为三平台合同，但不合并平台 runtime。Windows 保留 PowerShell
组合，macOS 保留 zsh 实现，Linux 增加 Bash 实现。公开 Unix artifact 仍只有一个
`install.sh`，由一个小型 dispatcher 实现，并包含分别编码的 macOS 与 Linux payload。

这仍然是一个 Trellis task，因为 source、contract、builder、binary、自更新和 Release
变更组成一个原子 artifact 合同。将其拆成独立发布的子任务会产生中间状态，而现有
门禁正是有意拒绝这些状态。

## 2. Current State And Owners

```text
platform source
  -> installer/contracts/steps.json + build.json
  -> installer/build.ps1 or installer/build.sh
  -> dist installer + tui/scripts/build.ts binaries
  -> .github/workflows/build-and-release.yml
  -> Release assets
  -> installer ccq download / TUI self-update
```

以下 owner 必须同步修改：

- `installer/contracts/steps.json`：步骤文件和 runtime 目录合同。
- `installer/contracts/build.json`：组合方式和八文件 Release 集合。
- `installer/contracts/Test-Contracts.ps1`：跨平台一致性门禁。
- `installer/build.sh`：Unix 单文件组合和 Unix binary 收集。
- `tui/scripts/build.ts`：Bun compile target registry。
- `tui/src/core/self-update.ts:getAssetName`：已安装 runtime asset 选择。
- `.github/workflows/build-and-release.yml`：test/build/smoke 依赖图。

`tui/src/core/self-update.ts:164` 当前拒绝除 `win32` 和 `darwin` 外的所有平台。POSIX
apply 和 self-uninstall 已使用非 Windows 路径，因此 Linux 需要 asset 映射和测试，
而不是第三套替换算法。

## 3. Contracts

### 3.1 Linux platform matrix

新增 `installer/contracts/linux-platforms.json`，作为以下数据的唯一 owner：

- 官方 distro ID、family 和固定的 CI image；
- 接受的 version/variant constraints；
- package-manager command 和 install argv template；
- `ID_LIKE` best-effort mapping；
- x64/arm64 host-name aliases；
- Bash runtime、仅 glibc 和 WSL policy。

初始固定基线是 PRD 接受的候选项。启用实现前，实施者必须确认每个精确 image 可用，
并将最终 tag 记录在此合同中。除 Arch rolling 按产品策略使用 `latest` 外，拒绝浮动
tag。

Linux shell 代码在 bootstrap 前不能依赖 Node 或 jq。因此 runtime 平台检测仍由
`linux/core/Platform.sh` 实现；合同测试针对 fixture 执行其检查函数，并将结果与
`linux-platforms.json` 比较。CI 矩阵生成直接读取 JSON。这样数据 owner 可以执行，
同时不会给 runtime 引入 bootstrap 依赖。

### 3.2 Step contract

在 `steps.json` 中增加：

- `DirectoryPolicy.RuntimeCoreDirectories.Linux`；
- 每个 active Basic step 都必须有 `LinuxStepFile`；
- 仅在不同于共享步骤时增加 Linux-specific skip semantics。

Basic 仍严格包含 NodeJS 和 Git。它们的 ID、生命周期函数和 TUI 边界不变。

### 3.3 Build contract

用明确的 `Unix` 条目替换仅 macOS 的 Unix artifact owner：

- builder：`installer/build.sh`；
- allowed payload platforms：`macos`、`linux`；
- artifact：一个 `install.sh`；
- executable files：macOS x64/arm64 加 Linux x64/arm64。

manifest 分别保存 macOS 与 Linux payload 组合列表。Release artifact 列表严格采用
PRD 中的八文件集合。Windows 仍是由 `build.ps1` 负责的独立条目。

## 4. Source Layout

新增与 macOS 并行但不假设完全相同的 Linux runtime：

```text
installer/linux/Install.sh
installer/linux/core/Ui.sh
installer/linux/core/Process.sh
installer/linux/core/Profile.sh
installer/linux/core/Platform.sh
installer/linux/core/PackageManager.sh
installer/linux/core/Json.sh
installer/linux/core/Registry.sh
installer/linux/core/Bootstrap.sh
installer/linux/steps/NodeJS.sh
installer/linux/steps/Git.sh
```

只有在 Bash 3.2、当前 Bash 和 zsh 下证明相同可执行合同成立时，才可将可移植算法
提取到 `installer/unix/core/`。首次实现应复用合同形状和测试 fixture，不要用虚假
抽象强行隐藏 macOS Homebrew 与 Linux 包管理器协议。

## 5. Runtime Flow

### 5.1 Unified built `install.sh`

生成文件包含 POSIX 兼容 dispatcher，后跟编码 payload。它只执行以下操作：

1. 检测 `uname -s`；
2. 选择 macOS zsh 或 Linux Bash payload；
3. 创建 private temporary file；
4. 只解码选中的 payload；
5. 使用 `/bin/zsh` 或发现的 `bash` 执行它；
6. 保留 child exit code，并通过 `trap` 删除临时文件。

dispatcher 不得解析未选择平台的 source。这就是拒绝直接拼接 zsh 与 Bash 模块的原因。

### 5.2 Linux preflight

```text
parse args
  -> --list-steps may run without TTY/root checks
  -> require Linux + Bash
  -> reject uid 0 for real install
  -> read /etc/os-release
  -> classify official / best-effort / unsupported
  -> reject WSL1 and musl
  -> normalize uname -m to linux-x64/linux-arm64
  -> validate expected package manager and downloader
  -> require TTY for mutation
```

未知的 exact distro ID 只能在明确提示“未验证”并获得确认后使用 `ID_LIKE`。
缺失或格式错误的 `/etc/os-release` 应判定为 unsupported，不能静默当作 Ubuntu。

### 5.3 Basic lifecycle

registry 消费 `LinuxStepFile`，并保持共享状态机：
`Pending -> Running -> Success|Failed|Skipped|Unsupported|ManualRequired`.

- NodeJS：复用满足版本要求的 node/npm；修复当前 nvm/fnm；否则从官方 URL 运行固定版本
  的 nvm installer，并验证 active LTS。
- Git：复用满足要求的 Git；否则使用映射的 package manager 搭配 sudo，并验证
  `git --version`。
- `ccq`：保留版本规范化、同版本跳过、版本不匹配时默认保留和显式原子覆盖。将
  `ccq-linux-x64` 或 `ccq-linux-arm64` 下载到 `~/.local/bin/ccq`，并 chmod 0755。

安装器不会在后续失败时回滚 package-manager 或 nvm 的副作用。它准确报告 partial
state，并保持可安全重跑。`ccq` 文件替换本身仍保持原子性。

### 5.4 Profile ownership

nvm official installer 拥有 nvm 初始化。CCQ 只能通过一个标记 block 或等价的精确行
检查，幂等地确保 `~/.local/bin` 出现在 Bash/Zsh 启动文件中，不得重写无关的 PATH
条目。Fish 和其他 shell 只提供手动说明。

## 6. TUI Binary And Lifecycle

在 `tui/scripts/build.ts` 和 `tui/package.json` 中增加
`bun-linux-{x64,arm64}` target 及 build contract 中的 output name。
即使本地 arm64 cross-compile 失败，也可在开发构建中报告为 nonfatal；只要缺少任何必需
target，Release 仍必须失败。

扩展 `getAssetName()`，加入以下映射：

```text
linux/x64   -> ccq-linux-x64
linux/arm64 -> ccq-linux-arm64
```

`verify-self-update.mjs` 必须覆盖两个映射、不受支持的架构、digest enforcement
以及 `platform: 'linux'` 下现有的 POSIX chmod/fsync/rename 路径。
`verify-compiled-contracts.mjs` 必须接受 Linux hosts。

## 7. CI And Release

在 `ubuntu-latest` 上增加 Linux contract job，读取 `linux-platforms.json`，并通过 Docker
运行每个固定版本的 distro image。每个矩阵成员验证 Bash 语法、distro classification、
package-manager argv、源码
`--list-steps`、无 TTY 拒绝和 fixture 驱动的 lifecycle 路径。测试使用 fake commands/
PATH 与临时 HOME，不修改 runner host。

增加编译产物 smoke 验证：

- Ubuntu runner 上的原生 x64 binary；
- 有条件时使用公共 runner 上的原生 arm64 binary，否则使用明确的 QEMU/container job；
- `--version`、help、无参数 non-TTY 行为和内嵌合同探针。

Unix 构建任务生成统一的 `install.sh`，并收集 macOS 与 Linux binary。Release 依赖
Windows、macOS、Linux installer test 和两个 Linux binary smoke。最终 collector 断言
恰好八个文件，并使用相同名称更新 Release 正文表格。

## 8. Failure Matrix

| Condition | Required result |
|---|---|
| root 执行真实安装 | 在 mutation 前失败，并说明普通用户命令 |
| 真实安装无 TTY | 安全取消/失败，不修改 package 或文件 |
| 已知 `ID_LIKE` 的未知 distro | 警告并显式继续；仅属于 best-effort |
| 未知 distro/family | 返回 unsupported，不猜测 package manager |
| WSL1 或 musl | 在下载 binary 前返回 unsupported |
| 缺少 package manager/sudo | 返回 `ManualRequired`，给出精确手动命令 |
| 已有满足要求的 Node/Git | 跳过，不迁移 provider |
| step command 成功但 postflight 失败 | step 失败，绝不报告假成功 |
| 已有 ccq target 版本未知 | 保留已有 binary |
| 缺少一个 Linux binary/build/smoke | 阻断完整 Release |
| dispatcher child 失败 | 返回 child exit code 并清理临时 payload |

## 9. Alternatives Rejected

- **单独的 `install-linux.sh`：**名称更清晰，但会产生第九个 artifact 和两个 Unix 公共
  入口 URL；用户已选择单个 `install.sh`。
- **直接复用 macOS zsh source：**会把 Linux 绑定到 Homebrew 和 macOS APIs。
- **拼接 zsh 与 Bash body：**选中的 interpreter 可能解析未选择平台的不兼容语法。
- **从 APT/DNF/Pacman 安装系统 Node：**五个 distro family 的版本和权限差异过大。
- **十个 distro/architecture job：**对 architecture-independent installer 来说重复，
  也超出约定的质量目标成本。
- **不做 runtime smoke 就发布 arm64：**与双架构支持承诺矛盾。

## 10. Rollout And Rollback

此变更在 contract gates 后原子落地。八个 artifact 和 Linux smoke 全部通过前，不修改
任何 Release 声明。回滚就是正常 revert Linux source/manifest/CI 变更，不引入用户数据
迁移。已经安装 `ccq` 的 Linux 用户会得到普通用户拥有的 binary，并可通过现有 POSIX
self-uninstall 行为卸载。
