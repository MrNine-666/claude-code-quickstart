# Skills 单实体三态闭环 - 可执行实施计划

> 任务状态：`in_progress`。本文件从当前工作区继续执行，不重复已经落地的 storage inspection、Claude-only 收编、projection repair 和同名来源替换基线，也不覆盖任何现有 staged/unstaged 用户修改。

## 0. 已确认基线（2026-07-18）

- [x] 当前物理分类已覆盖 `claude-only` / `canonical-only` / `shared-symlink` / `shared-copy` / invalid/conflict/missing。
- [x] 当前工作区已有目标树外 snapshot、Claude-only C→B 收编、canonical→B 投影修复、Windows `shared-copy` 展示和来源替换安全包装。
- [x] 当前管理状态机只完成 C→B、X→B、B→X；C→X、X→C、B→C 尚未接入，且没有统一拓扑事务。
- [x] `skills-actions.ts` 当前只支持无 `--copy` add、单 Agent remove 和 `{timeout}` exec options；尚不能表达本计划需要的命令/env 契约。
- [x] 现有 `SkillSnapshot` 未携带 manifest；`SkillSharedRow` 未保留 raw/other agents。
- [x] CodeGraph 按项目要求调用并重试各一次，均失败：`database disk image is malformed`；后续按规则使用精准源码检索。
- [x] 当前定向基线通过：
  - `cd tui && bun scripts/verify-skills-adoption.mjs`
  - `cd tui && bun scripts/verify-skills-view.mjs`
  - `cd tui && bun scripts/verify-skills-render.mjs`
  - `cd tui && bun scripts/verify-shortcuts.mjs`
  - `cd tui && bun run typecheck`

## 1. 固定契约与停止条件

### 1.1 单实体拓扑

| 拓扑 | C: `~/.claude/skills/<name>` | X: `~/.agents/skills/<name>` |
|---|---|---|
| C / Claude-only | 实体 | 不存在 |
| X / Codex-only | 不存在 | 实体 |
| B / 双侧 | 指向 X 的 symlink/junction | 实体 |

- [ ] 代码中的 `SkillTopology` 只包含 `claude-only | codex-only | shared`；每个值恰好一个物理实体。
- [ ] `shared-copy` 只作为可恢复的非成功 `partial` storage kind，不能直接映射为 `shared` 或触发成功 toast；其草稿选择 B 只表示发起 projection repair，必须经事务后置检查才能成为 B。
- [ ] invalid-link/conflict/invalid/missing 在 mutation 前阻断；只读检测不得自动修复。

### 1.2 官方 CLI 所有权

- [ ] `.agents/skills` 与 `.claude/skills` 下的创建、替换、删除、symlink/junction 全部委托 `skills@1.5.19`；ccq 只允许在 OS temp 中创建 staging snapshot。
- [ ] C→B 固定传 `--agent codex --agent claude-code` 且不传 `--copy`。1.5.19 按参数顺序先处理 X，再由 Claude 步骤删除原 C 实体并创建投影。
- [ ] 如果真实 smoke 证明上游顺序或最终物理事实变化，立即停止实现并回到 design；不得降级为 ccq 手写 `rm/cp/symlink`。
- [ ] 所有 topology 命令显式设置子进程 `HOME`/`USERPROFILE`、`CLAUDE_CONFIG_DIR=<home>/.claude`；需要让 Codex 映射 canonical 的 add/remove 额外只在该子进程设置 `CODEX_HOME=<home>/.agents`。

### 1.3 结果语义

- [ ] `complete`：精确到达目标 C/X/B，并通过 storage + manifest + link + lock + detection 对账。
- [ ] `partial`：目标 B 退化为 X 实体 + C 实体副本；内容保留但迁移未成功，保留 recovery snapshot 并提供重试。
- [ ] `restored`：目标迁移失败，但原 topology 与 manifest 已恢复；显示警告而非成功。
- [ ] `failed`：目标和原 topology 均未被证明；保留 snapshot 并返回 `recoveryPath`。

## 2. 实施前刷新与所有权检查

- [ ] 加载 `trellis-before-dev`，重读 `tui/AGENTS.md`、Skills lifecycle/batch contracts、`.context/prefs/` 和 OpenTUI React/input/keyboard/keymap/testing 参考。
- [ ] 运行 `git status --short`、`git diff --cached -- <Skills files>` 与 `git diff -- <Skills files>`，逐文件标记当前用户修改；实现必须增量编辑，禁止重写或回退已有 staged/unstaged 内容。
- [ ] 重跑第 0 节五个定向基线；若失败，先区分既有失败和本任务引入失败并记录，不在红灯基线上继续扩展。
- [ ] 在 `.context/current/branches/main/session.log` 记录实际开始实现的时间、基线结果和任何新增架构取舍。

