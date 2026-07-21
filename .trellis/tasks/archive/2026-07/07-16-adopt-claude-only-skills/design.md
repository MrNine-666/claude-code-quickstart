# Skills 存量收编与同名来源替换 — 技术设计

## 1. Summary

本设计把已安装 Skills 管理提升为单实体三态物理拓扑事务：Claude-only 的唯一实体在 `~/.claude/skills`，Codex-only 的唯一实体在 `~/.agents/skills`，双侧仍只有 `~/.agents/skills` 一个实体并让 Claude 路径投影到它。统一 service 负责三种合法状态之间全部六个有向切换、no-op、强确认、事实对账和失败恢复；视图不再把 checkbox diff 直接映射为单条 remove。

同时，已安装过滤框和安装页搜索框改为共享的 OpenTUI 原生单行 input，让 bracketed paste、光标/选择、撤销和重做由真正的 edit buffer 承载。进入页面、检测、刷新和打开普通管理 Modal 都保持只读；任何迁移只在用户提交目标草稿并通过对应强确认后发生。

## 2. Existing Boundaries and Evidence

- `tui/src/core/skills.ts` 负责解析 `skills list -g --json`、读取 lock 增强信息和投影 `SkillSharedRow`。
- `tui/src/core/skills-actions.ts` 负责 `npx skills add/update/remove` 命令与进度/错误映射。
- `tui/src/services/skills-service.ts` 负责 view-facing 生命周期编排；`toggleClaudeInstall()` 已复用远程 source 恢复 Claude 投影。
- `tui/src/state/skills-view-state.ts` 负责 Skills Modal/busy 状态转换。
- `tui/src/views/SkillsView.tsx` 负责键盘分发、Modal 渲染和 detection cache 刷新，不应拥有文件系统迁移逻辑。
- `tui/AGENTS.md:202-212` 要求 canonical/投影写入交给官方 CLI、双侧事实来自单次全量列表检测、Codex 直读共享本体。
- `vercel-labs/skills` 1.5.18 支持本地路径 source。双 agent 且不传 `--copy` 时使用 canonical + symlink；直接使用现有 Claude 目标目录或 canonical 目录作为 source 会因路径重叠提前返回，不能完成转换。
- 实施期对官方 `skills` 1.5.19 的隔离 HOME smoke 证实：双 Agent local add 会正确建立 canonical 与 Claude symlink，但 `list -g --json` 的 `agents` 可能只列 `Claude Code`。因此 CLI list 仍只调用一次，但附带 storage inspection 时 canonical/Claude 路径有效性必须覆盖 badge，Codex 可用性以 canonical 为事实源。
- 本地路径全局安装不会凭空生成可信远程 source；三态事务完成后必须确认不存在同名远程 lock，ccq 不创建、猜测或改写 provenance。若 1.5.19 未清理旧 lock，目标不得判定完成。
- 对官方 `skills` 1.5.19 `dist/cli.mjs` 的当前源码核实表明：`--copy` 会直接写目标 Agent 目录而不创建 canonical；无 `--agent` 的 remove 会清理所有投影并在无人使用时删除 canonical；`remove --agent codex` 会在仍检测到 Claude 投影时保留 canonical，因此不能产生严格 Claude-only。
- 同一官方实现会在 targeted remove 成功后删除全局 lock，而 local snapshot add 不会生成远程 provenance。因此任何经过 remove 的拓扑转换都保留当前内容字节，但不承诺保留远程更新来源。
- OpenTUI `InputRenderable` 继承 `TextareaRenderable` 的 edit buffer，原生处理 bracketed paste、selection、undo/redo 和 cursor movement；当前 Skills `InputBox` 只是 `<text>` + 手工字符串追加，没有这些能力。
- 2026-07-17 Windows 与 2026-07-18 macOS 隔离 HOME 官方 CLI 1.5.19 smoke 已真实跑通六向转换。关键契约是：Codex add 与每一条 topology remove（包括只移除 Claude 的 B→X）都把 `CODEX_HOME` 定向到隔离 HOME 的 `.agents`；否则 remove 会把 canonical 判断为无人使用并删除。该覆盖不参与任何 Codex config/profile 读写。

