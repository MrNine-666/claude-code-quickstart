# Skills 存量收编与同名来源替换

## Goal

完善 Manage TUI 的 Skills 安装与管理闭环：以明确物理拓扑支持 Claude-only、Codex-only、双侧共享三态互相切换，从任一合法状态都能安全迁移、对账、失败恢复；同时保留同名来源替换闭环，并让两个 Skills 搜索框具备完整的基础编辑能力。仅浏览、检测或刷新 Skills 不得改动已有 Skill。

## Background

- 当前 Skills 模型把 `~/.agents/skills` 视为共享本体，把 Claude Code 安装态视为 `~/.claude/skills` 下的投影；Codex 直接读取共享本体。该约束记录于 `tui/AGENTS.md:202-212`。
- 当前工作区基线已实现 storage inspection、Claude-only 收编、canonical 投影修复和同名来源替换；`tui/scripts/verify-skills-adoption.mjs` 覆盖这些能力，`projectSharedSkills()` 也已在物理检查存在时以 canonical/Claude 路径覆盖不可靠的 CLI badge。
- 当前管理状态机仍只开放 C→B、X→B、B→X 三条路径：Claude-only 的 Claude 行只读，canonical/shared 行的 Codex 行只读，提交仍由 `confirm-adopt` 或 Claude 单侧 toggle 分支处理，尚未形成统一六向拓扑事务。
- 当前 `skills-actions.ts` 不能为单次命令表达 `--copy`、重复 remove `--agent` 或子进程级 env；`SkillSnapshot` 也未暴露内容 manifest，无法执行逐步事实对账和等价恢复。
- 当前已安装过滤框和安装页搜索框仍由 `SkillsView.tsx` 手工拼接字符串并绘制假光标，没有原生输入缓冲区，因而不支持 bracketed paste、光标编辑、选择、撤销或重做。
- 当前安装页已经具备同名不同源的安全替换基线，但普通 Codex-only 新装仍复用单 Agent add，必须纳入统一 canonical 物化原语，避免落到 `~/.codex/skills`。
- 上游 `skills` CLI 支持本地路径 source 和 canonical + symlink 安装，但直接以现有 `~/.claude/skills/<name>` 为 source 会命中路径重叠保护并跳过转换；上游没有专用 `migrate` / `adopt` 命令。
- Context7 核实 Claude Code 自动发现 `~/.claude/skills`，Codex 官方 loader 发现 `~/.agents/skills`。DeepWiki 对 `vercel-labs/skills` 的分析也确认 canonical、软链接与路径重叠行为。
- `vercel-labs/skills` 1.5.18 对同名不同源采用覆盖语义：身份键是 `installName`，不做 source 冲突阻断或命名空间并存；交互模式在 Installation Summary 标记 `overwrites` 并统一确认，`--yes` 跳过确认。安装会清空并重建同名 canonical，成功后以新 source 覆盖全局 lock 的同名条目。
- 官方覆盖只显式处理本次目标 Agent；但任何仍指向同一 canonical 的未选 symlink consumer 也会立即看到新内容，而独立 copy 可能保留旧内容，因此选择性覆盖可能产生跨 Agent 版本分裂。
- 官方 `skills` 1.5.19 的隔离 HOME 六向 smoke 已确认三种目标拓扑均可由 CLI 实现：Claude-only 使用 `--agent claude-code --copy`；Codex-only 在仅该子进程中把 `CODEX_HOME` 指向 `~/.agents` 后使用 `--agent codex --copy`；双侧使用 Codex + Claude Code 且不传 `--copy`。`CODEX_HOME` 覆盖只服务 Skills 存储命令，不改变 ccq 对系统 Codex 配置固定使用 `~/.codex` 的契约。

## Requirements

### R1 — 实时识别 Claude-only 存量状态

- TUI SHALL 继续通过一次 `skills list -g --json` 派生双侧状态，不新增持久化状态文件。
- 当 Skill 满足 `claudeInjected=true && sharedInstalled=false` 时，TUI SHALL 只将其识别为需要文件系统预检的候选，不能仅凭 CLI 投影直接断言为 Claude-only。
- 真正的 Claude-only SHALL 严格定义为：`~/.claude/skills/<name>` 是有效实体 Skill 目录，且 `~/.agents/skills/<name>` 物理路径不存在。
- 执行迁移前 SHALL 通过文件系统检查区分实体目录、正确软链接、错误软链接、断链、非目录对象，以及 CLI 未识别但磁盘上已存在的 canonical 异常状态。
- 进入 Skills 页、列表刷新、启动检测和后台检测 SHALL 保持纯只读，不得自动收编、移动、复制或重建任何已有 Skill。
- 收编的唯一触发条件 SHALL 是用户在 Claude-only Skill 的管理流程中明确选择“安装到 Codex”并确认该动作。

