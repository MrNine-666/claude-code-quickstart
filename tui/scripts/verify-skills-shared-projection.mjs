import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	detectInstalledSkillItems,
	itemAvailableOn,
	otherAgentsOf,
	storageRootsOf,
	SKILL_AGENT_DISPLAY_TO_CONTEXT
} from '../src/core/skills-installed.ts';
import {createSkillsDetectionRunner, runSkillsDetection} from '../src/services/view-detection.ts';

// Skills 已安装检测投影门禁（task 07-28-skills-multi-source-topology R1/R2）。
// 本门禁替换旧的「list 后物理 inspection 修正 Agent badge」契约：
//   1) 检测事实只来自一次 `skills list -g --json`；
//   2) 不读 `.agents/.skill-lock.json`，不扫 `.claude`/`.agents`/`.codex` 目录；
//   3) Agent 可用侧只由 `agents` 派生，存储位置只由 `path` 派生；
//   4) 非 Claude Code / Codex 的 displayName 保留为 otherAgents，不影响双侧判定。

const listRecord = (over = {}) => ({
	name: 'pdf',
	path: '/home/u/.agents/skills/pdf',
	scope: 'global',
	agents: ['Codex'],
	source: 'owner/repo',
	...over
});

// ── 1) 检测只跑一次 list，且不带 --agent ────────────────────────────────────
{
	const calls = [];
	const items = await detectInstalledSkillItems(async (command, args) => {
		calls.push({command, args});
		return {code: 0, stdout: JSON.stringify([listRecord()]), stderr: ''};
	});

	assert.equal(calls.length, 1, '一次检测只允许一次 CLI 调用');
	assert.equal(calls[0].command, 'npx');
	assert.equal(calls[0].args.includes('--agent'), false, '检测必须是不带 --agent 的全量扫');
	assert.equal(calls[0].args.includes('--json'), true, '必须请求 JSON');
	assert.equal(calls[0].args.includes('-g'), true, '必须是全局 scope');
	assert.equal(items.length, 1);

	console.log('[PASS] 1 已安装检测只执行一次不带 --agent 的 list');
}

// ── 2) Agent 侧只由 agents 派生；storage 位置只由 path 派生 ──────────────────
{
	const [codexOnly] = await detectInstalledSkillItems(async () => ({
		code: 0,
		stdout: JSON.stringify([listRecord({agents: ['Codex']})]),
		stderr: ''
	}));
	assert.equal(itemAvailableOn(codexOnly, 'cx'), true, 'agents 含 Codex → Codex 侧可用');
	assert.equal(itemAvailableOn(codexOnly, 'cc'), false, 'agents 不含 Claude Code → Claude 侧不可用');
	assert.deepEqual(storageRootsOf(codexOnly), ['agents'], '存储根只由 JSON path 分类');

	const [claudeOnly] = await detectInstalledSkillItems(async () => ({
		code: 0,
		stdout: JSON.stringify([listRecord({agents: ['Claude Code'], path: '/home/u/.claude/skills/pdf'})]),
		stderr: ''
	}));
	assert.equal(itemAvailableOn(claudeOnly, 'cc'), true);
	assert.equal(itemAvailableOn(claudeOnly, 'cx'), false, '不得因 canonical 目录存在就推导 Codex 可用');
	assert.deepEqual(storageRootsOf(claudeOnly), ['claude']);

	const [shared] = await detectInstalledSkillItems(async () => ({
		code: 0,
		stdout: JSON.stringify([
			listRecord({agents: ['Codex']}),
			listRecord({agents: ['Claude Code'], path: '/home/u/.claude/skills/pdf'})
		]),
		stderr: ''
	}));
	assert.deepEqual([...shared.agents].sort(), ['Claude Code', 'Codex'], '同源多记录合并 agents 并集');
	assert.deepEqual([...storageRootsOf(shared)].sort(), ['agents', 'claude'], '两条投影都保留');

	console.log('[PASS] 2 Agent 侧只由 agents 派生，存储位置只由 path 派生');
}

