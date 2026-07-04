import assert from 'node:assert/strict';

// Task 1.5 骨架：工具管理按 agentContext 的可见性契约冻结（design D3/PBT-3）。
// 本阶段冻结分组与可见性矩阵；阶段 3 落地 group/visibility resolver 后改为 import 真实定义断言。

// ── 冻结的工具分组与可见性矩阵 ────────────────────────────────────────────────
// group: agent = 主 Agent（两上下文常显）；companion = 仅 Claude Code；tool = 两上下文通用
const TOOL_MATRIX = {
	ClaudeCode: {group: 'agent', contexts: ['cc', 'cx']},
	CodexCli: {group: 'agent', contexts: ['cc', 'cx']},
	AntigravityCli: {group: 'agent', contexts: ['cc', 'cx']},
	Ccline: {group: 'companion', contexts: ['cc']},
	OpenSpec: {group: 'tool', contexts: ['cc', 'cx']},
	CcgWorkflow: {group: 'tool', contexts: ['cc', 'cx']},
	CodeGraph: {group: 'tool', contexts: ['cc', 'cx']}
};

function visibleIn(ctx) {
	return Object.entries(TOOL_MATRIX)
		.filter(([, meta]) => meta.contexts.includes(ctx))
		.map(([id]) => id);
}

// ClaudeCode/CodexCli 在两种上下文都常显
for (const ctx of ['cc', 'cx']) {
	const visible = visibleIn(ctx);
	assert.ok(visible.includes('ClaudeCode'), `${ctx}: ClaudeCode 应常显`);
	assert.ok(visible.includes('CodexCli'), `${ctx}: CodexCli 应常显`);
}

// Ccline 仅 Claude Code
assert.ok(visibleIn('cc').includes('Ccline'), 'Ccline 在 Claude Code 上下文显示');
assert.equal(visibleIn('cx').includes('Ccline'), false, 'Ccline 不在 Codex 上下文显示');

// CodeGraph/CcgWorkflow 两上下文都在（生命周期按上下文分支，但可见性不受限）
for (const ctx of ['cc', 'cx']) {
	assert.ok(visibleIn(ctx).includes('CodeGraph'), `${ctx}: CodeGraph 可见`);
	assert.ok(visibleIn(ctx).includes('CcgWorkflow'), `${ctx}: CcgWorkflow 可见`);
}

// 分组归属
assert.equal(TOOL_MATRIX.ClaudeCode.group, 'agent', 'ClaudeCode 属 agent 组');
assert.equal(TOOL_MATRIX.CodexCli.group, 'agent', 'CodexCli 属 agent 组');
assert.equal(TOOL_MATRIX.AntigravityCli.group, 'agent', 'AntigravityCli 属 agent 组');
assert.equal(TOOL_MATRIX.Ccline.group, 'companion', 'Ccline 属 companion 组');
assert.equal(TOOL_MATRIX.OpenSpec.group, 'tool', 'OpenSpec 属 tool 组');
assert.equal(TOOL_MATRIX.CodeGraph.group, 'tool', 'CodeGraph 属 tool 组');

console.log('[PASS] 1.5 工具管理骨架：ClaudeCode/CodexCli 常显 + Ccline 仅 Claude Code + 分组矩阵冻结');
