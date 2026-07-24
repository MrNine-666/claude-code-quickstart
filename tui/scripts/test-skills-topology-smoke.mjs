import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSkillsChildEnv, runSkillsAdd} from '../src/core/skills-actions.ts';
import {readGlobalSkillLockMetadata} from '../src/core/skills.ts';
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

function row(name, storage) {
	return {
		name,
		path: '',
		scope: 'global',
		sharedInstalled: storage.canonicalValid,
		claudeInjected: storage.claudeValid,
		codexAvailable: storage.canonicalValid,
		agents: [],
		otherAgents: [],
		storage
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
		assert.equal((await readGlobalSkillLockMetadata(fixture.homeDir)).has(fixture.name), false, 'local topology must not retain remote lock provenance');
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
