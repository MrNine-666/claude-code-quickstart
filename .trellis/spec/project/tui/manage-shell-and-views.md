# Manage Shell and View Contract

## 1. Scope / Trigger

适用于 App Shell 导航、Agent 上下文、菜单/View 组合、Config 与 Global Rules 复用、列表/详情/表单模式、主题及内嵌编辑器。

## 2. Signatures and Stable Shape

```ts
type AgentContext = 'cc' | 'cx';
type ManageModuleId = 'tools' | 'provider' | 'config' | 'prompts' | 'mcp' | 'skills';
type Focus = 'nav' | 'header' | 'view' | 'form' | 'modal';
```

左侧导航顺序固定为：

```text
工具管理 -> 供应商 -> 配置文件 -> 全局规则 -> MCP -> Skills
```

## 3. Contracts

 - 默认上下文是 Claude Code。可见上下文标签必须使用完整的 `Claude Code` / `Codex`，不得显示 `cc` / `cx`。
 - Provider、Config 与 Global Rules 显示 Agent Header，并复用同一 UI；core/service 负责切换存储协议。
 - Tools、MCP 与 Skills 是共享双侧 View，隐藏 Header 且不占位；它们保留当前上下文供后续模块使用。
 - 动态 footer 由 App 持有。View 报告当前子模式；物理按键和显示标签均从 keybinding/shortcut registry 派生。
 - App 持有 `shouldExit` UI 状态，但通过 `onExit` prop 委托执行。Renderer 销毁和 `process.exit` 属于入口生命周期；App 不得等待后台 effect 结束。
 - 每个领域使用共享组件实现 list/detail/form/confirm 模式。破坏性操作必须进入强确认状态。
 - Config 与 Global Rules 使用预览、`e` 编辑、推荐和 fill-missing 导入语义。脏编辑在导航前必须 save/discard/cancel。
 - Global Rules 目标为 `~/.claude/CLAUDE.md` 或 `~/.codex/AGENTS.md`。General Config 排除这些文件以及所有 Provider/MCP/Skills 领域。
 - 多行编辑使用 `TextareaEditor`/OpenTUI textarea，并遵守禁止 scrollbox 的规则。搜索/过滤使用 `SingleLineInput`。
 - 主题值来自语义 token。不得在 View 中假设终端背景，或硬编码第二套仅深色调色板。

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| 在 Header 切换 Agent | 保持菜单顺序；重新加载当前独占领域 |
| Header focus 过期时进入 Tools/MCP/Skills | 将 focus 转到 View；保留上下文值 |
| 共享 View 顶行按 Up | 按 View 合同停留/循环；绝不进入隐藏 Header |
| Modal 激活 | 背景不可用；仅修改 Modal 草稿 |
| 可退出 focus 中退出 | App 报告 `onExit`；入口恢复终端并以 0 退出 |
| 脏编辑同时发生导航/上下文变化 | 提示 save/discard/cancel |
| 已有 rule/config 格式错误 | 显示错误/详情；不得覆盖 |
| 文件缺失 | 空预览/编辑器；仅在 save/import 时创建 |
| 窄终端/长内容 | 保持稳定区域；文本裁剪/换行且不重叠 |

## 5. Good / Base / Bad Cases

- 良好：从 Claude Config 切换到 Codex Config 时复用同一预览/编辑模型，由 service 切换 JSON 与 TOML 所有权。
- 基线：缺失的 AGENTS.md 显示空规则预览。
- 错误：新增第七个 Codex 菜单，或按 Header 上下文过滤共享 Tools。
- 错误：keybindings 使用其他按键时在 View 内硬编码 `Ctrl+T` 文案。

## 6. Tests Required

- `verify-manage-tui-state.mjs`、`verify-agent-context.mjs`、`verify-shortcuts.mjs`、布局 gate 和领域 View gate。
- `verify-manage-tui-state.mjs` 还覆盖 App 到入口的退出 wiring，以及 renderer-cleanup-before-process-exit 顺序。
- Config/Rules 变更运行 `verify-config-view.mjs`、`verify-config-rules-reuse.mjs`、`verify-prompts-view.mjs`。
- 涉及光标、选择、粘贴、撤销或 focus 所有权的输入变更，使用真实 OpenTUI render/input 测试。

## 7. Wrong vs Correct

```tsx
// 错误：View 持有重复 footer 和路径决策。
<ShortcutBar shortcuts={[{key: 'e', label: '编辑'}]} />

// 正确：View 报告模式；App 从 registry 派生快捷键。
useEffect(() => onSubModeChange(mode), [mode, onSubModeChange]);
```
