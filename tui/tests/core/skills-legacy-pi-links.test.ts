import {existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import type {InstalledSkillItem} from '../../src/core/skills-installed.js';
import {cleanupLegacyPiSkillLinks} from '../../src/core/skills-storage.js';
import {uninstallSkillInstance} from '../../src/services/skills-service.js';
import {createTempHome} from '../helpers/temp-home.js';

let home: ReturnType<typeof createTempHome>;
const agentsDir = () => join(home.path, '.agents', 'skills');
const piDir = () => join(home.path, '.pi', 'agent', 'skills');

function canonical(name: string): string {
	const path = join(agentsDir(), name);
	mkdirSync(path, {recursive: true});
	writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
	return path;
}

function link(name: string, target: string): string {
	const path = join(piDir(), name);
	symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
	return path;
}

const present = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

function item(name: string, id = `known:${name}`): InstalledSkillItem {
	return {
		id,
		name,
		provenance: {kind: 'known', identity: 'github:o/r', source: 'o/r', installSource: 'o/r'},
		agents: ['Pi', 'Zed'],
		projections: [{path: join(agentsDir(), name), root: 'agents', scope: 'global', agents: ['Pi', 'Zed']}],
		capabilities: {update: true, manageAgents: true, migrate: true, delete: true}
	};
}

beforeEach(() => {
	home = createTempHome('ccq-skills-legacy-pi-');
	mkdirSync(piDir(), {recursive: true});
	mkdirSync(agentsDir(), {recursive: true});
});

afterEach(() => {
	home.restore();
	home.cleanup();
});

describe('cleanupLegacyPiSkillLinks', () => {
	test('只删除指向同名 canonical 的链接（含断链），实体目录与指向别处的链接不动', async () => {
		const valid = link('valid', canonical('valid'));
		const broken = link('broken', join(agentsDir(), 'broken'));
		const realDir = join(piDir(), 'real');
		mkdirSync(realDir);
		const elsewhere = link('elsewhere', canonical('other'));
		const unsafe = link('.hidden', canonical('.hidden'));

		expect(await cleanupLegacyPiSkillLinks({homeDir: home.path})).toEqual([]);

		expect(present(valid)).toBe(false);
		expect(present(broken)).toBe(false);
		expect(existsSync(join(agentsDir(), 'valid', 'SKILL.md'))).toBe(true);
		expect(present(realDir)).toBe(true);
		expect(present(elsewhere)).toBe(true);
		expect(existsSync(join(agentsDir(), 'other'))).toBe(true);
		expect(present(unsafe)).toBe(true);
	});

	test('names 限定只处理指定条目；目录不存在时返回空', async () => {
		const a = link('a', canonical('a'));
		const b = link('b', canonical('b'));
		expect(await cleanupLegacyPiSkillLinks({homeDir: home.path}, ['a', '../b', 'missing'])).toEqual([]);
		expect(present(a)).toBe(false);
		expect(present(b)).toBe(true);

		rmSync(join(home.path, '.pi'), {recursive: true, force: true});
		expect(await cleanupLegacyPiSkillLinks({homeDir: home.path})).toEqual([]);
	});
});

describe('uninstallSkillInstance 清理旧 Pi 链接', () => {
	test('官方 remove 分支结束后不留断链', async () => {
		const piLink = link('demo', canonical('demo'));
		const calls: string[][] = [];
		const outcome = await uninstallSkillInstance(
			item('demo'),
			[item('demo')],
			undefined,
			async (_command, args) => {
				calls.push([...args]);
				rmSync(join(agentsDir(), 'demo'), {recursive: true, force: true});
				return {code: 0, stdout: '', stderr: ''};
			},
			{homeDir: home.path}
		);

		expect(outcome.outcome).toBe('complete');
		expect(calls[0]).not.toContain('pi');
		expect(present(join(agentsDir(), 'demo'))).toBe(false);
		expect(present(piLink)).toBe(false);
	});

	test('定向删除分支结束后不留断链', async () => {
		const piLink = link('demo', canonical('demo'));
		const other: InstalledSkillItem = {...item('demo', 'known:other'), projections: []};
		const outcome = await uninstallSkillInstance(
			item('demo'),
			[item('demo'), other],
			undefined,
			async () => {
				throw new Error('定向删除不应调用 CLI');
			},
			{homeDir: home.path, projectDir: home.path}
		);

		expect(outcome).toEqual({outcome: 'complete', mutated: true});
		expect(present(join(agentsDir(), 'demo'))).toBe(false);
		expect(present(piLink)).toBe(false);
	});
});
