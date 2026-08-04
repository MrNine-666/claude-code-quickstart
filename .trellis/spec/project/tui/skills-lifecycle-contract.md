# Skills Multi-Source Lifecycle Contract

## 1. Scope / Trigger

修改 Skills 已安装检测、逻辑实例身份、source 展示、update、Agent 管理、`.codex` adoption、同名替换、删除规划、snapshot 或生命周期对账前阅读此合同。

长期受管控拓扑仅包括：

- `.claude/skills/<name>`：Claude-only；
- `.agents/skills/<name>`：Codex-only；
- `.agents/skills/<name>` 加上 `.claude/skills/<name>` projection：Shared。

`.codex/skills` 是 upstream CLI 报告的用户安装 Skills 的兼容输入。新的 TUI 安装
绝不以 `.codex` 为目标。

## 2. Signatures

```ts
parseSkillsListJson(parsed: unknown): SkillsListParseResult;

groupInstalledSkillItems(
  records: readonly SkillsCliListRecord[]
): readonly InstalledSkillItem[];

detectInstalledSkillItems(
  exec?: ExecFn
): Promise<readonly InstalledSkillItem[]>;

normalizeSkillSourceIdentity(
  rawSource: string | undefined
): string | undefined;

buildSkillsOwnershipIndex(
  items: readonly InstalledSkillItem[]
): SkillsOwnershipIndex;

skillsHomeRows(state: SkillsViewState): readonly SkillsHomeRow[];

selectedOrCurrentInstalled(
  state: SkillsViewState
): readonly InstalledSkillItem[];

updateSkillInstances(
  items: readonly InstalledSkillItem[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn
): Promise<SkillsBatchUpdateOutcome>;

transitionSkillTopology(
  item: InstalledSkillItem,
  target: 'claude-only' | 'codex-only' | 'shared',
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  options?: SkillStorageOptions
): Promise<SkillsAdoptionResult>;

uninstallSkillInstance(
  item: InstalledSkillItem,
  allItems: readonly InstalledSkillItem[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  storageOptions?: SkillStorageOptions
): Promise<SkillsUninstallOutcome>;

uninstallSkillInstances(
  items: readonly InstalledSkillItem[],
  allItems: readonly InstalledSkillItem[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  storageOptions?: SkillStorageOptions
): Promise<SkillsBatchUninstallOutcome>;

installSearchResultsToTargets(
  results: readonly SearchSkillResult[],
  targets: readonly AgentContext[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  options?: SkillsInstallExecutionOptions
): Promise<SkillsBatchExecution>;

cleanupConfirmedReplacementSnapshots(
  replacements: readonly SkillsReplacementExecution[],
  confirmedKeys: readonly string[]
): Promise<void>;
```

共享 domain object 为：

```ts
type InstalledSkillItem = {
  readonly id: string;
  readonly name: string;
  readonly provenance: SkillProvenance;
  readonly agents: readonly string[];
  readonly projections: readonly SkillProjection[];
  readonly capabilities: {
    readonly update: boolean;
    readonly manageAgents: boolean;
    readonly migrate: boolean;
    readonly delete: true;
  };
};
```

`SkillsAdoptionResult.outcome` 为 `complete | partial | restored | failed`。
`SkillsUninstallOutcome.outcome` 为 `complete | partial | failed`。两者都暴露
`mutated`；一旦 mutation 可能改变外部状态，该字段就变为 true。已安装列表 reducer
state 持有 `homeLayout: 'flat' | 'grouped'`、`collapsedSourceKeys`、
`pickedInstalledIds` 和 `pendingBatchInstanceIds`。

## 3. Contracts

### Detection and identity

- 已安装 state 只有一个事实来源：一次成功的
  `npx skills list -g --json` JSON array。Detection 不读取 `.skill-lock.json`，也不
  枚举 `.claude`、`.agents` 或 `.codex` 来新增、删除、拆分、合并或修正记录。
- 非零退出、空输出、无效 JSON、顶层不是 array，或任一记录无效，都会使整个 detection
  失败。绝不静默跳过记录，也不回退到 filesystem inspection。
- 只有 `agents` 决定 Agent availability；只有 `source` 和 `sourceUrl` 决定
  provenance；`path` 只用于分类 storage projection 并支持已确认的迁移/删除安全性。
- 已知 instance identity 为 `(name, normalizedSourceIdentity)`。存在 `sourceUrl`
  时优先将其作为操作 source；`source` 与 `sourceUrl` 仍是分离的 display 字段。
  GitHub HTTPS、SSH、`github:`、`github.com/` 和 `owner/repo` 等价形式规范化为一个
  identity。
- 相同 name 和规范化 source 的已知记录合并为一个 Item，合并 agents，并按精确路径
  去重 projection。不读取或比较内容。不同 source 的已知记录仍保持为相邻的独立 Item。
