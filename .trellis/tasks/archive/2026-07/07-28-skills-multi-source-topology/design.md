# Skills 多来源检测与拓扑迁移设计

## 1. 设计目标

建立一个单一的 Skills 已安装实例边界，完整拥有以下链路：

```text
npx skills list -g --json
  -> 严格解析 CLI 记录
  -> 来源与路径归一化
  -> 逻辑实例分组和能力派生
  -> view/reducer/service 共用的 InstalledSkillItem
  -> 写操作后的同一边界复检
```

这个边界只解释 CLI 已返回的数据。目录、lock 和内容快照不再补充列表事实；文件
系统只在用户确认迁移/删除后作为事务安全工具使用。

## 2. 当前问题与受影响边界

当前实现把职责分散在多层：

- `getInstalledSkills()` 宽松跳过坏记录，并从 `.agents/.skill-lock.json` 补来源；
- `inspectInstalledSkillStorage()` 扫描 `.agents/.claude`，`projectSharedSkills()` 再用
  物理结果覆盖 CLI `agents`；
- `SkillSharedRow`、React key、搜索占位、删除完成和 install 对账以名称为身份；
- `skills-adoption.ts` 以 C/X/B 物理检查结果为迁移输入；
- `skills-service.ts` 的同名替换以单个 `Map<name, row>` 和 lock 后检为基础。

新边界会替换这些解释路径，但复用现有 `execCommand`、检测缓存、进度回调、临时
快照、搜索批次和 Modal 交互机制。

## 3. 核心领域模型

建议由新的 `core/skills-installed.ts`（名称可在实现时按现有模块命名微调）拥有原始
协议、归一化、分组、能力和对账谓词。Views 不再自行解释字段。

```ts
type SkillsStorageRoot = 'claude' | 'agents' | 'codex' | 'other';

type SkillsCliListRecord = {
  readonly name: string;
  readonly path: string;
  readonly scope: string;
  readonly agents: readonly string[];
  readonly source?: string;
  readonly sourceUrl?: string;
};

type SkillProvenance =
  | {
      readonly kind: 'known';
      readonly identity: string;
      readonly source?: string;
      readonly sourceUrl?: string;
      readonly installSource: string;
    }
  | {readonly kind: 'unknown'};

type SkillProjection = {
  readonly path: string;
  readonly root: SkillsStorageRoot;
  readonly scope: string;
  readonly agents: readonly string[];
};

type SkillInstanceCapabilities = {
  readonly update: boolean;
  readonly manageAgents: boolean;
  readonly migrate: boolean;
  readonly delete: true;
};

type InstalledSkillItem = {
  readonly id: string;
  readonly name: string;
  readonly provenance: SkillProvenance;
  readonly agents: readonly string[];
  readonly projections: readonly SkillProjection[];
  readonly capabilities: SkillInstanceCapabilities;
};
```

`source` 与 `sourceUrl` 始终分开保存和展示。`installSource` 取首个非空
`sourceUrl ?? source`，供 add/迁移使用；两个字段都没有才是 unknown。

## 4. CLI 解析与来源归一化

### 4.1 严格解析

一次检测只执行一次不带 `--agent` 的 `skills list -g --json`。解析规则为：

1. 非零退出、空 stdout、无效 JSON、非数组顶层都整体失败；
2. 数组中的每一项都必须是 object；`name`、`path`、`scope` 必须是字符串，
   `agents` 必须是字符串数组；
3. `source` / `sourceUrl` 缺失合法，存在时必须是字符串；空白值归一为缺失；
4. 任一记录不满足 schema 时返回带记录索引的检测错误，不静默跳过；
5. 不读取 `.skill-lock.json`，不调用 storage inspector。

解析器从 `unknown` 构造领域对象，`getInstalledSkills`/检测 service 只消费解析结果。

### 4.2 来源身份

统一导出 `normalizeSkillSourceIdentity()`，让搜索结果、安装冲突和已安装实例复用。

- 优先以非空 `sourceUrl` 作为输入，否则使用 `source`；
- GitHub HTTPS、SSH、`github:`、`github.com/` 与 `owner/repo` 归一为
  `github:<lowercase owner/repo>`；
- 其它来源使用 trim 后的精确值形成带类型前缀的 identity，不改变展示原值；
- `skillSourcesEquivalent()` 改为比较该 identity，避免再维护第二套规则。

## 5. 逻辑实例分组

### 5.1 已知来源

分组键为 `JSON.stringify(['known', name, normalizedSourceIdentity])`。同组记录：

- 按路径精确去重后保留全部 `projections`；
- `agents` 稳定去重合并，Claude/Codex badge 只从该并集派生；
- 不读取或比较目录内容；
- 多个等价原始来源值按 CLI 首次出现顺序选择展示代表值，同时保留每条 projection
  的原始协议事实供诊断。