### R2 — 内容保全与显式冲突处理

- 收编 SHALL 保留 Claude-only Skill 的 `SKILL.md`、scripts、references、assets 及其它本地内容，不得默认从远端覆盖本地修改。
- `SKILL.md` 缺失或无效、Skill 名不可安全映射、内部存在断链或逃逸出 Skill 根目录的软链接时，系统 SHALL 阻止自动收编并提供可理解错误。
- 若 `~/.agents/skills/<name>` 已存在，该 Skill 不再属于 Claude-only，系统 SHALL 退出 C 收编分支并执行完整 storage 分类：有效 canonical-only 作为 X 进入统一拓扑管理；无效、冲突或孤儿 canonical 才阻断并报告异常。
- canonical 已存在但内容无效、路径冲突或无法通过 storage 检查时，根因属于安装修复或 Skill 有效性问题；本任务不自动覆盖、merge 或重建该目录。

### R3 — 物理安装继续委托官方 CLI

- ccq SHALL NOT 直接在 `~/.agents/skills` 或 `~/.claude/skills` 中创建、删除或替换 Skill 本体/软链接。
- 对没有安全远程 source 的 Claude-only Skill，系统 SHALL 在两个目标目录之外创建一次性内容快照，并把该快照作为本地 source 交给官方 `skills` CLI。
- C→B SHALL 以固定 Agent 顺序 `codex` 后 `claude-code` 调用官方 add 且不使用 `--copy`：上游先在 `~/.agents/skills` 创建/刷新 X 实体，再删除原 C 实体并在原路径创建指向 X 的投影。最终 C 仍为实体目录时不得判定为 B。
- 临时快照不属于安装目录；其生命周期、失败保留/清理和敏感路径展示须在技术设计中明确。

### R4 — 事实对账与失败恢复

- 命令退出码 SHALL 只作为诊断，不能单独判定收编成功。
- 收编完成后 SHALL 验证 canonical `SKILL.md`、Claude 路径的软链接类型及目标，并通过一次共享 Skills 检测刷新确认 Claude Code/Codex 双侧事实。
- Windows 或其它环境中软链接失败而上游退化为 copy 时，系统 SHALL 保留已成功写入的 canonical 和 Claude Code 副本，不执行破坏性回滚。
- 上述降级结果 SHALL 表示为“Codex 已安装、Claude Code 仍使用独立副本”的非成功 `partial` 状态，不得伪报为 B、`complete` 或成功迁移。
- 部分完成状态 SHALL 提示用户检查 Windows 开发者模式/权限，并提供后续重试共享链接的可恢复入口。
- 任一步失败时 SHALL 保证至少存在一份可恢复的 Skill 内容，并提供失败原因；不得因清理临时快照而丢失唯一副本。

### R5 — 来源和更新语义

- 本地内容收编 SHALL NOT 伪造或手写上游 `.skill-lock.json` 远程来源。
- 三态转换 SHALL 保留当前内容并按目标拓扑切换物理事实源；上游 targeted remove 删除 lock 后不得由 ccq 手写恢复远程 provenance。
- 无远程 source 的收编结果 SHALL 在管理界面中明确为本地来源/不可自动更新，不得承诺 `u` 能从远端更新。
- 若未来允许用户选择远程 source 重新安装，该行为必须作为可能覆盖本地内容的独立动作，不与“保内容收编”混合。

### R6 — 既有 Skills 行为不回归

- 扁平搜索、跨来源批量安装、全量卸载和更新流程 SHALL 保持既有语义；已安装列表的 Agent 草稿改由三态拓扑事务统一解释，不再把任一侧的取消直接等同于一条单侧 remove 命令。
- 新状态和动作 SHALL 复用现有 Skills reducer、service/action 分层和统一进度/错误展示，不在视图中直接执行文件系统或进程逻辑。
- 用户可见快捷键若有变化 SHALL 继续来自统一 keybinding 数据源。
- `claude-only`、`canonical-only`、`shared-symlink` 与内容等价 `shared-copy` 行 MAY 编辑 Claude Code/Codex 目标草稿并提交到统一拓扑事务；invalid/conflict/missing 状态不得呈现可执行开关。

