# macOS Skills 管理对齐与双平台公共模块抽离计划

> 状态：待确认  
> 范围：`installer/windows/steps/Skills.ps1`、`installer/macos/steps/Skills.zsh`、`installer/contracts/skills.json`、`installer/contracts/scripts/skills-discovery.js`、构建与契约校验链路  
> 目标：修复 macOS Skills 管理未排除 CCG Workflow 受管 Skills 的问题，并研究/落地可控的双平台复用边界。

## 1. 已验证事实

1. Windows Skills 管理已有忽略名单：`installer/windows/steps/Skills.ps1` 中 `$script:SkillsIgnoredNames` 包含：
   - `ccg-skills`
   - `collaborating-with-codex`
   - `collaborating-with-gemini`
2. Windows 在 `Get-InstalledSkillRecords` 中过滤忽略名单，因此状态、更新、卸载等路径不会把 CCG Workflow 受管 Skills 当作普通 Skills 管理。
3. macOS `installer/macos/steps/Skills.zsh` 当前 `ccq_skills_installed_names` 直接解析 `npx --yes skills list -g -a claude-code --json` 并输出全部 `item.name`，未过滤 CCG Workflow 受管 Skills。
4. macOS Skills 管理的状态、更新、卸载、安装前快照都复用 `ccq_skills_installed_names`，因此在该函数补过滤可覆盖主要调用链。
5. `installer/contracts/scripts/skills-discovery.js` 已被定位为“纯算法层”，当前负责 `skills add --list` 输出解析和状态判定；macOS build 会嵌入此脚本，Windows source 模式可读取该脚本，但 Windows release 单文件模式不会嵌入 contracts/scripts。
6. `installer/contracts/skills.json` 当前只描述可安装 catalogue，未描述“由其他步骤管理、应从 Skills 管理中排除”的 ignore policy。
7. `installer/contracts/Test-Contracts.ps1` 会校验 `skills.json` 与 Windows fallback、macOS fallback catalogue 一致；如扩展 contract schema，需要同步更新此校验。

## 2. 修改前三问

### 2.1 这是真问题还是臆想？

是真问题。macOS Skills 管理会把 CCG Workflow 步骤安装/管理的 Skills 纳入普通 Skills 管理，导致：

- 状态页展示不属于 catalogue 的 CCG Workflow 受管 Skills；
- 更新“全部已安装 Skills”时可能误更新 CCG Workflow 受管 Skills；
- 卸载菜单可能误允许卸载 CCG Workflow 依赖的 Skills。

### 2.2 现有实现能否复用或扩展？

可以复用 Windows 的 ignore policy 语义，但不能直接 copy-paste 大段 PowerShell 逻辑到 zsh。推荐把“忽略名单”上升为 contract 数据，再由双平台 runtime 分别读取并 fallback。

### 2.3 会影响哪些调用关系、配置或用户流程？

影响链路：

- macOS：`ccq_skills_installed_names` → `ccq_skills_any_known_installed` / `Install-Skills` / `Update-Skills` / `Uninstall-Skills` / `ccq_skills_show_status`
- Windows：如将 ignore policy 抽到 contract，需要同步 `Get-SkillsCatalogue` 或新 helper 读取 contract 字段，保持 release fallback。
- contracts：`skills.json` schema、fallback 一致性校验、构建嵌入策略。
- Release：Windows `irm|iex` 场景不能假设 contracts/scripts 存在，必须保留 inline fallback。

## 3. 方案评估

### 方案 A：只在 macOS `Skills.zsh` 增加硬编码忽略名单

优点：

- 改动最小；
- 风险最低；
- 可立即修复 macOS 问题。

缺点：

- ignore policy 在 Windows/macOS 各自硬编码，后续可能漂移；
- 没有满足“双平台复用”的长期目标。

结论：可作为紧急补丁，但不推荐作为最终方案。

### 方案 B：在 `skills.json` 增加 `IgnoredSkillNames`，双平台读取 contract + fallback

优点：

- 将业务策略上升为跨平台单一事实源；
- Windows/macOS 均可保留平台原生实现，只复用 policy 数据；
- 对 Release 单文件兼容风险较小：source 模式读 contract，built/不可用场景走 inline fallback；
- 符合现有 `contracts/` 职责：保存跨平台业务语义。

缺点：

- 需要同步更新 `Test-Contracts.ps1`；
- Windows fallback 与 macOS fallback 仍需保留一份 inline 数据，但可由契约校验防漂移。

结论：推荐本轮执行。

### 方案 C：抽离完整 Skills 状态算法到 `contracts/scripts/skills-discovery.js`

优点：

- 可进一步复用状态判定、忽略过滤、名称归一化等算法；
- 已有脚本位置与职责适合承载纯算法。

缺点：

- Windows release 单文件当前不嵌入 contracts/scripts；若强制依赖 JS 脚本，会破坏 `irm|iex` fallback；
- PowerShell/zsh 与 Node 脚本之间的数据交换会增加复杂度；
- 当前 JS 解析规则与 PowerShell/zsh fallback 并不完全一致，贸然统一可能引入行为变更。

结论：本轮只做“研究与轻量增强”，不强制让 Windows/macOS runtime 全量依赖该 JS 脚本。可作为后续二期。

## 4. 推荐实施方案

采用“B 为主，A 作为 fallback，C 只做边界梳理”的分阶段实现。

