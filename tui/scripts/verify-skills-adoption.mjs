import assert from 'node:assert/strict';
import {access, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectSkillStorage} from '../src/core/skills-storage.ts';
import {runSkillsAdd, runSkillsRemove} from '../src/core/skills-actions.ts';
import {groupInstalledSkillItems} from '../src/core/skills-installed.ts';
import {targetTopologyOfDraft, topologyOfInspection, transitionSkillTopology} from '../src/services/skills-adoption.ts';
import {cleanupConfirmedReplacementSnapshots, installSearchResultsToTargets} from '../src/services/skills-service.ts';

// 迁移事务门禁（task 07-28-skills-multi-source-topology / design §8.4 / Checkpoint C5）。
// 输入模型已从旧 SkillSharedRow 迁到 InstalledSkillItem：拓扑身份由 Item `agents` 派生，
// `.codex` 收编经 official add 物化受管根 + 定向删除旧源，物化判定只看存储 kind 不比较内容。

const roots = [];

async function tempRoot(prefix) {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function writeSkill(root, name, marker = 'v1') {
	const skillDir = join(root, name);
	await mkdir(skillDir, {recursive: true});
	await writeFile(
		join(skillDir, 'SKILL.md'),
		`---\nname: ${name}\ndescription: Test ${name}\n---\n\n${marker}\n`,
		'utf8'
	);
	await mkdir(join(skillDir, 'scripts'), {recursive: true});
	await writeFile(join(skillDir, 'scripts', 'run.txt'), marker, 'utf8');
	return skillDir;
}

async function createHome() {
	const root = await tempRoot('ccq-skills-home-');
	const homeDir = join(root, 'home');
	const tempDir = join(root, 'temp');
	await mkdir(join(homeDir, '.claude', 'skills'), {recursive: true});
	await mkdir(join(homeDir, '.agents', 'skills'), {recursive: true});
	await mkdir(tempDir, {recursive: true});
	return {root, homeDir, tempDir};
}

// ── Item 构造（design Section 5）：records 经 groupInstalledSkillItems 分组 ──────

function claudeRecord(homeDir, name, source, extra = []) {
	return {name, path: join(homeDir, '.claude', 'skills', name), scope: 'global', agents: ['Claude Code', ...extra], source};
}

function canonicalRecord(homeDir, name, source, extra = []) {
	return {name, path: join(homeDir, '.agents', 'skills', name), scope: 'global', agents: ['Codex', ...extra], source};
}

function codexRecord(homeDir, name, source, extra = []) {
	return {name, path: join(homeDir, '.codex', 'skills', name), scope: 'global', agents: ['Codex', ...extra], source};
}

/**
 * 按拓扑构造单逻辑实例 Item。`location: 'codex'` 表示 codex-only 实体落在非受管 `.codex`
 * （需迁移收编）；默认 codex-only 落在受管 `.agents` canonical。`extraAgents` 注入第三方
 * universal agent（如 Cursor）以验证 Claude-only 占用阻断。
 */
function itemFor(homeDir, name, topology, {source = 'o/repo', extraAgents = [], location = 'agents'} = {}) {
	let records;
	if (topology === 'claude-only') {
		records = [claudeRecord(homeDir, name, source, extraAgents)];
	} else if (topology === 'codex-only') {
		records = location === 'codex' ? [codexRecord(homeDir, name, source, extraAgents)] : [canonicalRecord(homeDir, name, source, extraAgents)];
	} else {
		records = [canonicalRecord(homeDir, name, source, extraAgents), claudeRecord(homeDir, name, source)];
	}

	return groupInstalledSkillItems(records)[0];
}

function agentsFromArgs(args) {
	return args.filter((_, index) => args[index - 1] === '--agent');
}

function topologyExecEmulator(homeDir, calls, {sharedMode = 'link', fail = () => false} = {}) {
	return async (command, args, options) => {
		const verb = args.includes('add') ? 'add' : args.includes('remove') ? 'remove' : 'unknown';
		const agents = agentsFromArgs(args);
		const nameIndex = args.indexOf('--skill');
		const name = nameIndex >= 0 ? args[nameIndex + 1] : args[args.indexOf('remove') + 1];
		const source = verb === 'add' ? args[args.indexOf('add') + 1] : undefined;
		const canonical = join(homeDir, '.agents', 'skills', name);
		const claude = join(homeDir, '.claude', 'skills', name);
		calls.push({command, args: [...args], options, verb, agents, before: (await inspectSkillStorage(name, {homeDir})).kind});

		if (verb === 'remove') {
			if (agents.length === 0 || agents.includes('claude-code')) {
				await rm(claude, {recursive: true, force: true});
			}

			if (agents.length === 0 || agents.includes('codex')) {
				await rm(canonical, {recursive: true, force: true});
			}
		} else if (verb === 'add') {
			const staged = join(source, name);
			if (agents.length === 1 && agents[0] === 'claude-code') {
				await rm(claude, {recursive: true, force: true});
				await cp(staged, claude, {recursive: true});
			} else if (agents.length === 1 && agents[0] === 'codex') {
				await rm(canonical, {recursive: true, force: true});
				await cp(staged, canonical, {recursive: true});
			} else if (agents.join(',') === 'codex,claude-code') {
				await rm(canonical, {recursive: true, force: true});
				await rm(claude, {recursive: true, force: true});
				await cp(staged, canonical, {recursive: true});
				if (sharedMode === 'copy') {
					await cp(canonical, claude, {recursive: true});
				} else {
					await symlink(canonical, claude, process.platform === 'win32' ? 'junction' : 'dir');
				}
			}
		}

		calls[calls.length - 1].after = (await inspectSkillStorage(name, {homeDir})).kind;
		return fail({verb, agents, args})
			? {code: 1, stdout: '', stderr: 'simulated non-zero'}
			: {code: 0, stdout: '', stderr: ''};
	};
}

async function seedTopology(homeDir, name, topology, marker = 'v1') {
	const claudeRoot = join(homeDir, '.claude', 'skills');
	const canonicalRoot = join(homeDir, '.agents', 'skills');
	if (topology === 'claude-only') {
		await writeSkill(claudeRoot, name, marker);
	} else {
		const canonical = await writeSkill(canonicalRoot, name, marker);
		if (topology === 'shared') {
			await symlink(canonical, join(claudeRoot, name), process.platform === 'win32' ? 'junction' : 'dir');
		}
	}
}

async function verifyActionContracts() {
	const {homeDir} = await createHome();
	const calls = [];
	const exec = async (command, args, options) => {
		calls.push({command, args: [...args], options});
		return {code: 0, stdout: 'ok', stderr: ''};
	};

	const originalCodexHome = process.env.CODEX_HOME;
	const env = {...process.env, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_CONFIG_DIR: join(homeDir, '.claude')};
	await runSkillsAdd({source: '/tmp/source', skillNames: ['demo'], agents: ['cc'], copy: true, env}, undefined, exec);
	await runSkillsAdd({source: '/tmp/source', skillNames: ['demo'], agents: ['cx', 'cc'], env}, undefined, exec);
	await runSkillsRemove({skillNames: ['demo'], agents: ['cc', 'cx'], env}, undefined, exec);

	assert.equal(calls[0].args.includes('--copy'), true, '单侧物化必须显式 --copy');
	assert.equal(calls.every(call => call.args.includes('skills@latest')), true, '所有 mutation 必须使用官方 skills@latest');
	assert.equal(calls[1].args.includes('--copy'), false, '双侧投影不得使用 --copy');
	assert.deepEqual(agentsFromArgs(calls[1].args), ['codex', 'claude-code']);
	assert.deepEqual(agentsFromArgs(calls[2].args), ['claude-code', 'codex'], 'remove 必须支持重复 --agent');
	assert.equal(calls.every(call => call.options.env.CLAUDE_CONFIG_DIR === join(homeDir, '.claude')), true);
	assert.equal(process.env.CODEX_HOME, originalCodexHome, '子进程 env 不得污染父进程');
	console.log('[PASS] Skills action：copy / 有序 agents / 重复 remove agent / scoped env');
}

async function verifyTopologyFunctionsAndSnapshot() {
	const {homeDir, tempDir} = await createHome();
	for (const [name, topology] of [['c', 'claude-only'], ['x', 'codex-only'], ['b', 'shared']]) {
		await seedTopology(homeDir, name, topology);
		assert.equal(topologyOfInspection(await inspectSkillStorage(name, {homeDir})), topology);
	}

	assert.equal(targetTopologyOfDraft({cc: true, cx: false}), 'claude-only');
	assert.equal(targetTopologyOfDraft({cc: false, cx: true}), 'codex-only');
	assert.equal(targetTopologyOfDraft({cc: true, cx: true}), 'shared');
	assert.equal(targetTopologyOfDraft({cc: false, cx: false}), 'empty');

	const {createSkillSnapshot, cleanupSkillSnapshot} = await import('../src/core/skills-storage.ts');
	const snapshot = await createSkillSnapshot(join(homeDir, '.claude', 'skills', 'c'), 'c', {homeDir, tempDir});
	assert.ok(snapshot.manifest.length >= 3, 'snapshot 必须暴露已复检的内容 manifest');
	assert.equal(snapshot.manifest.some(entry => entry.startsWith('f:SKILL.md:')), true);
	await cleanupSkillSnapshot(snapshot);
	console.log('[PASS] Skills topology 纯函数与 snapshot manifest');
}

async function verifyTopologyTransitions() {
	const cases = [
		['claude-only', 'codex-only', ['remove', 'add'], ['claude-code'], 'canonical-only'],
		['claude-only', 'shared', ['add'], ['codex', 'claude-code'], 'shared-symlink'],
		['codex-only', 'claude-only', ['remove', 'add'], ['codex'], 'claude-only'],
		['codex-only', 'shared', ['add'], ['codex', 'claude-code'], 'shared-symlink'],
		['shared', 'claude-only', ['remove', 'add'], ['claude-code', 'codex'], 'claude-only'],
		['shared', 'codex-only', ['remove'], ['claude-code'], 'canonical-only']
	];

	for (const [current, target, verbs, firstAgents, expectedKind] of cases) {
		const {homeDir, tempDir} = await createHome();
		const name = `${current}-to-${target}`;
		await seedTopology(homeDir, name, current, 'preserved');
		const calls = [];
		const item = itemFor(homeDir, name, current);
		const result = await transitionSkillTopology(item, target, undefined, topologyExecEmulator(homeDir, calls), {homeDir, tempDir});
		assert.equal(result.outcome, 'complete', `${current} -> ${target} 应完成：${result.error ?? ''}`);
		assert.equal(result.success, true);
		assert.deepEqual(calls.map(call => call.verb), verbs);
		assert.deepEqual(calls[0].agents, firstAgents);
		if (verbs[0] === 'remove' && verbs.length > 1) {
			assert.equal(calls[0].after, 'missing', `${current} -> ${target} 必须先清空再物化`);
		}

		assert.equal((await inspectSkillStorage(name, {homeDir})).kind, expectedKind);
		const contentPath = target === 'claude-only' ? join(homeDir, '.claude', 'skills', name, 'scripts', 'run.txt') : join(homeDir, '.agents', 'skills', name, 'scripts', 'run.txt');
		assert.equal(await readFile(contentPath, 'utf8'), 'preserved');
		assert.equal(calls.every(call => call.options.env.HOME === homeDir && call.options.env.CLAUDE_CONFIG_DIR === join(homeDir, '.claude')), true);
		if (calls.some(call => call.agents.includes('codex'))) {
			assert.equal(calls.filter(call => call.agents.includes('codex')).every(call => call.options.env.CODEX_HOME === join(homeDir, '.agents')), true);
		}
	}

	for (const topology of ['claude-only', 'codex-only', 'shared']) {
		const {homeDir, tempDir} = await createHome();
		const name = `noop-${topology}`;
		await seedTopology(homeDir, name, topology);
		const calls = [];
		const result = await transitionSkillTopology(itemFor(homeDir, name, topology), topology, undefined, topologyExecEmulator(homeDir, calls), {homeDir, tempDir});
		assert.equal(result.success, true);
		assert.equal(result.mutated, false);
		assert.equal(calls.length, 0);
		assert.equal((await readdir(tempDir)).length, 0);
	}

	console.log('[PASS] C/X/B 六向转换与三种 no-op（Item 输入）');
}

async function verifyTopologyPartialAndBlocking() {
	const partialHome = await createHome();
	await seedTopology(partialHome.homeDir, 'partial-b', 'claude-only');
	const partialCalls = [];
	const partial = await transitionSkillTopology(
		itemFor(partialHome.homeDir, 'partial-b', 'claude-only'),
		'shared',
		undefined,
		topologyExecEmulator(partialHome.homeDir, partialCalls, {sharedMode: 'copy'}),
		{homeDir: partialHome.homeDir, tempDir: partialHome.tempDir}
	);
	assert.equal(partial.outcome, 'partial');
	assert.equal(partial.success, false);
	assert.ok(partial.recoveryPath);
	assert.equal((await readdir(partialHome.tempDir)).length, 1, 'partial 必须保留恢复快照');

	const blockedHome = await createHome();
	await seedTopology(blockedHome.homeDir, 'third-party', 'codex-only');
	const blockedCalls = [];
	const blocked = await transitionSkillTopology(
		itemFor(blockedHome.homeDir, 'third-party', 'codex-only', {extraAgents: ['Cursor']}),
		'claude-only',
		undefined,
		topologyExecEmulator(blockedHome.homeDir, blockedCalls),
		{homeDir: blockedHome.homeDir, tempDir: blockedHome.tempDir}
	);
	assert.equal(blocked.success, false);
	assert.equal(blocked.mutated, false);
	assert.match(blocked.error, /Cursor|其它 Agent/);
	assert.equal(blockedCalls.length, 0);
	console.log('[PASS] shared-copy 非成功 partial 与 Claude-only 第三方占用阻断（Item 输入）');
}

async function verifyTopologyRecoveryAndExitFacts() {
	const exitHome = await createHome();
	await seedTopology(exitHome.homeDir, 'exit-fact', 'claude-only');
	const exitCalls = [];
	const exitFact = await transitionSkillTopology(
		itemFor(exitHome.homeDir, 'exit-fact', 'claude-only'),
		'codex-only',
		undefined,
		topologyExecEmulator(exitHome.homeDir, exitCalls, {fail: ({verb}) => verb === 'remove'}),
		{homeDir: exitHome.homeDir, tempDir: exitHome.tempDir}
	);
	assert.equal(exitFact.outcome, 'complete', 'remove 非零但 missing 事实成立时应继续物化目标');
	assert.deepEqual(exitCalls.map(call => call.verb), ['remove', 'add']);

	const restoredHome = await createHome();
	await seedTopology(restoredHome.homeDir, 'restore-once', 'codex-only', 'original');
	const restoredCalls = [];
	const baseExec = topologyExecEmulator(restoredHome.homeDir, restoredCalls);
	let invocation = 0;
	const restored = await transitionSkillTopology(
		itemFor(restoredHome.homeDir, 'restore-once', 'codex-only'),
		'claude-only',
		undefined,
		async (command, args, options) => {
			invocation++;
			if (invocation === 2) {
				// 第二条命令（目标物化 add）模拟 no-op：返回成功但不物化，触发恢复。
				restoredCalls.push({command, args: [...args], options, verb: 'add', agents: agentsFromArgs(args), before: 'missing', after: 'missing'});
				return {code: 0, stdout: '', stderr: ''};
			}

			return baseExec(command, args, options);
		},
		{homeDir: restoredHome.homeDir, tempDir: restoredHome.tempDir}
	);
	assert.equal(restored.outcome, 'restored');
	assert.equal(restored.success, false, '恢复原拓扑是警告结果，不得冒充目标完成');
	assert.deepEqual(restoredCalls.map(call => call.verb), ['remove', 'add', 'remove', 'add']);
	assert.equal((await inspectSkillStorage('restore-once', {homeDir: restoredHome.homeDir})).kind, 'canonical-only');
	assert.equal(await readFile(join(restoredHome.homeDir, '.agents', 'skills', 'restore-once', 'scripts', 'run.txt'), 'utf8'), 'original');
	assert.equal((await readdir(restoredHome.tempDir)).length, 0, '拓扑物化恢复后应清理快照');

	const failedHome = await createHome();
	await seedTopology(failedHome.homeDir, 'restore-fails', 'codex-only');
	let failedInvocations = 0;
	const failed = await transitionSkillTopology(
		itemFor(failedHome.homeDir, 'restore-fails', 'codex-only'),
		'claude-only',
		undefined,
		async (_command, args, options) => {
			failedInvocations++;
			const agents = agentsFromArgs(args);
			if (args.includes('remove')) {
				await rm(join(failedHome.homeDir, '.claude', 'skills', 'restore-fails'), {recursive: true, force: true});
				await rm(join(failedHome.homeDir, '.agents', 'skills', 'restore-fails'), {recursive: true, force: true});
			}

			assert.ok(options.env);
			assert.ok(agents.length > 0);
			return {code: 0, stdout: '', stderr: ''};
		},
		{homeDir: failedHome.homeDir, tempDir: failedHome.tempDir}
	);
	assert.equal(failed.outcome, 'failed');
	assert.equal(failedInvocations, 4, '目标失败后只允许一次 cleanup + restore，不得递归恢复');
	assert.ok(failed.recoveryPath);
	assert.equal((await readdir(failedHome.tempDir)).length, 1);
	console.log('[PASS] exit/fact 对账与一次性自动恢复：restored 清快照，failed 保留快照（Item 输入）');
}

async function verifyCommandOutputDoesNotLeakIntoUiErrors() {
	const {homeDir, tempDir} = await createHome();
	const name = 'raw-output';
	await seedTopology(homeDir, name, 'claude-only');
	const interactiveOutput = '[1mSKILLS[0m\nSource: owner/repo\n/tmp/ccq-raw-source';
	const result = await transitionSkillTopology(
		itemFor(homeDir, name, 'claude-only'),
		'codex-only',
		undefined,
		async () => ({code: 0, stdout: interactiveOutput, stderr: interactiveOutput}),
		{homeDir, tempDir}
	);

	assert.equal(result.success, false);
	assert.ok(result.error);
	assert.equal(result.error.includes(interactiveOutput), false, '原始 CLI 输出不得成为 UI 错误文案');
	for (const fragment of ['SKILLS', 'Source:', '/tmp/ccq-raw-source']) {
		assert.equal(result.error.includes(fragment), false, `UI 错误不得泄漏 CLI 片段：${fragment}`);
	}

	assert.equal(//.test(result.error), false, 'UI 错误不得包含 ANSI 控制序列');
	console.log('[PASS] Skills CLI 原始 stdout/stderr 不泄漏到 UI 错误（Item 输入）');
}

async function verifyStorageKinds() {
	const {homeDir} = await createHome();
	assert.equal((await inspectSkillStorage('missing', {homeDir})).kind, 'missing');

	const claudeRoot = join(homeDir, '.claude', 'skills');
	const canonicalRoot = join(homeDir, '.agents', 'skills');
	await writeSkill(claudeRoot, 'claude-only');
	assert.equal((await inspectSkillStorage('claude-only', {homeDir})).kind, 'claude-only');

	await writeSkill(canonicalRoot, 'canonical-only');
	assert.equal((await inspectSkillStorage('canonical-only', {homeDir})).kind, 'canonical-only');

	const sharedCanonical = await writeSkill(canonicalRoot, 'shared-link');
	await symlink(sharedCanonical, join(claudeRoot, 'shared-link'), process.platform === 'win32' ? 'junction' : 'dir');
	assert.equal((await inspectSkillStorage('shared-link', {homeDir})).kind, 'shared-symlink');

	const copyCanonical = await writeSkill(canonicalRoot, 'shared-copy');
	await cp(copyCanonical, join(claudeRoot, 'shared-copy'), {recursive: true});
	assert.equal((await inspectSkillStorage('shared-copy', {homeDir})).kind, 'shared-copy');

	await writeSkill(canonicalRoot, 'conflict', 'canonical');
	await writeSkill(claudeRoot, 'conflict', 'claude');
	assert.equal((await inspectSkillStorage('conflict', {homeDir})).kind, 'conflict');

	await mkdir(join(claudeRoot, 'invalid'), {recursive: true});
	await writeFile(join(claudeRoot, 'invalid', 'SKILL.md'), '# Missing frontmatter\n', 'utf8');
	assert.equal((await inspectSkillStorage('invalid', {homeDir})).kind, 'invalid');

	await symlink(join(homeDir, 'missing-target'), join(claudeRoot, 'broken-link'), process.platform === 'win32' ? 'junction' : 'dir');
	assert.equal((await inspectSkillStorage('broken-link', {homeDir})).kind, 'invalid-link');

	if (process.platform !== 'win32') {
		const escaping = await writeSkill(claudeRoot, 'escaping-link');
		const outside = join(homeDir, 'outside.txt');
		await writeFile(outside, 'outside', 'utf8');
		await symlink(outside, join(escaping, 'outside-link'));
		assert.equal((await inspectSkillStorage('escaping-link', {homeDir})).kind, 'invalid');
	}

	console.log('[PASS] Skills storage：Claude-only/canonical-only/symlink/copy/conflict/invalid 分类');
}

// claude-only → shared 收编（替代旧 adoptClaudeOnlySkill）：official 双 Agent add 物化 shared。
async function verifyAdoption() {
	const {homeDir, tempDir} = await createHome();
	await seedTopology(homeDir, 'adopt-me', 'claude-only');
	const calls = [];
	const result = await transitionSkillTopology(
		itemFor(homeDir, 'adopt-me', 'claude-only'),
		'shared',
		undefined,
		installEmulator(homeDir, 'link', calls),
		{homeDir, tempDir}
	);

	assert.equal(result.outcome, 'complete');
	assert.equal(result.success, true);
	assert.equal(result.mutated, true, '官方 add 已启动后必须标记 mutation，供视图决定最终刷新');
	assert.equal(calls.length, 1);
	assert.deepEqual(agentsFromArgs(calls[0].args), ['codex', 'claude-code'], '收编必须按 Codex + Claude Code 双 Agent 调用官方 add');
	assert.equal(calls[0].args.includes('--copy'), false);
	assert.equal((await readdir(tempDir)).length, 0, '完整收编后应清理目标树外快照');

	const failedHome = await createHome();
	const failedClaude = await writeSkill(join(failedHome.homeDir, '.claude', 'skills'), 'lost-during-add');
	const failed = await transitionSkillTopology(
		itemFor(failedHome.homeDir, 'lost-during-add', 'claude-only'),
		'shared',
		undefined,
		async () => {
			await rm(failedClaude, {recursive: true, force: true});
			return {code: 1, stdout: '', stderr: 'simulated failure'};
		},
		{homeDir: failedHome.homeDir, tempDir: failedHome.tempDir}
	);
	assert.equal(failed.success, false);
	assert.equal(failed.mutated, true, '命令失败但可能已修改目标树时必须标记 mutation');
	assert.ok(failed.recoveryPath, '两侧都失效时必须保留恢复快照');
	assert.match(await readFile(join(failed.recoveryPath, 'SKILL.md'), 'utf8'), /name: lost-during-add/);

	console.log('[PASS] Claude-only → shared 收编：目标树外快照 + 官方双 Agent add + complete postflight（Item 输入）');
}

async function verifyPartialAndRepair() {
	const partialHome = await createHome();
	await seedTopology(partialHome.homeDir, 'partial', 'claude-only');
	const partial = await transitionSkillTopology(
		itemFor(partialHome.homeDir, 'partial', 'claude-only'),
		'shared',
		undefined,
		installEmulator(partialHome.homeDir, 'copy', []),
		{homeDir: partialHome.homeDir, tempDir: partialHome.tempDir}
	);
	assert.equal(partial.outcome, 'partial');
	assert.equal(partial.success, false);
	assert.ok(partial.recoveryPath);

	const repairHome = await createHome();
	await seedTopology(repairHome.homeDir, 'repair-me', 'codex-only');
	const repaired = await transitionSkillTopology(
		itemFor(repairHome.homeDir, 'repair-me', 'codex-only'),
		'shared',
		undefined,
		installEmulator(repairHome.homeDir, 'link', []),
		{homeDir: repairHome.homeDir, tempDir: repairHome.tempDir}
	);
	assert.equal(repaired.outcome, 'complete');
	assert.equal(repaired.success, true, 'Codex-only canonical → shared 应从快照补齐 Claude 投影');

	console.log('[PASS] Windows copy partial 与 Codex-only → shared 补齐 Claude 投影（Item 输入）');
}

// `.codex` 收编（design §8.4）：非受管 `.codex` 实体即使目标侧不变也必须迁移到受管 `.agents`。
async function verifyCodexMigration() {
	const {homeDir, tempDir} = await createHome();
	await mkdir(join(homeDir, '.codex', 'skills'), {recursive: true});
	await writeSkill(join(homeDir, '.codex', 'skills'), 'legacy', 'preserved');
	const calls = [];
	const item = itemFor(homeDir, 'legacy', 'codex-only', {location: 'codex', source: 'o/legacy'});
	const result = await transitionSkillTopology(item, 'codex-only', undefined, topologyExecEmulator(homeDir, calls), {homeDir, tempDir});
	assert.equal(result.outcome, 'complete', `.codex → codex-only 收编应完成：${result.error ?? ''}`);
	assert.equal(result.success, true);
	assert.equal(result.mutated, true);
	assert.equal((await inspectSkillStorage('legacy', {homeDir})).kind, 'canonical-only', '收编后受管根必须是 canonical-only');
	assert.equal(await readFile(join(homeDir, '.agents', 'skills', 'legacy', 'scripts', 'run.txt'), 'utf8'), 'preserved', '内容必须从 .codex 源保留');
	await assert.rejects(() => access(join(homeDir, '.codex', 'skills', 'legacy')), undefined, '.codex 非受管旧源必须被定向删除');

	// no-op 防御：已在受管 `.agents` 的 codex-only 不触发任何命令。
	const managedHome = await createHome();
	await seedTopology(managedHome.homeDir, 'managed', 'codex-only');
	const managedCalls = [];
	const managed = await transitionSkillTopology(
		itemFor(managedHome.homeDir, 'managed', 'codex-only'),
		'codex-only',
		undefined,
		topologyExecEmulator(managedHome.homeDir, managedCalls),
		{homeDir: managedHome.homeDir, tempDir: managedHome.tempDir}
	);
	assert.equal(managed.success, true);
	assert.equal(managed.mutated, false);
	assert.equal(managedCalls.length, 0);

	console.log('[PASS] .codex 收编：official add 物化 .agents + 定向删除旧源；受管 codex-only 保持 no-op');
}

function installEmulator(homeDir, mode, calls) {
	return async (command, args) => {
		calls.push({command, args: [...args]});
		const addIndex = args.indexOf('add');
		const skillIndex = args.indexOf('--skill');
		const source = args[addIndex + 1];
		const name = args[skillIndex + 1];
		const canonical = join(homeDir, '.agents', 'skills', name);
		const claude = join(homeDir, '.claude', 'skills', name);
		await rm(canonical, {recursive: true, force: true});
		await rm(claude, {recursive: true, force: true});
		await cp(join(source, name), canonical, {recursive: true});
		if (mode === 'copy') {
			await cp(canonical, claude, {recursive: true});
		} else {
			await symlink(canonical, claude, process.platform === 'win32' ? 'junction' : 'dir');
		}

		return {code: 0, stdout: '', stderr: ''};
	};
}

async function verifySourceReplacement() {
	// 异源替换：shared(old) → cx target → add 新源 + 定向清理 Claude 投影（不再 spawn remove、不读 lock）。
	const {homeDir, tempDir} = await createHome();
	const canonicalRoot = join(homeDir, '.agents', 'skills');
	const claudeRoot = join(homeDir, '.claude', 'skills');
	const canonical = await writeSkill(canonicalRoot, 'same', 'old');
	await symlink(canonical, join(claudeRoot, 'same'), process.platform === 'win32' ? 'junction' : 'dir');
	const commands = [];
	const exec = async (_command, args) => {
		const verb = args.includes('add') ? 'add' : 'remove';
		commands.push(verb);
		if (verb === 'add') {
			await rm(canonical, {recursive: true, force: true});
			await writeSkill(canonicalRoot, 'same', 'new');
		}

		return {code: 0, stdout: '', stderr: ''};
	};

	const installed = groupInstalledSkillItems([
		{name: 'same', path: canonical, scope: 'global', agents: ['Codex'], source: 'old/repo'},
		{name: 'same', path: join(claudeRoot, 'same'), scope: 'global', agents: ['Claude Code'], source: 'old/repo'}
	]);
	const execution = await installSearchResultsToTargets(
		[{name: 'new/repo@same', source: 'new/repo', description: ''}],
		['cx'],
		undefined,
		exec,
		{installed, storage: {homeDir, tempDir}}
	);
	assert.deepEqual(commands, ['add'], 'add 经官方 exec；Claude 投影由定向 fs 删除，不再 spawn remove 或读 lock');
	assert.equal(execution.replacements[0]?.success, true);
	assert.equal((await inspectSkillStorage('same', {homeDir})).kind, 'canonical-only');
	assert.equal((await readdir(tempDir)).length, 1, '最终 detection 确认前必须保留旧内容快照');
	await cleanupConfirmedReplacementSnapshots(execution.replacements, []);
	assert.equal((await readdir(tempDir)).length, 1, '未被最终 detection 确认的替换不得清理快照');
	await cleanupConfirmedReplacementSnapshots(execution.replacements, [execution.replacements[0].key]);
	assert.equal((await readdir(tempDir)).length, 0, '只有最终 detection 确认的替换才能清理快照');

	// C6 异源保留：itemA(canonical old) + itemB(claude other) → 只覆盖占用目标根的 itemA，itemB 原样保留。
	const duoHome = await createHome();
	const duoCanonicalRoot = join(duoHome.homeDir, '.agents', 'skills');
	const duoClaudeRoot = join(duoHome.homeDir, '.claude', 'skills');
	await writeSkill(duoCanonicalRoot, 'duo', 'old');
	await writeSkill(duoClaudeRoot, 'duo', 'other');
	const duoInstalled = groupInstalledSkillItems([
		{name: 'duo', path: join(duoCanonicalRoot, 'duo'), scope: 'global', agents: ['Codex'], source: 'old/repo'},
		{name: 'duo', path: join(duoClaudeRoot, 'duo'), scope: 'global', agents: ['Claude Code'], source: 'other/repo'}
	]);
	assert.equal(duoInstalled.length, 2, '异源同名必须拆成两个 Item');
	const duo = await installSearchResultsToTargets(
		[{name: 'new/repo@duo', source: 'new/repo', description: ''}],
		['cx'],
		undefined,
		async (_command, args) => {
			if (args.includes('add')) {
				await rm(join(duoCanonicalRoot, 'duo'), {recursive: true, force: true});
				await writeSkill(duoCanonicalRoot, 'duo', 'new');
			}

			return {code: 0, stdout: '', stderr: ''};
		},
		{installed: duoInstalled, storage: {homeDir: duoHome.homeDir, tempDir: duoHome.tempDir}}
	);
	assert.equal(duo.replacements[0]?.success, true, '覆盖占用目标根的异源 Item 应成功');
	assert.equal(await readFile(join(duoCanonicalRoot, 'duo', 'scripts', 'run.txt'), 'utf8'), 'new', 'canonical 应被新源覆盖');
	assert.equal(await readFile(join(duoClaudeRoot, 'duo', 'scripts', 'run.txt'), 'utf8'), 'other', '其它根的异源 Item 必须原样保留');

	// Shared 目标可能同时覆盖两个根中来自不同来源的实例；每个被覆盖 Item 都必须独立快照。
	const multiRootHome = await createHome();
	const multiAgentsRoot = join(multiRootHome.homeDir, '.agents', 'skills');
	const multiClaudeRoot = join(multiRootHome.homeDir, '.claude', 'skills');
	await writeSkill(multiAgentsRoot, 'multi', 'old-agents');
	await writeSkill(multiClaudeRoot, 'multi', 'old-claude');
	const multiInstalled = groupInstalledSkillItems([
		{name: 'multi', path: join(multiAgentsRoot, 'multi'), scope: 'global', agents: ['Codex'], source: 'old/agents'},
		{name: 'multi', path: join(multiClaudeRoot, 'multi'), scope: 'global', agents: ['Claude Code'], source: 'old/claude'}
	]);
	const multi = await installSearchResultsToTargets(
		[{name: 'new/repo@multi', source: 'new/repo', description: ''}],
		['cc', 'cx'],
		undefined,
		async (_command, args) => {
			if (args.includes('add')) {
				await rm(join(multiAgentsRoot, 'multi'), {recursive: true, force: true});
				await rm(join(multiClaudeRoot, 'multi'), {recursive: true, force: true});
				await writeSkill(multiAgentsRoot, 'multi', 'new');
				await writeSkill(multiClaudeRoot, 'multi', 'new');
			}

			return {code: 0, stdout: '', stderr: ''};
		},
		{installed: multiInstalled, storage: {homeDir: multiRootHome.homeDir, tempDir: multiRootHome.tempDir}}
	);
	assert.equal(multi.replacements.length, 2, 'Shared 覆盖两个根的异源实例时必须产生两个 replacement');
	assert.deepEqual(
		multi.replacements.map(item => item.oldSource).sort(),
		['old/agents', 'old/claude'],
		'两个目标根中的旧来源都必须被纳入替换事务'
	);
	const recoveredBySource = new Map(await Promise.all(multi.replacements.map(async item => [
		item.oldSource,
		await readFile(join(item.recoveryPath, 'scripts', 'run.txt'), 'utf8')
	])));
	assert.equal(recoveredBySource.get('old/agents'), 'old-agents', '.agents 占用者必须从自身投影创建恢复快照');
	assert.equal(recoveredBySource.get('old/claude'), 'old-claude', '.claude 占用者必须从自身投影创建恢复快照');
	assert.equal((await inspectSkillStorage('multi', {homeDir: multiRootHome.homeDir})).kind, 'shared-copy');
	await cleanupConfirmedReplacementSnapshots(multi.replacements, [multi.replacements[0].key]);
	assert.equal((await readdir(multiRootHome.tempDir)).length, 0, '同一新实例确认后必须清理其全部旧来源快照');

	// 同源拒绝：installed 同源 → prepareReplacements 抛错，batch 失败，不 spawn add。
	const sameSourceHome = await createHome();
	const sameCanonicalRoot = join(sameSourceHome.homeDir, '.agents', 'skills');
	await writeSkill(sameCanonicalRoot, 'dup');
	const sameInstalled = groupInstalledSkillItems([
		{name: 'dup', path: join(sameCanonicalRoot, 'dup'), scope: 'global', agents: ['Codex'], source: 'same/repo'}
	]);
	let sameSpawned = false;
	const sameResult = await installSearchResultsToTargets(
		[{name: 'same/repo@dup', source: 'same/repo', description: ''}],
		['cx'],
		undefined,
		async () => {
			sameSpawned = true;
			return {code: 0, stdout: '', stderr: ''};
		},
		{installed: sameInstalled, storage: {homeDir: sameSourceHome.homeDir, tempDir: sameSourceHome.tempDir}}
	);
	assert.equal(sameSpawned, false, '同源覆盖应在 add 前拒绝');
	assert.equal(sameResult.batches[0]?.result.success, false, '同源覆盖 batch 必须失败');

	// orphan 阻断：未被检测识别的 canonical 拒绝自动覆盖。
	const orphanHome = await createHome();
	await writeSkill(join(orphanHome.homeDir, '.agents', 'skills'), 'orphan');
	let orphanSpawned = false;
	await assert.rejects(
		() =>
			installSearchResultsToTargets(
				[{name: 'new/repo@orphan', source: 'new/repo', description: ''}],
				['cx'],
				undefined,
				async () => {
					orphanSpawned = true;
					return {code: 0, stdout: '', stderr: ''};
				},
				{installed: [], storage: {homeDir: orphanHome.homeDir, tempDir: orphanHome.tempDir}}
			),
		/未被检测识别|拒绝自动覆盖/
	);
	assert.equal(orphanSpawned, false, '孤儿 canonical 必须在 spawn 前阻止覆盖');

	console.log('[PASS] 同名来源替换：定向清理 Claude 投影、异源 Item 保留、同源拒绝与 orphan 阻断');
}

try {
	await verifyActionContracts();
	await verifyTopologyFunctionsAndSnapshot();
	await verifyStorageKinds();
	await verifyAdoption();
	await verifyPartialAndRepair();
	await verifyCodexMigration();
	await verifyTopologyTransitions();
	await verifyTopologyPartialAndBlocking();
	await verifyTopologyRecoveryAndExitFacts();
	await verifyCommandOutputDoesNotLeakIntoUiErrors();
	await verifySourceReplacement();
} finally {
	await Promise.all(roots.map(root => rm(root, {recursive: true, force: true})));
}