### R7 — 管理弹窗中的显式安装入口

- 收编入口 SHALL 复用现有“管理安装”Modal，不新增顶级页面、独立迁移页或新的列表快捷键。
- 管理 Modal SHALL 根据当前物理状态初始化真实草稿，并允许用户选择 Claude-only `{cc:true,cx:false}`、Codex-only `{cc:false,cx:true}` 或双侧 `{cc:true,cx:true}`。
- `{cc:false,cx:false}` SHALL 被拒绝并提示使用现有全量卸载动作，不能把管理提交静默解释成全量删除。
- 任一非 no-op 拓扑变更 SHALL 进入统一强确认，明确列出当前状态、目标状态、实体目录/软连接变化、lock/更新影响及可能影响的 `.agents` 消费者。
- 取消管理 Modal 或强确认 SHALL 不产生文件系统、CLI 或状态写入副作用。

### R8 — 安装与管理生命周期闭环

- 远程安装页 SHALL 继续只负责新装或经用户明确确认的来源替换；任何已存在同名 Skill 都不得被静默覆盖。
- Claude-only、Codex-only、完整共享和 shared-copy 等“同一已安装来源” SHALL 保持禁选，也不得通过 Enter 跳转或直接打开管理 Modal。
- 只有已安装 source 可识别、且与搜索 source 经 `skillSourcesEquivalent()` 规范化后确实不同的同名项，才 SHALL 作为“将覆盖现有安装”的来源替换候选允许选择。
- 已存在项的搜索状态 SHALL 区分“仅 Claude Code”“仅 Codex”“双侧已安装”“Claude 独立副本/部分完成”和同名来源替换；同名不同源候选在列表中的固定文案为“已有同名”。
- 无安装项 SHALL 继续通过安装页进入既有安装流程；安装目标、同名来源替换和已安装列表管理凡产生 Codex-only，最终物理事实都必须是 canonical-only，而不是 `~/.codex/skills` 独立 copy。
- Claude-only、Codex-only 与双侧 SHALL 通过同一个管理 Modal 和拓扑 service 互相切换，不得因 lock/source 缺失形成死路。
- `shared-copy` 不是合法“双侧完成态”；其管理草稿仍可迁移到任一单侧，选择双侧时表示重试构建 `shared-symlink`。
- 同名异来源 SHALL 在列表中显示“已有同名”，旧 source、新 source 和覆盖影响只在执行前强确认中完整展示；来源未知或无法安全比较时仍 SHALL 禁选，不得猜测为可替换。
- 检测未完成/失败 SHALL 保持安装禁用并提供现有 `r` 刷新恢复路径。
- 无效 Skill、孤儿 canonical、断链和内容冲突 SHALL 进入明确的不可自动处理状态，给出原因和人工处理方向；“闭环”不等于对不安全状态执行破坏性自动修复。

### R9 — 同名不同源覆盖确认

- 同名不同源候选 SHALL 参与现有 Space、全选和批量选择，但选择身份仍为 `(source, skillName)`，同一批次不得选择两个目标 source 的同名 Skill。
- 执行计划 SHALL 区分普通新装项与来源替换项；两者不得只靠同一个“安装”成功文案混淆。
- 在启动任何安装进程前，TUI SHALL 显示强确认，逐项列出 Skill 名、当前 source、新 source，以及同名 canonical 与 lock 来源会被覆盖的事实。
- 强确认 SHALL 明确说明新来源会直接覆盖同名 Skill，并按本次目标草稿决定最终保留的 Agent；取消确认 SHALL 零进程、零写盘。
- 来源替换前 SHALL 在目标树外保留现有有效内容快照和原 Agent 事实，用于命令中途失败后的恢复；不得把快照误记为新的远程 provenance。
- 每个来源替换 SHALL 先直接调用官方 add 安装新来源到本次目标草稿选中的 Agent；不得在 add 成功前删除旧 canonical 或旧 Agent 投影。
- 新 add SHALL 不传 `--copy`：选择 Claude Code + Codex 时由官方 CLI 覆盖 canonical 并为 Claude Code 创建软链接；只选择 Codex 时直接使用 canonical，无需额外 Agent 软链接。
- 只有新 canonical、所选 Agent 投影和新 lock source 通过 postflight 后，系统才 SHALL 删除未被本次目标选中的旧 Agent 投影；当前模型中只可能需要执行 Claude Code 单侧 remove，Codex canonical 恒保留。
- add 或 postflight 失败 SHALL NOT 清理未选择的旧投影；系统 SHALL 保留恢复快照并报告可恢复失败，不得继续执行后置 remove。
- 来源替换成功 SHALL 通过文件系统 postflight、共享检测以及 lock source 核对确认；退出码成功但 source/内容事实未切换时不得报告成功。

