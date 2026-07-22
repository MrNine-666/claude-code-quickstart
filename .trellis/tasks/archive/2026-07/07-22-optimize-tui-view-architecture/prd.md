# 优化 TUI View 架构与页面分层

## Goal

让 TUI 各业务模块采用一致的 domain view 拓扑：根 view 只负责屏幕状态、子页面选择和 App 回调；主页/列表页、表单/编辑页分别承担自己的渲染和输入；业务 mutation 通过 domain action/service 适配层执行。以现有 MCP 目录作为组织风格参考，同时消除已确认的重复页面结构和 view 内业务编排，保持现有用户行为与 CLI/core 契约不变。

## Confirmed Facts

- MCP 已有目录化页面：`tui/src/views/mcp/McpView.tsx`（429 行）和 `McpFormView.tsx`（278 行），但开关、删除 mutation 仍由主页直接调用 service（`McpView.tsx:90-104, 227-235`），保存 mutation 仍由表单直接调用 service（`McpFormView.tsx:200-209`）。
- Provider 目前以平铺文件存在：`provider-view.tsx`（453 行）在 screen 分支中组装 Claude/Codex 表单并直接处理删除（`provider-view.tsx:135-198, 323-336`）；通用 `provider-form.tsx`（430 行）同时包含字段、文本编辑、校验和提交编排。
- `ConfigView.tsx` 与 `PromptsView.tsx` 分别重复定义 `Mode/Panel/Focus`、键盘路由、只读预览、推荐面板和 `TextareaEditor` 组合（`ConfigView.tsx:34-36, 188-313`；`PromptsView.tsx:30-32, 186-303`）。
- `SkillsView.tsx`（1440 行）和 `ToolsView.tsx`（1334 行）把 reducer 接线、键盘分发、异步 mutation、Modal 和列表/grid 渲染集中在单文件（Skills：`209-1300`；Tools：`290-1103`），虽然已有独立 state/service 文件可复用。
- `app.tsx:60-69, 911-963` 仍直接导入平铺的 Provider/Config/Prompts/Skills/Tools view；MCP 是唯一已经使用 domain 子目录的模块。
- 前端规范要求：业务操作留在 core/services，view 只做 domain screen/key routing；共享视觉/input 使用 `components/`；列表状态使用 `ListState`；物理按键和 footer 来自统一 registry。

## Requirements

### R1. 统一 domain view 拓扑

覆盖全部六个菜单模块（Tools、Provider、Config、Global Rules、MCP、Skills），建立与 MCP 一致的 domain 目录和入口命名。每个模块至少有根 view 与主页/列表页；存在新增或编辑流程的模块必须有独立表单/编辑页。根 view 不再内联完整主页或表单 JSX。

### R2. 分离业务编排

将异步命令、持久化 mutation、结果归并和可测试的动作流程从页面渲染文件移到 domain action/service adapter 或现有 service/core；子页面通过 typed props/callback 接收事实和意图。`services/codex-service.ts` 不得再依赖 `views/*.tsx` 类型，Provider 表单 adapter 类型必须位于独立类型/领域模块。不得改变现有 storage topology、CLI argv、Agent 投影或 mutation reconciliation 语义。

### R3. 消除重复实现

优先复用现有 `FormPanel`、`TextareaEditor`、`ListState`、`Modal`、列表/grid helpers 和键盘工具。对 Config/Prompts 的同构预览/编辑 shell、Provider/MCP 的表单导航与文本编辑共性，只提取能保持类型和焦点契约的共享模块，不制造仅为减少行数的过度泛型。

### R4. 兼容 App 与验证入口

更新 `app.tsx` 导入和必要的 barrel/re-export，使运行时入口及现有测试不因文件迁移失效。保留 view props、footer submode、active/focus、Modal 背景失活和 onExit 回调契约，除非设计文档明确记录兼容迁移。

### R5. 可验证的架构边界

为新的目录拓扑和职责边界补充或更新静态 gate/单元测试：能证明 root view 只编排子页面、主页/表单可独立渲染、重复共性使用共享模块、业务 action 的成功/失败/取消仍完成最终事实刷新。

## Acceptance Criteria

- [ ] 目标模块的 view 文件按 domain 目录组织，根 view、主页/列表页、表单/编辑页的职责和导出关系在 design 中逐项列出，并能被 TypeScript 编译。
- [ ] 根 view 不再包含目标主页/表单的大段 JSX；页面输入和业务 mutation 有明确的 domain 子模块边界。
- [ ] Config/Prompts 的重复 preview/edit/recommendation shell 被共享实现或受控 adapter 复用，行为与现有 mode、focus、dirty、save/cancel 语义一致。
- [ ] Provider/MCP/Tools/Skills 的现有列表、表单、Modal、Agent 双侧投影和错误/加载/取消行为不回归；没有新增 view-local footer、loading 或表单控件实现。
- [ ] `cd tui; bun run check`、相关 `verify-*-view.mjs`/domain gates、`git diff --check` 全部通过；新增架构 gate 若无法静态证明，必须在 design 中说明替代验证。
- [ ] 规划文档记录迁移顺序、风险文件、回滚点和 out-of-scope；未改变 CLI/core 协议和用户可见功能范围。

## Out Of Scope

- 不做视觉重设计、菜单顺序调整或新的业务功能。
- 不重写 MCP/Provider/Skills/Tools core/service 的 CLI、文件存储或 Agent 拓扑契约。
- 不删除现有兼容导出，除非所有调用方和验证脚本在同一变更中迁移完成。

## Scope Decision

本次覆盖全部六个模块。实现按 Provider/MCP、Config/Global Rules、Tools/Skills 三个阶段推进，但在同一个任务中完成入口迁移、共享模块和验证 gate 的整合，避免仓库长期同时维护两套 view 拓扑。
