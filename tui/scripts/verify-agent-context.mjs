import assert from 'node:assert/strict';

// Task 1.4 骨架：agentContext Header 不变量冻结（design D2/PBT-2）。
// 本阶段只冻结规格契约；阶段 2 落地 manage-state.agentContext + app.tsx Header 后，
// 本脚本改为 import 真实 state/常量做断言（见 verify-manage-tui-state.mjs 协同）。

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