// ── 3) 未知 displayName 保留为 otherAgents，不影响双侧判定 ───────────────────
{
	const [item] = await detectInstalledSkillItems(async () => ({
		code: 0,
		stdout: JSON.stringify([listRecord({agents: ['Cline', 'Cursor', 'Codex']})]),
		stderr: ''
	}));
	assert.equal(itemAvailableOn(item, 'cx'), true, 'Codex 仍被识别');
	assert.equal(itemAvailableOn(item, 'cc'), false, 'Cline/Cursor 不影响 Claude 侧');
	assert.deepEqual([...otherAgentsOf(item)].sort(), ['Cline', 'Cursor'], '其它 Agent 保留供确认文案展示');

	assert.equal(SKILL_AGENT_DISPLAY_TO_CONTEXT['Claude Code'], 'cc');
	assert.equal(SKILL_AGENT_DISPLAY_TO_CONTEXT['Codex'], 'cx');
	assert.equal(SKILL_AGENT_DISPLAY_TO_CONTEXT['Cline'], undefined);

	console.log('[PASS] 3 未知 displayName 保留为 otherAgents');
}

// ── 4) 检测不读 lock、不扫目录：磁盘上的干扰内容不得改变结果 ─────────────────
{
	const root = await mkdtemp(join(tmpdir(), 'ccq-skills-detection-'));
	const homeDir = join(root, 'home');
	const originalCcqHome = process.env.CCQ_HOME;
	try {
		process.env.CCQ_HOME = homeDir;

		// 磁盘上放置 lock 与 canonical 目录：都不得影响检测结果。
		const agentsDir = join(homeDir, '.agents');
		await mkdir(join(agentsDir, 'skills', 'ghost'), {recursive: true});
		await writeFile(
			join(agentsDir, '.skill-lock.json'),
			JSON.stringify({version: 3, skills: {pdf: {source: 'lock/should-not-be-used', ref: 'v9'}}}),
			'utf8'
		);
		await mkdir(join(homeDir, '.claude', 'skills', 'pdf'), {recursive: true});

		let state;
		let calls = 0;
		const runner = createSkillsDetectionRunner(next => {
			state = next;
		});
		await runSkillsDetection(runner, async () => {
			calls += 1;
			return {code: 0, stdout: JSON.stringify([listRecord({agents: ['Codex']})]), stderr: ''};
		});

		assert.equal(calls, 1, '检测不得为文件系统分类追加第二次命令');
		assert.equal(state?.status, 'success');
		const items = state?.result ?? [];
		assert.equal(items.length, 1, '磁盘上的 ghost 目录不得出现在列表里');
		assert.equal(items[0].name, 'pdf');
		assert.equal(
			items[0].provenance.source,
			'owner/repo',
			'来源只来自 CLI 记录，lock 中的来源不得覆盖'
		);
		assert.equal(itemAvailableOn(items[0], 'cc'), false, '磁盘上的 .claude 目录不得改变 Agent 侧');
		assert.deepEqual(storageRootsOf(items[0]), ['agents']);

		console.log('[PASS] 4 检测不读 lock、不扫目录，磁盘干扰不改变结果');
	} finally {
		if (originalCcqHome === undefined) delete process.env.CCQ_HOME;
		else process.env.CCQ_HOME = originalCcqHome;
		await rm(root, {recursive: true, force: true});
	}
}

// ── 5) 失败整体传播，不回退文件系统扫描 ─────────────────────────────────────
{
	const failures = [
		['非零退出', {code: 7, stdout: '', stderr: 'boom'}],
		['空输出', {code: 0, stdout: '', stderr: ''}],
		['无效 JSON', {code: 0, stdout: 'not-json', stderr: ''}],
		['顶层非数组', {code: 0, stdout: '{}', stderr: ''}],
		['坏记录', {code: 0, stdout: JSON.stringify([{name: 5}]), stderr: ''}]
	];
	for (const [label, result] of failures) {
		await assert.rejects(() => detectInstalledSkillItems(async () => result), /Skills 列表检测失败/, `${label} 必须整体失败`);
	}

	assert.deepEqual(
		await detectInstalledSkillItems(async () => ({code: 0, stdout: '[]', stderr: ''})),
		[],
		'合法 [] 才是真正的空安装列表'
	);

	console.log('[PASS] 5 检测失败整体传播，不回退文件系统扫描');
}

console.log('[PASS] Skills 已安装检测投影门禁全部通过');
