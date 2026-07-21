# 修复 CLI 与 ccq 自生命周期可靠性问题

## Goal

统一修复 ccq CLI 命令契约、自更新事务完整性、Windows 自更新/自卸载和 OpenTUI 重启时序问题，使管理命令在交互式终端、管道/CI、预发布版本和跨平台单文件产物中都保持可预测、可验证且不静默损坏用户意图或可执行文件。

## Background

2026-07-15 对 tui/src/cli、tui/src/core/update.ts、tui/src/app.tsx、Release workflow 与现有 verify 脚本进行了只读审查。现有 bun run typecheck、bun run verify 与 git diff --check 全部通过，但隔离探针确认门禁未覆盖以下问题：

- tui/src/cli/argv.ts:118 在启动类命令同时包含普通透传参数与双横线分隔符时，会静默丢弃分隔符前的参数。
- tui/src/core/update.ts:796 仅按字符串不等判断更新，预发布构建可能把较新版本降级到较旧 stable release。
- tui/src/core/update.ts:821 下载 Release 二进制后不校验 GitHub API 已提供的 size/digest，并使用共享临时文件。
- tui/src/core/update.ts:965 重新推导临时路径，且 POSIX 在 rename 后执行可失败 chmod，可能出现目标已替换但调用方收到失败。
- tui/src/core/update.ts:921 的 Windows helper 无条件重启 ccq，导致 CLI update 与 TUI update 语义耦合。
- tui/src/cli/commands/uninstall.ts:23 在 Windows 直接删除当前运行的 ccq.exe，锁定者正是当前进程。
- tui/src/app.tsx:194 在销毁 OpenTUI renderer 前启动新进程，并在不可取消的应用阶段展示取消提示。
- tui/src/cli/commands/tools.ts:7 的工具别名与 TOOL_DEFINITIONS 漂移并漏掉 Trellis；显式 tools update 仍可能命中一小时缓存。
- tui/scripts/verify-self-update.mjs 主要使用源码正则，现有 Windows helper 运行测试未接入 Release CI。

本变更拆成两个可独立验收的子任务：

- 07-15-fix-cli-command-contracts：CLI 参数、help、工具 registry 与显式更新缓存。
- 07-15-harden-ccq-self-lifecycle：自更新事务、Windows helper、自卸载与 OpenTUI 重启。

## Confirmed Product Decisions

- Windows 的 ccq update 在 CLI 路径只安排替换并退出，不自动启动 TUI；从 TUI 发起更新时才在替换完成后重启 TUI。
- 显式 ccq tools update 必须绕过远程版本缓存并实时检查；普通 TUI 启动检测可继续使用缓存，手动刷新仍强制联网。
- GitHub Release asset 缺少合法 SHA-256 digest、size 不一致或 digest 校验失败时必须 fail closed，不得替换当前可执行文件。
- ccq uninstall 只删除 ccq 可执行文件；不删除 PATH、用户配置、供应商、~/.local/bin 目录或其他工具。

## Requirements

### R1 — CLI 命令契约

- 启动类 cc/cx 必须保留供应商名之后的全部底层参数；第一个双横线仅作为 ccq 与底层工具的分隔符被移除，分隔符前后的参数顺序保持不变。
- help 未知动词、缺参数和非法管理类 flag 必须输出对应错误并返回非零，不得退化为成功总帮助。
- CLI 工具 canonical id、别名与可用列表必须从 TOOL_DEFINITIONS 或其单一派生层获得，至少覆盖 8 个受管组件并包含 Trellis。
- 显式 tools update 必须强制刷新远程版本状态；检测或更新失败必须保留结构化进度与非零退出码。

### R2 — 可验证自更新事务

- Release 检查必须使用语义化版本比较：仅 latest 严格高于 current 时报告更新；不得自动降级。
- Release asset 必须携带合法 size 与 sha256 digest；缺失或格式异常时检查阶段失败。
- 下载必须使用唯一临时文件并返回绑定 version、asset、digest、size、targetPath 与 tempPath 的不可变事务对象。
- 下载完成后必须验证 size 和 SHA-256；失败时清理事务临时文件且目标字节不变。
- 应用阶段只能消费已验证事务，不得重新推导共享临时路径。

