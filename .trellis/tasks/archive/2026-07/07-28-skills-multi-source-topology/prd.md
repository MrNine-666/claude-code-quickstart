# 支持 Skills 多来源检测与拓扑迁移

## Goal

让 TUI 只依据 `npx skills list -g --json` 准确展示和管理用户通过不同方式安装的
Skills：长期受管目标仍是 `.claude/skills` 与 `.agents/skills`，同时兼容用户自行
安装到 `.codex/skills` 的实例，并对多来源同名、未知来源、更新、Agent 切换、
迁移、覆盖和删除给出可预测且可复检的行为。

## Background and Confirmed Facts

- TUI 的最终受管存储模型只有：
  - `.claude/skills/<name>`：Claude-only；
  - `.agents/skills/<name>`：Codex-only；
  - `.agents/skills/<name>` 加 `.claude/skills/<name>` 投影：Shared。
- `.codex/skills` 只是兼容用户自行安装实例的输入；TUI 新安装不以 `.codex` 为
  目标，但不能隐藏 CLI 已报告的 `.codex` 实例。
- 当前实现会读取 `.agents/.skill-lock.json` 补来源，并扫描 `.claude/skills` 与
  `.agents/skills` 修正 Agent 状态；本任务要求移除这些对列表事实和最终状态的
  补充或覆盖。
- 当前列表、React key、安装占位、删除和 reducer 对账大量以 `name` 为唯一身份；
  这些位置无法区分同名不同来源实例。
- 2026-07-28 实测 `skills@1.5.20`：
  - `update [skills...]` 只接受名称与 global/project scope，没有 Agent、来源、
    路径或实例选择参数；
  - 全局 lock 以 `skills[name]` 为键，同一名称最多表达一个更新来源；
  - `list -g --json` 按名称去重、合并 Agent badge，并把该名称的 lock 来源附到
    列表记录；
  - `.codex/skills/.system/<skill>` 不是直接位于扫描根下且 `.system` 本身没有
    `SKILL.md`，当前不会出现在列表 JSON 中。
- 因此磁盘上真实存在的同名异来源内容可能被当前 CLI 报告为同一来源。TUI 接受
  这一上游限制：不读取内容或 lock 反推差异，只按 CLI 实际返回的数据建模。

## Requirements

### R1. 唯一检测与复检来源

- 已安装列表的唯一事实源是一次成功的 `npx skills list -g --json` JSON 数组。
- TUI 不枚举 `.claude/skills`、`.agents/skills` 或 `.codex/skills` 来补充、拆分、
  修正或隐藏列表项，也不再从 `.skill-lock.json` 补充来源。
- 每条记录的 Agent 可用侧只来自 `agents`；来源身份和展示只来自记录本身的
  `source` / `sourceUrl`。
- `path` 只用于识别 `.claude`、`.agents`、`.codex` 存储位置以及执行经用户确认的
  迁移/删除；它不参与来源身份、Agent 可用侧或同源合并判断。
- 命令失败、输出为空、顶层不是数组，或任一记录的必需字段不可解析时，整个检测
  进入错误态，不回退文件系统扫描，也不静默跳过坏记录。
- 每次安装、更新、Agent 切换、迁移或删除后，都重新运行完整
  `list -g --json`；只有新 JSON 投影决定最终 UI 状态。

### R2. 逻辑实例身份与展示

- 已知来源实例以 `(name, normalizedSourceIdentity)` 为逻辑身份。
  `sourceUrl` 与 `source` 保留为两个展示字段；来源身份归一化复用 GitHub URL、
  SSH 与 `owner/repo` 等价规则，并以 `sourceUrl` 作为可用时的优先操作来源。
- 同名同来源的 CLI 记录直接合并为一个 Item，合并其 Agent 和路径投影；实际文件
  内容即使不同也不比较、不告警、不阻止合并。
- 只有 CLI 确实返回不同的归一化来源时，同名实例才拆成多个 Item；这些 Item
  必须相邻展示并拥有独立稳定 key。
