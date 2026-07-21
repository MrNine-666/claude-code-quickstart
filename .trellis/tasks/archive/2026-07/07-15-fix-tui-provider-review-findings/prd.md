# 修复 TUI 供应商模块审查问题

## Goal

修复 TUI 供应商模块在 Claude Code / Codex 配置完整性、冲突处理、凭据安全、部分成功反馈与损坏文件容错方面的 7 项已复现问题，使供应商 CRUD、设为默认和列表加载在异常输入下保持可恢复、无静默数据丢失且不泄露凭据。

## Background

2026-07-15 对当前 `main` 的供应商模块进行了只读 review。现有 `bun run typecheck` 及 Provider/Codex 相关 verify 门禁全部通过，但使用临时 `CCQ_HOME` 的隔离探针复现了门禁未覆盖的异常路径。实现时不得读取或写入真实 `~/.claude` / `~/.codex`。

## Change Classification

- **纯 bug，可按既有业务契约直接修复**：R1 配置损坏保护、R2 活跃 env 清理、R4 敏感文件权限、R5 Codex 已声明 TOML 契约落地、R6 部分成功反馈、R7 损坏 profile 容错、R8 回归门禁。
- **已确认的用户可见业务策略**：R3 新增时目标文件名已存在即拒绝保存；编辑时正常覆盖当前被编辑的 profile。新增不自动递增、不提供覆盖确认。
- R1/R6/R7 会改变异常路径的错误信息、warning 或 CLI stderr，但不改变合法配置下的正常业务结果；CLI stdout 与正常列表语义保持不变。
- **已确认的术语策略**：Claude Code / Codex 两侧用户可见实体统一称为“供应商”；Codex 官方技术协议中的 `profile`（类型、文件机制、`--profile` 参数）保持不变。

## Requirements

### R1 — 配置损坏时拒绝覆盖

- `tui/src/core/provider.ts:110-115` 的供应商写路径必须区分 JSON 文件“不存在”和“存在但无法解析”。
- 当 `~/.claude/settings.json` 损坏时，切换供应商、编辑活跃供应商同步和保存后激活必须中止对应写入，保留原文件字节不变，并返回不包含配置内容或 token 的可操作错误。
- `tui/src/core/provider.ts:122-131` 更新 `~/.claude.json.hasCompletedOnboarding` 时，损坏文件必须保持原样；供应商 profile 可保存，但 onboarding 标记应安全跳过并向上返回脱敏警告。
- 文件确实不存在时，继续按当前行为创建最小合法对象。

### R2 — 活跃供应商编辑必须清除旧 env

- `tui/src/core/provider.ts:754-783` 在修改活跃 profile 前必须捕获旧 profile 所拥有的 env 键。
- 同步 `settings.json` 时，清理集合必须包含旧 profile 键、当前全部 provider 键和受管模型键，然后写入新 profile 值。
- 不得删除未被任何 provider 拥有的用户/ClaudeConfig env，也不得改动 `model`、`language`、`permissions`、`hooks`、`statusLine`、`outputStyle` 等非供应商字段。

### R3 — 添加操作不得静默覆盖同名 profile

- Claude JSON 与 Codex TOML 的 TUI 新增路径无论内置或自定义，只要目标 profile 文件名已存在就必须拒绝保存并提示用户修改文件名（Claude 根因位于 `tui/src/core/provider.ts:623-658`）。
- TUI 新增不得自动递增为 `name-2`，也不得提供无确认或确认后覆盖入口；用户需要多个同类供应商时应在新增表单中显式填写新的唯一文件名。
- 同名新增冲突必须使用 error toast 提示“已存在”，表单保持打开供用户修改文件名；不得只在表单错误区展示。
- TUI 编辑继续按当前被编辑的 key 更新原 profile，属于 edit 而不是 add，不触发“文件已存在”拒绝；现有 rename-to-existing 保护继续保留。
- Core 的显式 `increment` / `overwrite` 策略可为非 TUI 调用方保留，但 Claude `saveProviderForm` add 必须使用 `conflictStrategy: 'error'`，Codex `saveCodexProviderForm` add 必须在写盘前检查 `codexProfileExists`。

### R4 — 敏感配置文件使用安全权限

- 在 POSIX/macOS 上，供应商模块写入或替换的以下含敏感信息文件必须最终为 `0600`：Claude provider JSON、写入供应商 env 后的 `settings.json`、被 ccq 写入的 `.claude.json`、Codex `<key>.config.toml`、`config.toml` 和 `auth.json`。
- Windows 行为保持兼容，不依赖 POSIX mode 语义。
- 原子写入仍需保证临时文件清理与目标替换语义；不得将通用非敏感调用方无条件改成新的权限策略。

### R5 — Codex profile TOML 必须守住身份与认证契约

- `tui/src/core/codex.ts:455-460` 必须拆分“清理旧供应商键”和“从 profile 导入键”：清理包含 legacy `profile` / `profiles`，导入仅允许 `model`、`model_provider`、`model_providers`。
- raw TOML 保存前必须拒绝顶层 `profile` / `[profiles.*]`、当前 provider table 内的 `env_key` / `auth` / `requires_openai_auth`，以及不符合“key 唯一身份”的额外 provider table 或不一致 `model_provider`。
- 保留合法自定义 provider 参数和 `config.toml` 中 MCP、hooks、approval、sandbox 等非供应商内容。
- 校验和错误输出不得包含 `experimental_bearer_token` 或 `auth.json` 凭据。

