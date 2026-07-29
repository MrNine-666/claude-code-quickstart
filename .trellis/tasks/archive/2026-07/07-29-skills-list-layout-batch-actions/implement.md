# Skills 列表布局与批量操作实施计划

## 1. 实施范围

在当前 `main` checkout 和现有未提交 Skills 多来源实现上增量开发，不创建 worktree，
不回退或格式化无关改动。每个 checkpoint 先补能在旧实现失败的门禁，再修改生产代码。

### Checkpoint A — reducer、派生行与快捷键

- [ ] 扩展 `verify-skills-view.mjs`：默认 flat、flat/grouped 切换、来源分组、所有
      unknown Item 进入同一“未知来源”展示组且保持独立 id、默认展开、组收缩、光标
      恢复/边界、Item id 多选、过滤范围 `a`、收缩组仍参与全选、选择与完整检测求交。
- [ ] 扩展 `verify-shortcuts.mjs`：新增 `v/o/Space/a` 列表语义、`u/d` 批量文案，
      删除列表页更新全部 command/footer，确认安装页选择快捷键不回归。
- [ ] 在 `skills-view-state.ts` 建立 home layout/group row/selection/pending batch state
      与纯派生 helper；移除双列 grid 导航常量和 update-all reducer intent。
- [ ] 调整 `skills-view-input.ts`：按 row kind 分派 Enter/Space，接入 layout、链接、
      select-all 和 selected-or-current batch target；保持 filter/Modal/busy 焦点隔离。
- [ ] 修改 `config/keybindings.ts` 与 `state/shortcuts.ts`，所有 footer 文案从 registry
      派生。

验证：

```sh
cd tui
bun scripts/verify-skills-view.mjs
bun scripts/verify-shortcuts.mjs
bun run typecheck
```

回滚点：仅反向修改列表 state/input/registry slice；不触碰领域检测与 lifecycle service。

### Checkpoint B — 单列渲染、分组与来源链接

- [ ] 扩展 `verify-skills-render.mjs`：单列三行、flat `name（source）`、grouped `name`、
      Checkbox、组标题/展开图标/计数、sourceUrl anchor、无链接 fallback、第三行双 Agent
      状态、长 URL/CJK 与窄终端。
- [ ] 让 `SkillsHomeView` 使用 `ScrollList` 单列投影，删除双列 Card rows 和存储/其它
      Agent 列表噪音；保持空/过滤无结果状态使用共享 ListState。
- [ ] 从 `core/open-url.ts` 导出安全 http/https 判定；Skills anchor 与 `o` action 共用，
      无安全 `sourceUrl` 显示并提示“无来源链接”。
- [ ] 更新 `SkillsUninstallConfirm` 为批量快照文案与可滚动目标列表，保持 destructive
      scope 明确。

验证：

```sh
cd tui
bun scripts/verify-skills-render.mjs
bun scripts/verify-skills-view.mjs
bun scripts/verify-shortcuts.mjs
bun run typecheck
```

回滚点：保留 Checkpoint A 纯状态，反向切回旧 home renderer/open action；不删除选择数据。

### Checkpoint C — 批量更新与批量卸载

- [ ] 先扩展 `verify-skills-update-action.mjs`：选中优先/当前回退、unknown skip、名称
      稳定去重、一次 `update <names...>`、移除全量入口、成功/失败后一次完整复检。
- [ ] 扩展 `verify-skills-uninstall-planner.mjs`：多 Item 快照、顺序继续、同名异源
      隔离、原始 allItems 安全证明、complete/partial/failed 聚合、零 mutation 不刷新、
      任意 mutation 只刷新一次、取消停止。
- [ ] 在 `skills-service.ts` 增加 typed batch update/uninstall orchestration，复用
      `updateSkills()` 与 `uninstallSkillInstance()`，不复制 argv 或删除安全逻辑。
- [ ] 更新 `skills-view-types/services/actions`：删除 update-all view seam，接入批量结果、
      busy overlay、一次 awaited reconciliation 和准确 summary。
- [ ] reducer completion 保留 layout/filter/collapse，并按 refreshed ids 对账多选；清除
      pending batch/busy 状态，不恢复 `action-done` 或名称级乐观过滤。

验证：

```sh
cd tui
bun scripts/verify-skills-update-action.mjs
bun scripts/verify-skills-uninstall-planner.mjs
bun scripts/verify-skills-instance-state.mjs
bun scripts/verify-skills-view.mjs
bun scripts/verify-skills-render.mjs
bun run typecheck
```

回滚点：批量 service/action 未通过全部 focused gate 前不得接入输入；撤回时保留现有
单实例安全 planner，不以 name-only remove 替代。

### Checkpoint D — 规格、全量门禁与审查

- [ ] 更新 `skills-lifecycle-contract.md`、`state-management.md` 和必要的 quality/shortcut
      断言，删除 TUI update-all 的陈旧规定，记录 list batch contract。
- [ ] 复核安装页 `a/Space/Enter`、Agent 管理 Enter、unknown 仅删除、同名异源 Item、
      过滤后隐藏选择、收缩组隐藏选择、Modal/busy 背景输入和取消路径。
- [ ] 运行 `trellis-check`，关闭所有 standards/spec findings；不得弱化 07-28 已有门禁。

最终验证：

```sh
cd tui
bun scripts/verify-skills-view.mjs
bun scripts/verify-skills-render.mjs
bun scripts/verify-skills-update-action.mjs
bun scripts/verify-skills-uninstall-planner.mjs
bun scripts/verify-skills-instance-state.mjs
bun scripts/verify-shortcuts.mjs
bun run check
bun run build
cd ..
git diff --check
```

## 2. 风险文件

- `tui/src/state/skills-view-state.ts`：当前 07-28 任务已有大量未提交改动，必须增量合并。
- `tui/src/views/skills/SkillsHomeView.tsx`：布局、选择、链接和 row focus 的共同渲染点。
- `tui/src/views/skills/skills-view-input.ts` / `config/keybindings.ts` /
  `state/shortcuts.ts`：输入与 footer 必须同源。
- `tui/src/views/skills/skills-view-actions.ts` / `skills-view-types.ts` /
  `skills-view-services.ts`：批量快照、busy 和复检边界。
- `tui/src/services/skills-service.ts`：名称级 update 与来源隔离 uninstall 的编排边界。
- `tui/scripts/verify-skills-*.mjs`：不得用删除现有断言的方式换绿灯。

## 3. 开始实现前复核

- [ ] 用户已审阅最新 `prd.md`、`design.md`、`implement.md` 并在后续消息明确批准。
- [ ] `implement.jsonl` 与 `check.jsonl` 已包含真实 spec 条目。
- [ ] `task.py start` 后状态为 `in_progress`，再按 Codex dispatch mode 派发
      `trellis-implement`，实现完成后派发 `trellis-check`。
- [ ] 重新检查 `git status --short`，确认 07-28 Skills 多来源任务之外没有新增重叠编辑。
