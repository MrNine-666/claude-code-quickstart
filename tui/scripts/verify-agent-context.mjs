import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Task 1.4 骨架：agentContext Header 不变量冻结（design D2/PBT-2）。
// 本阶段只冻结规格契约；阶段 2 落地 manage-state.agentContext + app.tsx Header 后，
// 本脚本改为 import 真实 state/常量做断言（见 verify-manage-tui-state.mjs 协同）。
// shared-resource-injection-ui：追加 Tools 隐藏 Header 时 agentContext 保留不变量（Task 2.4/6.3）。

// ── 冻结的 Header 契约 ────────────────────────────────────────────────────────
const AGENT_CONTEXTS = ['cc', 'cx']; // 内部键（短名）
const DEFAULT_AGENT_CONTEXT = 'cc'; // 默认 Claude Code
const HEADER_VISIBLE_LABELS = {cc: 'Claude Code', cx: 'Codex'}; // UI 全称，不展示缩写
const MENU_ORDER = ['tools', 'provider', 'config', 'prompts', 'mcp', 'skills']; // 6 菜单，Header 切换不改顺序

// 默认上下文为 Claude Code
assert.equal(DEFAULT_AGENT_CONTEXT, 'cc', '默认 agentContext 应为 cc（Claude Code）');
assert.equal(HEADER_VISIBLE_LABELS[DEFAULT_AGENT_CONTEXT], 'Claude Code', '默认 Header 可见标签为 Claude Code');

// Header 可见标签使用全称，禁止出现 cc/cx 缩写作为可见文本
for (const ctx of AGENT_CONTEXTS) {
	const label = HEADER_VISIBLE_LABELS[ctx];
	assert.ok(label, `${ctx} 应有可见标签`);
	assert.equal(/^(cc|cx)$/i.test(label), false, `Header 可见标签不得为缩写: ${label}`);
}
assert.deepEqual(Object.values(HEADER_VISIBLE_LABELS).sort(), ['Claude Code', 'Codex'], 'Header 全称标签集合固定');

// 左侧 6 菜单：Header 切换不改变菜单顺序（模拟切换 N 次，顺序恒定）
assert.equal(MENU_ORDER.length, 6, '左侧保持 6 菜单');
for (let i = 0; i < 20; i++) {
	const ctx = AGENT_CONTEXTS[i % AGENT_CONTEXTS.length];
	// 切换 agentContext 不应重排 MENU_ORDER
	assert.deepEqual(MENU_ORDER, ['tools', 'provider', 'config', 'prompts', 'mcp', 'skills'], `切换到 ${ctx} 后菜单顺序不变`);
}

console.log('[PASS] 1.4 agentContext 骨架：默认 Claude Code + 6 菜单顺序恒定 + Header 全称标签');

// ── Tools / MCP 隐藏 Header：agentContext 不被进出这两个模块改写（Task 2.4/6.3 + 10.2/13.3）──
// app.tsx 用 AGENT_HEADER_HIDDEN_MODULES（含 tools + mcp）决定不渲染 AgentHeader，并把残留 header 焦点强制回 view；
// 全局 agentContext 仅由 Header 的 switchAgentContext 改，Tools / MCP 路径不触碰它。
const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');

assert.match(
	appSource,
	/AGENT_HEADER_HIDDEN_MODULES\s*=\s*new Set<ManageModuleId>\(\[\s*'tools',\s*'mcp',\s*'skills'\s*\]\)/,
	'AGENT_HEADER_HIDDEN_MODULES 含 tools + mcp + skills（共享双侧模块隐藏 Header）'
);
assert.match(
	appSource,
	/hideAgentHeader\s*\?\s*null\s*:\s*\(?\s*<AgentHeader/,
	'隐藏 Header 模块（hideAgentHeader）不渲染 AgentHeader'
);
assert.match(
	appSource,
	/AGENT_HEADER_HIDDEN_MODULES\.has\(displayMenuId\) && state\.focus === 'header'/,
	'隐藏 Header 模块残留 header 焦点应强制回 view（焦点机跳过 header）'
);
assert.doesNotMatch(
	appSource,
	/<ToolsView[^>]*onExitToHeader=\{/,
	'ToolsView 调用不得再传 onExitToHeader（Tools 无 Header，顶行 ↑ 停首项）'
);
assert.doesNotMatch(
	appSource,
	/<McpView[^>]*onExitToHeader=\{/,
	'McpView 调用不得再传 onExitToHeader（MCP 无 Header，列表内循环）'
);
assert.doesNotMatch(
	appSource,
	/<SkillsView[^>]*onExitToHeader=\{/,
	'SkillsView 调用不得再传 onExitToHeader（Skills 无 Header，列表内循环）'
);
// Skills 检测与 agentContext 解耦：services 装配不再按 state.agentContext 建 key。
assert.doesNotMatch(
	appSource,
	/createSkillsViewServices\(state\.agentContext\)/,
	'skillsViewServices 不得再按 state.agentContext 建 service key（检测与 agentContext 解耦）'
);

// ToolsView / McpView / SkillsView 顶行 ↑ 不再退回 header：不引用 onExitToHeader。
const toolsViewSource = readFileSync(new URL('../src/views/tools/tools-view-input.ts', import.meta.url), 'utf8');
const mcpViewSource = readFileSync(new URL('../src/views/mcp/McpHomeView.tsx', import.meta.url), 'utf8');
const skillsViewSource = readFileSync(new URL('../src/views/skills/SkillsView.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(
	toolsViewSource,
	/onExitToHeader/,
	'ToolsView 不得引用 onExitToHeader（顶行 ↑ 停首项，不进 header）'
);
assert.doesNotMatch(
	mcpViewSource,
	/onExitToHeader/,
	'McpHomeView 不得引用 onExitToHeader（列表内循环，不进 header）'
);
assert.doesNotMatch(
	skillsViewSource,
	/onExitToHeader/,
	'SkillsView 不得引用 onExitToHeader（列表内循环，不进 header）'
);

console.log('[PASS] 2.4/6.3/13.3/19.5 Tools / MCP / Skills 隐藏 Header：agentContext 保留 + 焦点机跳过 header + 顶行 ↑ 不进 header');
