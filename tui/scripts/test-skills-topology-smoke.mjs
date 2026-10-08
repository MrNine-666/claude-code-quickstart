import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative} from 'node:path';
import {execCommand} from '../src/core/exec.ts';
import {createSkillsChildEnv, runSkillsAdd} from '../src/core/skills-actions.ts';
import {detectInstalledSkillItems, parseSkillsListJson} from '../src/core/skills-installed.ts';
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
// row() 用 known provenance 给迁移事务提供可证明来源。实际检测必须以官方 list
// 的 source/sourceUrl 为准：新版 CLI 会返回本地来源，不能再假定它们始终缺失。
function row(name, storage) {
	const agents = [...(storage.claudeValid ? ['Claude Code'] : []), ...(storage.canonicalValid ? ['Codex'] : [])];
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
		const beforeManifest = await readSkillManifest(current === 'claude-only' ? before.claudePath : before.canonicalPath, fixture.name);
		const result = await transitionSkillTopology(row(fixture.name, before), target, undefined, undefined, fixture);
		assert.equal(result.outcome, 'complete', `${current} -> ${target}: ${result.error ?? ''}`);
		const after = await inspectSkillStorage(fixture.name, {homeDir: fixture.homeDir});
		assert.equal(after.kind, expectedKind);
		const afterManifest = await readSkillManifest(target === 'claude-only' ? after.claudePath : after.canonicalPath, fixture.name);
		assert.deepEqual(afterManifest, beforeManifest, `${current} -> ${target} must preserve content`);
		// 用同一次官方 list 响应核对 provenance；本地元数据不能被推断为远端来源。
		let listPayload;
		const exec = scopedExec(fixture.homeDir);
		const detection = await detectInstalledSkillItems(async (command, args, options) => {
			const result = await exec(command, args, options);
			if (result.code === 0) listPayload = JSON.parse(result.stdout);
			return result;
		});
		const parsed = parseSkillsListJson(listPayload);
		assert.ok(parsed.ok, 'official list must return valid records');
		const records = parsed.records.filter(item => item.name === fixture.name);
		assert.ok(records.length > 0, 'official list must retain the fixture');
		const smokeItem = detection.find(item => item.name === fixture.name);
		assert.ok(smokeItem, `${current} -> ${target}: list must still report ${fixture.name}`);
		const installSource = records[0].sourceUrl ?? records[0].source;
		if (installSource) {
			for (const record of records) {
				assert.equal(record.sourceUrl ?? record.source, installSource, 'fixture projections must report the same source');
				for (const source of [record.source, record.sourceUrl].filter(Boolean)) {
					assert.ok(isAbsolute(source), 'local source must remain an absolute filesystem path');
					const path = relative(root, source);
					assert.ok(
						path && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path),
						'local source must stay inside the isolated fixture'
					);
				}
			}
			assert.equal(smokeItem.provenance.kind, 'known', 'explicit official source must remain known');
			assert.equal(smokeItem.provenance.installSource, installSource, 'operation source must match official metadata');
			assert.equal(smokeItem.provenance.identity, `raw:${installSource}`, 'local path must not become a remote identity');
			assert.equal(smokeItem.capabilities.update, true, 'known-source capability must follow the domain contract');
		} else {
			assert.equal(smokeItem.provenance.kind, 'unknown', 'missing official source must remain unknown');
			assert.equal(smokeItem.capabilities.update, false, 'unknown source must not expose update');
		}
		if (target === 'shared') {
			assert.equal(after.canonicalValid && after.claudeValid, true);
		}
	}

	for (const topology of ['claude-only', 'codex-only', 'shared']) {
		const fixture = await createFixture(`noop-${topology}`, topology);
		const before = await inspectSkillStorage(fixture.name, {homeDir: fixture.homeDir});
		let spawned = false;
		const result = await transitionSkillTopology(
			row(fixture.name, before),
			topology,
			undefined,
			async () => {
				spawned = true;
				return {code: 0, stdout: '', stderr: ''};
			},
			fixture
		);
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