### Phase 1：跨平台 ignore policy contract 化

1. 修改 `installer/contracts/skills.json`：
   - 新增顶层字段 `IgnoredSkillNames`；
   - 值为当前 Windows 语义：`ccg-skills`、`collaborating-with-codex`、`collaborating-with-gemini`。
2. 修改 `installer/windows/steps/Skills.ps1`：
   - 保留 `$script:SkillsIgnoredNames` inline fallback；
   - 新增/调整 helper 从 `skills.json` 读取 `IgnoredSkillNames`；
   - `Test-SkillNameIgnored` 使用 contract 优先、fallback 兜底；
   - 不改变当前 `Get-InstalledSkillRecords` 的过滤调用点。
3. 修改 `installer/macos/steps/Skills.zsh`：
   - 新增 `ccq_skills_ignored_names_fallback`；
   - 新增 `ccq_skills_ignored_names`，优先从 `skills.json` 读取 `IgnoredSkillNames`，失败时 fallback；
   - 新增 `ccq_skills_name_ignored` 或在 Node 解析中传入 ignore list；
   - `ccq_skills_installed_names` 输出前过滤忽略项。
4. 修改 `installer/contracts/Test-Contracts.ps1`：
   - 校验 `IgnoredSkillNames` 存在且非空；
   - 校验 contract 中 ignore list 与 Windows fallback 一致；
   - 校验 macOS fallback 可从 `Skills.zsh` 中提取并与 contract 一致。

### Phase 2：公共模块复用边界研究落地（轻量）

1. 更新 `installer/contracts/scripts/skills-discovery.js` 注释/能力边界：
   - 明确它是纯算法辅助，不是 release 必需依赖；
   - 可选增加 ignore filtering 的纯函数或 CLI 参数，但平台 runtime 必须保留 fallback。
2. 不在本轮强制迁移 Windows/macOS 全部状态计算到 JS，以避免 Release 单文件兼容风险。
3. 后续如要二期抽离，可单独规划：
   - Windows build.ps1 嵌入 contracts/scripts 到临时目录；
   - 将 Windows/macOS discovery parse 规则统一；
   - 设计跨平台 JSON 输入/输出协议；
   - 增加 Node 脚本单测。

### Phase 3：文档同步

1. 更新 `installer/contracts/README.md`：说明 `skills.json` 同时包含 catalogue 与 ignore policy。
2. 更新 `installer/windows/steps/CLAUDE.md` 的 Skills 段：说明 CCG Workflow 受管 Skills 被排除在 Skills 管理之外。
3. 更新 `installer/macos/README.md` 或新增 macOS Skills 说明：同步说明 macOS 与 Windows 对齐。

## 5. 具体改动文件

预计修改：

- `installer/contracts/skills.json`
- `installer/contracts/README.md`
- `installer/contracts/Test-Contracts.ps1`
- `installer/windows/steps/Skills.ps1`
- `installer/macos/steps/Skills.zsh`
- `installer/windows/steps/CLAUDE.md`
- `installer/macos/README.md`

可能修改（视实现细节）：

- `installer/contracts/scripts/skills-discovery.js`

## 6. 验证计划

### 必跑

1. contracts 一致性检查：

```powershell
pwsh -File installer/contracts/Test-Contracts.ps1
```

2. Windows 语法检查：

```powershell
pwsh -File test-syntax.ps1
```

3. Windows 构建检查：

```powershell
pwsh -File installer/build.ps1
```

4. macOS 构建结构检查（当前环境若无 zsh，则接受文本结构检查结果）：

```sh
sh installer/build.sh --check
```

### 有 zsh 环境时追加

```sh
zsh -n installer/macos/steps/Skills.zsh
zsh -n installer/macos/Manage.zsh
zsh -n installer/macos/Install.zsh
```

### 手工/交互验证建议

在 macOS 环境或 zsh 可用环境验证：

```sh
zsh installer/macos/Manage.zsh --action Skills
```

确认状态页、更新菜单、卸载菜单不再展示 `ccg-skills`、`collaborating-with-codex`、`collaborating-with-gemini`。

## 7. 风险与控制

1. `skills.json` schema 扩展风险：通过 `Test-Contracts.ps1` 控制。
2. Release 单文件兼容风险：所有 runtime 读取 contract 都必须失败可用，保留 inline fallback。
3. macOS zsh 数组/下标风险：尽量用现有函数风格，避免大规模重构。
4. Windows StrictMode 风险：读取数组/字段时保持 `@()` 包裹与空值防御。
5. JS 公共模块过度抽离风险：本轮不强制 runtime 全量依赖 JS，仅抽离稳定 policy 数据。

## 8. 验收标准

1. macOS Skills 管理不再把 CCG Workflow 受管 Skills 纳入状态、更新、卸载候选。
2. Windows 现有过滤行为不退化。
3. `IgnoredSkillNames` 成为跨平台 contract 字段，并由契约检查防漂移。
4. source 模式与 release fallback 模式均不依赖不存在的源码路径。
5. 必跑校验通过；若环境缺少 zsh，则明确报告跳过项。

## 9. 不做范围

本轮不做：

- 不重写 Windows/macOS Skills 管理 UI；
- 不把全部状态判定迁移到 Node.js；
- 不改变 `skills add/update/remove` 的 CLI 参数语义；
- 不调整 CCG Workflow 安装步骤本身；
- 不执行 git commit / push。