### 5.2 未知来源

未知来源分组键包含精确规范化路径：
`JSON.stringify(['unknown', name, normalizedPath])`。相同路径的重复记录可以去重，
不同路径绝不只因名称相同而合并。

### 5.3 排序与所有权冲突

Items 先按 `name` 排序，再按来源 identity/unknown path 排序，使同名实例相邻。
`id` 作为 React key、Modal 快照和 reducer 对账身份。

另建 `(root, name) -> itemId` 所有权索引。CLI 若让不同 Item 声明同一物理目标，
列表仍忠实展示，但该路径标记为歧义；任何覆盖、迁移或定向删除在预检阶段拒绝，
不能任选一个来源写入。

## 6. 能力派生与 UI 投影

能力只由 provenance 派生：

| provenance | U 单项更新 | Enter Agent 管理/迁移 | D 删除 |
|---|---:|---:|---:|
| known (`source` 或 `sourceUrl`) | 是 | 是 | 是 |
| unknown（两者都无） | 否 | 否 | 是 |

路径可用性和安全性属于 mutation preflight，不改变列表上的产品能力；预检无法证明
安全时返回具体诊断。更新全部仅在至少一个 known Item 存在时启用。

卡片使用 `item.id` 作为 key，并显示：

- Skill 名称；
- Claude Code / Codex Agent badge（仅由 `agents` 派生）；
- `.claude` / `.agents` / `.codex` 存储 badge（仅由 JSON `path` 分类）；
- `source` 与 `sourceUrl`；两者都缺失时显示 `未知来源`。

unknown Item 按 Enter 时保持 list mode 并提示“未知来源仅支持删除”；不会生成可提交
草稿。D 确认文案包含 Item 来源和“所有 Agent/投影”，避免与侧别移除混淆。

## 7. Reducer 与异步输入

`SkillsViewState` 的 installed 类型改为 `InstalledSkillItem[]`。涉及异步或 Modal 的
意图必须快照 `item.id`/Item 输入，不能在确认后重新用名称或当前 cursor 查找：

```text
cursor -> selected item -> pending instance snapshot -> confirm/busy
       -> service(item snapshot) -> refreshAndWait -> lifecycle-reconciled
```

主要调整：

- `manage-inject`、`confirm-topology-change`、`confirm-uninstall` 保存 instance id；
- `action-uninstall-done(names)` 等名称级乐观过滤删除；所有 lifecycle 都以刷新后的
  Items 替换 state；
- install reconciliation 以搜索 `(skillName, sourceIdentity)` 和目标 Agent 条件确认，
  不再以 `installedNames` 判断成功；
- 刷新后若 pending id 消失，视为该实例已被实际移除；若同名其它来源仍在，不影响
  当前操作结果。

## 8. 写操作设计

### 8.1 新安装与目标冲突

保留现有扁平多选、同批 source 分组和 Agent 目标 Modal。

1. 搜索结果先用来源 identity 查是否已安装：同名同源 disabled；同名异源可选；
2. 选定目标 Agent 后，把目标映射到 `.claude`/`.agents` 根；
3. 只检查这些目标根的 `(root, name)` 占用；有异源占用时进入 `已有同名` 强确认；
4. 确认后为被覆盖目标建快照，再执行官方 add；
5. 完整 list 刷新按来源 identity + Agent 投影确认，未确认项保留选择以重试。

其它根中的同名异源 Item 不属于本次覆盖目标，必须保留。

### 8.2 更新

- 单项：known Item -> `skills update <name> -g -y`；同名多来源时进度/结果说明这是
  CLI 名称级更新，不声称来源隔离；
- 全量：一次 `skills update -g -y`；
- unknown Item 不会进入单项更新；
- 两种命令结束后都只通过一次完整 list 刷新回填最终状态。

### 8.3 D 全量删除与 Enter 侧别移除

删除 planner 接收完整 Item，而不是名称。

1. 若官方 remove 的 name/Agent 选择在当前列表中能证明不会命中同名其它来源，使用
   官方命令；
2. 否则由 Item 的 JSON projections 加上无歧义的 Agent 标准投影生成精确路径计划；
3. 任何推导路径若被另一 Item 的 `(root, name)` 占用，整体拒绝；
4. 对每个路径执行核心层安全验证后再删除；
5. D 计划包含该 Item 的所有可证明投影；Enter 计划只包含为达到目标 Agent 集合需
   移除的侧；
6. 完成后完整 list 刷新，不做本地 `filter(name)` 乐观成功。