### R3 — 跨平台应用与重启

- POSIX 必须在原子 rename 前完成权限、完整性和所有其他可失败步骤；rename 后不得把已成功替换报告为失败。
- Windows update helper 必须等待父进程退出、重试替换、验证结果、清理临时文件，并由明确 restart policy 决定是否启动 TUI。
- CLI update 使用 restart=false；TUI update 使用 restart=true。
- TUI 重启前必须先恢复 OpenTUI 终端状态；下载阶段可取消，应用阶段不得展示虚假的取消能力。

### R4 — Windows 自卸载

- 当 Windows 安装目标与当前 process.execPath 指向同一文件时，禁止直接 rmSync；必须启动独立 helper，在父进程退出后重试删除。
- helper 启动成功只表示 scheduled，不得提前声称文件已删除；helper 启动失败返回非零。
- helper 成功后验证目标不存在并自删除；失败保留脱敏日志，不启动 TUI。
- Windows 非当前目标以及 macOS/Linux 保持直接删除。

### R5 — 回归门禁与交付

- 所有文件探针使用临时 CCQ_HOME，禁止读写真实 ~/.local、~/.claude 或 ~/.codex。
- 自更新测试必须使用 fake Release/fetch 和真实临时文件断言，不得只依赖源码正则。
- Windows CI 必须执行 update helper、自卸载 helper 和编译产物自卸载 smoke。
- 保持 Bun 单文件编译、PS 5.1 helper 语法、non-TTY 守卫和现有 CLI 正常输出兼容。
- 实施时保护当前工作区供应商任务的未提交改动，尤其是 tui/src/cli/help.ts 与 tui/src/cli/index.ts 的重叠修改。

## Acceptance Criteria

- [ ] AC1：cc/cx 在双横线前后都有参数时，底层 runner 收到除第一个分隔符外的完整有序参数，退出码继续透传。（R1）
- [ ] AC2：未知 help 返回非零；8 个受管工具均可用 canonical id 解析，Trellis 别名可用，帮助列表与 registry 一致。（R1）
- [ ] AC3：显式 tools update 绕过一小时缓存；普通 TUI 检测缓存语义不变。（R1）
- [ ] AC4：较新 prerelease/current 不会被旧 stable latest 降级；相等版本零下载；仅严格升级返回 asset plan。（R2）
- [ ] AC5：digest 缺失、size 不符、digest 不符、下载中断和并发下载均不会改变目标文件，且各事务临时文件互不串扰。（R2）
- [ ] AC6：POSIX 更新原子替换成功后不再执行可导致假失败的步骤；失败路径保留旧目标。（R3）
- [ ] AC7：Windows CLI update 替换后不启动 TUI；TUI update 替换后重启；renderer 清理发生在新 TUI 启动之前。（R3）
- [ ] AC8：从正在运行的安装版 ccq.exe 执行 uninstall --yes 返回 scheduled success，父进程退出后 exe 被删除，helper 自清理且不启动 TUI。（R4）
- [ ] AC9：non-TTY 未传 --yes/-y 仍拒绝卸载；macOS/Linux 直接删除行为保持不变；用户配置与 PATH 不受影响。（R4）
- [ ] AC10：bun run typecheck、bun run verify、git diff --check、四平台构建与 Windows 编译产物 smoke 全部通过。（R5）

## Technical Constraints

- Windows helper 必须兼容 Windows PowerShell 5.1，不使用 PS7 专有语法。
- 不新增运行时依赖；继续兼容 Bun >=1.2.0 与 bun build --compile。
- 当前版本继续以内嵌 CCQ_VERSION 为唯一事实源，运行时只联网获取 latest release。
- Release 仍保持既有 6 个 artifact；优先使用 GitHub Release asset 自带 digest，不新增 checksum artifact。
- 不改变 cc/cx/use 的业务含义，不增加新的破坏性 flag。

## Out of Scope

- 自动降级或指定历史版本安装；如未来需要应设计独立 force/rollback 命令。
- 删除用户配置、PATH、~/.local/bin 目录或其他受管工具。
- 重做工具管理 TUI、供应商模块或 installer bootstrap。
- 本规划阶段不实施代码、不暂存、不提交。
