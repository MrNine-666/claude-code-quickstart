import assert from 'node:assert/strict';

// Task 1.14 骨架：Skills CLI agent 参数按 agentContext 映射（design D13, PBT-14）。
// 冻结「Claude Code=claude-code，Codex=codex」映射不变量；
// 阶段 8 参数化 tui/src/core/skills.ts / skills-actions.ts 后改为 import 真实映射断言。

function skillsAgentOf(agentContext) {
	switch (agentContext) {
		case 'cc':
			return 'claude-code';
		case 'cx':
			return 'codex';
		default:
			throw new Error(`未知 agentContext: ${agentContext}`);
	}
}

assert.equal(skillsAgentOf('cc'), 'claude-code', 'Claude Code → --agent claude-code');
assert.equal(skillsAgentOf('cx'), 'codex', 'Codex → --agent codex');

// 映射完备：两种上下文都必须有确定的 skills agent，不落 undefined
for (const agent of ['cc', 'cx']) {
	const resolved = skillsAgentOf(agent);
	assert.ok(typeof resolved === 'string' && resolved.length > 0, `${agent} 必须映射到非空 skills agent`);
}

// 禁止硬编码单一 agent：两种上下文映射结果必须不同
assert.notEqual(skillsAgentOf('cc'), skillsAgentOf('cx'), '两上下文 skills agent 必须区分（禁硬编码单值）');

console.log('[PASS] 1.14 Skills agent 骨架：Claude Code=claude-code / Codex=codex 映射冻结');