## 3. Invariants

1. Claude-only 是经两阶段确认的物理事实，不等同于单纯的 CLI badge：Claude 是实体有效目录且 canonical 不存在。
2. 检测和浏览永远无写盘副作用；迁移必须来自一个明确且非空的三态目标草稿以及独立强确认。
3. 当前有效目录中的现有字节是迁移内容的事实源；任一方向都不通过远程重装替换本地修改。
4. `.agents` canonical 和 `.claude` 投影的创建、替换、删除只由官方 CLI 完成。
5. ccq 允许在 OS 临时目录创建短生命周期快照；该例外不扩张为手写安装目录或软链接。
6. 文件系统 postflight 与一次共享 detection refresh 共同决定结果，进程退出码不是成功事实源。
7. Windows symlink 失败后允许部分完成：Codex 使用 canonical，Claude Code 使用 CLI 回退副本。
8. 不新增持久化状态文件；完整链接、独立副本和异常状态每次从实时文件系统派生。
9. 三态成功只能由物理事实定义且恰好一个实体：Claude-only=Claude 实体且 canonical 缺失；Codex-only=canonical 实体且 Claude 缺失；双侧=canonical 实体且 Claude 为正确链接。badge、两侧实体副本或 CLI 退出码都不能替代该事实。
10. 两个搜索框由同一个原生 input 组件拥有编辑缓冲区；reducer 仍是 React 值状态的唯一来源，但视图不得再自行解释普通字符、Backspace、paste、undo 或 redo。

## 4. State Model

CLI 投影继续保留：

```ts
type SkillSharedRow = {
  sharedInstalled: boolean;
  claudeInjected: boolean;
  codexAvailable: boolean;
  // existing fields...
};
```

在需要展示/管理存储差异时叠加实时物理分类，建议由 core/service 单一入口产生：

```ts
type SkillStorageKind =
  | 'shared-symlink'       // canonical 存在，Claude 是指向它的链接
	| 'shared-copy'          // canonical 与 Claude 均为实体；仅为可恢复 partial，不是合法双侧拓扑
  | 'claude-only'          // Claude 实体目录存在，canonical 不存在
  | 'canonical-only'       // canonical 存在，Claude 不存在
  | 'invalid-link'         // 断链或指向错误位置
  | 'conflict'             // 两侧实体目录存在但不是已接受的回退副本/无法证明一致
  | 'missing';
```

远程搜索页仍以 Skill 名作为占位身份；同来源已安装项继续禁选，只有 source 可识别且规范化后确实不同的项例外进入 `source-replacement`。建议扩展展示状态并仅对该分支放开 `selectable`：

```ts
type SearchInstallStatus =
  | 'available'
  | 'installed'
  | 'claude-only'
  | 'codex-only'
  | 'shared-copy'
  | 'source-replacement'
  | 'name-occupied'
  | 'selection-conflict';
```

建议契约：

```ts
inspectSkillStorage(name: string): Promise<SkillStorageInspection>;
adoptClaudeOnlySkill(
  skill: SkillSharedRow,
  onProgress?: ProgressCallback,
  dependencies?: SkillsAdoptionDependencies
): Promise<SkillsAdoptionResult>;

transitionSkillTopology(
  skill: SkillSharedRow,
  target: SkillTopology,
  onProgress?: ProgressCallback,
  dependencies?: SkillsAdoptionDependencies
): Promise<SkillsTopologyResult>;
```

`SkillsAdoptionDependencies` 仅用于注入 CLI exec、临时目录和文件系统缝，保证测试不触碰真实 home。`SkillsAdoptionResult` 至少区分：

```ts
type SkillsAdoptionOutcome =
  | 'complete'  // canonical + 正确 Claude symlink + 双侧检测
  | 'partial'   // canonical + Claude copy，Codex 已可用
  | 'failed';
```

失败结果可选携带 `recoveryPath`，仅在无法证明其它可恢复副本存在时保留并展示临时快照路径。

三态与结果类型为：

