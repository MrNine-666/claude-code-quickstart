import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectSkillStorage} from '../src/core/skills-storage.ts';
import {runSkillsAdd, runSkillsRemove} from '../src/core/skills-actions.ts';
import {
	adoptClaudeOnlySkill,
	repairClaudeProjection,
	targetTopologyOfDraft,
	topologyOfInspection,
	transitionSkillTopology
} from '../src/services/skills-adoption.ts';
import {
	cleanupConfirmedReplacementSnapshots,
	installSearchResultsToTargets
} from '../src/services/skills-service.ts';

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

function sharedRow(name, {claude = true, codex = false} = {}) {
	return {
		name,
		path: '',
		scope: 'global',
		sharedInstalled: codex,
		claudeInjected: claude,
		codexAvailable: codex,
		agents: [claude ? 'Claude Code' : undefined, codex ? 'Codex' : undefined].filter(Boolean),
		otherAgents: []
	};
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
	assert.equal(calls.every(call => call.args.includes('skills@1.5.19')), true, '所有 mutation 必须固定官方 skills@1.5.19');
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
		const row = {...sharedRow(name), storage: await inspectSkillStorage(name, {homeDir})};
		const result = await transitionSkillTopology(row, target, undefined, topologyExecEmulator(homeDir, calls), {homeDir, tempDir});
		assert.equal(result.outcome, 'complete', `${current} -> ${target} 应完成：${result.error ?? ''}`);
		assert.equal(result.success, true);
		assert.deepEqual(calls.map(call => call.verb), verbs);
		assert.deepEqual(calls[0].agents, firstAgents);
		if (verbs[0] === 'remove' && verbs.length > 1) {
			assert.equal(calls[0].after, 'missing', `${current} -> ${target} 必须先清空再物化`);
		}
		assert.equal((await inspectSkillStorage(name, {homeDir})).kind, expectedKind);
		const contentPath = target === 'claude-only'
			? join(homeDir, '.claude', 'skills', name, 'scripts', 'run.txt')
			: join(homeDir, '.agents', 'skills', name, 'scripts', 'run.txt');
		assert.equal(await readFile(contentPath, 'utf8'), 'preserved');
		assert.equal(calls.every(call => call.options.env.HOME === homeDir && call.options.env.CLAUDE_CONFIG_DIR === join(homeDir, '.claude')), true);
		if (calls.some(call => call.agents.includes('codex'))) {
			assert.equal(calls.filter(call => call.agents.includes('codex')).every(call => call.options.env.CODEX_HOME === join(homeDir, '.agents')), true);
		}
	}

	for (const topology of ['claude-only', 'codex-only', 'shared']) {
		const {homeDir, tempDir} = await createHome();
		await seedTopology(homeDir, `noop-${topology}`, topology);
		const calls = [];
		const name = `noop-${topology}`;
		const result = await transitionSkillTopology(
			{...sharedRow(name), storage: await inspectSkillStorage(name, {homeDir})},
			topology,
			undefined,
			topologyExecEmulator(homeDir, calls),
			{homeDir, tempDir}
		);
		assert.equal(result.success, true);
		assert.equal(result.mutated, false);
		assert.equal(calls.length, 0);
		assert.equal((await readdir(tempDir)).length, 0);
	}

	console.log('[PASS] C/X/B 六向转换与三种 no-op');
}

async function verifyTopologyPartialAndBlocking() {
	const partialHome = await createHome();
	await seedTopology(partialHome.homeDir, 'partial-b', 'claude-only');
	const partialCalls = [];
	const partial = await transitionSkillTopology(
		{...sharedRow('partial-b'), storage: await inspectSkillStorage('partial-b', {homeDir: partialHome.homeDir})},
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
		{...sharedRow('third-party', {claude: false, codex: true}), agents: ['Codex', 'Cursor'], otherAgents: ['Cursor'], storage: await inspectSkillStorage('third-party', {homeDir: blockedHome.homeDir})},
		'claude-only',
		undefined,
		topologyExecEmulator(blockedHome.homeDir, blockedCalls),
		{homeDir: blockedHome.homeDir, tempDir: blockedHome.tempDir}
	);
	assert.equal(blocked.success, false);
	assert.equal(blocked.mutated, false);
	assert.match(blocked.error, /Cursor|其它 Agent/);
	assert.equal(blockedCalls.length, 0);
	console.log('[PASS] shared-copy 非成功 partial 与 Claude-only 第三方占用阻断');
}