- `source` 与 `sourceUrl` 都不存在时为未知来源。未知来源没有可证明的跨路径合并
  键，不得仅按名称或内容相似度合并；精确重复路径可视为同一条物理记录去重。
- 每个受支持存储根内 `(root, name)` 唯一。向同一根写入同名不同来源时必须进入
  覆盖确认，不能制造第二个物理实例。
- Item 展示 Agent/存储位置、`source` 和 `sourceUrl`；两个来源字段都缺失时显示
  `未知来源`。

### R3. 能力矩阵

- `source` 或 `sourceUrl` 任一存在即为已知来源，可进入单项更新、Agent 管理和
  迁移；TUI 不按存储目录、操作系统或平台预先屏蔽这些能力，执行失败时展示 CLI
  或安全预检的真实诊断。
- 未知来源 Item 只能查看和删除，不能更新、迁移、收编或切换 Agent；`Enter`
  不打开可提交的 Agent 管理流程。用户若要改变它，只能删除后从搜索页重新安装。
- “更新全部”仅在至少一个已知来源 Item 存在时启用，仍只执行官方全局 update；
  它不能把未知来源 Item 呈现为已更新。

### R4. 安装目标与同名冲突

- 保留现有搜索结果多选和 Agent 目标多选交互，不新增三段式拓扑选择器。
- 新安装只生成 `.claude` / `.agents` 受管拓扑，绝不写入 `.codex`。
- 搜索结果与已安装状态按来源感知：同名同来源视为已安装；同名不同来源仍可选择，
  但目标根已存在同名实例时必须提示 `已有同名`。
- 覆盖提示展示待安装来源、已有实例来源及目标存储位置；用户确认继续后才覆盖目标
  根中的同名实例。位于其它根且来源不同的同名 Item 不受影响。
- 同一批次仍不允许把两个不同来源的同名 Skill 安装到同一目标集合。

### R5. 更新语义

- 单项 `U` 对已知来源 Item 执行一次 `skills update <name> -g -y`。若存在同名
  不同来源 Item，由 CLI 的名称级 contract 决定实际更新对象；TUI 不承诺只更新
  当前来源。
- “更新全部”执行一次 `skills update -g -y`，不循环伪造逐实例成功。
- 更新命令结束后必须完整复检；命令退出码本身不代表哪个逻辑实例已更新。

### R6. Agent 管理与迁移

- `Enter` 管理当前已知来源逻辑实例的 Claude/Codex 可用侧；关闭某一侧只移除为
  达到目标拓扑所需的该侧投影，不等同于 `D` 全量删除。
- `.codex` 已知来源实例进入管理时按其 `agents` 初始化草稿，但确认“仅 Codex”
  也不是 no-op：必须提示并迁移到 `.agents`。
- `.codex` 选择两侧时迁移为 Shared；选择仅 Claude 时迁移为 `.claude`
  Claude-only；两侧都不选仍由现有零目标规则阻止。
- `.codex` 识别只依据 JSON `path`，不得扫描用户目录发现 CLI 未报告的实例。
- 迁移先快照源与将被覆盖的目标，再建立并验证目标；只有目标成功后才删除源。
- 目标已存在同名实例时先显示来源、来源链接和存储位置，确认后以源实例覆盖目标。
- 目标创建或验证失败时恢复被覆盖目标；目标成功但源删除不完整时报告“目标已创建、
  原实例残留”，保留真实残留并等待复检，不宣称完整成功。
- 快照和精确路径检查只服务于防止数据丢失，不参与列表身份、来源、Agent 投影或
  同源合并。

### R7. 删除语义与安全边界

- 列表页 `D` 删除当前逻辑 `(name, sourceIdentity)` 的全部 Agent/路径投影，但不
  删除同名其它来源 Item；确认文案必须明确删除范围。