```ts
type SkillTopology = 'claude-only' | 'codex-only' | 'shared';
type SkillsTopologyOutcome = 'complete' | 'partial' | 'restored' | 'failed';
```

`complete` 只表示精确到达 C/X/B 之一；`partial` 是保留内容后的非成功结果，不能与 `success=true` 或双侧完成等价。`shared-copy` 可作为后续修复/迁移的输入事实，但不能由 `targetTopologyOfDraft()` 产生，也不能通过成功 postflight。

## 5. Data Flow

```text
skills list -g --json
        │ 只读
        ▼
SkillSharedRow (Claude=true, Codex=false)
        │ Enter 管理
        ▼
inspectSkillStorage(name)
        ├─ 非 claude-only → 普通管理/异常提示，不迁移
        └─ claude-only
               │
               ▼
管理 Modal：Codex「安装（将迁移为共享本体）」
               │ 用户提交
               ▼
强确认 Modal（展示两条目标路径）
               │ 用户确认
               ▼
busy: preflight 再检查 → 安全快照 → skills add
               │
               ▼
文件系统 postflight
        ├─ canonical + Claude symlink → complete
        ├─ canonical + Claude copy    → partial
        └─ 其它                       → failed/recovery
               │
               ▼
共享 detection cache refreshAndWait 一次
               │
               ▼
列表 + toast/结果状态
```

统一拓扑迁移流：

```text
SkillSharedRow + storage inspection
        │ Enter 管理；编辑 cc/cx 草稿
        ▼
targetTopologyOfDraft()
        ├─ 空目标 → 阻止，提示全量卸载
        ├─ 与当前相同 → no-op
        └─ 三种合法目标
        │
        ▼
强确认：当前拓扑 → 目标拓扑；路径/lock/其它 Agent 影响
        │ 用户确认
        ▼
二次 preflight → snapshot + manifest + 原 lock/agents
        │
        ▼
按转换表执行 targeted remove/add；每步后 fact reconciliation
        │
        ▼
目标 storage/manifest/lock postflight
        ├─ 成功/Windows partial → refreshAndWait 一次
        └─ 失败 → 最多一次清理当前两侧并从 snapshot 恢复原拓扑
```

## 6. Preflight and Snapshot Algorithm

### 6.1 Candidate inspection

1. 从受控 Skill 名计算 `~/.claude/skills/<name>` 与 `~/.agents/skills/<name>`；拒绝路径穿越和空名称。
2. `lstat` Claude 路径：必须是实体目录，不接受链接、断链或非目录。
3. `lstat` canonical：必须是 `ENOENT`；任何已存在对象都终止 Claude-only 收编并报告异常状态。
4. 校验根 `SKILL.md` 存在且能产生有效 name/description；最终安装名必须与当前行身份一致。
5. 递归检查内部符号链接：断链或解析后逃逸出 Skill 根目录则拒绝；安全内部链接的复制语义与上游 CLI 保持一致。
6. 用户强确认后、创建快照前再次执行关键 preflight，缩小确认期间状态变化窗口。

### 6.2 Snapshot

1. 使用 OS temp 下的 `mkdtemp` 创建 `ccq-skill-adopt-*` 根目录。
2. 将 Claude Skill 内容复制到 `<temp>/<name>`，不修改原目录。
3. 对快照重新检查 `SKILL.md` 和关键内容 hash/清单，确认 snapshot 完整后才调用 CLI。
4. 临时路径只用于 CLI source，不写入 UI 常规状态或持久化配置。

该临时复制是 source staging，不是安装行为。实现时同步收紧 `tui/AGENTS.md`：禁止直接修改两个安装树，同时明确允许目标树外的一次性快照。

### 6.3 三态转换预检

