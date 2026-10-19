import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {
	classifySkillLockEntry,
	findSkillLockKeys,
	patchSkillLock,
	readSkillLock,
	resolveSkillLockPath,
	type SkillLockSnapshot,
	saveSkillLock
} from '../../src/core/skills-lock-metadata.js';
import {createTempHome} from '../helpers/temp-home.js';

let home: ReturnType<typeof createTempHome>;
const lockPath = () => join(home.path, '.agents', '.skill-lock.json');
const github = {
	source: 'vercel-labs/skills',
	sourceType: 'github',
	sourceUrl: 'https://github.com/vercel-labs/skills.git',
	ref: 'main',
	skillPath: 'skills/pdf/SKILL.md',
	skillFolderHash: 'upstream-tree-sha',
	installedAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-02T00:00:00.000Z',
	futureV3Field: {nested: true}
};

function writeLock(value: unknown): void {
	mkdirSync(join(home.path, '.agents'), {recursive: true});
	writeFileSync(lockPath(), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function valid(): Extract<SkillLockSnapshot, {state: 'valid'}> {
	const read = readSkillLock(lockPath());
	if (!read.ok || read.data.state !== 'valid') throw new Error('lock not valid');
	return read.data;
}

beforeEach(() => {
	home = createTempHome('ccq-skill-lock-');
});

afterEach(() => {
	home.restore();
	home.cleanup();
});

describe('lock 路径与严格读取', () => {
	test('XDG_STATE_HOME 优先，否则 home/.agents', () => {
		expect(resolveSkillLockPath({homeDir: home.path})).toBe(lockPath());
		expect(resolveSkillLockPath({homeDir: home.path, xdgStateHome: join(home.path, 'state')})).toBe(
			join(home.path, 'state', 'skills', '.skill-lock.json')
		);
		process.env.XDG_STATE_HOME = join(home.path, 'xdg');
		expect(resolveSkillLockPath({homeDir: home.path})).toBe(join(home.path, 'xdg', 'skills', '.skill-lock.json'));
	});

	test('缺失为空；坏 JSON、坏结构、未知版本均为错误且不含绝对路径', () => {
		expect(readSkillLock(lockPath())).toEqual({ok: true, data: {state: 'missing'}});
		for (const bad of ['{', '[]', JSON.stringify({version: 3, skills: []}), JSON.stringify({version: 4, skills: {}})]) {
			writeLock(bad);
			const read = readSkillLock(lockPath());
			expect(read.ok).toBe(false);
			if (!read.ok) expect(read.error).not.toContain(home.path);
		}
		writeLock({version: 2, skills: {}});
		expect(readSkillLock(lockPath())).toMatchObject({ok: false, error: expect.stringContaining('版本不受支持：2')});
	});

	test('sanitize 归一碰撞返回多个 key', () => {
		writeLock({version: 3, skills: {pdf: github, PDF: github, other: github}});
		expect(findSkillLockKeys(valid().lock, 'pdf')).toEqual(['pdf', 'PDF']);
		expect(findSkillLockKeys(valid().lock, 'missing')).toEqual([]);
	});
});

describe('可迁移条目判定', () => {
	test('受支持远程来源整条原样保留（含未知 v3 字段）', () => {
		const classified = classifySkillLockEntry(github);
		expect(classified).toEqual({kind: 'transferable', entry: github, missingUpdateFields: false});
		expect(classifySkillLockEntry({...github, sourceUrl: 'git@github.com:vercel-labs/skills.git'}).kind).toBe('transferable');
		expect(classifySkillLockEntry({...github, sourceUrl: 'ssh://git@github.com/vercel-labs/skills.git'}).kind).toBe('transferable');
	});

	test('缺少更新基线仍保留来源但标记能力限制', () => {
		const {skillFolderHash: _, ...entry} = github;
		expect(classifySkillLockEntry(entry)).toEqual({kind: 'transferable', entry, missingUpdateFields: true});
	});

	test('本机路径、内部快照与 local 类型只导出内容', () => {
		for (const entry of [
			{...github, sourceType: 'local', source: 'C:\\skills\\pdf'},
			{...github, source: '/home/u/skills'},
			{...github, source: './skills'},
			{...github, source: 'file:///tmp/x'},
			{...github, sourceUrl: 'C:\\Temp\\ccq-skill-stage-abc123'},
			{...github, sourceUrl: '/tmp/ccq-skill-stage-abc123/'}
		]) {
			expect(classifySkillLockEntry(entry)).toEqual({kind: 'content-only', reason: 'local'});
		}
	});

	test('任意字符串含疑似凭据即按凭据处理（包括未知字段）', () => {
		for (const entry of [
			{...github, sourceUrl: 'https://x-access-token:secret@github.com/o/r.git'},
			{...github, sourceUrl: 'https://oauth2@gitlab.com/o/r.git'},
			{...github, sourceUrl: 'https://github.com/o/r.git?access_token=abc'},
			{...github, futureV3Field: `ghp_${'a'.repeat(36)}`},
			{...github, futureV3Field: {deep: 'ssh://git:pw@host/o/r'}}
		]) {
			expect(classifySkillLockEntry(entry)).toEqual({kind: 'content-only', reason: 'credential'});
		}
	});

	test('不支持类型、危险协议/选项注入/越界 skillPath/坏 ref 只导出内容', () => {
		for (const entry of [
			{...github, sourceType: 'direct-url'},
			{...github, source: '--upload-pack=x'},
			{...github, sourceUrl: 'http://github.com/o/r.git'},
			{...github, sourceUrl: 'ext::sh -c x'},
			{...github, skillPath: '../escape/SKILL.md'},
			{...github, ref: '-x'},
			{...github, ref: 'a..b'},
			{...github, ref: 1},
			{...github, sourceBaseUrl: 'ssh://git@host/x'},
			{sourceType: 'github'},
			'not-an-object'
		]) {
			expect(classifySkillLockEntry(entry)).toEqual({kind: 'content-only', reason: 'unsupported'});
		}
	});
});

describe('按名称补丁与原子保存', () => {
	const target = {
		version: 3 as const,
		skills: {keep: {source: 'a/b', sourceType: 'github', local: 'x'}, stale: github},
		dismissed: {findSkillsPrompt: true},
		lastSelectedAgents: ['claude-code'],
		unknownTop: 1
	};

	test('只替换/删除包内名称，保留顶层字段、偏好与无关条目', () => {
		writeLock(target);
		const before = valid();
		const next = patchSkillLock(before, [
			{name: 'stale', entry: null},
			{name: 'pdf', entry: github}
		]);
		expect(next).toEqual({...target, skills: {keep: target.skills.keep, pdf: github}});
		expect(saveSkillLock(lockPath(), before, next!)).toEqual({ok: true, data: undefined});
		expect(JSON.parse(readFileSync(lockPath(), 'utf8'))).toEqual(next);
		// 重复补丁幂等：无变化不写。
		expect(patchSkillLock(valid(), [{name: 'pdf', entry: github}])).toBeNull();
	});

	test('目标缺失：只有删除不创建 lock；需要写入时创建 v3', () => {
		const missing = {state: 'missing'} as const;
		expect(patchSkillLock(missing, [{name: 'x', entry: null}])).toBeNull();
		const next = patchSkillLock(missing, [{name: 'x', entry: github}]);
		expect(next).toEqual({version: 3, skills: {x: github}});
		expect(saveSkillLock(lockPath(), missing, next!).ok).toBe(true);
		expect(valid().lock).toEqual({version: 3, skills: {x: github}});
	});

	test('写前发现外部修改或文件损坏时拒绝写入，原字节不变', () => {
		writeLock(target);
		const before = valid();
		const next = patchSkillLock(before, [{name: 'pdf', entry: github}])!;
		writeLock({...target, unknownTop: 2});
		const changed = readFileSync(lockPath(), 'utf8');
		expect(saveSkillLock(lockPath(), before, next).ok).toBe(false);
		expect(readFileSync(lockPath(), 'utf8')).toBe(changed);

		writeLock('{broken');
		expect(saveSkillLock(lockPath(), before, next).ok).toBe(false);
		expect(readFileSync(lockPath(), 'utf8')).toBe('{broken');
	});
});