async function verifyTopologyRecoveryAndExitFacts() {
	const exitHome = await createHome();
	await seedTopology(exitHome.homeDir, 'exit-fact', 'claude-only');
	const exitCalls = [];
	const exitFact = await transitionSkillTopology(
		{...sharedRow('exit-fact'), storage: await inspectSkillStorage('exit-fact', {homeDir: exitHome.homeDir})},
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
		{...sharedRow('restore-once', {claude: false, codex: true}), storage: await inspectSkillStorage('restore-once', {homeDir: restoredHome.homeDir})},
		'claude-only',
		undefined,
		async (command, args, options) => {
			invocation++;
			if (invocation === 2) {
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
	assert.equal((await readdir(restoredHome.tempDir)).length, 0, 'manifest 等价恢复后应清理快照');

	const failedHome = await createHome();
	await seedTopology(failedHome.homeDir, 'restore-fails', 'codex-only');
	let failedInvocations = 0;
	const failed = await transitionSkillTopology(
		{...sharedRow('restore-fails', {claude: false, codex: true}), storage: await inspectSkillStorage('restore-fails', {homeDir: failedHome.homeDir})},
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
	console.log('[PASS] exit/fact 对账与一次性自动恢复：restored 清快照，failed 保留快照');
}

async function verifyCommandOutputDoesNotLeakIntoUiErrors() {
	const {homeDir, tempDir} = await createHome();
	const name = 'raw-output';
	await seedTopology(homeDir, name, 'claude-only');
	const interactiveOutput = '\u001b[1mSKILLS\u001b[0m\nSource: owner/repo\n/tmp/ccq-raw-source';
	const result = await transitionSkillTopology(
		{...sharedRow(name), storage: await inspectSkillStorage(name, {homeDir})},
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
	assert.equal(/\u001b/.test(result.error), false, 'UI 错误不得包含 ANSI 控制序列');
	console.log('[PASS] Skills CLI 原始 stdout/stderr 不泄漏到 UI 错误');
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

	await symlink(
		join(homeDir, 'missing-target'),
		join(claudeRoot, 'broken-link'),
		process.platform === 'win32' ? 'junction' : 'dir'
	);
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

async function verifyAdoption() {
	const {homeDir, tempDir} = await createHome();
	await writeSkill(join(homeDir, '.claude', 'skills'), 'adopt-me');
	const calls = [];
	const result = await adoptClaudeOnlySkill(
		sharedRow('adopt-me'),
		undefined,
		installEmulator(homeDir, 'link', calls),
		{homeDir, tempDir}
	);

	assert.equal(result.outcome, 'complete');
	assert.equal(result.success, true);
	assert.equal(result.mutated, true, '官方 add 已启动后必须标记 mutation，供视图决定最终刷新');
	assert.equal(calls.length, 1);
	const args = calls[0].args;
	assert.deepEqual(
		args.filter((value, index) => args[index - 1] === '--agent'),
		['codex', 'claude-code'],
		'收编必须按 Codex + Claude Code 双 Agent 调用官方 add'
	);
	assert.equal(args.includes('--copy'), false);
	assert.equal((await readdir(tempDir)).length, 0, '完整收编后应清理目标树外快照');

	const failedHome = await createHome();
	const failedClaude = await writeSkill(join(failedHome.homeDir, '.claude', 'skills'), 'lost-during-add');
	const failed = await adoptClaudeOnlySkill(
		sharedRow('lost-during-add'),
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

	console.log('[PASS] Claude-only 收编：目标树外快照 + 官方双 Agent add + complete postflight');
}

async function verifyPartialAndRepair() {
	const partialHome = await createHome();
	await writeSkill(join(partialHome.homeDir, '.claude', 'skills'), 'partial');
	const partial = await adoptClaudeOnlySkill(
		sharedRow('partial'),
		undefined,
		installEmulator(partialHome.homeDir, 'copy', []),
		{homeDir: partialHome.homeDir, tempDir: partialHome.tempDir}
	);
	assert.equal(partial.outcome, 'partial');
	assert.equal(partial.success, false);
	assert.ok(partial.recoveryPath);

	const repairHome = await createHome();
	await writeSkill(join(repairHome.homeDir, '.agents', 'skills'), 'repair-me');
	const repaired = await repairClaudeProjection(
		sharedRow('repair-me', {claude: false, codex: true}),
		undefined,
		installEmulator(repairHome.homeDir, 'link', []),
		{homeDir: repairHome.homeDir, tempDir: repairHome.tempDir}
	);
	assert.equal(repaired.outcome, 'complete');
	assert.equal(repaired.success, true, 'Codex-only 且无 lock source 时仍应从 canonical 快照恢复 Claude 投影');

	console.log('[PASS] Windows copy partial 与 Codex-only canonical 快照修复闭环');
}

async function verifySourceReplacement() {
	const {homeDir, tempDir} = await createHome();
	const canonicalRoot = join(homeDir, '.agents', 'skills');
	const claudeRoot = join(homeDir, '.claude', 'skills');
	const canonical = await writeSkill(canonicalRoot, 'same', 'old');
	await symlink(canonical, join(claudeRoot, 'same'), process.platform === 'win32' ? 'junction' : 'dir');
	const commands = [];
	const exec = async (_command, args) => {
		const verb = args.includes('add') ? 'add' : args.includes('remove') ? 'remove' : 'unknown';
		commands.push(verb);
		if (verb === 'add') {
			await rm(canonical, {recursive: true, force: true});
			await writeSkill(canonicalRoot, 'same', 'new');
		} else if (verb === 'remove') {
			await rm(join(claudeRoot, 'same'), {recursive: true, force: true});
		}
		return {code: 0, stdout: '', stderr: ''};
	};
	const installed = [{...sharedRow('same', {claude: true, codex: true}), source: 'old/repo'}];
	const execution = await installSearchResultsToTargets(
		[{name: 'new/repo@same', source: 'new/repo', description: ''}],
		['cx'],
		undefined,
		exec,
		{
			installed,
			storage: {homeDir, tempDir},
			readLockMetadata: async () => new Map([['same', {source: 'new/repo'}]])
		}
	);
	assert.deepEqual(commands, ['add', 'remove'], '替换顺序必须是 add → postflight → 清理未选 Claude 投影');
	assert.equal(execution.replacements[0]?.success, true);
	assert.equal((await inspectSkillStorage('same', {homeDir})).kind, 'canonical-only');
	assert.equal((await readdir(tempDir)).length, 1, '最终共享 detection 确认前必须保留旧内容快照');
	await cleanupConfirmedReplacementSnapshots(execution.replacements, []);
	assert.equal((await readdir(tempDir)).length, 1, '未被最终 detection 确认的替换不得清理快照');
	await cleanupConfirmedReplacementSnapshots(execution.replacements, [execution.replacements[0].key]);
	assert.equal((await readdir(tempDir)).length, 0, '只有最终 detection 确认的替换才能清理快照');

	const lockLossHome = await createHome();
	const lockLossCanonicalRoot = join(lockLossHome.homeDir, '.agents', 'skills');
	const lockLossClaudeRoot = join(lockLossHome.homeDir, '.claude', 'skills');
	const lockLossCanonical = await writeSkill(lockLossCanonicalRoot, 'same', 'old');
	await symlink(lockLossCanonical, join(lockLossClaudeRoot, 'same'), process.platform === 'win32' ? 'junction' : 'dir');
	let lockReads = 0;
	const lockLoss = await installSearchResultsToTargets(
		[{name: 'new/repo@same', source: 'new/repo', description: ''}],
		['cx'],
		undefined,
		async (_command, args) => {
			if (args.includes('add')) {
				await rm(lockLossCanonical, {recursive: true, force: true});
				await writeSkill(lockLossCanonicalRoot, 'same', 'new');
			} else {
				await rm(join(lockLossClaudeRoot, 'same'), {recursive: true, force: true});
			}

			return {code: 0, stdout: '', stderr: ''};
		},
		{
			installed,
			storage: {homeDir: lockLossHome.homeDir, tempDir: lockLossHome.tempDir},
			readLockMetadata: async () => ++lockReads === 1
				? new Map([['same', {source: 'new/repo'}]])
				: new Map()
		}
	);
	assert.equal(lockLoss.replacements[0]?.success, false, 'targeted remove 删除 lock 后不得提前报告替换成功');
	assert.ok(lockLoss.replacements[0]?.recoveryPath, 'remove 后最终 lock 对账失败必须保留旧内容快照');
	assert.equal((await readdir(lockLossHome.tempDir)).length, 1);

	const failedHome = await createHome();
	const failedCanonicalRoot = join(failedHome.homeDir, '.agents', 'skills');
	const failedClaudeRoot = join(failedHome.homeDir, '.claude', 'skills');
	const failedCanonical = await writeSkill(failedCanonicalRoot, 'same', 'old');
	await symlink(failedCanonical, join(failedClaudeRoot, 'same'), process.platform === 'win32' ? 'junction' : 'dir');
	const failedCommands = [];
	const failed = await installSearchResultsToTargets(
		[{name: 'new/repo@same', source: 'new/repo', description: ''}],
		['cx'],
		undefined,
		async (_command, args) => {
			failedCommands.push(args.includes('add') ? 'add' : 'remove');
			if (args.includes('add')) {
				await rm(failedCanonical, {recursive: true, force: true});
				await writeSkill(failedCanonicalRoot, 'same', 'new');
			}
			return {code: 0, stdout: '', stderr: ''};
		},
		{
			installed,
			storage: {homeDir: failedHome.homeDir, tempDir: failedHome.tempDir},
			readLockMetadata: async () => new Map([['same', {source: 'old/repo'}]])
		}
	);
	assert.deepEqual(failedCommands, ['add'], 'lock/postflight 失败不得执行后置 remove');
	assert.equal(failed.replacements[0]?.success, false);
	assert.ok(failed.replacements[0]?.recoveryPath, '替换失败必须保留旧内容恢复快照');

	const orphanHome = await createHome();
	await writeSkill(join(orphanHome.homeDir, '.agents', 'skills'), 'orphan');
	let orphanSpawned = false;
	await assert.rejects(
		() => installSearchResultsToTargets(
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

	console.log('[PASS] 同名来源替换：直接 add、lock postflight、成功后清理与失败保留快照');
}

try {
	await verifyActionContracts();
	await verifyTopologyFunctionsAndSnapshot();
	await verifyStorageKinds();
	await verifyAdoption();
	await verifyPartialAndRepair();
	await verifyTopologyTransitions();
	await verifyTopologyPartialAndBlocking();
	await verifyTopologyRecoveryAndExitFacts();
	await verifyCommandOutputDoesNotLeakIntoUiErrors();
	await verifySourceReplacement();
} finally {
	await Promise.all(roots.map(root => rm(root, {recursive: true, force: true})));
}