1. 接受 `claude-only`、`canonical-only`、`shared-symlink` 和内容等价 `shared-copy`；其它 kind 阻断。
2. 从草稿派生唯一 `SkillTopology`；拒绝零目标，识别 no-op。
3. 再次验证当前有效 source path 与目标树事实，且 snapshot source 与两个目标树不重叠。
4. 以当前有效内容创建快照，保存 manifest，并在任何 remove 前再次比较源 manifest，发现并发变化即停止。
5. 记录原 storage kind、拓扑、lock/source 与 CLI `agents`。目标为 Claude-only 且存在非 Claude/Codex agent 时阻断。
6. 每个 CLI step 后重新检查 storage；只有期望中间事实成立才进入下一步。

## 7. CLI Delegation

### 7.1 Claude-only 收编为单实体双侧拓扑

复用/扩展现有 action 层，等价调用：

```text
npx --yes skills add <temp-root>
  --skill <name>
  --yes
  --agent codex
  --agent claude-code
  -g
```

- 同时传两个 Agent 保持 `uniqueDirs.size > 1`，在非 `--copy` 情况下走 symlink 模式。
- temp source 与 Claude/canonical 都不重叠，因此绕开上游安全 short-circuit。
- `--agent codex` 必须先于 `--agent claude-code`。官方 1.5.19 保留参数顺序并逐 Agent 执行：Codex 步骤先创建/刷新 canonical，Claude 步骤随后从同一 snapshot 再次刷新 canonical、删除原 C 实体并在原路径创建指向 canonical 的链接。
- 上述删除和投影发生在官方 CLI 内部；ccq 不调用 shell `rm`/`mv`/`ln`，也不直接删除原 Claude 目录。该内部顺序由固定版本源码证据与隔离 HOME smoke 共同守护；上游行为变化时停止而不是降级为手写目录操作。
- 上游若创建链接失败并回退 copy，action 可以 exit 0；因此必须做 postflight。

### 7.2 三态拓扑执行器

统一 action 使用确定的 child env：`HOME/USERPROFILE=<resolved-home>`、`CLAUDE_CONFIG_DIR=<home>/.claude`；Codex-only add 与所有需要把 canonical 作为 Codex 路径参与保留/删除的 remove 额外使用 `CODEX_HOME=<home>/.agents`。该环境只传给 `skills` 子进程。

单实体目标原语：

| 目标 | 官方 CLI 操作 | 严格后置事实 |
|---|---|---|
| Claude-only | `add <snapshot> --skill <name> -g --agent claude-code --copy -y` | Claude 实体；canonical 缺失 |
| Codex-only | 同上但 `--agent codex --copy`，scoped `CODEX_HOME=.agents` | canonical 实体；Claude 缺失 |
| 双侧 | 固定 `--agent codex --agent claude-code`，不传 `--copy`；官方内部先写 X，再以投影替换 C | canonical 实体；Claude 正确链接；只有一个实体 |

双侧原语可由一条官方 add 表达，但语义不是“同时复制到两侧”，而是一个有序 composite：`materialize X → remove physical C → project C to X`。unit test 断言 Agent 参数顺序，隔离 HOME smoke 断言最终只有 X 实体与 C 投影；若上游将两侧都写为实体，只能返回 `partial`。

六向转换表：

| 原状态 → 目标 | CLI 命令序列 | 命令后必须成立的事实 |
|---|---|---|
| C → X | `remove --agent claude-code` → Codex-only 原语 | remove 后 `missing`；add 后 X |
| C → B | 双侧有序 composite | 官方内部先写 X、再删除 C 实体并创建 C 投影；最终 B |
| X → C | `remove --agent codex`（canonical env）→ Claude-only 原语 | remove 后 `missing`；add 后 C |
| X → B | 双侧有序 composite | X 内容保持与 snapshot 等价；新增 C 投影；最终 B |
| B → C | `remove --agent claude-code --agent codex`（canonical env）→ Claude-only 原语 | remove 后 `missing`；add 后 C |
| B → X | `remove --agent claude-code`（canonical env） | remove 后即 X；禁止额外重写 X |

- remove 支持重复 `--agent`，禁止用无 `--agent` 的全 Agent 删除代替三态转换。
- action 退出码与事实分开记录；例如 B→X 的 remove 即使 non-zero，只要 Claude 已消失、canonical 内容等价且 lock 后置事实可解释，就继续最终对账。
- 双侧 add 在 Windows 回退实体 copy 时返回非成功 `partial`，不伪报双侧完成，也不触发成功 toast。
- 恢复同样调用拓扑原语：先 targeted 清理当前 CC/Codex 事实，再从 snapshot 重建原拓扑；只尝试一次，避免递归恢复循环。