路径验证必须由 core 单点实现：Skill 名称不得含分隔符或 `.`/`..`；候选绝对路径
必须等于允许根下的直接 `<name>`；拒绝根、父目录、穿越、未知根和所有权歧义；
用 lstat 区分目录与链接。链接/联接点必须解析到同名、受支持且归属当前 Item 的
投影，只 unlink 链接本身；真实目录才允许对该精确目录递归删除，永不跟随链接目标。

### 8.4 Agent 管理与 `.codex` 迁移

从 Item `agents` 初始化 Claude/Codex 草稿，目标映射为：

| 草稿 | 受管目标 |
|---|---|
| Claude-only | `.claude/skills/<name>` |
| Codex-only | `.agents/skills/<name>` |
| Shared | `.agents` 本体 + `.claude` 投影 |

若当前 projection 含 `.codex`，即使目标仍是 Codex-only，也必须进入迁移确认；它不
是 no-op。受管根中的同名异源占用进入覆盖确认。

事务状态机：

```text
prepared
  -> snapshot source + occupied targets
  -> materialize target with official add
  -> validate exact target paths
  -> delete exact old-source paths
  -> full CLI reconciliation
  -> complete / partial / restored / failed
```

- 建立/验证目标失败：源未删，恢复所有被覆盖目标，返回 `restored` 或 `failed`；
- 目标成功、源只删除一部分：保留可用目标和残留源，返回 `partial`，保留恢复快照；
- 源已删但最终 CLI 对账不符：执行至多一次恢复原源/目标的回滚；能证明恢复时返回
  `restored`（非成功），否则 `failed` 并暴露 recovery path；
- 完整 CLI 对账成功才清理快照并返回 `complete`。

精确目标 path/lstat 和快照只证明事务安全，不反馈到列表身份或 Agent badge。

## 9. 检测缓存与错误结果

- `view-detection.ts` 直接调用深模块返回 `InstalledSkillItem[]`；App cache 不再缓存
  带 `storage` 的半成品；
- 普通检测和每次最终复检各自只执行一次 list 命令；迁移内部 path 验证不是列表
  检测；
- service 结果保留 `complete | partial | restored | failed`、`mutated`、诊断和
  recovery path，不能压成 boolean；
- 命令退出成功但目标 path/最终 list 不符仍失败；命令失败但不能据此本地猜测最终
  UI 状态；
- 取消 mutation 后仍按现有 AbortSignal 规则刷新最终 CLI facts。

## 10. 兼容性与规格迁移

这是对现有 Skills lifecycle contract 的有意替换：

- 删除“list 后物理 inspection 修正 Agent badge”的要求；
- 删除“canonical 存在即可推导 Codex 可用”的要求；
- `skills-storage.ts` 从检测事实 owner 收缩为快照、精确路径验证和事务恢复工具；
- `readGlobalSkillLockMetadata()` 不再参与检测、来源或最终对账；若无其它调用可移除；
- C/X/B 不再由目录扫描分类，而由 Item `agents` + JSON path 规划目标；
- 允许在官方 remove 无法来源隔离时执行经过严格验证的直接删除，这是现有“目标树
  只能由官方 CLI 修改”规则的窄例外；add/覆盖/恢复仍优先通过官方 CLI；
- batch contract 的“名称全局占位”改为“来源感知已安装 + 目标根占位”，但保留同一
  批次不安装两个异源同名 Skill。

需要同步更新 `skills-lifecycle-contract.md`、`skills-batch-install-contract.md` 和
相关 verify gates，不能让旧物理拓扑规范继续描述为当前行为。

## 11. 风险与取舍

- 当前 `skills@1.5.20` 以名称去重，TUI 无法显示 CLI 未表达的磁盘异源实例；这是
  接受的上游限制，不用扫描补救。
- 单项 update 仍按名称，可能更新同名另一来源；UI 明示不隔离，结果以刷新为准。
- 直接删除绕开官方 lock 维护，但只在官方选择器不安全时使用；列表刷新决定可见
  状态，残留 lock 不得重新补进列表。
- 不比较内容会放弃发现同源副本差异，但符合“平台只关心 CLI 元数据”的产品边界。
- `.system` 当前不在 JSON 中，因此无专门分支；未来 CLI 行为变化必须重新做 contract
  研究，不能由本次实现猜测。

## 12. Rollout / Rollback Shape

实现按“只读投影 -> reducer/UI -> mutation”三段落地，每段先有 focused gate。
任何 mutation gate 未通过时，不启用直接删除或新迁移路径；保留已完成的纯解析测试
作为下一轮基础。运行时事务通过快照实现数据回滚，代码回滚则以本任务涉及文件的
小范围反向补丁为单位，绝不重置用户工作区或无关自更新改动。
