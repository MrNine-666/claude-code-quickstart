# Skills Flat Multi-Source Install Contract

## 1. Scope / Trigger

修改 Skills search/install 页面、search identity、多选 reducer state、target Modal、source batches、同名冲突流程、替换 snapshot cleanup 或安装后对账前阅读此合同。

可见结果列表保持平铺。内部执行可以按 source 分组选项，但新安装只允许目标为受管控的 `.agents` / `.claude` 拓扑。

## 2. Signatures

```ts
searchSkillIdentity(
  result: SearchSkillResult
): SearchSkillIdentity | undefined;

planSkillInstallBatches(
  results: readonly SearchSkillResult[]
): readonly SkillsInstallPlanBatch[];

searchInstallItems(
  state: SkillsViewState
): readonly SearchInstallItem[];

pendingSourceReplacements(
  state: SkillsViewState
): readonly SourceReplacementItem[];

targetRootsOfDraft(
  draft: InstallDraft
): readonly SkillsStorageRoot[];

installSearchResultsToTargets(
  results: readonly SearchSkillResult[],
  targets: readonly AgentContext[],
  onProgress?: ProgressCallback,
  exec?: SkillsExecFn,
  options?: {
    readonly installed?: readonly InstalledSkillItem[];
    readonly storage?: SkillStorageOptions;
  }
): Promise<SkillsBatchExecution>;

DetectionCache<Result>['refreshAndWait']:
  (options?: DetectionRunOptions) =>
    Promise<DetectionState<Result> | undefined>;
```

Reducer 持有的安装字段是 `pickedResultKeys`、`pendingInstallKeys` 和 `batchStage`。`SourceReplacementItem` 携带新 result/identity、旧 `InstalledSkillItem`，以及仅与目标 root 相交的该 Item 投影。

## 3. Contracts

### Selection and planning

- 保留现有的平铺多选 UI。`SearchSkillIdentity.key` 为
  `JSON.stringify([source, skillName])`；选择逻辑始终区分 source。
- 已安装匹配使用 `(skillName, normalizedSourceIdentity)`，有已安装的
  `sourceUrl` identity 时优先使用它。等价的 GitHub URL、SSH、`github:` 和
  `owner/repo` 形式视为同一 source。
- 相同 name 加相同 source 表示已安装且不可选。相同 name 加可证明不同的已知
  source 可标记为 `已有同名` 并选择；实际覆盖范围只有在 Agent target 草稿确定
  后才能决定。
- 不能把未知的已安装 Item 推断为不同 source，也不能直接 adoption。target-root
  preflight 遇到未知 provenance 时必须阻止 add。
- planner 保留 source 首次出现的顺序，将同一 source 的 name 合并为重复的
  `--skill` 参数，并去重完全相同的 identity。一次提交选择同一 `skillName` 的
  不同 source 时，必须在 spawn 前拒绝，因为它们会竞争同一个 target-root name。
- 不同 source 的 batch 按顺序执行，一个 batch 失败后仍继续后续 batch。不得并发
  执行，也不得读取隐藏的 Header Agent context。

### Targets and replacement confirmation

- target Modal 保持多选行为。新 install 默认选中 Codex，可切换 Claude。Codex-only
  映射到 `agents`；Shared 映射到 `agents` 加 `claude`。新 install 不得写入
  `.codex`。
- `pendingInstallKeys` 是不可变的提交快照。取消时清除快照，但保留显式选择。
- 对每个 pending search identity，`pendingSourceReplacements()` 返回占用至少一个
  已选 target root 的所有不同 source Item。不得使用 `.find()`：`.agents` 与
  `.claude` 可能包含来自两个不同 source 的同名 Item。
- 每行确认项展示旧 source/sourceUrl、新 source，以及即将覆盖的 target projection。
  render key 同时包含新 search identity 和旧 Item id。
- service preflight 与确认项保持一致：收集每个 target-root occupant，拒绝相同、
  未知或不可恢复的 owner，并在 add 前从各旧 Item 自己的 target-root projection
  创建快照。任何失败都要清理已准备的快照且不得 spawn add。

### Execution and reconciliation

- 每个 source batch 使用一个明确的 target 集合。Shared 按顺序使用
  `--agent codex --agent claude-code` 且不带 `--copy`；Codex-only 使用
  `--agent codex --copy`。
- action 命令使用不固定版本的 `skills@latest`。受限 child env 保留
  `HOME`/`USERPROFILE` 与 `CLAUDE_CONFIG_DIR`；面向 Codex 的命令额外设置
  `CODEX_HOME=<home>/.agents`，因此受管控正文不会落入 `.codex`。
- 所有命令完成后，调用共享 cache 的 `refreshAndWait()` 且仅调用一次，包括
  可能已经修改状态的命令失败。最终已安装 Item 只能来自刷新后的
  `list -g --json` 结果。
- 只有刷新后的 Item 同时匹配 source identity 并覆盖请求的 Agent/root projection
  时，提交的 result 才算确认。退出码为零或仅出现同名记录都不充分。
- 返回 install 页面时保留 query、平铺结果和 cursor。已确认的 result 取消选择；
  缺失、partial 或未确认的 result 保持选择以便重试。