- 未知记录既没有 `source` 也没有 `sourceUrl`。只有规范化后的精确 path 相同时才合并；
  name 单独绝不能作为合并 key。
- `(root, name)` 在每个物理 root 中必须唯一。如果不同 Item 声明了同一 pair，owner
  就是不明确的；所有覆盖、迁移或 direct-delete preflight 都必须拒绝猜测。

### Capabilities and UI intent

- 已知 provenance 支持 update、Agent management 和 migration。未知 provenance 仅支持
  deletion。未知 Item 的 `Enter`/`U` 必须在执行任何命令前拒绝；要改变它必须先删除，
  再重新 install。
- 已安装列表默认为单列平铺。`V` 切换按 source 分组的 projection，分组标题可展开/
  收起；所有未知 Item 共用标为 `未知来源` 的 `unknown` display group，但保留各自带
  path 的 id 和 mutation target。
- 页面级 layout/selection 摘要独立于过滤后的行 projection。它使用紧凑的
  `RadioField` 文案 `布局：平铺 / 分组`，反映 `homeLayout`，并保留 `V` 作为切换输入。
  即使已安装列表为空或当前过滤无匹配行，也要显示它和已选择 Item 总数。
- 每个 Skill 行严格包含三行内容：平铺标题 `name（source）` 或分组标题 `name`；
  http/https `sourceUrl` 锚点或 `无来源链接`；以及仅从 `agents` 推导的 Claude Code
  和 Codex availability。绝不从 `source` 合成 URL。链接保持可点击/带下划线，但使用
  install 页 `colors.muted + DIM` 的 source 样式。
- Skill Item 行使用共享的 themed `Checkbox`；聚焦或选中的框使用完整 primary color
  bracket/checkmark。分组标题通过 `ScrollList` 并设置 `bordered: false` 渲染，Skill
  Item 保留 Card border。
- `Space` 切换当前 Item 选择，也切换聚焦的 group header；`Enter` 切换 group 或管理
  当前 Item。`A` 选择/取消选择当前过滤匹配的所有 Item，包括被收起 group 隐藏的匹配项。
  过滤范围之外已有选择保持不变。
- `E` 是集中管理的 grouped-layout bulk toggle：只要有一个 installed source group
  展开，就收起全部 group；全部收起时则全部展开。过滤不会缩小范围，flat layout 下
  为 no-op；收起隐藏当前 Item 时，cursor 仍锚定到该 Item 的 source group。Skills
  报告 `list-flat` / `list-grouped` submode；仅在 `list-grouped` 下 footer 才提示
  `E 全部展开/收起`。
- `U` 和 `D` 优先使用显式选中的 Item id；没有选择时回退到当前 Skill 行。聚焦 group
  header 且没有选择时没有 mutation target。`D` 在确认前快照完整 target id 集；`Enter`
  仍然是单 Item Agent-topology 操作。
- TUI 没有 update-all 入口。批量 update 按 `capabilities.update` 过滤，跳过未知
  Item，稳定去重 name，并执行一次 `skills update <unique names...> -g -y`。上游 update
  按 name 作用，因此 UI 绝不声称 source-isolated success。
- 批量 uninstall 按顺序为每个 target 调用 instance-safe planner，始终使用操作开始时
  的同一个 `allItems` 快照。一个 Item 失败不阻止后续 Item；`AbortError` 停止整个 batch。
  任何 mutation 都使 batch 结束后执行一次完整 detection；所有 `mutated=false` 的
  preflight 失败则不刷新。

### Migration and deletion

- `.codex` 中的已知 instance 可以 adoption 为 Claude-only、Codex-only 或 Shared。
  确认 Codex-only 仍然是 migration，因为受管控的目标是 `.agents` 而不是 `.codex`。
- Migration 顺序为：快照 source/已占用 target -> 创建并验证受管控 target -> 删除旧
  source -> 完整 list reconciliation。target 创建失败时恢复被覆盖的 target；如果
  target 创建成功但 source 删除不完整，报告 partial success 并保留事实供 reconciliation。
- 只有当前完整 Item 列表证明按 name 删除不会影响另一个同名 source 时，才优先使用官方
  `skills remove`。否则使用 direct deletion 这一范围受限的安全例外。
- Direct deletion 必须先对每个候选项执行原子校验：root 受支持、是直接的
  `<root>/<name>` child、basename 安全、无 traversal、绝不是 root 或 parent，并且没有
  跨 Item ownership ambiguity。symlink/junction 只解除链接，绝不递归跟随。任何候选项
  preflight 失败时，一个都不删除。

### Same-name replacement and reconciliation

- 已选 install Agent 映射到 target root：Codex-only -> `agents`；Shared -> `agents`
  加 `claude`。其他 root 不属于 replacement transaction。
