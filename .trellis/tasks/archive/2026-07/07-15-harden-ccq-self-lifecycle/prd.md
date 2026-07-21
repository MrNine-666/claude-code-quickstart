# 加固 ccq 自更新与 Windows 自卸载

## Goal

将 ccq 自更新从“下载到共享临时文件后尽力替换”升级为绑定版本、平台、size 与 SHA-256 的可验证事务，并修复 Windows 当前进程无法更新/删除自身、CLI update 意外启动 TUI、POSIX 部分成功误报和 OpenTUI 重启时序问题。

## Background

- core/update.ts:781 的 checkLatestVersion 只在 latestVersion 与 CCQ_VERSION 字符串完全相等时判定无更新。GitHub releases/latest 排除 prerelease，因此较新的 prerelease 构建可能看到较旧 stable 并被错误降级。
- GitHub Release API 当前为四个平台 ccq asset 提供 size 和 digest=sha256:...，但 core/update.ts:671 的 ReleaseAsset 类型只读取 name/url，下载后不做完整性验证。
- core/update.ts:776 使用固定 .ccq-update.tmp；downloadUpdate 和 applyUpdate 分别重新推导 target/temp，两个 ccq 进程或旧临时文件可能串扰。
- core/update.ts:977 先 rename 再调用外部 chmod；后者失败时目标已经被替换，却返回 apply failure。
- Windows update helper 在 core/update.ts:921 无条件 Start-Process target，CLI update 也会启动无参 ccq/TUI。
- cli/commands/uninstall.ts:24 在运行中的安装版 ccq.exe 内直接 rmSync 自身，Windows 映像锁必然导致 sharing violation。
- app.tsx:194 在 renderer.destroy 前调用 restartExecutable；应用阶段没有 AbortController 却仍提示 Esc 停止。
- verify-self-update 主要锁定源码形状；test-windows-helper.mjs 没有进入 build-and-release.yml 的 Windows 门禁。

## Confirmed Product Decisions

- CLI 发起 update：完成检查、下载与安排替换后退出，不自动启动 TUI。
- TUI 发起 update：用户确认应用后，Windows helper 或 POSIX restart 流程负责重新启动 TUI。
- Release asset 缺 digest、digest 非 sha256、size 无效或校验不匹配时 fail closed。
- Windows uninstall 延迟删除当前 exe；只删除 ccq 可执行文件，不清理 PATH、配置或目录。

## Requirements

### L1 — 语义化版本与 Release plan

- checkLatestVersion 必须解析 current/latest semver，仅 latest 严格高于 current 时 hasUpdate=true。
- latest 等于 current、低于 current 或 prerelease 优先级更低时不得下载或降级。
- GitHub asset 必须匹配严格的平台/架构；非 x64/arm64 架构返回 unsupported，不得默认为 x64。
- asset size 必须为正整数，digest 必须匹配 sha256 加 64 位十六进制；否则检查阶段返回结构化错误。
- 成功结果返回不可变 SelfUpdatePlan，包含 version、assetName、downloadUrl、expectedSize、expectedSha256。

### L2 — 可验证下载事务

- downloadUpdate 接收完整 SelfUpdatePlan，不再只接收裸 URL。
- 临时文件位于 target 同目录以保证 POSIX 原子 rename，并使用 pid+随机后缀与排他创建避免并发覆盖/符号链接跟随。
- 下载应流式写盘，设置合理超时并继续支持调用方 AbortSignal。
- 写完后校验实际 size 与 SHA-256；校验失败、取消、网络错误或写盘错误必须清理本事务临时文件。
- 成功返回 DownloadedSelfUpdate，绑定 plan、targetPath、tempPath；apply 只能消费该对象。

### L3 — POSIX 原子应用

- 在 rename 前完成 temp 文件 mode=0755、fsync（平台支持时）和最终完整性复核。
- rename 是最后一个可能改变目标的步骤；成功后不再运行外部 chmod 等可失败命令。
- apply 前失败时旧目标字节与 mode 保持不变；临时文件按错误类型清理或保留可诊断状态，语义必须测试锁定。

### L4 — Windows 延迟更新

- helper 必须兼容 PS5.1，以参数传入 ParentPid、TempPath、TargetPath、WorkingDirectory、RestartAfterApply、ExpectedSize 与 ExpectedSha256。
- helper 等待父进程退出后重试 Copy-Item，校验目标 size/hash，成功后清理 temp/helper。
- RestartAfterApply=false 时不得 Start-Process；true 时才重启目标。
- spawn 必须等待 child spawn 事件确认，异步 error 不能被误报为 helper 已启动。
- CLI 对 scheduled 结果使用准确文案；不能在 helper 尚未执行时声称更新已完成。

