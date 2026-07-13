import assert from 'node:assert/strict';
import {
	getInstalledSkills,
	projectSharedSkills,
	skillInstalledOn,
	SKILL_AGENT_DISPLAY_TO_CONTEXT
} from '../src/core/skills.ts';

// shared-resource-injection-ui Section 19.3：Skills 共享本体+注入投影门禁（core/skills.ts）。
// 断言（对齐 specs/skills-multitool/spec.md「Skills status SHALL be projected as a shared-body plus per-Agent injection view」）：
//   1) getInstalledSkills() 无参 / 仅传 exec → 不含 `--agent`（全量扫）；显式 cc/cx → 带 `--agent`（单侧）；
//   2) projectSharedSkills 从 agents displayName 派生 sharedInstalled/claudeInjected/codexAvailable；
//   3) codexAvailable 恒等于 sharedInstalled（codex 直读本体，无独立态）；
//   4) 非 Claude Code / Codex displayName 被忽略；
//   5) 一行一 skill name。

// ── 1) getInstalledSkills 无 --agent 全量扫 vs 显式单侧带 --agent ──────────────
{
	const noAgentArgs = [];
	await getInstalledSkills(async (_cmd, args) => {
		noAgentArgs.push(args);
		return {code: 0, stdout: '[]', stderr: ''};
	});
	assert.equal(noAgentArgs[0].includes('--agent'), false, '无参（仅 exec）→ 不含 --agent，全量扫所有 agent 目录');
	assert.equal(noAgentArgs[0].includes('--json'), true, '仍带 --json');

	const bareArgs = [];
	// 完全无参不可捕获命令，用 exec 缝验证；显式 cc/cx 带 --agent。
	const ccArgs = [];
	await getInstalledSkills('cc', async (_cmd, args) => {
		ccArgs.push(args);
		return {code: 0, stdout: '[]', stderr: ''};
	});
	assert.equal(ccArgs[0].includes('--agent'), true, '显式 cc → 带 --agent（单侧过滤，旧主路径保留）');
	assert.equal(ccArgs[0][ccArgs[0].indexOf('--agent') + 1], 'claude-code', 'cc → --agent claude-code');

	console.log('[PASS] 19.3-1 getInstalledSkills：无 --agent 全量扫 / 显式单侧带 --agent');
}

// ── 2/3) projectSharedSkills 派生双侧态 + codexAvailable===sharedInstalled ─────
{
	const installed = [
		// 两侧都在：canonical 本体 + Claude Code symlink
		{name: 'both-skill', path: '/p/both', scope: 'global', agents: ['Claude Code', 'Codex']},
		// 仅本体（codex 直读）：agents 只含 Codex
		{name: 'codex-only', path: '/p/codex', scope: 'global', agents: ['Codex']},
		// 仅 Claude Code symlink（存量实体目录场景）：agents 只含 Claude Code
		{name: 'claude-only', path: '/p/claude', scope: 'global', agents: ['Claude Code']},
		// 都不在
		{name: 'none-skill', path: '/p/none', scope: 'global', agents: []}
	];

	const rows = projectSharedSkills(installed);
	assert.equal(rows.length, 4, '一行一 skill name');

	const byName = name => rows.find(r => r.name === name);

	const both = byName('both-skill');
	assert.equal(both.sharedInstalled, true, 'both：agents 含 Codex → sharedInstalled');
	assert.equal(both.claudeInjected, true, 'both：agents 含 Claude Code → claudeInjected');
	assert.equal(both.codexAvailable, true, 'both：codexAvailable');

	const codexOnly = byName('codex-only');
	assert.equal(codexOnly.sharedInstalled, true, 'codex-only：本体在');
	assert.equal(codexOnly.claudeInjected, false, 'codex-only：无 Claude Code symlink');
	assert.equal(codexOnly.codexAvailable, true, 'codex-only：codex 可用');

	const claudeOnly = byName('claude-only');
	assert.equal(claudeOnly.sharedInstalled, false, 'claude-only：无本体（agents 无 Codex）');
	assert.equal(claudeOnly.claudeInjected, true, 'claude-only：Claude Code symlink 在');
	assert.equal(claudeOnly.codexAvailable, false, 'claude-only：codexAvailable 随本体=false');

	const none = byName('none-skill');
	assert.equal(none.sharedInstalled, false, 'none：三态全 false');
	assert.equal(none.claudeInjected, false, 'none：三态全 false');
	assert.equal(none.codexAvailable, false, 'none：三态全 false');

	// codexAvailable 恒等于 sharedInstalled（无独立态）。
	for (const row of rows) {
		assert.equal(row.codexAvailable, row.sharedInstalled, `${row.name}: codexAvailable === sharedInstalled`);
	}

	console.log('[PASS] 19.3-2/3 projectSharedSkills 双侧派生 + codexAvailable===sharedInstalled（无独立态）');
}

// ── 4) 未知 displayName 忽略 ─────────────────────────────────────────────────
{
	const withUnknown = [
		{name: 'multi-agent', path: '/p', scope: 'global', agents: ['Cline', 'Cursor', 'Codex']}
	];
	const [row] = projectSharedSkills(withUnknown);
	assert.equal(row.sharedInstalled, true, 'Codex 仍识别（本体在）');
	assert.equal(row.claudeInjected, false, 'Cline/Cursor 等未知 displayName 不影响 cc 事实');

	// skillInstalledOn 纯函数：仅按已知映射判定。
	assert.equal(skillInstalledOn(withUnknown[0], 'cx'), true, 'skillInstalledOn cx（Codex）为真');
	assert.equal(skillInstalledOn(withUnknown[0], 'cc'), false, 'skillInstalledOn cc（无 Claude Code）为假');

	// 映射常量只含 Claude Code / Codex。
	assert.equal(SKILL_AGENT_DISPLAY_TO_CONTEXT['Claude Code'], 'cc');
	assert.equal(SKILL_AGENT_DISPLAY_TO_CONTEXT['Codex'], 'cx');
	assert.equal(SKILL_AGENT_DISPLAY_TO_CONTEXT['Cline'], undefined, '未知 displayName 无映射');

	console.log('[PASS] 19.3-4 非 Claude Code/Codex displayName 忽略');
}

console.log('[PASS] Skills 共享本体+注入投影门禁全部通过');