- replacement confirmation 列出占用 target root 的每个不同 source Item，展示各自的
  source 以及即将覆盖的 projection。多个旧 Item 可以对应一个新的 search identity。
- spawn add 前收集所有 target-root occupant。每个 occupant 都必须已知且可证明不同；
  每个 Item 都从自己的 target-root projection 创建快照。任一 validation/snapshot
  失败时，清理已准备的快照并不得 spawn add。
- add 成功后保留所有旧快照，直到最终 list detection 确认新 identity。确认一个新 key
  后，清理附着在该 replacement 上的所有快照；失败/未确认的 replacement 条目保留
  `recoveryPath`。
- Filesystem inspection、manifest 和 snapshot 仅是 transaction-safety 工具，绝不提供
  installed identity、provenance、Agent badge 或最终 UI state。
- 每个已启动的 install、update、migration 或 delete 都必须执行一次完整的
  `list -g --json` 刷新，即使命令/result 报告失败。安全的 preflight/no-op 且
  `mutated=false` 时不刷新。退出码和本地 optimistic filtering 都不能定义最终 state。
- lifecycle mutation 命令使用不固定版本的 `skills@latest` package contract；list/search
  命令继续使用不固定版本的 `npx skills`，绝不能恢复固定的 minor package 引用。

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| list 命令失败、输出为空/JSON 损坏或任一记录格式错误 | 整体 detection 失败，不回退 filesystem |
| `source` 和 `sourceUrl` 均缺失 | 显示 `未知来源`，仅允许 delete |
| `sourceUrl` 缺失、无效或不是 http(s) | 显示 `无来源链接`；点击和 `O` 都不打开 |
| 已安装 `sourceUrl` 安全 | 使用与 install 页相同的 muted/dim source color 渲染可点击 URL |
| 已安装列表为空或过滤无匹配行 | 在 empty state 上方保留紧凑的 `布局：平铺 / 分组` Radio 和已选数量 |
| grouped layout 下按 `E` | 如果尚有展开的 installed source group，则全部收起；否则全部展开 |
| flat layout footer / `E` 输入 | 不提示 `E`；直接输入保持 no-op |
| 不同 path 上的相同 name 与规范化已知 source | 合并 Item，合并 agents/projection，不比较内容 |
| 相同 name 但 source 已知且不同 | 保持为带稳定 id 的独立 Item |
| 不同 path 上的未知同名记录 | 保持为独立 Item |
| 不同 Item 声明同一个 `(root, name)` | 标记 ownership ambiguous，阻止 mutation preflight |
| `.codex` 已知 Item 确认 Codex-only | 迁移到 `.agents`，不是 no-op |
| 官方 remove 可能影响另一个同名 Item | 使用已验证的 direct-delete plan，或拒绝操作 |
| 任一 direct-delete 候选项校验失败 | 不删除任何内容；返回 `failed`、`mutated=false` |
| 部分已校验 target 在后续 runtime 失败前已删除 | 返回 `partial`、`mutated=true`，并完整刷新 |
| 官方 remove 已启动但以非零退出 | 返回 `failed`、`mutated=true`，并完整刷新 |
| 选择同时包含已知和未知 Item | 对已知 name 去重后只 update 一次；将未知 Item id 报为 skipped |
| 选择只包含未知 Item | 不启动 update 命令；保持可恢复并给出明确错误 |
| batch-uninstall 中一个 Item 在 mutation 前失败 | 使用原始完整 `allItems` snapshot 继续后续 Item |
| batch uninstall 产生任意 mutation | 整个 batch 完成后只 reconciliation 一次，绝不每个 Item 一次 |
| Shared replacement 覆盖 `.agents` 和 `.claude` 中不同的 Item | add 前展示并为两者创建快照 |
| replacement occupant 未知、同 source 或不可恢复 | 不执行 add；清理已准备的快照 |
| mutation 成功但最终 list 未确认 | 不得声称成功；保留诊断和 recovery snapshot |
| mutation 命令可能写入后失败 | 保留诊断并完整 reconciliation |

## 5. Good / Base / Bad Cases

- 正确：CLI 在 `.agents` 返回来自 source A 的 `pdf`，在 `.claude` 返回来自 source B 的
  `pdf`；两者显示为独立 Item。将 source C 安装到 Shared 时显示两个冲突，先为两个旧
  root 创建快照，写入新拓扑，并且只在检测到 source C 后清理两个快照。
- 正确：CLI 返回同一 name 的两种等价 GitHub 形式；无需读取任一目录即可合并。
- 正确：未知 `.codex` Item 可以通过已校验的精确 path 删除，但不能 update 或 adoption。
- 正确：过滤到 `pdf`、收起其 source group 后按 `A`，仍选中每个匹配的 `pdf` Item；
  过滤范围之外此前的选择保持选中。