### L5 — Windows 延迟自卸载

- 新增 core/self-uninstall.ts，返回 deleted、scheduled 或结构化错误，不直接输出 console。
- 使用规范化真实路径、Windows 大小写不敏感规则比较安装目标与 process.execPath。
- 目标是当前 Windows exe 时启动独立 uninstall helper；helper 等父进程退出、重试 Remove-Item、验证 Test-Path=false、记录脱敏日志并自删除。
- uninstall helper 禁止启动目标/TUI；helper 文件使用唯一安全名称。
- 目标非当前 exe 或非 Windows 时继续直接删除。
- cli/commands/uninstall.ts 保持确认/non-TTY/退出码入口，只根据 core 结果输出“已删除”或“已安排”。

### L6 — OpenTUI 状态与重启

- UpdateScreen 的 ready 状态必须携带 DownloadedSelfUpdate，而不是只保存 version 后重新推导路径。
- 仅 downloading/cancelling 阶段允许 Esc 中止；applying 阶段显示不可取消。
- POSIX 更新完成后，立即重启路径必须先 renderer.destroy 再启动新可执行文件。
- Windows TUI apply 在 helper scheduled 后销毁 renderer/退出，由 helper 在替换成功后重启。
- restart spawn 失败必须给出可操作的手工重启提示，不得留下终端 raw mode。

### L7 — 测试、CI 与文档

- 核心测试通过依赖注入 mock fetch/platform/currentVersion/spawn，并使用临时 CCQ_HOME。
- verify-self-update 从源码正则升级为真实 Release plan、下载、hash、apply 运行断言；可保留少量结构守卫。
- 新增 Windows uninstall helper runtime test，并将现有 update helper runtime test 接入 Windows CI。
- Windows 编译产物 smoke 必须从临时 CCQ_HOME/.local/bin/ccq.exe 执行 uninstall --yes，轮询确认 exe 与 helper 消失且未启动 TUI。
- 同步 CLI help、tui/AGENTS.md 和 build-and-release workflow。

## Acceptance Criteria

- [ ] LC1：版本矩阵覆盖 upgrade/equal/downgrade/prerelease/build metadata；只有严格 upgrade 产生 SelfUpdatePlan。（L1）
- [ ] LC2：unsupported arch、缺 asset、非法 size、缺/非法 digest 均在 check 阶段失败且零下载。（L1）
- [ ] LC3：100MB 级 response 走流式写盘；成功事务 size/hash 与计划一致；两个并发下载 tempPath 不同。（L2）
- [ ] LC4：取消、HTTP 错误、size 不符和 digest 不符会清理自己的 temp，旧目标逐字节不变。（L2）
- [ ] LC5：POSIX apply 成功后目标为新内容且 mode=0755；rename 前任一失败保留旧目标，不出现“已替换但返回失败”。（L3）
- [ ] LC6：Windows update helper 的 restart=false 不启动进程，restart=true 只在 copy+size/hash 验证成功后启动；失败保留旧目标或可诊断 temp/log。（L4）
- [ ] LC7：helper spawn 异步失败返回非零，scheduled 输出不冒充 completed。（L4）
- [ ] LC8：运行中的安装版 ccq.exe 执行 uninstall --yes 返回 0/scheduled，退出后目标删除、helper 自清理、没有新 TUI。（L5）
- [ ] LC9：Windows 非当前目标和 macOS/Linux 直接删除；取消、non-TTY 未确认和目标不存在保持既有退出语义。（L5）
- [ ] LC10：TUI 下载阶段可取消、应用阶段不可取消；POSIX restart 前 renderer 已销毁，Windows 由 helper 成功替换后重启。（L6）
- [ ] LC11：typecheck、self-update/uninstall 定向测试、全量 verify、四平台 build、Windows helper 与编译产物 smoke 全部通过。（L7）

## Technical Constraints

- Windows helper 仅使用 PS5.1 语法与内置 cmdlet。
- 不新增 runtime dependency；hash、随机数、文件流使用 node:crypto/node:fs 或 Bun 已有能力。
- 继续支持 Bun 单文件编译和四个平台 artifact 命名。
- 不增加第 7 个 Release artifact；使用 GitHub API asset.digest。
- 不把自更新失败升级为应用/TUI整体崩溃，保持失败不阻断当前可用版本。
- 不读取或写入真实用户 home 的测试。

## Out of Scope

- 指定历史版本、回滚到任意版本或 --force 降级。
- 代码签名、公钥供应链或替换 GitHub Release 信任根。
- 清理用户 PATH、配置、provider/profile、缓存目录或其他工具。
- 改造 installer 首次下载链；本任务只处理 ccq 运行后的自生命周期。
