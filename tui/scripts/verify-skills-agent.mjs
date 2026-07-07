import assert from 'node:assert/strict';
import {skillsAgentOf} from '../src/core/skills.ts';

// Task 8.2 / PBT-14：Skills CLI agent 参数按 agentContext 映射。
// Claude Code → --agent claude-code；Codex → --agent codex。

assert.equal(skillsAgentOf('cc'), 'claude-code', 'Claude Code → --agent claude-code');
assert.equal(skillsAgentOf('cx'), 'codex', 'Codex → --agent codex');

// 映射完备：两种上下文都必须有确定的 skills agent，不落 undefined。
for (const agent of ['cc', 'cx']) {
	const resolved = skillsAgentOf(agent);
	assert.ok(typeof resolved === 'string' && resolved.length > 0, `${agent} 必须映射到非空 skills agent`);
}

// 禁止硬编码单一 agent：两种上下文映射结果必须不同。
assert.notEqual(skillsAgentOf('cc'), skillsAgentOf('cx'), '两上下文 skills agent 必须区分（禁硬编码单值）');

console.log('[PASS] 8.2 Skills agent：Claude Code=claude-code / Codex=codex 映射来自 core');
