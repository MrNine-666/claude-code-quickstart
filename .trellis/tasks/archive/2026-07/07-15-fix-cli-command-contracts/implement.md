# Implementation Plan — CLI 命令契约与工具更新一致性

## Preconditions

- 父任务策略已确认，当前任务保持 planning，用户批准后再 task.py start。
- 修改前加载 trellis-before-dev 与相关 frontend/backend spec。
- 记录并保护 tui/src/cli/help.ts、index.ts 的现有供应商术语 diff。

## Ordered Checklist

### 1. 红灯：参数和 help

- [ ] 在 verify-cli-subcommands 增加双横线前后同时有参数的 cc/cx fixture。
- [ ] 增加第二个双横线作为底层字面参数的 fixture。
- [ ] 增加 help unknown、help、help cc 的 intent 与 runCli 退出码断言。
- [ ] 确认新断言在修复前失败。

### 2. 修复 parser/help

- [ ] 修改 parsePassthrough，仅移除第一个双横线并拼接两侧 token。
- [ ] 修改 help 解析，保留任意 verb。
- [ ] 保持已知命令缺参数与全局 help/version 行为。
- [ ] 运行 CLI 定向门禁与 typecheck。

### 3. 红灯：工具 registry

- [ ] 增加 8 个 canonical id 全量解析测试。
- [ ] 增加 Trellis、现有短别名与连字符别名测试。
- [ ] 断言 help/错误工具集合等于 registry 集合。

### 4. 收敛工具事实源

- [ ] 给 ToolDefinition 增加 cliAliases 或等价单一派生字段。
- [ ] 把 TOOL_ALIASES 迁入各 definition，删除完整静态 Record。
- [ ] resolveToolId 与 printAvailableTools 遍历 TOOL_DEFINITIONS。
- [ ] HELP_TOOLS 从相同集合派生或由 verify 锁定无漂移。

### 5. 显式更新强制刷新

- [ ] 添加可注入 seam，断言 runToolsUpdate 以 forceRefresh=true 调用 detectComponents。
- [ ] 保持 selectUpdateTargets/updateComponents 不变。
- [ ] 断言检测失败返回 1，零目标返回 0。

### 6. 文档与全量回归

- [ ] 同步 tui/AGENTS.md 的 CLI 动词与工具 registry 约束。
- [ ] 更新 package verify 聚合（如新增脚本）。
- [ ] 运行全量验证并对照 CC1-CC7。

## Validation

    cd tui
    bun scripts/verify-cli-subcommands.mjs
    bun run typecheck
    bun run verify
    git -c core.whitespace=cr-at-eol diff --check

## Risky Files

| File | Risk | Mitigation |
|---|---|---|
| src/cli/argv.ts | 底层 argv 顺序变化 | 精确数组 fixture |
| src/cli/help.ts | 与当前供应商术语 diff 冲突 | 小范围 patch，保留现有文案 |
| src/cli/commands/tools.ts | alias 或工具列表回退 | registry 全集矩阵 |
| src/core/tools-install.ts | ToolDefinition 类型影响全调用方 | 可选 readonly 字段 + typecheck |

## Completion Gate

CC1-CC7 全部满足后只标记本子任务 implementation/checklist 完成；父任务集成与生命周期子任务未完成前不得归档父任务，也不授权提交。

## Execution Result - 2026-07-17

- CC1-CC6 已由 `verify-cli-subcommands.mjs` 的解析、help、registry 和 force-refresh 运行时断言覆盖。
- `bun scripts/verify-cli-subcommands.mjs`、`bun run typecheck`、`bun run verify` 与 `git -c core.whitespace=cr-at-eol diff --check` 全部通过。
- 用户已明确授权完成并归档只剩验收的任务；本子任务可进入 Phase 3.4 和归档。