### R10 — Claude-only / Codex-only / 双侧三态闭环

- 每个合法完成态 SHALL 恰好只有一个物理实体，严格定义为：

  | 拓扑 | Claude 路径 C | Codex/canonical 路径 X |
  |---|---|---|
  | Claude-only（C） | 有效实体目录 | 物理不存在 |
  | Codex-only（X） | 物理不存在 | 有效实体目录 |
  | 双侧（B） | 指向 X 的有效 symlink/junction 投影 | 有效实体目录 |

- “双侧”表示两边均可用，不表示两侧各有一份实体。`shared-copy` SHALL 继续表示可恢复但未完成的 `partial`，不是合法 B，也不能作为成功目标；`conflict`、invalid-link、invalid 和 missing 不得直接进入拓扑迁移。
- 系统 SHALL 支持三种完成态之间全部六个有向切换，并识别三种 no-op；任何切换都保留当前有效内容，不从远程 source 静默重装。
- 所有非 no-op 切换 SHALL 在目标树外创建并复检内容快照，同时记录原拓扑、内容 manifest、lock/source 事实和 CLI 报告的其它 Agent。
- 三种目标 SHALL 由统一 service 委托官方 CLI 实现：C 使用 Claude Code `--copy`；X 使用 Codex `--copy` 且仅在该子进程设置 `CODEX_HOME=~/.agents`；B 固定按 Codex 后 Claude Code 的顺序执行双 Agent add 且不传 `--copy`，其唯一合法结果是 X 实体 + C 投影。
- 六向转换 SHALL 遵循以下可观察事务语义；表中的“删除/物化/投影”均由官方 CLI 完成，ccq 只负责调度和事实对账：

  | 转换 | 必须执行的语义顺序 |
  |---|---|
  | C→X | 快照 C → 删除 C 实体 → 确认两目标均空 → 物化 X |
  | C→B | 快照 C → 物化 X → 删除 C 实体 → 在 C 创建指向 X 的投影 |
  | X→C | 快照 X → 删除 X 实体 → 确认两目标均空 → 物化 C |
  | X→B | 快照 X → 保持/刷新 X 实体 → 在 C 创建指向 X 的投影 |
  | B→C | 快照 X → 删除 C 投影和 X 实体 → 确认两目标均空 → 物化 C |
  | B→X | 删除 C 投影 → 保留且复检 X 实体 |

- C→B MAY 由一条固定 Agent 顺序的官方双 Agent add 完成；上游 1.5.19 在该命令内部先处理 Codex canonical，再由 Claude 步骤替换原 C 实体为投影。该内部顺序必须由版本固定的源码证据和隔离 HOME smoke 守护，不能只凭最终 exit code 假设。
- 移除旧投影 SHALL 只传需要移除的 Claude Code/Codex agent 参数，不使用无 `--agent` 的全量 remove；所有 Skills 子进程 SHALL 显式固定 `CLAUDE_CONFIG_DIR=~/.claude`，需要把 canonical 作为 Codex 路径参与 remove/add 时 SHALL 显式固定 `CODEX_HOME=~/.agents`。
- 目标树的创建、替换和删除仍 SHALL 全部由官方 CLI 完成；ccq 不得用 `rm`/`rename`/`cp`/`symlink` 直接改写 `.agents/skills` 或 `.claude/skills`。
- 每个 remove/add 后 SHALL 立即执行 storage + lock 中间对账；CLI 退出码只作诊断。若退出码失败但期望文件事实已经成立，流程按事实继续；若退出码成功但事实不符，流程必须失败或进入恢复。
- 只有目标 storage kind、内容 manifest、Claude 链接目标、lock/source 后置条件和一次共享 detection refresh 全部一致时才 SHALL 报告成功。
- 任一步失败 SHALL 从同一快照最多执行一次“清理当前 CC/Codex 投影 → 重建原拓扑 → postflight”的自动恢复；恢复成功返回“迁移失败但已恢复原状态”，恢复失败保留 snapshot 并展示路径。
- 首个 CLI mutation 一旦启动，无论最终为 complete、partial、restored 或 failed，视图都 SHALL 在结束时调用共享 detection cache 的 `refreshAndWait()` 恰好一次；mutation 前的 preflight/no-op/取消路径不刷新。
- 快照只有在目标拓扑成功，或恢复后的有效内容 manifest 与原快照一致时才能清理；仅检测到某个有效目录但内容不一致时不得删除恢复快照。
- 迁移到 Claude-only 前若 CLI 明确报告其它 Agent 使用同名 Skill，系统 SHALL 阻止删除 canonical；即使未报告其它 Agent，强确认仍 SHALL 说明所有直接读取 `.agents/skills` 的 Agent 都会失去该 Skill。
- 任一 remove 可能删除全局 lock；postflight SHALL 验证最终 lock 事实。无 lock 的本地状态 SHALL 禁用当前项远程更新，且后续全量 update 不得重建 canonical 或改变目标拓扑。

