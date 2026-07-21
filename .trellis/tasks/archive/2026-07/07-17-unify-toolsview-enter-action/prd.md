# 统一 ToolsView Enter 主操作

## Goal

将 ToolsView 网格中的安装、单项更新和管理开关入口统一到 `Enter`，让当前卡片依据实时状态执行唯一合理的主操作，减少用户记忆 `i` / `u` / `m` 三套键位的负担。

## Background

- 当前 `ToolsView.tsx` 将网格主操作拆成 `i` 安装、`m` 管理开关、`u` 单项更新；`keybindings.ts` 与 `shortcuts.ts` 同步展示这三套入口。
- `tui/AGENTS.md` 仍定义：非管理型工具由 `Enter` 按安装态执行安装、更新或“已是最新”提示；CodeGraph / CcgWorkflow 等管理型工具由 `Enter` 打开双 Agent 管理 Modal。
- ToolsView 已有可复用的 `installCurrent()`、`updateCurrent()`、`manageInjectCurrent()` 和 Modal 状态机，本次不改变底层生命周期服务或双侧投影模型。

## Requirements

- `Enter` 成为 ToolsView 网格中安装、单项更新和管理 Modal 的统一主操作键。
- 非管理型工具未安装时，`Enter` 执行当前项安装。
- 非管理型工具已安装且 `hasUpdate === true` 时，`Enter` 执行当前项更新。
- 非管理型工具已安装且无更新时，`Enter` 不执行破坏性操作，只提示已是最新。
- 具备管理 Modal 的 CodeGraph / CcgWorkflow 始终由 `Enter` 进入现有管理开关流程，即使当前存在更新；Modal 内的 `Enter` 仍只负责应用草稿。
- CodeGraph / CcgWorkflow 保留 `u` 作为单项更新入口，避免管理入口被更新状态或更新失败阻塞；非管理型工具不再暴露或响应 `u` 单项更新。
- footer 与实际绑定必须来自 `keybindings.ts` / `shortcuts.ts` 同一事实源，不保留 `i` / `m` 的旧入口，也不在非管理型工具上重复展示 `u` 更新。
- 保留 `a` 更新全部、`d` 卸载、`o` 打开文档、`r` 重新检测，以及方向键导航和退出键行为。
- 不改变 install / update / inject / eject / uninstall 的 service 契约、执行语义和共享状态投影。

## Acceptance Criteria

- [x] ToolsView 网格按 `Enter` 后，非管理型未安装卡片启动安装。
- [x] ToolsView 网格按 `Enter` 后，非管理型可更新卡片启动单项更新。
- [x] ToolsView 网格按 `Enter` 后，非管理型已是最新卡片仅显示提示，不进入 busy 或卸载流程。
- [x] ToolsView 网格按 `Enter` 后，管理型卡片进入现有管理 Modal；Modal 的草稿初始化、切换、应用和取消行为保持不变。
- [x] 管理型卡片即使有更新，`Enter` 仍优先打开管理 Modal，`u` 可单独启动该卡片更新。
- [x] 非管理型 Tools footer 只展示一个 `Enter` 安装/更新主操作，不再展示 `i` / `m` / `u`；管理型 footer 展示 `Enter` 管理开关和 `u` 更新。
- [x] 快捷键门禁覆盖统一绑定与网格分派，Tools 相关定向验证和 TypeScript 类型检查通过。

## Out Of Scope

- 不合并更新全部、卸载、打开文档或重新检测快捷键。
- 不改变管理 Modal 的布局、文案或双 Agent 开关语义。
- 不改变工具检测、版本判断或安装/更新命令解析。

## Verification

- `bun run typecheck`
- `bun run verify`
- Red/green regression coverage in `verify-shortcuts.mjs` and `verify-tools-shared-projection.mjs`