- 优先使用能够精确隔离当前来源实例的官方 `skills remove`。当前 CLI 只有名称/
  Agent 选择器：只要它可能影响同名其它来源，就必须改用当前 Item 的 JSON `path`
  及无歧义的 `agents` 投影做定向删除。
- 定向删除前必须验证：路径位于受支持 Skills 根、目标是该根的直接 `<name>`、
  basename 与 Item 名称一致、没有路径穿越、目标不是根/父目录，且链接/联接点不会
  让递归删除逃逸。无法证明安全时拒绝删除并展示诊断。
- 删除链接时只移除链接本身，不递归跟随目标；任何由 `agents` 推导的投影若已被
  同名其它来源 Item 占用，必须中止而不是猜测所有权。
- 删除完成后完整复检；不得通过本地过滤名称伪造成功。

### R8. 上游契约限制

- `npx skills` 仍是安装、更新与官方删除能力的事实来源；TUI 不增加 CLI 不存在的
  来源级 update 参数或平台限制。
- 当前 CLI 无法表达的磁盘差异就无法由 TUI 展示。若未来 CLI 改变 JSON schema、
  同名去重或 `.system` 扫描行为，应重新验证 contract，而不是为当前未返回的目录
  增加旁路扫描。

## Acceptance Criteria

- [ ] 已安装列表和每次写操作后的最终状态严格来自完整 `list -g --json`；失败或
      坏记录进入错误态，且不读取 lock/目录补救。
- [ ] Item 的 Agent 侧只由 `agents` 决定，来源只由 `source/sourceUrl` 决定，
      `path` 仅参与存储定位与经确认的迁移/删除。
- [ ] CLI 返回的同名同来源记录合并为一个 Item；同名不同来源保持多个相邻 Item；
      CLI 把真实差异报告为同源时，TUI 仍按一个 Item 处理。
- [ ] 同名同来源但内容不同不会产生内容冲突；未知来源不会因名称或内容相似而跨
      路径合并。
- [ ] 每个 Item 展示 Agent/存储、`source` 与 `sourceUrl`；两者都缺失时显示
      `未知来源`。
- [ ] 未知来源只能经 `D` 删除，不能单项更新、迁移、收编或进入可提交的 Agent
      切换；删除后才可重新安装。
- [ ] 搜索页保留现有多选；同名同来源显示已安装，同名异来源可选，只有目标根冲突
      才显示 `已有同名` 覆盖确认；新安装不写 `.codex`。
- [ ] 单项和全量更新分别只执行一次官方名称级/全局命令，并在之后完整复检；同名
      多来源时不虚构当前来源被独立更新。
- [ ] `.codex` 已知来源 Item 确认仅 Codex 时收编到 `.agents`；选择 Claude-only
      或 Shared 时迁移到相应受管拓扑。
- [ ] 迁移覆盖遵循“快照 → 建立并验证目标 → 删除源 → 完整复检”；目标失败恢复
      被覆盖目标，源删除失败准确报告部分成功。
- [ ] `D` 只删除当前逻辑实例的全部投影；`Enter` 只改变选中侧。两种确认文案能
      清楚区分范围，同名其它来源保持不变。
- [ ] CLI 无法按来源隔离时，只删除通过根目录、直接子项、basename、穿越和链接
      校验的路径；任何所有权歧义都拒绝删除。
- [ ] 当前不会为 CLI 未返回的 `.codex/skills/.system` 做扫描、隐藏规则或专门
      管理入口。

## Out of Scope

- 把 `.codex/skills` 作为 TUI 新安装的长期目标。
- 为未知来源猜测、搜索或手工绑定 `source/sourceUrl`。
- 比较 Skill 内容、生成内容 hash 或以内容决定逻辑身份。
- 一次迁移后刻意保留源、目标两个副本的“复制”动作。
- 在 TUI 内实现脱离 `npx skills` 的远程更新协议或来源级 update 选择器。
- 为当前 `list -g --json` 未返回的 `.codex/skills/.system` 做额外扫描；未来上游
  行为变化需重新验证后另行设计。
