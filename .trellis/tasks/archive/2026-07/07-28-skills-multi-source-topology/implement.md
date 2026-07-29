# Skills 多来源检测与拓扑迁移实施计划

## 1. 实施顺序

### Checkpoint A — CLI 协议与逻辑实例（只读）

- [ ] 先扩展 `verify-skills-shared-projection.mjs`，覆盖严格逐记录解析、独立
      `source/sourceUrl`、GitHub 等价归一化、known/unknown identity、同源合并、
      异源拆分、unknown 按 path 隔离和同名相邻排序；确认旧实现会失败。
- [ ] 在 core 建立已安装 deep module，定义 `SkillsCliListRecord`、
      `InstalledSkillItem`、provenance、projection、capability 和稳定 id。
- [ ] 让 `getInstalledSkills`/`view-detection` 只消费 list JSON；移除 lock enrichment、
      `inspectInstalledSkillStorage` 和 physical override 的检测调用。
- [ ] 保留 exact JSON `path`，只做 root 分类；不扫描三个目录，不读取内容。
- [ ] 迁移直接调用方和类型导出，删除或隔离不再属于检测链的 legacy projection。

验证：

```sh
cd tui
bun scripts/verify-skills-shared-projection.mjs
bun scripts/verify-async-detection.mjs
bun run typecheck
```

回滚点：此阶段不包含写操作；若类型迁移未闭合，只反向修改新 deep module 与检测
调用方，不触碰 storage snapshot/mutation 代码。

### Checkpoint B — reducer、列表与安装占位

- [ ] 扩展 `verify-skills-view.mjs`：Item id 而非 name、同名多 Item cursor/过滤、
      unknown 能力门禁、source/sourceUrl 展示数据、目标根级 `已有同名`、
      source-aware install reconciliation。
- [ ] 扩展 `verify-skills-render.mjs`：同名卡片稳定 key、来源/链接/存储/Agent 展示、
      未知来源、窄终端裁剪和 Modal 文案。
- [ ] 把 `SkillsViewState.installed`、selected helpers、pending Modal/busy 输入迁移到
      `InstalledSkillItem`/instance id；移除 name-based uninstall optimistic filter。
- [ ] 更新 Skills home card 和 details；Agent badge 只读 `agents`，source 与
      sourceUrl 分行展示，两者都无时显示 `未知来源`。
- [ ] unknown Item 的 Enter/U 在 reducer/input 层阻断，D 保持可用；footer 继续由
      command registry 派生。
- [ ] 把搜索已安装判断改为来源 identity；保持扁平多选与同批异源同名冲突，目标
      Modal 后再按根计算覆盖对象。
- [ ] install 对账使用 `(name, sourceIdentity)` 和目标 Agent，不再只看 name。

验证：

```sh
cd tui
bun scripts/verify-skills-view.mjs
bun scripts/verify-skills-render.mjs
bun scripts/verify-skills-agent.mjs
bun scripts/verify-shortcuts.mjs
bun run typecheck
```

回滚点：此阶段尚不改变写入 primitive；若 UI/state gate 不稳定，保留 Checkpoint A
领域投影，反向迁移 view/reducer 后重新拆分动作。

### Checkpoint C — 更新、删除和迁移事务

- [ ] 先扩展 `verify-skills-adoption.mjs` 和 `verify-skills-view.mjs`，覆盖 known/unknown
      能力、名称级 update、D 与 Enter 范围、同名异源保留、direct-delete 安全矩阵、
      `.codex` 三种目标、覆盖确认和 complete/partial/restored/failed。
- [ ] 更新 action builder：单项 update 固定一次 `update <name> -g -y`，全量固定一次
      `update -g -y`；unknown 不进入单项调用。
- [ ] 将 uninstall service 输入从 `name` 改为 Item 快照；实现“可证明唯一时官方
      remove，否则精确 path 删除”的 planner。
- [ ] 在 core 集中实现安全名称、受支持根、直接子项、basename、穿越、lstat、
      symlink/junction 目标和所有权歧义验证；链接只 unlink，真实目录只删除已验证
      的精确目标。
- [ ] 迁移 `skills-adoption.ts`：由 JSON item + Agent draft 规划拓扑，不再由 physical
      inspection 推导；`.codex` Codex-only 确认同侧仍强制迁移 `.agents`。
- [ ] 复用/调整 snapshot primitive，实现 source + occupied targets 快照、目标先行、
      源后删、一次恢复和 snapshot retention；不以 manifest/hash 作为身份。
