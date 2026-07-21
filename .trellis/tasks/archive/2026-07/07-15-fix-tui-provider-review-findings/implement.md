# Implementation Plan — TUI 供应商模块审查修复

## Preconditions

- 用户已批准实施，任务已通过 `task.py start` 进入 `in_progress`。
- 同名冲突业务语义已确认：TUI 新增拒绝同名，编辑正常覆盖当前 profile；纯 bug 项无需逐项业务审批。
- 开始实施前加载 `trellis-before-dev`，完整读取 `.context/prefs/` 与相关 `.trellis/spec/` 指南。
- 记录并保护现有无关工作区修改：`tui/src/views/ToolsView.tsx` 不属于本任务。
- 所有运行时探针必须设置临时 `CCQ_HOME`，禁止触碰真实 home。

## Ordered Checklist

### 1. 先补失败回归

- [ ] 在 provider verify 中加入损坏 `settings.json` / `.claude.json` 保持字节不变的回归。
- [ ] 加入活跃 profile 删除 extra env 与受管模型键后 settings 无残留的回归。
- [ ] 加入同名 custom/builtin add 均拒绝且原文件不变、edit 仍正常更新当前 profile 的回归。
- [ ] 加入 add 保存成功但 activate 失败的结构化 partial-success 回归。
- [ ] 在 Codex verify 中加入 legacy selector、禁用 auth 字段、额外 provider table 和身份不一致 raw TOML 的拒绝回归。
- [ ] 加入 valid + corrupt Codex profile 混合扫描回归，并断言错误不含 fixture token。
- [ ] 加入敏感文件 mode 回归：非 Windows 断言 `0600`，Windows 仅验证写盘与无异常。

### 2. 实现严格 JSON 读取

- [ ] 在 `tui/src/core/fs-utils.ts` 新增 tagged-result 严格 JSON 读取；保留现有 `readJsonFile` 行为。
- [ ] `provider.ts` 的 settings 变更路径改用严格读取，missing 创建、invalid 拒绝。
- [ ] onboarding 更新改用严格读取；invalid 保留原文并产出 warning。
- [ ] 验证所有异常消息均使用逻辑路径且不拼接文件内容。

### 3. 修复 Claude provider 所有权与冲突

- [ ] 在 `editProviderUnlocked` 修改前捕获旧 env 键。
- [ ] 给内部 switch/apply 路径增加额外清理键，并显式加入契约受管模型键。
- [ ] 保持非 provider env 与所有非供应商顶层字段不变。
- [ ] Claude `saveProviderForm` add 固定传 `conflictStrategy:'error'`；Codex add 写盘前检查 `codexProfileExists`，两侧同名 builtin/custom 均拒绝。
- [ ] 保持 edit 分支正常更新当前 key；Core 显式 increment/overwrite 仅供非 TUI 调用方继续使用。
- [ ] 确认冲突失败发生在任何文件写入/onboarding/settings 变更之前。

### 4. 实现敏感文件安全原子写入

- [ ] 给 `fs-utils.atomicWrite` / `writeJsonAtomic` 增加可选 mode，并导出统一 `SECRET_FILE_MODE`。
- [ ] 给 `toml-edit.atomicWrite` 增加 mode 透传。
- [ ] Claude provider/settings/.claude.json 写入点显式使用 `0600`。
- [ ] Codex profile/config/auth 写入点显式使用 `0600`。
- [ ] 验证异常路径清理临时文件，且不改变非敏感调用点默认行为。

### 5. 落地 partial-success UI 契约

- [ ] 给 `ProviderServiceResult` 成功分支增加可选 warning。
- [ ] Claude add/onboarding/activate 与 Codex save/set-default 将落盘后失败转换为 partial warning。
- [ ] `ProviderForm` 将 warning 传给保存回调。
- [ ] `ProviderView` 保存后先 refresh，再按 warning/success 显示准确 toast。
- [ ] 确认失败后从列表 Enter 重试激活，不会再次 add 或生成递增副本。

### 6. 收紧 Codex TOML 边界

- [ ] 拆分 provider clear keys 与 import keys，legacy selector 只清理不导入。
- [ ] 增加单一 Codex profile document 验证器并由 `saveCodexProfileToml` 调用。
- [ ] 拒绝 legacy selector、禁用 auth 字段、多 provider table、key/name/model_provider 不一致。
- [ ] 保留合法扩展字段及现有 config.toml 非供应商内容。
- [ ] 所有解析/保存错误统一脱敏。

### 7. Codex 列表逐文件容错

- [ ] 新增 `scanCodexProfiles` 结构化 profiles/failures 返回值。
- [ ] 保留 `listCodexProfiles` 兼容包装，避免无关调用点破坏。
- [ ] `codex-service` 将 failures 投影到 display data。
- [ ] ProviderView 使用现有 ErrorPanel 显示损坏文件提示。
- [ ] `ccq ls --tool codex` 输出有效项，并把脱敏失败摘要写 stderr。