## 8. Postflight Matrix

| 文件系统事实 | CLI/detection 事实 | 结果 | UI |
|---|---|---|---|
| canonical 有效；Claude 是指向 canonical 的链接 | Claude/Codex 均可见 | `complete` | 两侧已安装 |
| canonical 有效；Claude 是实体副本 | Claude/Codex 均可见 | 非成功 `partial` | Codex 已安装；Claude 独立副本；提示重试共享链接 |
| canonical 有效；Claude 缺失/断链 | Codex 可见或检测失败 | `failed` | 保留 canonical，显示修复错误 |
| canonical 缺失；Claude 原目录仍有效 | Codex 不可见 | `failed` | 原 Skill 未迁移，允许重试 |
| 两侧均无法证明有效 | 任意 | `failed` + recovery | 保留 temp 并显示恢复路径 |

`complete` / `partial` 结果都调用共享 detection cache 的 `refreshAndWait()` 恰好一次。`partial` 必须靠实时文件系统分类在后续刷新中仍可重建，不能只存在于一次 toast，也不得触发成功分支。

三态 postflight：

| 文件系统事实 | 结果 | UI |
|---|---|---|
| Claude 实体有效；canonical 物理不存在 | `claude-only` | 仅 Claude Code 已安装；本地来源 |
| canonical 实体有效；Claude 物理不存在 | `codex-only` | 仅 Codex 已安装；来源按 lock 事实 |
| canonical 实体有效；Claude 正确链接 | `shared` | 双侧已安装 |
| canonical + Claude 等价实体 copy | 非成功 `partial` | 双侧内容可用但链接未完成；允许重试，不显示成功 |
| 原拓扑重建且 manifest 等价 | `restored` | 迁移失败但已恢复原状态 |
| 其它事实 | `failed` + recovery | 展示恢复路径，禁止清理 snapshot |

成功还要求：目标 manifest 与 snapshot 一致；Claude link 的 realpath 正确；目标为本地 topology 时不存在会被 update 消费的伪造 lock；`refreshAndWait()` 的投影与 storage 一致。首个 CLI mutation 启动后，无论最终 complete/partial/restored/failed 都在 view 层恰好 refresh 一次；preflight/no-op/取消不刷新。snapshot 只有在 `complete` 或 manifest 等价的 `restored` 后清理；`partial` 与未恢复的 `failed` 保留 snapshot 并返回 recovery path。

## 9. UI and Reducer Changes

- 复用 `manage-inject` Modal；打开候选行时异步完成只读 inspection，busy/loading 状态复用现有 list-state/Modal 模式。
- 对四种可恢复 storage kind，管理 Modal 的 Claude Code/Codex 两行都可切；checkbox 只表达目标可用侧，`targetTopologyOfDraft()` 将 `{true,false}` / `{false,true}` / `{true,true}` 唯一映射为 C/X/B，零目标提示使用 `d` 全量卸载。当前物理实体位置不由 checkbox 直接决定。
- 所有非 no-op 统一进入 `confirm-topology-change`，替代当前 `confirm-adopt` 和 view 内 Claude toggle 分支；六条 transition 只在 service 的转换表中分叉。Esc 返回原草稿且不写盘。
- 确认后进入 busy，service 完成 preflight、snapshot、CLI、postflight；视图只 dispatch 状态并请求共享 cache 刷新。
- `shared-copy` 行显示非成功部分完成警告，并在管理 Modal 提供“重试共享链接”。该动作从 canonical 创建临时 source 快照，再次委托双 Agent 有序 composite，不走 Claude-only 收编分类，也不能在检测或刷新时自动修复。
- `codex-only` 行允许安装 Claude Code。把“重试共享链接”推广为 canonical projection service：从 canonical 生成 temp source，再委托双 agent CLI；即使 lock/source 缺失也能恢复，且不会从远端更新 canonical 内容。
- 不新增列表快捷键；footer 数据源无需新增命令。用户通过既有 Enter 管理路径完成操作。
- 两个顶部输入框替换为一个共享原生 React `<input>` 组件：保持 renderable 实例稳定，使用 `value` + `onChange` 同步 reducer。远程搜索 Enter 继续由顶层页面 handler 单独拥有，input 不注册第二个 submit 回调；测试断言一次 Enter 只调用一次 service。
- 原生 input 负责普通字符、bracketed paste、selection、cursor、delete 和 undo history；顶层 `useKeyboard` 只处理页面 Esc/Tab/上下键以及原生 action 不覆盖的复制/剪切反馈，并对已处理事件 preventDefault。
- Windows/Linux 补齐 `Ctrl+A/C/X/Z/Y/Shift+Z`，macOS 使用 Command 语义；复制/剪切复用 `copyTextWithFeedback`，绑定/处理器放在共享 input edit helper/config 中，不写进 SkillsView 平台分支。

