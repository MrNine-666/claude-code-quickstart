# Linux Installer Support Implementation Plan

## Preconditions

- 在用户审阅 `prd.md`、`design.md` 和本计划前，不运行 `task.py start`。
- 编辑生产代码前，加载 `trellis-before-dev` 和当前 installer specs。
- 保留无关改动，并在每个阶段为 Windows/macOS 源码行为保持门禁。

## 1. Establish Contract Gates

- [ ] 新增 `installer/contracts/linux-platforms.json`，包含固定的官方 distro image、精确
      ID/family、package manager、architecture alias、glibc policy 和 best-effort mapping。
- [ ] 验证候选 CI image 存在；固定非 rolling tag，并记录为何只有 Arch 使用 rolling tag。
- [ ] 在 `installer/contracts/steps.json` 中为 NodeJS/Git 增加 Linux runtime directory 和
      `LinuxStepFile` 字段。
- [ ] 围绕 Unix dispatcher 重做 `installer/contracts/build.json`：由一个 `install.sh`
      拥有 macOS/Linux 分离 payload，并列出精确的八文件 Release 清单。
- [ ] 扩展 `installer/contracts/Test-Contracts.ps1`，优先检查 Linux path、distro mapping、
      payload、binary 和数量是否缺失或不一致。
- [ ] 在 `installer/contracts/` 增加 Bash-focused contract test，覆盖 fixture 平台检测、
      command mapping、privilege/no-TTY 行为和 lifecycle postflight。

回滚点：仅合同变更可在不触碰 runtime 的情况下还原。

## 2. Implement Linux Source Runtime

- [ ] 新增 `installer/linux/Install.sh` 以及 UI、process、profile、platform、package manager、
      JSON/registry 和 bootstrap 行为的 Bash core modules。
- [ ] 不使用 `eval` 解析 `/etc/os-release`；只接受校验过的 key/value，并用 fixture 测试
      格式错误输入。
- [ ] 实现 official、best-effort 和 unsupported 分类，覆盖 CentOS Stream、WSL1/WSL2 以及
      glibc/musl 分支。
- [ ] 将 `x86_64`/`amd64` 和 `aarch64`/`arm64` 规范化；拒绝所有其他 arch。
- [ ] 强制 normal-user、sudo-per-command 和 TTY-before-mutation 边界。
- [ ] 增加 Linux NodeJS lifecycle：复用满足要求的 runtime、修复当前 nvm/fnm、官方 nvm
      fallback 和验证。
- [ ] 仅使用 contract 选定的 package manager 实现 Linux Git lifecycle，并做安装后验证。
- [ ] 幂等处理 Bash/Zsh 的 `~/.local/bin`，不重写无关 profile 内容，并为其他 shell 提供
      手动说明。
- [ ] 实现 Linux `ccq` architecture URL selection、version handoff、download、chmod 和
      `~/.local/bin/ccq` 的原子替换。
- [ ] 证明 partial failure 能报告正确的 lifecycle state，重复运行不会复制 profile block 或
      迁移 Node provider。

Focused 验证：

```sh
bash -n installer/linux/Install.sh installer/linux/core/*.sh installer/linux/steps/*.sh
bash installer/linux/Install.sh --list-steps
bash installer/contracts/Test-LinuxInstaller.sh
pwsh -File installer/contracts/Test-Contracts.ps1
```

回滚点：Linux 目录是隔离的；Windows/macOS 保持不变。

## 3. Build The Unified Unix Installer

- [ ] 将 `installer/build.sh` 从仅 macOS 输出重构为由 manifest 拥有的 Unix artifact，不引入
      Windows 组合。
- [ ] 生成 POSIX dispatcher，嵌入独立编码的 macOS zsh 和 Linux Bash payload，只解码选中
      payload，传递退出状态并清理临时文件。
- [ ] 保留 macOS payload 中现有源码顺序、steps contract embedding、Release tag 注入
      和版本交接语义。
- [ ] 根据 `build.json` 增加 Linux 源码顺序和内嵌合同。
- [ ] 验证 dispatcher 结构、两个 payload marker、无仓库路径依赖以及未知平台失败。
- [ ] 更新本地 build help/check 行为和 installer 导航文档。

Focused 验证：

```sh
sh installer/build.sh --check
sh installer/build.sh --platform unix
zsh -n installer/macos/Install.zsh
zsh installer/macos/Install.zsh --list-steps
bash installer/linux/Install.sh --list-steps
```

构建 artifact smoke 应在匹配的 CI OS 上运行，不通过伪造 platform 执行真实 payload。

回滚点：在合并任何 Release expected-list 变更前，先恢复 macOS-only manifest/builder。