- replacement snapshot 保留到刷新后的 Item 确认新 key。确认一个 key 后，清理
  该新 Item 对应旧 owner 的全部快照。
- outcome 摘要由 parent-owned toast 展示；不要增加持久的页面底部摘要。

### View behavior

- 进入 install 页面时复用 App detection cache，不执行刷新。刷新只发生在 App 初次
  detection、显式按下 `r` 或 lifecycle reconciliation 时。
- 行使用 `focusIndicator="leading"`；聚焦 Checkbox 的 bracket/title 使用 primary
  color，不铺满整张 Card 背景。disabled/installed/conflict title 保持普通文字颜色，
  固定的 `titleRight` status/download 内容在长 title 下仍然可见。
- 已安装过滤和远程搜索使用共享 `SingleLineInput`；reducer 同步同时处理
  `onInput` 与 `onChange`，页面 input 对 Enter 只拥有一次处理权。

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| 选择为空或 target 为空 | 在 spawn 前拒绝 |
| search result 无法生成 `source@skillName` | UI 中禁用，并在防御性校验中拒绝 |
| 相同 source/name 已安装 | 显示已安装，不可选择 |
| 不同已知 source/name 只存在于已选 target root 之外 | 不为该 Item 显示 replacement confirmation，并保留它 |
| 不同已知 source 占用 Shared 两个 target root | 显示两行确认项并创建两个快照 |
| target root 被未知 provenance 占用 | 阻止自动覆盖，要求删除后重新安装 |
| 两个已选 source 使用同一 `skillName` | 在 spawn 前拒绝整个提交 |
| 存在未上报的物理 target path | 在 spawn 前拒绝孤立覆盖 |
| 一个 source 命令失败 | 记录失败，继续后续 source batch，并完整刷新 |
| Codex-only target | 一个 Codex Agent、`--copy`、`CODEX_HOME=.agents`；绝不使用 `.codex` |
| Shared target | 按顺序执行 Codex 再 Claude Code，不使用 `--copy` |
| 命令退出码为零但刷新后的 source/topology 不完整 | 保持选择并报告未确认 |
| 刷新失败 | 不得声称 install/replacement 成功；保留重试选择和快照 |

## 5. Good / Base / Bad Cases

- 正确：`org/a@one`、`org/a@two` 和 `org/b@three` 组成两个顺序 batch；即使第一个
  batch 失败，第二个仍然执行。
- 正确：source C 安装到 Shared 时发现 `.agents` 中的 source A 和 `.claude` 中的
  source B；确认项列出两个旧实例，service 在 add 前为两者都创建快照。
- 正确：source B 安装到 Codex-only 时发现 `.agents` 中的 source A 和 `.claude` 中的
  source C；只有 source A 进入事务，source C 保持不变。
- 基线：没有显式选择时按 Enter，为当前可选 result 创建一个单 Item 提交并打开一个
  target Modal。
- 错误：在 target 尚未确定前禁用所有同名不同 source 的 search 行，或仅凭 name
  判断已安装。
- 错误：按 repo 对可见行分组、并发运行 source、使用 `.find()` 查找冲突，或在完整
  detection 前派发 `action-done`。

## 6. Tests Required

- `verify-skills-view.mjs`：平铺顺序、tuple identity、规范化 source 匹配、显式/全选/
  单项选择、快照取消、target-root 冲突展开、旧 Item 唯一 key、source batch 顺序、
  失败后继续以及 source/topology 对账。
- `verify-skills-adoption.mjs`：孤立项 preflight、相同/未知 source 阻止、其他 root
  保留、全 target preflight、多 replacement snapshot、保留 recovery path 和确认后
  清理。
- `verify-skills-render.mjs`：聚焦/禁用颜色、leading/titleRight 布局、source 与
  target projection 文案、Modal 滚动、共享 input 行为和窄终端。
- `verify-skills-installed-domain.mjs` 与 `verify-skills-shared-projection.mjs`：本合同
  消费的已安装事实保持 CLI-only 且感知 source。
- `verify-async-detection.mjs`：等待完成的刷新返回与写入 cache sink 的最终状态相同。
- `verify-shortcuts.mjs`：Space/select-all/confirm/cancel 绑定和 footer 文案从
  `SKILLS_COMMANDS` 派生。
- 最后运行 `bun run check` 和 `git diff --check`。

## 7. Wrong vs Correct

### Wrong

```ts
const occupied = installed.find(item => item.name === result.skillName);
if (occupied) showOneConflict(occupied);

await installSearchResultsToTargets(selected, targets);
dispatch({type: 'action-done'});
cache.refresh();
```

这会按 source 折叠 identity、隐藏第二个 target-root owner、只保护一个旧实例，并在
刷新前报告完成。

### Correct

```ts
const conflicts = pendingSourceReplacements(state); // one entry per old Item
dispatch({type: 'confirm-source-replacement'});

const execution = await installSearchResultsToTargets(
  pendingInstallResults(state),
  selectedTargets(state.installDraft),
  onProgress,
  exec,
  {installed: state.installed}
);

const finalState = await cache.refreshAndWait();
dispatch(reconcileInstallExecution(execution, finalState));
```

UI 与 service 使用同一个 target-root ownership model，只有完整的 CLI 刷新才能决定
哪些选择和快照已确认。
