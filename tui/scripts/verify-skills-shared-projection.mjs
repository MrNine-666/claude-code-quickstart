import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	getInstalledSkills,
	inspectInstalledSkillStorage,
	projectSharedSkills,
	skillInstalledOn,
	SKILL_AGENT_DISPLAY_TO_CONTEXT
} from '../src/core/skills.ts';
import {createSkillsDetectionRunner, runSkillsDetection} from '../src/services/view-detection.ts';

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

// ── 1b) getInstalledSkills 严格区分空列表与检测失败，lock 只做 best-effort 增强 ──
{
	const execResult = result => async () => result;
	await assert.rejects(
		() => getInstalledSkills(execResult({code: 7, stdout: '', stderr: 'list failed'})),
		/ExitCode:\s*7|list failed/,
		'非零退出必须进入检测 error'
	);
	await assert.rejects(
		() => getInstalledSkills(execResult({code: 0, stdout: '', stderr: ''})),
		/JSON|Skills 列表检测失败/,
		'空输出不得伪装成空列表'
	);
	await assert.rejects(
		() => getInstalledSkills(execResult({code: 0, stdout: 'not-json', stderr: ''})),
		/JSON|Skills 列表检测失败/,
		'非 JSON 输出必须进入检测 error'
	);
	await assert.rejects(
		() => getInstalledSkills(execResult({code: 0, stdout: '{}', stderr: ''})),
		/JSON|Skills 列表检测失败/,
		'JSON 顶层非数组也是协议错误'
	);
	assert.deepEqual(
		await getInstalledSkills(execResult({code: 0, stdout: '[]', stderr: ''})),
		[],
		'合法 [] 才表示真正的空安装列表'
	);

	const originalCcqHome = process.env.CCQ_HOME;
	const temporaryHome = await mkdtemp(join(tmpdir(), 'ccq-skills-lock-'));
	const listOne = execResult({
		code: 0,
		stdout: JSON.stringify([{name: 'pdf', path: '/skills/pdf', scope: 'global', agents: ['Codex']}]),
		stderr: ''
	});
	try {
		process.env.CCQ_HOME = temporaryHome;

		const [withoutLock] = await getInstalledSkills(listOne);
		assert.equal(withoutLock.source, undefined, '缺失 lock 时仍返回 CLI 列表事实');

		const agentsDir = join(temporaryHome, '.agents');
		await mkdir(agentsDir, {recursive: true});
		await writeFile(join(agentsDir, '.skill-lock.json'), '{broken', 'utf8');
		const [withCorruptLock] = await getInstalledSkills(listOne);
		assert.equal(withCorruptLock.source, undefined, '损坏 lock 只放弃增强，不得让列表检测失败');

		await writeFile(
			join(agentsDir, '.skill-lock.json'),
			JSON.stringify({version: 3, skills: {pdf: {source: 'openai/skills', ref: 'v1'}}}),
			'utf8'
		);
		const [enriched] = await getInstalledSkills(listOne);
		assert.equal(enriched.source, 'openai/skills', 'lock source 应增强已安装行');
		assert.equal(enriched.ref, 'v1', 'lock ref 应增强已安装行');
		assert.equal(enriched.skillName, 'pdf', 'lock key 应作为重新安装的 --skill 值');

		await writeFile(
			join(agentsDir, '.skill-lock.json'),
			JSON.stringify({version: 3, skills: {pdf: {source: 'openai/skills', sourceUrl: 'https://github.com/openai/skills.git', ref: 'v2'}}}),
			'utf8'
		);
		const [withSourceUrl] = await getInstalledSkills(listOne);
		assert.equal(withSourceUrl.source, 'https://github.com/openai/skills.git', 'sourceUrl 应优先于 source shorthand');
	} finally {
		if (originalCcqHome === undefined) delete process.env.CCQ_HOME;
		else process.env.CCQ_HOME = originalCcqHome;
		await rm(temporaryHome, {recursive: true, force: true});
	}

	console.log('[PASS] getInstalledSkills 严格错误传播 + 合法 [] + lock 缺失/损坏容错与 source/ref 增强');
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

// ── 5) 单次 CLI 检测后追加只读物理分类，不把 badge 直接当作 Claude-only ──────
{
	const root = await mkdtemp(join(tmpdir(), 'ccq-skills-storage-detection-'));
	const homeDir = join(root, 'home');
	const claudeSkill = join(homeDir, '.claude', 'skills', 'local-only');
	await mkdir(claudeSkill, {recursive: true});
	await writeFile(
		join(claudeSkill, 'SKILL.md'),
		'---\nname: local-only\ndescription: Local only\n---\n',
		'utf8'
	);
	let state;
	let calls = 0;
	const runner = createSkillsDetectionRunner(next => {
		state = next;
	});
	try {
		await runSkillsDetection(
			runner,
			async () => {
				calls += 1;
				return {
					code: 0,
					stdout: JSON.stringify([{name: 'local-only', path: claudeSkill, scope: 'global', agents: ['Claude Code']}]),
					stderr: ''
				};
			},
			{homeDir, tempDir: join(root, 'temp')}
		);
		assert.equal(calls, 1, '物理分类不得新增第二次 skills list');
		assert.equal(state?.status, 'success');
		assert.equal(state?.result?.[0]?.storage?.kind, 'claude-only');
		const projected = projectSharedSkills(state?.result ?? [])[0];
		assert.equal(projected?.storage?.kind, 'claude-only');
		assert.equal(projected?.codexAvailable, false, 'Claude-only 物理上无 canonical，不能只看 CLI badge');

		const canonicalPath = join(homeDir, '.agents', 'skills', 'physical-canonical');
		await mkdir(canonicalPath, {recursive: true});
		await writeFile(
			join(canonicalPath, 'SKILL.md'),
			'---\nname: physical-canonical\ndescription: Canonical\n---\n',
			'utf8'
		);
		const physicallyEnriched = await inspectInstalledSkillStorage([
			{name: 'physical-canonical', path: canonicalPath, scope: 'global', agents: ['Claude Code']}
		], {homeDir});
		const physicalRow = projectSharedSkills(physicallyEnriched)[0];
		assert.equal(physicalRow?.codexAvailable, true, 'canonical 物理存在时 Codex 可用，即使 CLI agents 漏报 Codex');
	} finally {
		await rm(root, {recursive: true, force: true});
	}

	console.log('[PASS] 单次 Skills CLI 检测 + 只读文件系统分类增强');
}

console.log('[PASS] Skills 共享本体+注入投影门禁全部通过');