- 正确：选择 `pdf` 的两个 source、一个 `docs` 和一个未知 Item 时，执行一次
  `update pdf docs -g -y`，再执行一次完整 list reconciliation。
- 基线：已知 Codex-only `.agents` Item 选择相同拓扑时是 no-op 且不刷新；同一逻辑拓扑
  位于 `.codex` 时需要 adoption。
- 错误：从 `.skill-lock.json` 丰富 list record，从 `inspectSkillStorage()` 覆盖 `agents`，
  或 delete 后在本地按 name 过滤。
- 错误：使用 `.find()` 查找 target-root replacement occupant；Shared 可能覆盖两个旧
  source，导致未快照的那个丢失。
- 错误：另一个 source 存在同名 Item 时仍使用官方 name-level remove。
- 错误：把收起的 Item 当作不在全选范围内，从 `source` 合成链接，或在 batch uninstall
  中每个 Item 都刷新一次。

## 6. Tests Required

- `verify-skills-installed-domain.mjs`：严格解析器、source 规范化、已知/未知分组、稳定
  id、capability、root 分类和 ownership ambiguity。
- `verify-skills-instance-state.mjs`：同名 cursor 行为、selected/current 回退、pending
  单项/批量 instance snapshot、未知 capability gate 和完整 reconciliation。
- `verify-skills-deletion-safety.mjs` 与 `verify-skills-uninstall-planner.mjs`：path 矩阵、
  link、原子 preflight、官方/direct-delete 选择、complete/partial/failed 和 mutation flag。
- `verify-skills-update-action.mjs`：精确去重的 batch argv，以及命令成功/失败后的完整刷新；
  稳定 name 去重、未知项跳过、无 update-all TUI seam 和恰好一次刷新。
- `verify-skills-adoption.mjs`：`.codex` adoption、C/X/B 转换、回滚、target-root replacement、
  多旧 source 快照和确认后清理。
- `verify-skills-shared-projection.mjs`：一次 list 调用、不从 lock 丰富、不扫描目录、仅
  agents badge 和仅 path storage label。
- `verify-skills-view.mjs` 与 `verify-skills-render.mjs`：source/sourceUrl/unknown 展示、
  默认平铺单列、source 分组/收起、带独立 id 的统一未知 display group、包含收起 Item
  的过滤选择、覆盖完整 installed group 集合且保持 cursor 锚定的 grouped `E` 展开/收起、
  `list-flat` 中不出现 `E` 的 flat/grouped footer projection、空过滤 projection 中保留
  页面级 layout/selection 摘要、精确 target-root 冲突列表、唯一 Modal/row key、D 与
  Enter 文案、取消、共享 themed Checkbox、muted/dim 可点击链接、无边框 group header、
  两个 Agent badge 和窄布局。
- `test-skills-topology-smoke.mjs`：在隔离 HOME 下针对官方 `skills@latest` 运行；网络或
  权限失败必须报告为外部阻塞，绝不能替换成 mock success。
- 最后运行 `bun run check` 和仓库级 `git diff --check`。

## 7. Wrong vs Correct

### Wrong

```ts
const installed = installedItems.find(item => item.name === skillName);
const storage = await inspectSkillStorage(skillName);
const snapshot = await createSkillSnapshot(preferredSkillContentPath(storage)!, skillName);
await addNewSource();
dispatch({type: 'action-done'});
```

这会按 name 折叠不同 source，最多只快照一个 target-root owner，把 filesystem inspection
当作 identity oracle，并在 CLI list reconciliation 前声称成功。

### Correct

```ts
const occupants = installedItems.filter(item =>
  item.name === skillName &&
  item.projections.some(projection => targetRoots.includes(projection.root))
);

const prepared = await snapshotEveryOccupantFromItsTargetProjection(occupants);
const action = await addNewSource();
const finalState = await cache.refreshAndWait();
await cleanupConfirmedReplacementSnapshots(
  preparedResults(action),
  confirmedSourceKeys(finalState)
);
```

Item 列表仍由 CLI 派生，每个被覆盖的逻辑 owner 都受到保护，最终 UI state 只由完整的
刷新列表替换。

### Installed-list batch actions

```ts
// 错误：收起会改变操作范围；update 假装实现了 source 隔离。
const visible = skillsHomeRows(state).filter(row => row.kind === 'skill');
for (const row of visible) await updateSkills([row.item.name]);

// 正确：选择范围来自过滤后的 Item，上游 name 只执行一次。
const targets = selectedOrCurrentInstalled(state);
const result = await updateSkillInstances(targets);
const finalState = await cache.refreshAndWait();
dispatch({type: 'lifecycle-reconciled', installed: finalState.result});
```

display projection 可以隐藏收起的行，但绝不会缩小选择范围或 mutation identity。按 name
作用域的 update 执行一次，最终事实也只 reconciliation 一次。