## 3. 红灯测试先行

### 3.1 Action 与 env 契约

目标文件：`tui/scripts/verify-skills-adoption.mjs`、`tui/scripts/verify-skills-view.mjs`。

- [ ] 先写失败断言：add 可显式传 `copy=true`；C/X 单侧目标都包含 `--copy`，B 不含 `--copy`。
- [ ] 断言 B 的 Agent 参数顺序严格为 `codex` 后 `claude-code`。
- [ ] 断言 remove 接受 Agent 数组并展开重复 `--agent`；拓扑事务永远不使用无 Agent 全量 remove，现有 `d` 全量卸载继续省略 `--agent`。
- [ ] 断言每次 exec 收到完整 `ExecOptions.env`，且测试前后 `process.env.CODEX_HOME` 未改变。
- [ ] 断言 action 返回 exit code/stdout/stderr/是否已 spawn 的结构化诊断；service 不以 `success` 布尔代替事实对账。

### 3.2 Storage、snapshot 与 topology 纯函数

- [ ] 为 `topologyOfInspection()` 覆盖 C/X/B；`shared-copy`、invalid-link/conflict/invalid/missing 均返回不可作为完成态的结果。
- [ ] 为 `targetTopologyOfDraft()` 覆盖 `{true,false}=C`、`{false,true}=X`、`{true,true}=B`、`{false,false}=empty`。
- [ ] 扩展 snapshot 测试，证明返回 manifest；source 在 snapshot 前后变化时阻断 mutation；普通列表检测不为每个单实体目录重复计算完整 hash。
- [ ] 扩展 `SkillSharedRow` 测试，保留 raw agents，并能可靠提取 Claude/Codex 之外的 `otherAgents`。

### 3.3 六向转换表

每条用临时 HOME、真实目录 fixture 和 fake exec 驱动；fake exec 按命令模拟官方文件事实，逐命令断言中间状态。

| 转换 | 预期命令 | 强制中间/最终事实 |
|---|---|---|
| C→X | remove C；add X `--copy` | remove 后 missing；最终 X |
| C→B | B 有序 add `[codex, claude-code]` | 官方 composite 先 X，最终 C 被投影替换且只有一个实体 |
| X→C | remove X（canonical env）；add C `--copy` | remove 后 missing；最终 C |
| X→B | B 有序 add `[codex, claude-code]` | X manifest 不变；最终新增 C 投影 |
| B→C | remove `[claude-code, codex]`（canonical env）；add C `--copy` | remove 后 missing；最终 C |
| B→X | remove C（canonical env） | X manifest 不变；无后续 add |

- [ ] 六条转换逐条断言命令参数、env、命令数、中间 storage、最终 storage 和 manifest。
- [ ] 三种 no-op 断言零 snapshot、零 spawn、零 refresh。
- [ ] C→B 与 X→B 的 symlink 失败 fixture 必须得到非成功 `partial`，不能得到 `complete` 或成功。

### 3.4 失败、lock、恢复与其它 Agent

- [ ] 每个 add/remove 覆盖 exit/fact 四象限：exit 0/fact 对、exit 0/fact 错、exit 非 0/fact 对、exit 非 0/fact 错。
- [ ] 每条含 remove 的转换断言 postflight 重新读取 lock；lock 被上游删除后结果降级为本地来源，不复用迁移前内存 source。
- [ ] mutation 后失败最多执行一次恢复：targeted cleanup 当前 Claude/Codex 事实 → 从同一 snapshot 物化原 topology → manifest/postflight；恢复调用不得递归。
- [ ] 恢复成功返回 `restored`；恢复失败返回 `failed + recoveryPath`；仅目标 `complete` 或 manifest 等价的 `restored` 才清理 snapshot。
- [ ] `partial` 不做破坏性回滚、也不清理 recovery snapshot；后续重试成功后再清理。
- [ ] 目标为 C 且 raw agents 含第三方时在首个 spawn 前阻断；其它转换只删除明确的 Claude/Codex 投影，不删除第三方独立路径。

### 3.5 Reducer、Modal 与刷新

- [ ] `verify-skills-view.mjs` 覆盖 C/X/B/shared-copy 四种可恢复行均可编辑两侧目标；零目标被拒绝并提示使用 `d`。
- [ ] 用统一 `confirm-topology-change` 覆盖六向转换，替代 `confirm-adopt` 和 view 内方向分支；取消后保留草稿且零 action。
- [ ] 强确认展示当前→目标、实体/投影变化、lock/update 影响和 `.agents` 第三方消费风险。
- [ ] complete 才显示成功；partial/restored 显示警告；failed 显示错误和 recovery path。
- [ ] 首个 mutation 启动后的 complete/partial/restored/failed 均恰好 `refreshAndWait()` 一次；preflight/no-op/取消零刷新。