### R6 — 保存成功但激活失败必须报告部分成功

- `tui/src/services/provider-service.ts:95-100` 不得忽略 `activated: false` / `activateError`。
- profile 已落盘而默认配置同步失败时，列表必须刷新并保留已保存 profile；UI 使用 warning 明确提示“保存成功、激活失败”，不得显示“已添加并激活”。
- 用户可在修复配置文件后通过列表 Enter 再次设为默认，不得因重试保存生成重复 profile。
- 同一结构化结果机制应覆盖 Claude 与 Codex 保存后激活的部分成功，避免两侧语义分裂。

### R7 — 损坏 Codex profile 不得拖垮列表

- `tui/src/core/codex.ts:406-412` 扫描 `<key>.config.toml` 时必须逐文件隔离解析失败。
- 有效 profile 和 official 虚拟条目仍可展示；损坏项以文件名和脱敏原因进入失败集合，不显示 token/TOML 原文。
- ProviderView 使用现有 `ErrorPanel` 展示可恢复提示，页面不得在 React 初始化阶段抛出。
- `ccq ls --tool codex` 复用同一安全扫描结果：输出有效条目，并把损坏文件警告写到 stderr，不因单个文件丢失全部列表。

### R8 — 回归门禁与工作区隔离

- 为 R1-R7 增加真实临时目录回归，不得仅使用源码正则断言。
- 测试统一使用 `CCQ_HOME` 隔离并清理临时目录；日志和断言消息不得输出真实或 fixture token。
- 保持既有 Provider/Codex verify、类型检查和 Bun 单文件编译门禁通过。
- 不修改本任务范围外的 `tui/src/views/ToolsView.tsx` 现有工作区改动。

### R9 — Codex 用户术语统一为供应商

- TUI 标题、表单帮助、空状态、toast、warning、ErrorPanel 与 CLI 帮助/输出中，Claude Code / Codex 两侧业务实体都直接称为“供应商”；不得显示“Codex profile/profiles”“Codex provider”或“Codex 供应商”。
- `CodexProfile*` 类型/函数、`<key>.config.toml`、`codex --profile <key>`、TOML 的 `profile/profiles` legacy selector 等技术标识保持原样，不做协议级重命名。

## Acceptance Criteria

- [ ] AC1：损坏 `settings.json` 下执行 switch/edit-sync/add-and-activate 均不会改变原文件，调用方收到脱敏错误或部分成功警告。（R1、R6）
- [ ] AC2：损坏 `.claude.json` 下新增 profile 不覆盖原文件，并报告 onboarding 标记被跳过。（R1、R6）
- [ ] AC3：活跃 profile 删除 extra env 或受管模型键后，`settings.env` 不再残留旧值，用户自有 env 保持不变。（R2）
- [ ] AC4：TUI 新增任意同名内置/自定义 profile 时通过 error toast 明确报冲突、表单保持打开且原文件不变；编辑该 profile 时仍可正常更新原文件且不会生成副本。（R3）
- [ ] AC5：支持 POSIX mode 的平台上，所有列出的敏感文件新建和替换后均为 `0600`；Windows 门禁不误报。（R4）
- [ ] AC6：含 legacy selector、禁用认证字段、额外 provider table 或身份不一致的 Codex raw TOML 被拒绝且不写盘；合法未知参数仍可保存。（R5）
- [ ] AC7：保存成功但激活失败时 UI 列表出现新 profile，并只显示部分成功 warning；再次 Enter 可独立完成激活。（R6）
- [ ] AC8：一个损坏 Codex profile 与一个有效 profile 并存时，TUI/CLI 仍列出有效项和 official，且展示脱敏损坏警告。（R7）
- [ ] AC9：`bun run typecheck`、全部 provider/codex 定向门禁、`bun run verify`、`bun run build` 与 `git diff --check` 通过。（R8）
- [ ] AC10：Codex TUI/CLI 用户文案直接使用“供应商”，不添加 `Codex` 前缀；技术性 `--profile` / `.config.toml` / 内部类型与函数名保持不变。（R9）

## Technical Constraints

- Claude profile 继续使用 settings-compatible 单层 `{env}`，不得恢复 `_meta` / `modelEnv` / `modelMapping` / `extraEnv`。
- Codex 路径继续固定为基于 `resolveHome()` 的 `~/.codex`，不得读取运行时 `CODEX_HOME`。
- Codex API key 继续只写 `experimental_bearer_token`，不得引入 vault 或运行时 env 注入。
- 视图不直接写用户配置；写盘与验证留在 core/service 层。
- 保持离线可用与 Bun `--compile` 兼容，不新增运行时依赖。

## Out of Scope

- 不重做供应商表单布局、快捷键或视觉样式。
- 不迁移已有合法 provider/profile 的业务字段，不自动修复损坏 JSON/TOML 内容。
- 不改变 Claude/Codex CLI 启动参数和底层 Agent 的认证协议。
- 不实施本计划；实现需用户后续明确授权并通过 `task.py start` 进入 Phase 2。
