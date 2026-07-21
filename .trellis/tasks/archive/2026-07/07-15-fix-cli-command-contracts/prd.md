# 修复 CLI 命令契约与工具更新一致性

## Goal

修复 ccq 启动类参数透传、help 错误语义、工具 registry/别名漂移和显式工具更新缓存问题，使 CLI 对用户输入、工具全集与退出码的解释稳定且可通过纯函数和命令级回归验证。

## Background

- tui/src/cli/argv.ts:118 的 parsePassthrough 当前在检测到双横线后直接返回其后缀，因此 ccq cc glm -p hi -- --verbose 会静默丢失 -p hi；cx 同样受影响。
- tui/src/cli/argv.ts:48-54 只为已知 VERBS 保留 help verb，未知动词退化成无 verb 的总帮助并返回 0，与 tui/src/cli/index.ts:35-39 已存在的未知 help 错误分支矛盾。
- tui/src/cli/commands/tools.ts:7-26 维护独立 TOOL_ALIASES，漏掉 TOOL_DEFINITIONS 已注册的 Trellis；同文件可用列表也只有 7 项。
- tui/src/cli/commands/tools.ts:39 调用 detectComponents() 默认允许命中 update.ts 的一小时 npm outdated/npm view 缓存，显式 tools update 可能误报没有更新。
- scripts/verify-cli-subcommands.mjs 只覆盖双横线位于透传参数首位的情况，没有覆盖分隔符前后同时存在 token、未知 help、8 工具 registry 或 force refresh。

## Confirmed Product Decisions

- 第一个双横线只充当 ccq 启动类命令的分隔符并被移除；它之前和之后的其他 token 全部按原顺序交给 claude/codex。
- 显式 ccq tools update 每次强制刷新远程版本状态；普通 TUI 启动检测继续允许使用既有缓存。
- CLI 工具名称必须由 registry 单一派生，Trellis 与其他 7 个组件平权。

## Requirements

### C1 — 启动类参数透传

- parseCc/parseCx 必须继续区分供应商名与底层参数，并保留 plain cx 的现有语义。
- parsePassthrough 只能移除第一个双横线分隔符，不得丢弃此前或此后的参数；后续作为底层字面参数出现的双横线必须保留。
- cc/cx runner 的 stdio inherit、ENOENT=127 与底层退出码透传保持不变。

### C2 — Help 与错误语义

- help 后存在任意 verb 时必须保留该 verb；helpFor 未找到时由 runCli 输出未知子命令、总帮助并返回 1。
- help 无 verb、全局 -h/--help 继续返回总帮助和退出码 0。
- 已知管理类命令的缺参数或非法 flag 继续输出定向用法，不得落入 TUI/non-TTY 守卫。

### C3 — 工具 registry 单一事实源

- ToolDefinition 增加可选 CLI aliases，或提供等价的 registry 派生层；canonical id 必须自动可解析且大小写不敏感。
- resolveToolId、printAvailableTools 与 HELP_TOOLS 的工具集合不得分别维护静态列表。
- 8 个组件 ClaudeCode、Ccline、CcgWorkflow、OpenSpec、Trellis、CodeGraph、CodexCli、AntigravityCli 必须全部可发现。
- 保留现有短别名与连字符别名兼容，不移除已公开输入。

### C4 — 显式更新实时刷新

- runToolsUpdate 必须调用 detectComponents 的 forceRefresh=true 路径，同时复用现有 updateComponents。
- 未指定 name 时仍只更新检测到 hasUpdate=true 的工具；指定 name 时保持当前是否有更新的判定语义。
- 网络/检测失败继续返回非零；不得因强制刷新回退到过期缓存并报告成功。

### C5 — 测试与文档

- verify-cli-subcommands 增加解析矩阵、help 退出码与工具全集断言。
- 工具解析应暴露可注入或纯函数边界，测试不得真实安装或更新工具。
- 同步 tui/src/cli/help.ts 与 tui/AGENTS.md 的动词/工具约束。
- 所有测试使用临时 CCQ_HOME，不触碰真实 Agent 配置。

## Acceptance Criteria

- [ ] CC1：cc glm -p hi -- --verbose 透传为 -p、hi、--verbose；cx dev -m gpt-5 -- --help 透传为 -m、gpt-5、--help。（C1）
- [ ] CC2：plain cx、显式供应商 cx、cc 缺 name、ENOENT=127 与底层非零退出码行为不回退。（C1）
- [ ] CC3：help nope 返回 1 并包含未知子命令与总帮助；help、help cc、-h 返回 0。（C2）
- [ ] CC4：8 个 registry 组件 canonical id 都可解析，Trellis 常用别名可解析，帮助和错误列表没有静态漏项。（C3）
- [ ] CC5：现有 Claude/Codex/CodeGraph 等公开别名继续通过。（C3）
- [ ] CC6：每次 ccq tools update 都以 forceRefresh=true 检测；普通 detectComponents 默认缓存行为保持不变。（C4）
- [ ] CC7：定向 CLI verify、bun run typecheck、bun run verify 与 git diff --check 通过。（C5）

## Technical Constraints

- CLI 层只做解析、调用、输出和退出码；不得复制 tools-manage 的更新业务逻辑。
- 管理类命令不引入双横线透传语义。
- 不新增运行时依赖，不改变 Bun 单文件编译入口。
- 实施时保护当前工作区 tui/src/cli/help.ts 与 tui/src/cli/index.ts 的供应商术语修改。

## Out of Scope

- 新增 mcp、skills、add 或历史版本管理命令。
- 改变工具更新的安装方式、快照范围或 Antigravity 手工更新策略。
- 改动 TUI 工具卡片布局或检测缓存总体架构。
- 本子任务不处理自更新二进制与 Windows 自卸载。
