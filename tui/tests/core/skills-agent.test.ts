import {describe, expect, test} from 'bun:test';
import {skillsAgentOf} from '../../src/core/skills.js';

// 载体迁移（P3a）：原 scripts/verify-skills-agent.mjs（5 条静态断言）整体迁入。
// Task 8.2 / PBT-14：Skills CLI agent 参数按 agentContext 映射。
// Claude Code → --agent claude-code；Codex → --agent codex；Pi → --agent pi。

describe('Skills agent 映射（core/skills.ts）', () => {
	test('8.2 Skills agent：Claude Code=claude-code / Codex=codex / Pi=pi 映射来自 core', () => {
		expect(skillsAgentOf('cc'), 'Claude Code → --agent claude-code').toBe('claude-code');
		expect(skillsAgentOf('cx'), 'Codex → --agent codex').toBe('codex');
		expect(skillsAgentOf('pi'), 'Pi → --agent pi').toBe('pi');

		// 映射完备：两种上下文都必须有确定的 skills agent，不落 undefined。
		const agents = ['cc', 'cx', 'pi'] as const;
		for (const agent of agents) {
			const resolved = skillsAgentOf(agent);
			expect(typeof resolved === 'string' && resolved.length > 0, `${agent} 必须映射到非空 skills agent`).toBe(true);
		}

		// 禁止硬编码单一 agent：两种上下文映射结果必须不同。
		expect(new Set(agents.map(agent => skillsAgentOf(agent))).size, '三上下文 skills agent 必须一一映射（禁硬编码单值）').toBe(3);
	});
});
