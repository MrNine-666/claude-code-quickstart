# Reducer and View-State Contract

## State Layers

- `manage-state.ts` 拥有 shell focus、selected menu 与保留的 Agent context。
- Domain reducer（`tools-view-state.ts`、`skills-view-state.ts`、
  `self-update-state.ts`）拥有确定性的多步骤 screen state。
- App cache 拥有 async detection result；reducer 接收 snapshot 或 reconciliation
  action，而不是读取 cache。
- Toast/progress output 是 presentation state，不是 domain success 的来源。

## Reducer Rules

- Reducer 保持纯函数，并对 discriminated action 使用 exhaustive switch。
- Mode 必须显式。Confirmation、form、downloading、applying、partial 与 error
  state 不得从多个无关 boolean 推断。
- Modal draft 与 persisted/detected fact 分离。Cancel 丢弃 draft；confirm 计算
  delta 后才启动 mutation。
- 在 reducer/list helper 中强制执行 boundary。Empty array 与 filtered list 不得
  造成 index `-1` crash。
- Context/header 变化保留 menu order 与 domain data，除非拥有该行为的 contract
  明确要求重置 draft。
- Failure state 携带重试失败 stage 所需的 context。Reducer 不得把失败收窄为
  bare message，并丢弃产生它的 plan、draft 或 transaction。

## Mutation Sequence

```text
intent -> confirm/draft -> started -> service/core mutation
       -> final detection -> reconciled/partial/failed reducer action
```

不得用名为 `action-done` 的通用 reducer action 替代 domain postflight contract。
Skills install、topology transition、tool injection 与 self-update 使用领域专用
 completion action。

List 可包含同名 logical instance 时，每个 Modal/busy intent 都 snapshot domain id，
而不是 display name 或 cursor index。Skills 对 known source 使用
`InstalledSkillItem.id = (name, normalized source identity)`，对 unknown source
使用 exact-path-qualified id。Confirm/delete/update code 在 live cursor 之前解析
single-Item topology action 的 `pendingInstanceId`，以及 update/uninstall 的
`pendingBatchInstanceIds`。生命周期 settle 时清除二者，且只有完整 CLI
reconciliation 才替换 installed state。禁止 name-level optimistic filtering，
因为它可能移除其他 source。

Installed-list selection 使用稳定 domain id，绝不使用 visible row index。
`homeLayout`、source-group collapse 与 filter 只改变 `SkillsHomeRow` projection。
切换 layout 或 reconciliation detection 时，尽可能按 Item id/group key 恢复当前
row，将 selection 与 refresh 后 Item id 取交集，并保留有效的
layout/filter/collapse state。Filtered select-all 作用于完整 filtered Item set，
包括被 collapsed group 隐藏的 Item。`toggle-all-source-groups` action 只用于
grouped layout：如果全部 installed source group 已 collapse，则展开全部；否则
collapse 每个 installed source group。它的 scope 是完整 installed set，而不是
当前 filter；collapse Item row 时，cursor 移到该 Item 的 source-group header。
Skills 向 shell 上报 `list-flat` / `list-grouped` presentation submode，使其能投影
layout-specific footer command，而不复制 key fact。

## Failure Recovery

多阶段 flow 可在任意 stage 失败，因此 failure state 必须记录失败 stage 和重新
执行它所需的全部内容。使用 discriminated union，而不是 retry boolean，使类型
系统保证 apply-stage failure 携带 transaction，download-stage failure 携带 plan：

```typescript
type SelfUpdateRetry =
  | {readonly stage: 'check'}
  | {readonly stage: 'download'; readonly plan: SelfUpdatePlan}
  | {readonly stage: 'apply'; readonly transaction: DownloadedSelfUpdate};

type Screen =
  | /* ... */
  | {readonly kind: 'error'; readonly message: string; readonly retry: SelfUpdateRetry};
```

每个 error surface 除了退出方式，还必须提供继续方式。Enter 重试失败 stage；
Esc 关闭。两个 key 绑定到同一个 close action 是 dead end 的特征：state 没有 retry
context，因此 UI 无法提供重试。某个 status 还驱动外部 affordance（sidebar
button、badge）时，要检查 dismiss error surface 后，该 affordance 是否会重新
打开同一个 terminal state。这种情况是 trap loop，不是已修复的 error screen。

重试通常复用已记录的 stage input，而不是重启整个 flow。复用 artifact 的安全性
来自 core layer 在 apply 前重新验证 size 与 SHA-256，而不是 reducer 假设它仍然
有效。如果 core 报告 apply transaction 自身缺失或无效，recovery stage 应为
`download` 并携带 transaction plan；反复 apply 同一个确定无效的 temp 是 retry
trap，不是 recovery。

## Focus State

Shell focus 限制为 `nav`、`header`、`view`、`form` 与 `modal`。共享
Tools/MCP/Skills view 隐藏 Agent Header；任何 stale header focus 都被强制改为
view，但不改变保留的 `agentContext`。

## Tests

- 对每个合法 action/mode transition 与 cancellation 做 table test。
- 使用 seeded key sequence 测试 boundary 与 focus invariant。
- 断言 mutation start count 与 exactly-once reconciliation。
- 每个 stage 各做一个 failure table test：断言 error state 保留该 stage 的
  retry input，并断言 flow 能离开 error state 回到被重试 stage。还要断言 key
  handler 执行 retry 而不是 close。
- 新 gate assertion 必须通过反转修复并观察其失败来验证；永不失败的 assertion
  不是 gate。
- 运行 `verify-manage-tui-state.mjs`、`verify-shortcuts.mjs` 与相关 domain
  state/render gate。
