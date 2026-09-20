import assert from 'node:assert/strict';

// Layout / state / view 杂项载体迁移（P5d）。
// [P5d 迁走] 纯 reducer / menuItems / agentContext 循环 / 退出控制器行为断言（45 条）→
//   tests/core/manage-tui-state.test.ts。本脚本只保留静态契约段：
//   源码结构不变量（Tools/MCP/Skills 隐藏 Agent Header）与 index/app 的退出接线正则。

// ── Tools / MCP 隐藏 Header（shared-resource-injection-ui Task 2.1/2.2/2.3 + 10.2/10.3）──
// Header 隐藏与列表顶行行为在 App 层/视图落地（reducer 与菜单无关），断言源码契约：
//   1) app.tsx：hideAgentHeader（HIDDEN_MODULES 含 tools + mcp）不渲染 AgentHeader，且 header 焦点被 coerce 回 view；
//   2) ToolsView / McpView：顶行 ↑ 不再调用 onExitToHeader；MCP 交给 clampMove 首尾循环。
const {readFileSync} = await import('node:fs');
const appSrc = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const toolsSrc = readFileSync(new URL('../src/views/tools/tools-view-input.ts', import.meta.url), 'utf8');
const mcpSrc = readFileSync(new URL('../src/views/mcp/McpHomeView.tsx', import.meta.url), 'utf8');
const skillsSrc = readFileSync(new URL('../src/views/skills/SkillsView.tsx', import.meta.url), 'utf8');
const indexSrc = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');

assert.match(appSrc, /AGENT_HEADER_HIDDEN_MODULES\s*=\s*new Set<ManageModuleId>\(\[\s*'tools',\s*'mcp',\s*'skills'\s*\]\)/, 'HIDDEN_MODULES 含 tools + mcp + skills');
assert.match(appSrc, /hideAgentHeader\s*\?\s*null\s*:\s*\(?\s*<AgentHeader/, '隐藏 Header 模块不渲染 AgentHeader');
assert.match(appSrc, /AGENT_HEADER_HIDDEN_MODULES\.has\(displayMenuId\) && state\.focus === 'header'/, '隐藏 Header 模块下 header 焦点被 coerce 回 view');
// 隐藏 Header 不占布局行由 flex 自适应天然保证（hideAgentHeader ? null : <AgentHeader> 不渲染即不占位），
// 无需再断言 reserved-rows 算高（flex-height-unify 已移除 AGENT_HEADER_ROWS 等算高常量）。
assert.doesNotMatch(toolsSrc, /onExitToHeader/, 'ToolsView 不得再引用 onExitToHeader（顶行 ↑ 停首项，不进 header）');
assert.doesNotMatch(mcpSrc, /onExitToHeader/, 'McpHomeView 不得再引用 onExitToHeader（列表内循环，不进 header）');
assert.doesNotMatch(mcpSrc, /\batTop\b/, 'McpHomeView 不得在顶行拦截上键，列表导航应交给 clampMove 首尾循环');
assert.match(mcpSrc, /case 'arrowup':[\s\S]{0,160}onMove\(-1\)/, 'McpHomeView 上键应始终进入循环移动');
assert.doesNotMatch(skillsSrc, /onExitToHeader/, 'SkillsView 不得再引用 onExitToHeader（顶行 ↑ 停首项，不进 header）');
assert.doesNotMatch(appSrc, /<ToolsView[^>]*onExitToHeader/, 'app.tsx 渲染 ToolsView 时不得再传 onExitToHeader');
assert.doesNotMatch(appSrc, /<McpView[^>]*onExitToHeader/, 'app.tsx 渲染 McpView 时不得再传 onExitToHeader');
assert.doesNotMatch(appSrc, /<SkillsView[^>]*onExitToHeader/, 'app.tsx 渲染 SkillsView 时不得再传 onExitToHeader');
console.log('[PASS] Tools / MCP / Skills 模块隐藏 Agent Header + MCP/Skills 列表循环（不进 header）');

// TUI 退出不能依赖后台检测/网络句柄自然释放。只有 renderer 完成 destroy 回调后，
// 才显式结束 ccq 进程，既恢复终端状态，也避免残留 ccq.exe。
// [P5d 迁走] 退出控制器行为断言（6 条）→ tests/core/manage-tui-state.test.ts；
// 本段只保留入口接线源码契约。
assert.match(indexSrc, /onDestroy:\s*exitController\.handleRendererDestroyed/, 'renderer onDestroy 必须接入退出控制器');
assert.match(indexSrc, /<App[^>]*onExit=\{requestTuiExit\}/, 'App 必须把普通退出委派给入口控制器');
assert.match(appSrc, /if \(state\.shouldExit\) \{\s*onExit\(\);/, 'shouldExit 必须调用入口 onExit，不能只销毁界面');
console.log('[PASS] TUI 退出在 renderer 清理后显式结束 ccq 进程');