### 9.1 Closed-loop state matrix

| 实时状态 | 搜索安装页 | 已安装列表管理 | 下一状态 |
|---|---|---|---|
| `missing` | 可选；新装 | 无 | shared-symlink 或 shared-copy |
| `claude-only` | 禁选；显示仅 Claude | 可选 C/X/B | claude-only/canonical-only/shared-symlink 或 partial |
| `canonical-only` / Codex-only | 禁选；显示仅 Codex | 可选 C/X/B | claude-only/canonical-only/shared-symlink 或 partial |
| `shared-symlink` | 禁选；显示双侧已装 | 可选 C/X/B；零目标走 d | claude-only/canonical-only/shared-symlink |
| `shared-copy` | 禁选；显示部分完成 | 可选 C/X/B；B 表示修复链接 | claude-only/canonical-only/shared-symlink 或仍 partial |
| 同名异来源且来源可比较 | 可选；显示“已有同名” | 强确认后直接 add 覆盖；postflight 成功后清理未选旧投影 | shared-symlink/shared-copy/canonical-only（新 source） |
| 同名但来源未知 | 禁选；显示来源未知占用 | 阻止自动覆盖 | 人工确认来源后 `r` 重检 |
| detection error | 全部禁选 | 列表保留旧事实/错误提示 | `r` 刷新后重新分类 |
| invalid/conflict/orphan | 禁选；显示异常 | 阻止自动写入，给出路径与原因 | 人工修复后 `r` 重检 |

合法状态必须存在自动或用户确认后的下一步；不安全状态以“明确阻断 + 可验证恢复入口”闭环，而不是自动覆盖。

### 9.2 Same-name source replacement

来源替换使用官方 add 的 canonical overwrite，但由 service 在外层增加快照、强确认、postflight 与未选投影清理：

```text
选择 source-replacement 项
        │
        ▼
目标 Modal（Codex 恒选，Claude Code 可选）
        │
        ▼
强确认：旧 source → 新 source；同名 canonical/lock 将覆盖
        │
        ▼
快照旧内容/原 Agent 事实
        │
        ▼
npx --yes skills add <new-source> --yes
  --skill <name> -g <selected-agent-args>
        │ 不传 --copy
        ▼
文件系统 + lock source postflight
        │ 成功
        ▼
若 Claude 未选且旧 Claude 存在：
npx --yes skills remove <name> -g --agent claude-code --yes
        │
        ▼
共享 detection refreshAndWait 最终对账
```

