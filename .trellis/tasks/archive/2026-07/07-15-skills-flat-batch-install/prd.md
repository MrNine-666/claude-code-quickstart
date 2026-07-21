# Skills 扁平多选批量安装

## Goal

在现有 Skills 安装页中增加跨来源的子 Skill 多选与批量安装能力，同时保留扁平浏览体验、实时已安装标识和当前安装上下文，使用户无需进入 owner/repo 分组页即可选择多个未安装 Skill，并在任何安装结果后继续停留在原安装页处理剩余项目。

## Background

- 当前安装页以扁平 `SearchSkillResult[]` 展示 `skills find` 返回的子 Skills，并以 `resultIndex` 维护光标；该扁平结构必须保留。
- 上游 `npx skills add <source>` 一次只接受一个 source，但允许在同一 source 下重复传入多个 `--skill`。
- 当前 core 已有 `installMultipleSkills()`，能够用一次进程调用安装同一 source 下的多个 Skill；当前 view service 尚未暴露扁平跨来源批量入口。
- 当前全局检测通过一次无 `--agent` 的 `skills list -g --json` 得到 Claude Code / Codex 双侧事实，并投影为 `SkillSharedRow[]`。
- Skills CLI 的已安装目录和 lock 以 Skill 名为身份键；同名不同来源会占用相同全局身份，不能作为两个独立可选安装项处理。
- 历史提交 `33df1d7` 曾实现 repo 分组和子页多选，后续提交 `2e77afd` / `4c84983` 将其简化为当前扁平安装流。
- 当前新安装成功走通用 `action-done` 后会重置回已安装列表页；安装失败已通过 `busyReturnMode` 回到安装页。

## Requirements

### R1 — 安装页保持扁平子 Skill 列表

- 安装页 SHALL 继续逐条展示搜索得到的子 Skills，不按 owner、repo 或完整 source 分组。
- 安装页 SHALL NOT 新增 repo 父级列表、repo 子页面、分组标题或独立安装篮页面。
- 每个 item SHALL 保留 Skill 名与 source 信息，使不同来源的选择可辨识。

### R2 — 跨来源多选

- 用户 SHALL 能在同一扁平列表中选择多个未安装 Skill，包括来自不同 owner/repo/source 的项目。
- 选择身份 SHALL 同时包含 source 与子 Skill 名，避免不同来源的搜索结果在 UI 选择状态中互相覆盖。
- Space SHALL 只切换当前可安装项；全选动作 SHALL 只选择当前列表中的可安装项。
- 用户提交新的远程搜索时，系统 SHALL 清空旧结果的选择集合；不得保留当前扁平结果之外的隐藏选择。
- 当没有显式多选且当前光标项可安装时，Enter SHALL 保持现有单项安装便利性，把当前项作为单项批次打开目标 Modal；存在显式多选时 Enter SHALL 提交选中集合。
- 未选择任何可安装项时 SHALL NOT 启动安装。

### R3 — 已安装检测、标识与禁选

- 安装页 SHALL 复用当前全局实时检测结果标识已安装 Skill，不得为每个 item 单独执行检测命令。
- 同一 TUI 会话内 SHALL 复用 App 级已安装状态缓存；进入安装页本身 SHALL NOT 再触发检测命令。首次 App 检测、用户按 `r` 主动刷新，以及安装完成后的最终对账是允许的刷新入口。
- 已安装 item SHALL 保留在扁平列表中并可被光标遍历，同时显示明确的“已安装”标识。
- 已安装 item SHALL NOT 被 Space、全选或提交动作加入选择集合。
- 已存在的同名不同来源 Skill SHALL 显示为同名占用/冲突并禁选，避免覆盖全局 Skill 身份。
- 同一批搜索结果中，若用户已选择某个 Skill 名，则其它来源下的同名结果 SHALL 立即变为选择冲突且不可同时选中；上游全局 Skill 身份不允许同名来源共存。
- 安装状态未完成检测或检测失败时，系统 SHALL NOT 在无法确认资格的情况下允许批量提交。
- 安装页列表的 active 状态 SHALL 通过 Checkbox 方括号与标题的主题色表达，不得给整行卡片增加 active 背景；非 active 标题 SHALL 始终使用正常文字色，包括不可选或冲突项。
- 每个搜索结果 SHALL 在标题右侧展示可用的安装状态与下载量；接入 Checkbox leading 后不得丢失 `titleRight` 内容。
- lock 中的 GitHub `sourceUrl`（如 `https://github.com/owner/repo.git`）与搜索结果 `owner/repo` SHALL 视为同一来源并显示“已安装”；只有同名且规范化后确属不同仓库时才显示“同名已占用”。

### R4 — 批量安装与上游 source 限制

- 面向用户的动作 SHALL 表现为一次批量安装，不暴露 owner/repo 分组页面。
- 同一 source 下被选中的多个 Skill SHALL 合并为一次上游安装调用，并重复传入 `--skill`。
- 不同 source SHALL 由内部执行计划拆成多个上游调用；该拆分只属于 service/core 执行细节，不得改变扁平 UI。
- 多个 source 的调用 SHALL 顺序执行，避免同时写全局 Skill 目录和 lock。
- 任一 source 调用失败后，执行计划 SHALL 继续尝试后续 source，不得因一个来源失败而提前终止整个批量动作。
- 批量执行开始后 SHALL 锁定交互并完成全部 source 调用或等待既有命令超时；本任务 SHALL NOT 新增用户中途取消或外部进程主动终止协议。
- 一次批量选择 SHALL 统一使用同一套安装目标，并只打开一次当前目标 Modal：Codex 只读恒选，Claude Code 可选；不得逐 Skill 保存不同目标，也不得重新依赖隐藏的全局 Agent Header。

