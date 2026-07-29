# Skills 列表布局与批量操作设计

## 1. 设计目标

把已安装 Skills 页收敛为一个来源感知、单列、可多选的维护列表，同时保留当前
`InstalledSkillItem`、能力矩阵、来源隔离删除和完整 CLI 复检边界。

本任务是一条不可拆分发布的垂直切片：布局、光标行投影、多选、快捷键、批量动作、
确认 Modal 和复检状态必须同时生效，否则 footer、输入语义或 destructive scope 会
彼此不一致，因此不拆父子任务。

## 2. 状态模型与派生行

`SkillsViewState` 增加以下列表页状态：

```ts
type SkillsHomeLayout = 'flat' | 'grouped';

type SkillsHomeRow =
  | {readonly kind: 'group'; readonly key: string; readonly label: string}
  | {readonly kind: 'skill'; readonly key: string; readonly item: InstalledSkillItem};

type SkillsViewState = {
  // existing fields...
  readonly homeLayout: SkillsHomeLayout;
  readonly collapsedSourceKeys: readonly string[];
  readonly pickedInstalledIds: readonly string[];
  readonly pendingBatchInstanceIds: readonly string[];
};
```

- 默认 `homeLayout='flat'`，优先服务名称导向的日常浏览、过滤和批量选择；分组模式
  用于来源导向的排查与维护。所有来源组默认展开。
- 平铺模式的派生行只包含过滤后的 Skill 行。
- 分组模式先按来源身份分组，再投影组标题和未收缩的 Skill 行。已知来源以
  `provenance.identity` 为组 key；所有未知来源 Item 仅在展示投影中统一进入一个
  key 为 `unknown`、label 为“未知来源”的组。该展示聚合不得改写 Item id、路径限定
  identity、能力或 mutation target。
- 组标题显示来源 label、条目数和已选数；label 优先
  `source ?? sourceUrl ?? '未知来源'`。组按 label 稳定排序，组内按现有 Item 顺序。
- 光标索引指向当前 `SkillsHomeRow[]`。布局切换、过滤、收缩和检测刷新后优先按当前
  Item id/组 key 恢复光标，无法恢复时再 clamp。
- `pickedInstalledIds` 以稳定 Item id 持有选择，跨布局、过滤和收缩保留；每次完整
  检测只与新 Item id 集合求交，防止保留失效目标。
- `a` 针对 `filterInstalled()` 的结果切换：若范围内全部已选，则只取消该范围；
  否则补选该范围。收缩不改变范围，范围外已有选择不被清除。

## 3. 单列渲染

`SkillsHomeView` 复用 `ScrollList`、`Card` 和 `Checkbox`，不再维护双列网格与
`SKILLS_GRID_COLUMNS`。

Skill 行固定为三行：

1. 标题行前置 Checkbox。平铺模式为 `name（source）`，分组模式仅为 `name`；
   source label 使用 `source ?? sourceUrl ?? '未知来源'`。
2. 只有安全的 http/https `sourceUrl` 才渲染为带下划线的 OSC-8 `<a href>`；否则
   显示弱化的“无来源链接”。不从 `source` 猜测或合成 URL。
3. 使用现有 `itemAvailableOn()` 展示 Claude Code 与 Codex 的 `●/○` 状态。

存储根和其它 Agent 不再占用列表行；它们仍保留在领域 Item 与管理/卸载 Modal 中。
组标题也作为 `ScrollList` 行，使用 leading 展开图标承载焦点；在组标题上按
`Enter`/`Space` 切换收缩，在 Skill 行上分别执行管理安装/多选。

来源链接复用 `core/open-url.ts`：导出同一个安全 URL 判定供渲染和键盘动作共用；
`o` 对当前 Skill 调用 `openUrl()`，无安全链接或当前为组标题时只提示“无来源链接”。

## 4. 快捷键与焦点

集中 keybinding registry 增加/调整：

- `v`：切换 `flat/grouped`；
- `e`：分组模式下全部展开/收起来源组，仅在分组 footer 展示；
- `o`：打开当前 Skill 来源；
- `Space`：Skill 行切换选择，组标题切换展开；
- `a`：当前过滤范围全选/全部取消；
- `u`：更新选中项；无选择时回退当前 Skill；
- `d`：卸载选中项；无选择时回退当前 Skill；
- `Enter`：Skill 行管理 Agent，组标题切换展开；
- `i/r/Tab/Esc/Left`：继续安装、刷新、过滤焦点和返回菜单。