## 4. Add Linux TUI Binaries And Self-Lifecycle

- [ ] 在 `tui/scripts/build.ts` target registry 和注释中加入 `bun-linux-x64` 与
      `bun-linux-arm64`。
- [ ] 只有在中央 target registry 之外仍有价值时才增加 focused package script；不要创建
      第二个 artifact-name source。
- [ ] 为 Linux current hosts 扩展 `tui/scripts/verify-compiled-contracts.mjs`。
- [ ] 在 `tui/src/core/self-update.ts:getAssetName` 增加两个 Linux asset。
- [ ] 为 Linux x64/arm64 选择、digest failure 和共享 POSIX 原子应用路径扩展
      `tui/scripts/verify-self-update.mjs`。
- [ ] 确认 POSIX self-uninstall 和 open-url 行为不需要 Linux-specific fork；只有证据
      暴露缺口时才增加 regression。

Focused 验证：

```sh
cd tui
bun run typecheck
bun scripts/verify-self-update.mjs
bun scripts/verify-compiled-contracts.mjs
bun run build
```

回滚点：Linux targets 和 asset mapping 一起还原；不要保留已发布但 installed runtime
无法选择的 asset。

## 5. Wire CI And Release

- [ ] 增加 Linux source/contract job，Docker matrix 从 `linux-platforms.json` 生成；mutation
      test 使用 fake command 和临时 HOME。
- [ ] 增加 native Linux x64 compiled smoke 和 native-or-QEMU Linux arm64 smoke。
- [ ] 让 Unix artifact build 收集 macOS、Linux binary 以及统一的 `install.sh`。
- [ ] 将 upload/download path、platform cleanup list、expected files、最终数量和 Release
      body table 更新为精确八文件合同。
- [ ] 让 Release 依赖所有 platform test 和两个 Linux binary smoke；缺 artifact 或 digest
      时 fail closed。
- [ ] 保持 main-branch 和 tag-version smoke expectation 与当前 version injection 一致。

CI 验证场景：

- Ubuntu/Debian -> APT mapping。
- Fedora/CentOS Stream -> DNF/YUM contract mapping。
- Arch -> Pacman mapping。
- derivative `ID_LIKE` -> warning 和显式继续。
- WSL1/musl/unknown -> no mutation 和 unsupported result。
- Linux x64/arm64 -> `--version`、help、无参数 non-TTY、内嵌 contracts。

回滚点：所有新增 job 独立通过前，不修改 Release 发布依赖。

## 6. Documentation And Durable Specs

- [ ] 更新 `.trellis/spec/project/installer/platform-runtime.md`，补充 Linux runtime、
      distro/package-manager、privilege、shell 和 best-effort contract。
- [ ] 将 `.trellis/spec/project/installer/build-release.md` 从六个 artifact 更新为八个，
      并记录 Unix dispatcher/payload build。
- [ ] 更新 `.trellis/spec/project/installer/index.md`、`.trellis/spec/project/architecture.md`、
      installer README 和面向用户的 install command。
- [ ] 删除仍把 Linux 称为 proposal 或 unsupported platform 的措辞；保留明确的
      Alpine/WSL1/derivative 限制。
- [ ] 确保 Release notes 和文档不声称十组合矩阵。

## 7. Full Quality Gate

先运行 focused gate，再运行完整的 blast-radius 检查：

```powershell
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/windows/Install.ps1 -ListSteps
pwsh -File installer/build.ps1
```

```sh
zsh -n installer/macos/Install.zsh
zsh installer/macos/Install.zsh --list-steps
bash -n installer/linux/Install.sh installer/linux/core/*.sh installer/linux/steps/*.sh
bash installer/linux/Install.sh --list-steps
bash installer/contracts/Test-LinuxInstaller.sh
sh installer/build.sh --check
```

```sh
cd tui
bun run check
bun run build
```

- [ ] 在真实 macOS 和 Linux 路径上 smoke 构建出的 `install.sh`。
- [ ] 在 CI 中 smoke `ccq-linux-x64` 和 `ccq-linux-arm64`。
- [ ] 验证 dist 和 Release 集合恰好包含八个 artifact。
- [ ] 运行 `git diff --check`，并审查无关用户改动是否保留。
- [ ] 在 commit/archive 前完成 spec/source/CI 一致性审查。

## Completion Gate

只有当 `prd.md` 中的 AC1-AC8 都有源码、focused gate 和完整 CI-compatible validation
set 证据时，实施才算完成。只有本地构建 Linux binary、却没有统一 installer、distro matrix
或 Release blocker 证据，不算适合发布的部分完成。
