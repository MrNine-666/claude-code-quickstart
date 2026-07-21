# 完善 Codex 推荐配置

## Goal

让 ccq 的 Codex 配置页以当前常用、可跨设备复用的运行配置为基础推荐，同时不把机器私有状态、供应商凭据或权限扩张悄悄写入用户配置。

## Confirmed Facts

- Codex 推荐配置的唯一源文件是 `tui/contracts/codex-config.toml`，并会在编译时内嵌到 ccq 可执行文件。
- 当前可一键补全的基础配置为 `model_reasoning_effort`、`approval_policy`、`sandbox_mode`、`web_search`、`hide_agent_reasoning` 与 `file_opener`。
- 当前常用配置采用 `model_reasoning_effort = "xhigh"`、`approval_policy = "on-request"` 与 `sandbox_mode = "workspace-write"`。
- `model`、`model_provider`、`model_providers` 与 `mcp_servers` 分别由供应商或 MCP 模块持有，配置页必须继续过滤并在保存时保留它们。
- 当前通知配置依赖本机 macOS 应用的绝对路径；用户已确认不纳入推荐项。

## Requirements

### R1: 更新基础推荐

- 将默认 `model_reasoning_effort` 更新为 `xhigh`。
- 保持现有 `approval_policy`、`sandbox_mode`、`web_search`、`hide_agent_reasoning` 与 `file_opener` 的归属和 fill-missing 语义不变。

### R2: 展示增强选项而不自动启用

- 在 Codex 推荐配置文本中说明两项可选增强：`[sandbox_workspace_write] network_access = true` 与 `[features] memories = true`。
- 两项增强不得被 Ctrl+O / fill-missing 自动写入；用户仅能在推荐面板中查阅并在编辑器中主动采用。
- 对联网权限与实验/版本兼容性写明风险和适用场景。

### R3: 边界保护

- 不加入 `notify`，也不得写入任何绝对路径、桌面主题、插件市场、项目信任、钩子信任记录或凭据。
- 供应商和 MCP 的现有过滤、保存合并与脱敏行为不得回归。

### R4: TOML 预览可读性

- Codex 配置页的当前配置预览和推荐配置边栏必须以 TOML 样式渲染，不再使用纯文本回退。
- TOML 预览应与现有 JSON/Markdown `CodePreview` 保持相同的行号、主题色、滚动和可选择复制体验。
- 预览至少区分表头、键、字符串、数字、布尔值、标点和注释；解析仅用于展示，不能影响 TOML 保存或 fill-missing 行为。

## Acceptance Criteria

- [ ] Codex 推荐面板将 `model_reasoning_effort` 展示为 `xhigh`，而 Ctrl+O 对缺失项补全后写入该值。
- [ ] 推荐文本清晰展示联网与 memories 的手动可选片段及其说明，但 Ctrl+O 不会写入它们。
- [ ] 推荐文本不含 `notify` 或任何本机绝对路径。
- [ ] Codex 当前配置和推荐配置边栏均使用 TOML 预览样式，且注释、表头和键值具备可读的主题化区分。
- [ ] 既有供应商模型、provider token、MCP 表和 hooks 的可见性及保存保护测试继续通过。
- [ ] 源码与编译产物均加载更新后的内嵌契约。

## Out Of Scope

- 为通知新增跨平台配置生成、安装或测试机制。
- 调整供应商模型、MCP、插件、桌面设置、项目 trust 或 hooks 配置。
- 默认开启工作区网络访问或 memories 功能。
- 通过 Tree-sitter 为 TOML 增加仅源码模式可用的高亮，导致编译后的 ccq 出现体验差异。