### 3.6 原生输入

目标文件：`tui/scripts/verify-skills-render.mjs`、`tui/scripts/verify-shortcuts.mjs`。

- [ ] 使用 `@opentui/react/test-utils` 的 `testRender` + mock input 驱动两个真实 `<input>`，覆盖 bracketed paste、左右/Home/End、Backspace/Delete、选择、全选、复制、剪切、撤销和重做。
- [ ] 断言 React 受控接口使用 `value + onChange`，renderable 实例稳定且 rerender 不清空 undo history。
- [ ] 断言远程搜索 Enter 只由顶层页面 handler 拥有，input 不注册第二个 submit 回调；输入聚焦时页面 `A/U/I/D/R/Space` 不穿透。
- [ ] 断言 CR/LF 被单行输入剥离；窄终端与超长 paste 不改变列表/Modal 布局。

## 4. Action 与存储基础能力

### 4.1 `tui/src/core/skills-actions.ts`

- [ ] 将 `SkillsExecFn` options 对齐共享 `ExecOptions`，不要维护缩水版 `{timeout}`。
- [ ] 提取低层 `runSkillsAdd()` / `runSkillsRemove()`（最终命名按现有风格），接收显式 agents、`copy`、env 并返回结构化命令诊断；现有普通安装/卸载 wrapper 保持兼容。
- [ ] add 参数构建只存在一处；B 固定 `[cx, cc]`，C/X 单侧显式 `--copy`。
- [ ] remove 参数构建只存在一处；支持 Agent 数组。`'*'` 仅保留给现有全量卸载 wrapper，拓扑 service 类型上不能传 `'*'`。

### 4.2 `tui/src/core/skills-storage.ts` 与 `tui/src/core/skills.ts`

- [ ] 让 `SkillSnapshot` 携带不可变 manifest，并公开事务 postflight 所需的 manifest 读取/比较 helper；避免普通 detection 对所有单实体 Skill 做不必要的全树 hash。
- [ ] snapshot source、temp root、C/X 目标均做 containment 检查；snapshot 与两个目标树不得重叠。
- [ ] `SkillSharedRow` 保留 raw agents 或等价 `otherAgents`，但 C/X 可用性仍以 storage inspection 为事实源。

## 5. 统一拓扑事务

目标文件：`tui/src/services/skills-adoption.ts`。现有 `adoptClaudeOnlySkill()` / `repairClaudeProjection()` 作为兼容入口薄封装到新事务，禁止复制两套 snapshot/CLI 逻辑。

- [ ] 定义 `SkillTopology`、`SkillsTopologyOutcome`、`SkillsTopologyResult`、`topologyOfInspection()` 和 `targetTopologyOfDraft()`。
- [ ] 实现三个目标原语：`materializeClaudeOnly()`、`materializeCodexOnly()`、`projectClaudeFromCanonical()`；最后一个使用固定 `[codex, claude-code]` 有序 composite，语义为 X 实体 + C 投影。
- [ ] 实现 `transitionSkillTopology()`：二次 preflight → snapshot/manifest/lock/agents → 执行六向表 → 每命令 fact reconciliation → final postflight。
- [ ] C→X 必须在物化 X 前证明 C 已删除且 X 不存在；C→B 必须通过固定 Agent 顺序保证 X 先成为实体、C 最终被投影替换。
- [ ] B→X 只删除 C 投影并复检 X，禁止为了“统一”再 add 一次覆盖 canonical。
- [ ] 实现单次恢复 guard；partial 走 repairable 分支，不冒充 complete，不触发成功路径。
- [ ] 所有结果携带 `mutated`；只有可能已 spawn 首个 mutation 时为 true。
- [ ] 普通新装/来源替换产生 X 目标时复用 X 原语或同一 scoped env builder，禁止继续写 `~/.codex/skills`。

## 6. Reducer 与 View 接入

目标文件：`tui/src/state/skills-view-state.ts`、`tui/src/views/SkillsView.tsx`、`tui/src/views/skills-view-services.ts`、`tui/src/services/skills-service.ts`。

- [ ] 管理 Modal 的两个 checkbox 只表达目标可用侧；C/X/B/shared-copy 均允许选择 C、X、B，invalid 状态全部只读。
- [ ] 增加统一 `confirm-topology-change` mode/action，移除 `request-adopt` 特例和 `runManageInject()` 内按当前方向选择 service 的逻辑。
- [ ] View 只提交 `current + target`，service 独占转换表、CLI、snapshot 和文件系统；View 不读取路径决定命令。
- [ ] no-op 关闭 Modal；零目标保留 Modal 并提示 `d`；Esc 从确认返回管理 Modal且保留草稿。
- [ ] shared detection 后再次验证目标 topology；只有 complete 使用 success toast，partial/restored/failed 使用独立文案。
- [ ] 当前行无最终 lock/source 时在 `U` spawn 前阻止；`A` 只更新 lock-managed Skills且不得重建本地三态行。