### R5 — 所有安装结果均停留在安装页

- 新安装进入 busy 状态时，底页 SHALL 保持为安装页。
- 全部成功、全部失败、部分成功/失败、全部已安装/no-change 或安装后状态复检失败时，最终 SHALL 均返回并停留在安装页。
- 返回安装页时 SHALL 保留搜索词、扁平搜索结果、光标位置和可恢复的滚动位置。
- 新安装路径 SHALL NOT 复用会重置到已安装列表页的通用成功迁移。

### R6 — 结果核对与可重试状态

- 批次完成后 SHALL 刷新全局已安装状态，并以实际最终状态核对选中 Skill，而非只依赖进程退出码推断逐项结果。
- 已确认成功的 item SHALL 变为已安装、禁选并从选择集合移除。
- 仍未安装的失败 item SHALL 保持选中，允许用户直接重试。
- 若最终状态无法确认，相关 item SHALL 保持可恢复的选择状态，并展示检测错误，不得伪报成功。
- 页面 SHALL 给出成功、失败、跳过/no-change 的汇总；技术错误继续遵循现有友好消息与详情展开约束。

### R7 — 既有行为边界

- 已安装列表页的更新、卸载、Claude Code 安装管理和共享本体/双侧投影语义 SHALL 保持不变。
- 所有物理安装、symlink/copy 和删除 SHALL 继续委托官方 `npx skills` CLI；ccq 不直接写或删 Skill 文件。
- 快捷键展示 SHALL 继续由项目统一 keybinding/shortcut 数据源驱动，不在视图中新增用户可见的硬编码键位提示。

## Acceptance Criteria

- [ ] AC1：搜索结果在安装页保持单一扁平列表，不出现 owner/repo 分组、父级或子页面。
- [ ] AC2：用户可同时选择来自至少两个不同 source 的未安装 Skill，选择身份互不覆盖。
- [ ] AC2a：已有选择后提交新搜索会清空旧选择，不存在当前结果之外的隐藏安装目标。
- [ ] AC2b：无显式多选时 Enter 仍可把当前可安装项作为单项批次；存在多选时 Enter 只提交选中集合。
- [ ] AC3：同一 source 的多个选择只产生一次安装调用，并生成多个独立 `--skill` 参数。
- [ ] AC4：不同 source 生成顺序执行的多个调用；任一调用失败后仍继续后续调用，且 UI 始终表现为一次批量动作。
- [ ] AC4a：busy 期间不提供取消动作，既有命令超时保护仍生效，且无新增进程终止路径。
- [ ] AC5：已安装和同名冲突 item 有可见标识、仍可遍历，但 Space、全选和提交均无法选择它们。
- [ ] AC5a：同一次搜索中不同来源的同名 Skill 不能同时进入选择集合，且冲突状态不会依赖执行顺序。
- [ ] AC5b：active 行的 Checkbox 方括号与标题变为主题色且无整卡背景；非 active 标题（含不可选项）均使用正常文字色。
- [ ] AC5c：带 Checkbox 的搜索结果仍展示右侧安装状态与下载量，长标题只能挤压标题区，不能挤掉状态区。
- [ ] AC5d：同一 GitHub 仓库的 URL/SSH/`owner/repo` source 形态均显示“已安装”，真正不同仓库的同名 Skill 才显示“同名已占用”。
- [ ] AC6：安装资格检测未就绪或失败时不能启动批量安装，并提供可恢复的刷新路径。
- [ ] AC6a：已有成功缓存时反复进入安装页不新增 `skills list` 请求；首次检测、`r` 手动刷新和安装后对账仍可更新缓存。
- [ ] AC7：全部成功后仍停留安装页；成功项更新为已安装、禁选且取消选择，查询/结果/光标保留。
- [ ] AC8：部分成功后仍停留安装页；成功项取消选择并禁选，失败项保持选中可重试。
- [ ] AC9：全部失败或安装后检测失败时仍停留安装页，并保留相关选择、查询、结果和光标。
- [ ] AC10：Codex 只读恒选、Claude Code 可选的安装目标 Modal 与现有共享本体语义不回归。
- [ ] AC10a：整批只打开一次目标 Modal，所有选中 Skill 使用同一目标集合。
- [ ] AC11：更新、卸载和已安装项管理仍使用各自既有返回页与行为，不受新安装完成迁移影响。
- [ ] AC12：测试覆盖零选择、全选排除禁选项、跨 source、同 source 合并、顺序执行、各类结果留页、选择对账和检测失败。

## Out of Scope

- 恢复历史 repo 分组/两级安装导航。
- 新增独立安装篮、批次详情页或新的顶级菜单。
- 改造上游 Skills CLI 以支持单次多 source。
- 改变 Skills 更新、卸载或已安装项管理的业务语义。
- 并发执行不同 source 的安装命令。
- 批量安装执行中的用户取消、终止当前子进程或跳过剩余 source。
- 为不同 Skill 配置不同 Claude Code/Codex 安装目标。