- 列表只显示固定状态“已有同名”；详细旧/新 source 放在强确认，避免长 source 挤压扁平列表。
- 安装页 add 只使用本次目标草稿：Codex 仍恒选；Claude Code 按用户选择。双 agent 触发 canonical + Claude symlink；只选 Codex 时必须复用三态 Codex-only materializer 的 scoped env，禁止落成 `~/.codex/skills` copy。
- 官方 add 会在 clone/discovery 完成后才进入安装，因此无效 source 通常不会先删除旧内容；ccq 仍在 add 前 snapshot，覆盖中途失败时保留恢复副本。
- 若 Claude 未选，旧 Claude symlink 会在 canonical 覆盖后短暂看到新内容，旧 Claude copy 则仍是旧内容；只有 add/postflight 成功后才调用 Claude 单侧 remove，最终状态统一为 Codex-only。
- 若 add 或 source postflight 失败，禁止后置 remove；保留旧投影与 snapshot，并返回 recovery-required 错误。由于 canonical/lock 可能已部分变化，不承诺自动改写上游 lock 做伪原子回滚。
- 同一用户批次可同时包含新装与替换候选，但执行计划必须把每个替换视为有顺序边界的事务，不能把 remove 与 add 跨 Skill 任意重排。
- 同 source 的新装项和替换项可以继续合并为一次多 `--skill` add；postflight 必须逐个确认替换项，只有确认成功的替换项才能执行其后置投影清理。命令整体失败时不清理任何旧投影，并继续后续独立 source 批次。
- 强确认若包含多条替换项，使用有高度上限的可滚动列表展示旧/新 source，避免长路径撑破 Modal；不使用 textarea/scrollbox 组合。

## 10. Source and Update Semantics

- 本地收编保留现有 Skill 内容，不主动从 lock source 重装。
- 若已有 lock 条目，ccq 不删除或重写；若没有 lock，ccq 不制造远程 source。
- `source` 缺失时 UI 明确标识为本地来源/不可自动更新。
- 全局 `u` 继续由上游 lock 驱动；实现不得声称未入 lock 的本地 Skill可远程更新。
- 将本地内容替换为远程版本属于独立的未来功能，不复用本任务确认文案。
- 任何经过 targeted remove 的转换都可能删除 lock；随后从本地快照物化目标只保留当前内容，不恢复或伪造远程 provenance。列表应按最终 lock 事实决定当前项更新能力；全量更新仍只处理 lock 中其它 Skill。
- 任一 targeted remove 在上游 1.5.19 都可能移除该 Skill 的全局 lock，即使 canonical 被保留；因此 B→X 等转换也必须按 postflight 后的 lock 事实降级为本地来源，不能沿用迁移前的内存 source。
- `U` 在当前行无 source/lock 时于 spawn 前阻止；`A` 仍可更新其它 lock-managed Skills，但必须回归证明不会重建本地三态行。

## 11. Compatibility and Security

- macOS/Linux：验证相对 symlink 最终 `realpath` 指向 canonical。
- Windows：上游使用 junction/symlink，并可能因权限回退 copy；保留内容并返回非成功 `partial`，提示开发者模式/权限后重试；两侧实体永远不是合法 B。
- 编译产物：只使用 Bun/Node 可内嵌的文件系统 API，不依赖外部 `cp`、`ln`、PowerShell 或 shell。
- 路径安全：Skill name、临时根、Claude/canonical 根都经过 containment 检查；错误消息不泄漏 Skill 内容。
- 内部链接：拒绝断链和根目录逃逸，避免 snapshot 意外摄取外部文件。
- 并发：同一收编动作 busy 期间锁定输入；不增加取消/终止协议。外部进程竞争仅能 best-effort 检测，postflight 必须发现不一致。
- 输入兼容：paste 使用终端 bracketed paste 事件，不直接读取系统剪贴板；这同时适配 Windows Terminal、常见 Unix 终端和 macOS Command+V 的终端粘贴路径。
- 其它 Agent：canonical 对所有 `.agents/skills` 消费者天然可见。迁移到 Claude-only 若 `agents` 明确包含第三方则阻断；未显式报告时确认文案仍说明潜在影响。其它转换只 targeted remove Claude/Codex，不删除独立第三方投影。
- scoped env：`CODEX_HOME=.agents` 是 skills 子进程的存储映射，不得泄漏到进程全局，也不得改变 `codexDir()` 固定 `~/.codex` 的配置契约。

## 12. Alternatives Considered

### A. 进入 Skills 页自动迁移

拒绝。用户明确要求已有 Skills 不变；检测必须保持纯只读。