- [ ] 更新 replacement/install service，使同名覆盖只作用于选定目标根，保留其它根
      的异源 Item。
- [ ] 每个 mutation 结束后通过共享 detection cache 完整复检；结果使用领域级
      reconciled/partial/restored/failed action，不派发名称级 `action-done`。

验证：

```sh
cd tui
bun scripts/verify-skills-adoption.mjs
bun scripts/verify-skills-view.mjs
bun scripts/verify-skills-shared-projection.mjs
bun scripts/verify-skills-agent.mjs
bun scripts/test-skills-topology-smoke.mjs
bun run typecheck
```

回滚点：direct-delete 与迁移必须在 focused gate 全绿后才接入输入处理。运行事务失败
使用快照恢复；无法证明恢复时保留 recovery path，禁止清理。代码层若需撤回，仅反向
修改 Skills mutation slice，不重置工作树。

### Checkpoint D — 规格、全量门禁与审查

- [ ] 重写 `.trellis/spec/frontend/skills-lifecycle-contract.md` 的检测、身份、删除、
      迁移和复检规则，删除 physical inspection 覆盖 CLI 的旧事实。
- [ ] 更新 `skills-batch-install-contract.md`：已安装判断 source-aware、覆盖按目标根，
      仍保留 flat multi-select 与同批同名限制。
- [ ] 必要时同步 `state-management.md` 的 instance snapshot/reconciliation 示例；不在
      `tui/AGENTS.md` 重复长期细节。
- [ ] 检查所有 `skills` verify 脚本没有继续断言 lock enrichment、name-only key、
      physical badge override 或“只能官方 CLI 删除目标树”的旧规则。
- [ ] 审查同名其它来源、unknown、其它 Agent badge、取消/失败和刷新失败路径。

最终验证：

```sh
cd tui
bun scripts/verify-skills-shared-projection.mjs
bun scripts/verify-skills-view.mjs
bun scripts/verify-skills-render.mjs
bun scripts/verify-skills-adoption.mjs
bun scripts/verify-skills-agent.mjs
bun scripts/verify-async-detection.mjs
bun scripts/verify-shortcuts.mjs
bun run check
cd ..
git diff --check
```

`test-skills-topology-smoke.mjs` 会调用官方 `skills@latest`，若本机网络/权限不允许，
必须记录为外部验证阻塞，不能用 mock gate 冒充官方 CLI smoke 成功。

## 2. 风险文件

- `tui/src/core/skills.ts`：当前 list/parser/source normalization owner，调用面大。
- `tui/src/core/skills-storage.ts`：从检测分类收缩到快照和精确删除安全边界。
- `tui/src/core/skills-actions.ts`：官方命令 argv、环境和 direct-delete 入口。
- `tui/src/services/view-detection.ts`：共享 cache 的 installed 结果类型。
- `tui/src/services/skills-service.ts`：批次、replacement、更新/删除 orchestration。
- `tui/src/services/skills-adoption.ts`：迁移/回滚事务和 partial 结果。
- `tui/src/state/skills-view-state.ts`：name identity、pending snapshot、reconciliation。
- `tui/src/views/skills/*`：输入、Modal、卡片 key、来源展示和确认文案。
- `tui/scripts/verify-skills-*.mjs`：旧物理拓扑 contract 与新 contract 必须同批迁移。

## 3. 实施守则

- 保留工作区中 self-update、Trellis workflow/config 和其它任务的现有改动；不顺手
  格式化或重构无关文件。
- 不创建 worktree，不执行 reset/checkout 清理用户改动。
- 新增验证先证明能在旧实现上失败，再实现通过；不得删除旧覆盖来让门禁变绿。
- parser、路径信任边界和 mutation result 使用显式 readonly/discriminated union；
  Views 不 cast CLI JSON、不读 HOME 路径。
- 所有命令仍走 `core/exec.ts` 和 AbortSignal seam；正常 TUI 文案不泄露未经处理的
  stdout/stderr。

## 4. 开始实现前复核

- [ ] 用户已审阅最新 `prd.md`、`design.md`、`implement.md` 并在后续消息明确批准。
- [ ] `implement.jsonl` 与 `check.jsonl` 已换成真实 spec 条目。
- [ ] 运行 `task.py start` 后状态为 `in_progress`，再加载 `trellis-before-dev` 或按
      当前 Codex dispatch mode 进入 Phase 2。
- [ ] 开始前重新检查 `git status --short`，确认无新增重叠编辑。

## 实施进度（会话记录）

### Checkpoint A — CLI 协议与逻辑实例（只读）✅ 已完成