### R11 — 两个搜索框的基础编辑能力

- 已安装列表“过滤”和安装页“搜索” SHALL 复用同一个真实 OpenTUI React 单行 `<input>` 组件，以受控 `value` + `onChange` 同步 reducer，不再由视图按键处理器手工拼接字符串或绘制假光标。
- 两个输入框 SHALL 支持终端 bracketed paste、光标左右移动、Home/End、选择、退格/删除、按词删除、全选、撤销和重做；换行在单行输入中 SHALL 被剥离。
- Windows/Linux SHALL 支持 `Ctrl+A` 全选、`Ctrl+C` 复制、`Ctrl+X` 剪切、`Ctrl+Z` 撤销、`Ctrl+Y` 与 `Ctrl+Shift+Z` 重做；macOS SHALL 使用对应 Command 语义。复制/剪切复用现有 OSC52 反馈入口，粘贴沿用终端 bracketed paste。
- 输入值 SHALL 继续通过 reducer 的 `filter-input` / `query-input` 成为唯一 React 状态；原生 input 的更新不得造成循环重置或在每次输入时清空 undo 历史。
- 输入框聚焦时，Tab/Esc/Enter 与上下导航 SHALL 保持现有页面语义；编辑快捷键不得穿透为 Skills 页的安装、更新、卸载、全选或刷新动作。
- 远程搜索提交 SHALL 只有一个事件 owner，Enter 不得同时被原生 input `onSubmit` 与顶层 `useKeyboard` 触发两次；本地过滤框 Enter 保持无副作用。
- 实现 SHALL 复用现有 `utils/keyboard.ts` 平台语义与 OpenTUI key binding API；不得在 SkillsView 再维护一套操作系统判断或手写剪贴板读取。

## Acceptance Criteria