### 8. 全量验证与交付检查

- [ ] 运行 `bun run typecheck`。
- [ ] 运行 `bun scripts/verify-provider-form.mjs`。
- [ ] 运行 `bun scripts/verify-provider-migration.mjs`。
- [ ] 运行 `bun scripts/verify-provider-switch.mjs`。
- [ ] 运行 `bun scripts/verify-provider-tui.mjs`。
- [ ] 运行 `bun scripts/verify-codex-core.mjs`。
- [ ] 运行 `bun scripts/verify-codex-profile.mjs`。
- [ ] 运行 `bun scripts/verify-codex-provider-form.mjs`。
- [ ] 运行 `bun scripts/verify-cli-subcommands.mjs`。
- [ ] 运行 `bun run verify`。
- [ ] 运行 `bun run build`，验证 Bun 单文件编译未受可选 mode/新类型影响。
- [ ] 运行 `git diff --check`，确认没有空白错误、凭据、临时目录或测试产物。
- [ ] 对照 PRD AC1-AC9 做一次人工逐项验收，并确认 `ToolsView.tsx` 无关改动未被覆盖。

## Risky Files and Rollback Points

| Area | Files | Main Risk | Rollback Point |
|---|---|---|---|
| JSON mutation safety | `core/fs-utils.ts`, `core/provider.ts` | 误把 missing 当 invalid 或阻断正常首次创建 | 完成步骤 2 后单独跑 Claude 定向门禁 |
| Provider ownership/conflict | `core/provider.ts`, `services/provider-service.ts` | 清理过宽或改变内置递增语义 | 完成步骤 3 后比较 settings 字段所有权 fixture |
| File permissions | `core/fs-utils.ts`, `core/toml-edit.ts`, provider/codex call sites | mode 透传影响 Windows 或非敏感调用方 | 保持默认参数兼容；步骤 4 可独立回滚调用点 |
| Partial success | `services/*provider*`, `views/provider-form.tsx`, `views/provider-view.tsx` | generic adapter 类型漂移或重复 toast | 完成步骤 5 后 typecheck + TUI 门禁 |
| Codex schema/scan | `core/codex.ts`, `services/codex-service.ts`, CLI `ls` | 拒绝合法扩展或改变 CLI 输出 | 验证合法扩展 fixture；保留 list 兼容包装 |

## Execution Progress (2026-07-15)

- [x] 步骤 1-7 已完成；回归覆盖严格 JSON、env 所有权、精确同名冲突、partial success、Codex TOML/扫描/脱敏与敏感文件 mode。
- [x] `bun scripts/verify-provider-safety.mjs`、`bun run typecheck`、全部定向门禁与 `bun run verify` 通过。
- [x] `bun run build:windows-x64` 单文件编译通过。
- [ ] 四平台构建环境门禁：Windows ARM64 / macOS x64 / macOS ARM64 因 Bun 1.3.14 目标运行时下载包不完整、无法解压而失败；沙箱外重试因自动审批服务不可用被拒绝。
- [x] `git -c core.whitespace=cr-at-eol diff --check` 通过；CRLF 文件按仓库既有行尾保留。
- [x] 人工逐项验收完成；用户既有 `tui/src/views/ToolsView.tsx` 修改未编辑、未还原。
- [x] Phase 3.3 已新增 `.trellis/spec/backend/provider-config-safety.md` 固化跨层契约。
- [x] 后续确认：同名新增冲突增加结构化 `errorKind:'conflict'`，由 `ProviderForm` 使用 error toast 展示且不关闭表单。
- [x] 后续确认：Codex 端 TUI/CLI 用户可见实体直接称为“供应商”，不添加 `Codex` 前缀；保留内部类型、文件与 `--profile` 技术契约。
- [ ] Phase 3.4 未提交、未暂存：本计划明确不授权提交。

环境备注：CodeGraph 两次返回 `database disk image is malformed`，已按仓库规则降级为源码搜索，索引需另行重建。

2026-07-17 收尾复验：供应商定向门禁、`bun run typecheck`、`bun run verify` 和 `git diff --check` 再次通过；无图标 Windows x64 单文件编译成功。`bun run build` 仍因 Bun 1.3.14 的 Windows metadata `FailedToCommit` 与三个交叉目标 runtime 包无法解压而失败，本任务继续保持 `in_progress`。

## Completion Gate

只有在 AC1-AC9 全部满足、全量 verify/build 通过、用户确认实现结果后，才进入 Trellis Phase 3 的 spec 更新与提交步骤。本计划不授权提交、暂存或覆盖无关工作区修改。