## 7. OpenTUI 原生单行输入

目标文件：优先新增共享 input 组件/helper，并最小修改 `SkillsView.tsx`、键位配置和快捷键测试。

- [ ] 用 React `<input value={...} onChange={...} focused={...}>` 替换两个假输入框；保持组件 key/ref 稳定。
- [ ] 删除 `handleListKey()` / `handleInstallKey()` 中普通字符、Backspace/Delete 的字符串拼接；顶层只保留页面 Esc/Tab/Enter/上下导航。
- [ ] 远程搜索继续由顶层 Enter handler 单次提交；本地过滤 Enter 为 no-op，不给 `<input>` 绑定第二个 submit owner。
- [ ] 编辑语义复用 OpenTUI edit buffer 和项目统一 keymap/keyboard helper；Windows/Linux 使用 Ctrl，macOS 使用 Command；复制/剪切继续走现有 OSC52 feedback。
- [ ] 每个已处理的页面事件阻止默认传播；不得在 `SkillsView.tsx` 新增 OS 分支或第二套快捷键字面量。

## 8. 契约、文档与真实 smoke

- [ ] 更新 `tui/AGENTS.md` 与 `.trellis/spec/frontend/skills-lifecycle-contract.md`：单实体三态、六向表、C→B 内部顺序、partial 非成功、scoped env、第三方阻断、lock/update 和刷新契约。
- [ ] 仅当安装页目标/来源替换行为发生变化时同步 `.trellis/spec/frontend/skills-batch-install-contract.md`；不要把管理页迁移细节塞入 batch contract。
- [ ] 新增 `tui/scripts/test-skills-topology-smoke.mjs`，仅使用临时 HOME/USERPROFILE/CLAUDE_CONFIG_DIR/CODEX_HOME 调用固定 `skills@1.5.19`，在 `finally` 清理；严禁触碰真实 HOME。
- [ ] smoke 覆盖 C/X/B 三个完成态、六向转换、三种 no-op、C→B 最终单实体、X 不落到 `.codex/skills`、targeted remove 不误删第三方独立投影。
- [ ] 将 smoke 接入可用的 macOS/Windows CI gate；Windows 额外断言 junction/symlink 失败时为非成功 partial。
- [ ] 更新 `.context/current/branches/main/session.log`，记录最终实现与计划偏差。

## 9. 验证顺序

### 9.1 每个实现批次

- [ ] `cd tui && bun scripts/verify-skills-adoption.mjs`
- [ ] `cd tui && bun scripts/verify-skills-view.mjs`
- [ ] `cd tui && bun run typecheck`
- [ ] `git diff --check -- <本批次文件>`

### 9.2 UI/输入批次追加

- [ ] `cd tui && bun scripts/verify-skills-render.mjs`
- [ ] `cd tui && bun scripts/verify-shortcuts.mjs`
- [ ] `cd tui && bun scripts/verify-manage-tui-state.mjs`
- [ ] `cd tui && bun scripts/verify-agent-context.mjs`

### 9.3 最终门禁

- [ ] `cd tui && bun scripts/verify-skills-shared-projection.mjs`
- [ ] `cd tui && bun scripts/verify-skills-agent.mjs`
- [ ] `cd tui && bun scripts/test-skills-topology-smoke.mjs`
- [ ] `cd tui && bun run typecheck`
- [ ] `cd tui && bun run verify`
- [ ] 使用 `trellis-check` 做 spec、跨层数据流、复用、typecheck、focused/full regression 检查。

## 10. 完成判定与回滚点

- [ ] AC1-AC14 的既有收编/来源替换能力全部保持通过。
- [ ] AC15/AC16/AC16a：单实体三态、六向顺序和 no-op 均有红绿测试证据。
- [ ] AC17-AC21/AC24：真实 CLI、env、恢复、第三方、lock、detection 刷新均有证据。
- [ ] AC22-AC23：真实 OpenTUI input 和窄终端交互有离屏测试证据。
- [ ] 任一步发现唯一内容副本无法证明时立即停止，保留 snapshot，不继续清理或后续 mutation。
- [ ] 最终 diff 只包含本任务文件；不清理、不格式化、不重置其它 76 项工作区改动。
- [ ] 计划内代码、规范、测试全部完成后再进入 Trellis finish/check/commit；本任务已是 `in_progress`，不得再次运行 `task.py start`。