- [ ] AC1：Claude-only 仅在 Claude 实体 Skill 目录存在且同名 canonical 物理路径不存在时成立；完整共享安装、孤儿 canonical、正确软链接、断链和错误链接不会被误判。
- [ ] AC1a：进入 Skills 页、自动检测和手动刷新对 Claude-only Skill 均无写盘副作用。
- [ ] AC2：C→B 使用目标树外快照和固定的 Codex→Claude Agent 顺序；官方 CLI 先建立 X 实体，再以 C 投影替换原 C 实体，最终只有一个内容实体且列表两侧均显示已安装。
- [ ] AC2a：只有用户对 Claude-only Skill 明确执行“安装到 Codex”才会进入收编流程；取消管理弹窗或确认框不写盘。
- [ ] AC3：迁移期间 `.agents`/`.claude` 内的写入与软链接操作全部由官方 `skills` CLI 完成。
- [ ] AC4：直接 source/target 路径重叠不会进入危险安装；实现使用目标目录外的安全快照或等价的上游能力。
- [ ] AC5：canonical 同名异内容、无效 Skill、断链、逃逸软链接和软链接创建失败均有回归测试，且不会丢失唯一内容副本。
- [ ] AC5a：Windows 软链接失败并退化为 copy 时，canonical 与 Claude 副本均保留，UI 明确显示非成功 `partial` 并允许后续重试，不把它显示为 B、`complete` 或成功迁移。
- [ ] AC6：本地收编或双侧转 Claude-only 的结果不会获得伪造远程来源；UI 不把无 lock 的本地内容错误展示为可远程更新。
- [ ] AC7：只有精确 C/X/B 目标事实、manifest、lock 条件和一次共享检测刷新全部一致才报告成功；`shared-copy` 与退出码 0 均不能单独构成成功。
- [ ] AC8：既有 `verify-skills-view`、`verify-skills-agent`、`verify-skills-shared-projection`、Skills batch contract 门禁和 TypeScript typecheck 继续通过。
- [ ] AC9：macOS/Linux 软链接与 Windows symlink/junction 失败回退语义在测试或平台边界说明中明确覆盖。
- [ ] AC10：管理 Modal 对 C/X/B/shared-copy 四种可恢复状态均允许选择 C、X、B 目标；invalid/conflict/missing 保持只读，取消任一层弹窗均零写盘。
- [ ] AC11：无安装、Claude-only、Codex-only、完整共享、Windows shared-copy、同名异来源、检测失败和无效/冲突状态均有唯一且可解释的下一步，不存在因 source 缺失而无法恢复 Claude 投影的合法状态。
- [ ] AC12：搜索安装页对同来源已安装及来源未知的同名项继续禁选；只有可证明同名不同源的项显示固定文案“已有同名”并允许选择。
- [ ] AC12a：Claude-only、Codex-only、双侧同来源安装和 shared-copy 不跳转管理 Modal、不触发迁移；同名不同源只进入独立覆盖确认，不伪装为普通新装。
- [ ] AC13：来源替换强确认完整列出旧/新 source、直接覆盖语义、所选 Agent 与 canonical/lock 影响；取消后没有 CLI 或文件系统副作用。
- [ ] AC14：命令顺序严格为 add 新来源到所选 Agent → postflight → 清理未选择的旧投影；add/对账失败时不执行后置 remove，并至少保留一份旧内容恢复快照。
- [ ] AC15：C、X、B 三种成功态始终恰好一个实体；B 只能是 `.agents` 实体 + `.claude` 正确投影，两侧实体目录不得冒充双侧完成。
- [ ] AC16：C→X、C→B、X→C、X→B、B→C、B→X 六个有向切换和三种 no-op 都有 service/reducer 回归测试，逐条断言命令顺序、中间文件事实和内容 manifest。
- [ ] AC16a：C→X 在 X 物化前已删除 C 实体；C→B 的官方命令按 Codex→Claude 顺序先建立 X，再把 C 实体替换为投影；B→X 不重写 X 内容。
- [ ] AC17：真实官方 CLI 1.5.19 隔离 HOME smoke 证明六向切换可达并验证 C→B 单实体结果；Codex-only add/remove 使用 scoped `CODEX_HOME=~/.agents`，不会把物理源写到 `~/.codex/skills`。
- [ ] AC18：每个 remove/add 的 exit/fact 四象限、中间存储状态、自动恢复成功/失败与 snapshot 清理条件均有测试；任何最终结果至少有原内容等价的有效安装或恢复快照。
- [ ] AC19：管理草稿能选择三种且只允许三种完成态；零目标被阻止并引导全量卸载；取消管理/确认均零 CLI、零写盘。
- [ ] AC20：迁移到 Claude-only 时显式其它 Agent 占用会阻止 canonical 删除，确认文案覆盖隐式 `.agents` 消费者影响；其它拓扑切换不误删无关 Agent 投影。
- [ ] AC21：迁移成功同时对账 storage、manifest、链接目标、lock/source 与一次 detection；本地无 lock 行的单项更新被禁用，全量更新不会改变其拓扑。
- [ ] AC22：两个搜索框均通过真实 OpenTUI input 支持 bracketed paste、光标/选择、全选、复制、剪切、撤销和重做；平台修饰键正确，Enter 只提交一次且页面快捷键不穿透。
- [ ] AC23：窄终端和超长粘贴下输入内容被稳定裁剪/滚动，不改变列表/Modal 布局，不出现文字重叠。
- [ ] AC24：任何已启动 mutation 的 complete/partial/restored/failed 结局都恰好刷新一次共享检测；取消、no-op 和 preflight 阻断为零刷新。

## Out of Scope

- 自动合并两个同名但内容不同的 Skill。
- 同名 Skill 的 side-by-side 命名空间或自动重命名。
- 修复磁盘上已存在但 CLI/Codex 未识别的孤儿或无效 canonical Skill。
- 猜测或伪造远程 Git 来源。
- 修改 Agent Skills 的 `SKILL.md` 通用格式。
- 改造上游 `vercel-labs/skills` CLI 或增加其新命令。
- 改变项目级 Skills 安装；本任务聚焦当前 TUI 的全局 `-g` 生命周期。
- 自动迁移或删除 Claude Code/Codex 之外的 Agent 投影；显式检测到第三方占用时采用阻断而不是代替用户迁移。