### B. ccq 直接 `move` 到 `.agents` 并创建 symlink

拒绝。违反项目由官方 CLI 管理物理存储/映射的约束，也复制了上游 Windows fallback 逻辑。

### C. 直接以 `~/.claude/skills/<name>` 或 canonical 为 local source

拒绝。`installSkillForAgent()` 的路径重叠保护会提前 skip，不能稳定替换 Claude 实体目录为链接。

### D. 依据 lock source 从远程重新安装

拒绝作为默认迁移。它可能覆盖用户本地修改，违背内容保全目标；只适合作为未来独立、明确覆盖的动作。

### E. Windows symlink 失败时整体回滚

拒绝。Codex canonical 已可用且 Claude 副本仍安全，强制回滚增加数据风险；采用可恢复的部分完成状态。

### F. 完全跟随官方同名覆盖

官方 `skills add` 以 `installName` 为唯一 canonical/lock 键：交互模式显示 `overwrites` 后确认，`--yes` 直接清空并重建 canonical，再以新 source 覆盖同名 lock 条目；不存在 side-by-side namespace。该行为适合通用 CLI，但 ccq 当前所有命令都非交互传 `--yes`，若直接放开搜索项会绕过用户对“来源替换”的明确确认。

普通批量安装不得静默复用官方覆盖语义。本任务采用安全包装：同名不同源可参与选择并标为 `source-replacement`，列表显示“已有同名”；强确认后直接 add 覆盖 canonical/lock，成功 postflight 后才清理未选中的旧投影。相比 remove-then-add，这保留了官方先获取 source 再写入的失败优势，也避免新安装开始前出现完全不可用窗口。

### G. 只执行 `remove --agent codex`

拒绝“使用默认 `CODEX_HOME` 的普通 remove”。官方会把 Codex global path 解释为 `~/.codex/skills`，无法可靠删除/保留 `~/.agents` canonical。三态执行器只在 skills 子进程中使用 `CODEX_HOME=.agents`，让 targeted remove 的 Codex 路径与项目 canonical 契约一致。

### H. 用 Cline 等第三方 Agent 作为 canonical 写入适配器

拒绝。虽然某些上游 Agent 的 globalSkillsDir 恰为 `.agents/skills`，借其 `--copy` 可以写 canonical，但会污染 Agent 语义、telemetry 与未来兼容。scoped Codex HOME 直接表达 Codex canonical，且六向 smoke 已验证。

### I. ccq 直接 unlink/copy/symlink 目标树

拒绝。它能简化 B→X，但会扩大安全边界并复制 Windows junction/fallback 逻辑；当前 scoped env + 官方 CLI 已能实现三态，无需破坏“目标树只由 CLI 写”的硬约束。

## 13. Rollback and Recovery

- 用户确认前、no-op 或 preflight 阻断：零 mutation，无需刷新或回滚。
- snapshot 创建/复检失败：两个目标树未动，删除不完整 temp 后返回失败。
- 首个 mutation 后任一 command/fact/lock 对账失败：最多一次 targeted 清理当前 Claude/Codex 事实，再按原 topology 从同一 snapshot 恢复；恢复路径设置 guard，禁止递归恢复。
- 恢复成功且 storage + manifest 等价：返回 `restored`，显示“迁移失败，已恢复原状态”，完成一次 detection 后清理 snapshot。
- 恢复后 topology 或内容不一致：返回 `failed + recoveryPath`，保留 snapshot，禁止把任一仅“看起来有效”的目录当作等价恢复。
- B 目标退化为 `shared-copy`：为避免删除两个仍可用副本，不做破坏性自动回滚；返回非成功 `partial + recoveryPath`，保留 snapshot，后续“重试共享链接”重新走 snapshot + CLI + postflight。
- 目标 `complete`：完成 storage + manifest + link + lock + detection 对账后才清理 snapshot；不伪造被上游 remove 删除的 provenance。
- 来源替换 add/postflight 失败：不执行未选投影清理，保留旧内容 snapshot；若 canonical/lock 已部分变化，返回 recovery-required，不自动手写 lock 回滚。