删除列表页 `UPDATE_ALL` command、输入分支、footer 项和 view service。安装页已有
`a`/`Space` 多选保持原子命令与子模式隔离。过滤框、Modal 和 busy 状态继续独占输入，
不得让背景列表处理上述键位。

## 5. 动作目标快照

统一纯函数 `selectedOrCurrentInstalled()`：

- 有 `pickedInstalledIds` 时，按已安装列表顺序返回这些 Item；
- 无选择且当前行是 Skill 时返回当前 Item；
- 当前为组标题且无选择时返回空。

`Enter` 和 `o` 始终只读取当前 Skill，不把多选解释成批量 Agent 管理或批量打开。
卸载确认把目标 Item ids 写入 `pendingBatchInstanceIds`，Modal 与执行阶段都从该快照
解析，不能重新按名称或光标取目标。

完整检测对账保留布局、过滤、收缩和有效选择：

- 更新后 Item 仍存在则保持已选，方便检查或重试；
- 卸载成功消失的 ids 自然移除；失败或残留的 Item 继续保持已选；
- busy、pending ids 和进度按现有 lifecycle completion 规则清理。

## 6. 批量更新

新增来源感知的 batch update service，输入为完整 `InstalledSkillItem[]`：

1. 只保留 `capabilities.update=true` 的已知来源 Item；未知来源记录为 skipped；
2. 按首次出现顺序将名称去重，因为上游 update 只有名称级选择器；
3. 只执行一次 `skills update <unique names...> -g -y`，不循环伪造来源级成功；
4. 命令启动后无论成功或失败都只做一次完整 `list -g --json` 复检；
5. summary 明确选中数、唯一名称数和未知来源跳过数，不宣称每个来源实例独立更新。

如果目标中没有可更新 Item，不启动 busy/命令并给出可恢复提示。移除 TUI
“更新全部”，但 core 仍可保留上游空名称 update primitive，不作为列表入口暴露。

## 7. 批量卸载

`uninstallSkillInstances(targets, allItems, ...)` 在 service 层顺序调用现有
`uninstallSkillInstance()`：

- targets 使用确认时的完整 Item 快照；
- 每一项都用操作前的完整 `allItems` 做来源隔离证明，避免前一项完成后通过本地推断
  放宽后续 official-remove 边界；
- 一个独立 Item 失败不阻止后续安全 Item，取消信号则立即停止；
- 返回逐 Item 的 `complete/partial/failed`、`mutated` 和 error，聚合成结构化结果；
- 任一项 `mutated=true` 时，整批完成后只做一次完整复检；全部安全预检失败且未 mutation
  时不刷新；
- Modal 显示目标数量、每个 `name（source）` 和“全部 Agent/投影”范围，列表过长时
  使用受限高度滚动区。

最终 toast/error 展示成功、部分完成和失败数量；不得按名称乐观删除。

## 8. 兼容、风险与回滚

- 当前工作区的 07-28 Skills 多来源实现是本任务基线；所有修改必须在其未提交内容上
  增量完成，不恢复旧 `SkillSharedRow`、name-only identity 或 storage scan。
- 同名异源的 update 仍受上游名称级限制；UI 通过去重和文案避免虚构隔离。
- 批量卸载是 destructive 高风险面；必须先扩展 planner/action gate，再接输入。
- OSC-8 anchor 只接收与键盘动作相同的安全 http/https URL，防止本地或脚本协议。
- 回滚按“state/keybinding → render/link → batch lifecycle”三个 checkpoint 逆序进行；
  不 reset/checkout 工作树，不触碰 07-28 任务的领域拓扑成果。

## 9. 规格同步

完成实现后更新现有 Skills lifecycle、state management 与 shortcut/render 门禁，写清：

- 单列 flat/grouped 投影；
- id-backed selection 和 pending batch snapshot；
- 过滤范围全选；
- name-scoped batch update；
- instance-scoped sequential batch uninstall；
- mutation 后一次完整检测对账。
