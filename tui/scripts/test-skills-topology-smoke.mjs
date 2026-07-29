import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execCommand} from '../src/core/exec.ts';
import {createSkillsChildEnv, runSkillsAdd} from '../src/core/skills-actions.ts';
import {detectInstalledSkillItems} from '../src/core/skills-installed.ts';
import {inspectSkillStorage, readSkillManifest} from '../src/core/skills-storage.ts';
import {transitionSkillTopology} from '../src/services/skills-adoption.ts';

const root = await mkdtemp(join(tmpdir(), 'ccq-skills-topology-smoke-'));
const previousNpmCache = process.env.npm_config_cache;
process.env.npm_config_cache = join(root, 'npm-cache');

async function createFixture(label, topology) {
	const homeDir = join(root, label, 'home');
	const tempDir = join(root, label, 'temp');
	const sourceRoot = join(root, label, 'source');
	const name = `smoke-${label}`;
	const skillDir = join(sourceRoot, name);
	await mkdir(skillDir, {recursive: true});
	await mkdir(tempDir, {recursive: true});
	await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: Isolated topology smoke\n---\n\n${label}\n`, 'utf8');

	const agents = topology === 'claude-only' ? ['cc'] : topology === 'codex-only' ? ['cx'] : ['cx', 'cc'];
	const seeded = await runSkillsAdd({
		source: sourceRoot,
		skillNames: [name],
		agents,
		copy: topology !== 'shared',
		env: createSkillsChildEnv(homeDir, topology !== 'claude-only')
	});
	assert.equal(seeded.success, true, `seed ${topology} failed: ${seeded.stderr || seeded.error || ''}`);
	return {name, homeDir, tempDir};
}

// 把官方 list/检测命令限定到 fixture HOME，避免污染真实用户环境。
// 包装层自行注入 env，detectInstalledSkillItems 的 ExecFn 只传 timeout 也足够。
function scopedExec(homeDir) {
	const env = createSkillsChildEnv(homeDir, true);
	return (command, args, options = {}) => execCommand(command, args, {...options, env});
}

// 逻辑实例契约（task 07-28）：transitionSkillTopology 收 InstalledSkillItem，
// 从 agents 派生当前拓扑、从 projections 派生存储根。这里由 official inspection
// 的 claudeValid/canonicalValid 还原 Item，不重新枚举目录。fixture 均为受管根
//（.claude/.agents），不含 .codex，故 needsManagedMigration 恒不触发收编分支。
//
// 注意：row() 用 known provenance 只是给迁移事务提供可证明来源；真实 CLI list 对
// 本地 path 安装通常不返回 source/sourceUrl，检测链会把它们归为 unknown（见下方断言）。
function row(name, storage) {
	const agents = [
		...(storage.claudeValid ? ['Claude Code'] : []),
		...(storage.canonicalValid ? ['Codex'] : [])
	];
	const projections = [];
	if (storage.canonicalValid) {
		projections.push({path: storage.canonicalPath, root: 'agents', scope: 'global', agents});
	}
	if (storage.claudeValid) {
		projections.push({path: storage.claudePath, root: 'claude', scope: 'global', agents});
	}
	return {
		id: JSON.stringify(['known', name, 'raw:smoke']),
		name,
		provenance: {kind: 'known', identity: 'raw:smoke', installSource: 'smoke'},
		agents,
		projections,
		capabilities: {update: true, manageAgents: true, migrate: true, delete: true}
	};
}

const cases = [
	['claude-only', 'codex-only', 'canonical-only'],
	['claude-only', 'shared', 'shared-symlink'],
	['codex-only', 'claude-only', 'claude-only'],
	['codex-only', 'shared', 'shared-symlink'],
	['shared', 'claude-only', 'claude-only'],
	['shared', 'codex-only', 'canonical-only']
];

try {
	for (const [current, target, expectedKind] of cases) {
		const fixture = await createFixture(`${current}-to-${target}`, current);
		const before = await inspectSkillStorage(fixture.name, {homeDir: fixture.homeDir});
		assert.equal(before.kind, current === 'codex-only' ? 'canonical-only' : current === 'shared' ? 'shared-symlink' : 'claude-only');
		const beforeManifest = await readSkillManifest(
			current === 'claude-only' ? before.claudePath : before.canonicalPath,
			fixture.name
		);
		const result = await transitionSkillTopology(row(fixture.name, before), target, undefined, undefined, fixture);
		assert.equal(result.outcome, 'complete', `${current} -> ${target}: ${result.error ?? ''}`);
		const after = await inspectSkillStorage(fixture.name, {homeDir: fixture.homeDir});
		assert.equal(after.kind, expectedKind);
		const afterManifest = await readSkillManifest(
			target === 'claude-only' ? after.claudePath : after.canonicalPath,
			fixture.name
		);
		assert.deepEqual(afterManifest, beforeManifest, `${current} -> ${target} must preserve content`);
		// 本地来源不得被当成远端 provenance（design §10 / R5）：检测链只解释官方 list JSON，
		// 不再读 `.skill-lock.json`。真实 CLI 对本地 path 安装通常不返回 source/sourceUrl，
		// 经严格解析后 provenance 为 unknown，UI 不会暴露单项远端更新。
		const detection = await detectInstalledSkillItems(scopedExec(fixture.homeDir));
		const smokeItem = detection.find(item => item.name === fixture.name);
		assert.ok(smokeItem, `${current} -> ${target}: list must still report ${fixture.name}`);
		assert.equal(smokeItem.provenance.kind, 'unknown', 'local source must not surface remote provenance');
		assert.equal(smokeItem.capabilities.update, false, 'local source must not expose single-item remote update');
		if (target === 'shared') {
			assert.equal(after.canonicalValid && after.claudeValid, true);
		}
	}

	for (const topology of ['claude-only', 'codex-only', 'shared']) {
		const fixture = await createFixture(`noop-${topology}`, topology);
		const before = await inspectSkillStorage(fixture.name, {homeDir: fixture.homeDir});
		let spawned = false;
		const result = await transitionSkillTopology(row(fixture.name, before), topology, undefined, async () => {
			spawned = true;
			return {code: 0, stdout: '', stderr: ''};
		}, fixture);
		assert.equal(result.mutated, false);
		assert.equal(spawned, false);
	}

	console.log('[PASS] skills@latest isolated HOME：C/X/B 六向转换、三种 no-op、B 单实体');
} finally {
	if (previousNpmCache === undefined) {
		delete process.env.npm_config_cache;
	} else {
		process.env.npm_config_cache = previousNpmCache;
	}
	await rm(root, {recursive: true, force: true});
}