- 新建 `tui/src/core/skills-installed.ts`：唯一事实源。严格逐记录解析（坏记录整体
  失败并带索引，不静默跳过）、`(name, normalizedSourceIdentity)` 逻辑身份、
  known/unknown provenance、能力矩阵（只由 provenance 派生）、
  `(root, name)` 所有权索引、路径删除安全验证骨架。
- 新建 `tui/scripts/verify-skills-installed-domain.mjs`（A-1..A-7 全绿）。
- `tui/src/services/view-detection.ts` 检测链切到 `detectInstalledSkillItems`，
  移除 lock enrichment 与 `inspectInstalledSkillStorage` 调用。
- 修掉继承自旧 `skills.ts` 的真实 bug：`github:Owner/Repo` 形态被 `new URL()`
  解析为合法 URL（scheme=github:），走进 hostname 分支直接 return undefined，
  永远到不了处理 `github:` 前缀的归一化分支，导致等价来源判为不同实例。
  新模块在 slug 解析前先剥离 scheme。
- typecheck 干净。

### Checkpoint B — reducer、列表与安装占位 ✅ 已完成

- `tui/src/state/skills-view-state.ts`：`installed` 改为 `InstalledSkillItem[]`；
  新增 `pendingInstanceId` 快照、`pendingInstance()`、`uninstallTarget()`、
  `canUpdateAll()`、`targetRootsOfDraft()`、`currentTopologyOfItem()`、
  `needsManagedMigration()`、`groupInstalledByName()`、`installedMatchingSource()`、
  `sourceMatchKey()`；删除 name 级乐观删除（`action-uninstall-done` →
  `uninstall-reconciled`，最终状态由完整复检 JSON 替换）。
- 能力门禁：unknown 来源在 reducer 层阻断 `manage-inject`/单项 update；
  `.codex` 同侧提交强制进入迁移确认，受管根同侧才是 no-op。
- 搜索页已安装判定改为来源 identity；覆盖确认按目标根冲突；同批仍禁选异源同名。
- View 层：卡片 React key 改 `item.id`（同名异源不再撞 key），展示
  source/sourceUrl/存储根/其它 Agent；Modals 展示来源与投影路径，删除确认
  说明范围并声明同名其它来源不受影响。
- seam：`tui/src/views/skills/skills-view-services.ts` 新增显式标注的过渡适配层
  （Item → 旧 service 签名），Checkpoint C 将替换为 Item 原生实现。
- 新建 `tui/scripts/verify-skills-instance-state.mjs`（B-1..B-5 全绿）。
- typecheck 干净。

门禁抓到并修复的真实缺陷：
1. `uninstallTarget` 优先读 cursor 而非快照——确认后移动光标会把删除打到
   同名另一来源上（R7）。改为 pendingInstance 优先。
2. `cancel` 回列表时未清 `pendingInstanceId`——快照泄漏到下一次操作（R2）。
   现在回 list 时清除快照。

旧门禁按新契约迁移（保留无关覆盖，未删覆盖换绿灯）：
- `tui/scripts/verify-skills-shared-projection.mjs`：重写，断言检测不读 lock、
  不扫目录、Agent 侧只由 agents 派生、存储位置只由 path 派生。
- `tui/scripts/verify-skills-render.mjs`：fixture 迁到逻辑实例契约，
  service seam 改名（uninstallInstance/updateOne）。
- `tui/scripts/verify-skills-view.mjs`：fixture 工厂用真实归一化函数，
  断言迁移到实例作用域（卸载文案/未知来源/来源 identity 判定）。

当前全绿门禁：verify-skills-installed-domain、verify-skills-instance-state、
verify-skills-view、verify-skills-render、verify-skills-shared-projection、
verify-skills-agent、verify-async-detection、verify-shortcuts、
verify-skills-adoption。

### Checkpoint C — 更新、删除和迁移事务 ✅ 已完成

C3-C7 按 design §8.1/§8.3/§8.4/§11/§191 落地；typecheck + 全量 skills gate + 官方
skills@latest 隔离 smoke 全绿。

- C3 uninstall planner：`uninstallSkillInstance(item, allItems)`——官方 remove 可证明
  唯一（`officialRemovalIsolated`）时走 `skills remove`，否则按 projection 经
  `verifySkillDeletionTarget` + `removeSkillTarget` 定向删除；返回 complete/partial/failed。
  `verify-skills-uninstall-planner.mjs`（U-1..U-5）。
- C4 update：单项固定 `update <name> -g -y`、全量固定 `update -g -y`；unknown 不进单项。
  `verify-skills-update-action.mjs`（C4-1..C4-7）。
- C5 迁移事务：`transitionSkillTopology(item, target)` 由 JSON item + draft 规划，
  snapshot 先行/源后删/一次恢复；`.codex` 同侧仍强制收编 `.agents`（needsManagedMigration）。
  `test-skills-topology-smoke.mjs` 真实 skills@latest 验证六向转换 + 三 no-op + 内容保留。
- C6 replacement source-aware：同名覆盖只作用选定目标根，保留其它根异源 Item；
  `verify-skills-adoption.mjs` 重写 verifySourceReplacement（11/11）。
  额外修生产 bug：`verifySkillDeletionTarget` symlink 分支 supportedRoots 词法 resolve
  与 target realpath 规范化不对称（win32 8.3 / macOS /tmp→/private/tmp），改为两端
  等价 realpath 规范化后再比较。`verify-skills-deletion-safety.mjs`（C-1..C-12）。
- C7 seam 替换 + reducer 对账 + B 遗留收尾：
  - `skills-view-services.ts` `uninstallInstance` seam 从 `uninstallSkillAllAgents(name)`
    （name 级全量删）替换为 `uninstallSkillInstance(item, allItems)` Item 原生来源隔离删除
    （R7：同名异源不再被官方 remove 误伤）；outcome 适配为 `{success, error?}`。
  - reducer `install-loaded` 用 `installedFullyConfirmed`（来源 identity + Agent 投影全覆盖
    目标根）清除已确认选择，仅来源匹配但投影未齐不算确认（§191 / R4）。
  - `searchInstallItems` source-replacement 分支补 R3：旧来源 unknown 无法证明异源，
    不得猜测为可替换（`hasKnownInstance` 门禁）。
  - 修 `verify-skills-view.mjs` Checkpoint B 遗留：B 阶段误删 `getInstalledSkills` import
    破坏 Task 8.1-8.5 块；fixture `{...sharedRow, source:undefined}` 顶层覆盖无效（reducer
    只读 provenance），改为 `sharedRow(name, {source:undefined})` 真正生成 unknown provenance。
  - 修 `test-skills-topology-smoke.mjs` C5 遗留：`row` helper 仍是旧 InstalledSkill 格式
    （无 provenance/projections），transitionSkillTopology 访问 `item.provenance.kind` crash；
    迁移到 InstalledSkillItem 契约（由 inspection 的 claudeValid/canonicalValid 还原
    agents/projections）。

全量 gate（全绿）：typecheck、verify-skills-installed-domain、verify-skills-instance-state、
verify-skills-view、verify-skills-render、verify-skills-shared-projection、verify-skills-agent、
verify-skills-adoption、verify-skills-deletion-safety、verify-skills-uninstall-planner、
verify-skills-update-action、verify-async-detection、verify-shortcuts、test-skills-topology-smoke。

### Checkpoint D — 规格、全量门禁与审查 ✅ 已完成

- `trellis-check` 发现并修复 Shared 目标的多根覆盖缺陷：`.agents` 与 `.claude`
  分别由不同来源占用时，service 不再只 `.find()` 一个旧实例，而是完整预检并从
  各自目标根投影建立两个恢复快照；确认 Modal 同样展示两个旧来源，并使用
  `(new identity, old item id)` 唯一 key。
- `verify-skills-adoption.mjs` 新增双根双来源覆盖、两个恢复内容和统一清理回归；
  `verify-skills-view.mjs` / `verify-skills-render.mjs` 固化完整冲突列表、准确目标根与
  最终 CLI 复检文案。
- 重写 `skills-lifecycle-contract.md` 与 `skills-batch-install-contract.md`，同步
  CLI list 唯一事实源、来源身份、unknown 仅删除、目标根级覆盖、窄 direct-delete
  例外和所有 mutation 完整复检；`state-management.md` 补 instance snapshot 规则。
- TUI runtime/scripts/package 已确认不存在固定 `skills@<minor>`；mutation 使用
  `skills@latest`，list/search 使用未钉版本的 `npx skills`。任务 PRD/design 中的
  `skills@1.5.20` 只保留为 2026-07-28 上游实测记录。
- `bun run check` 全绿；官方 `skills@latest` 隔离 HOME smoke 全绿；
  `git diff --check` 全绿。当前 Windows 未启用目录符号链接权限，删除安全门禁按既有
  规则跳过 C-8/C-9/C-10/C-12 的 symlink 实机分支，其余路径与真实拓扑 smoke 已通过。
