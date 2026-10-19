import * as childProcess from 'node:child_process';
import {cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, type Mock, spyOn, test} from 'bun:test';
import {type BundlePayload, type BundleSection, parseBundlePayload} from '../../src/core/config-transfer.js';
import {
	applyConfigTransferImport,
	type ConfigTransferApplyOptions,
	type ConfigTransferCategoryDecision,
	planConfigTransferExport,
	planConfigTransferImport
} from '../../src/core/config-transfer-plan.js';
import {parseSkillsSection, planSkillsImport, snapshotSkillsSection, type SkillsSection} from '../../src/core/config-transfer-skills.js';
import {execCommand} from '../../src/core/exec.js';
import {createTempHome} from '../helpers/temp-home.js';

let home: ReturnType<typeof createTempHome>;
const agentsDir = () => join(home.path, '.agents', 'skills');
const claudeSkillsDir = () => join(home.path, '.claude', 'skills');
const SKILLS = [
	{tool: 'ccq', category: 'skills'},
	{tool: 'cc', category: 'skills'}
] as const;

function writeSkill(dir: string, name: string, body: string): string {
	const path = join(dir, name);
	mkdirSync(path, {recursive: true});
	writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n${body}\n`);
	return path;
}

function link(target: string, path: string): void {
	mkdirSync(join(path, '..'), {recursive: true});
	symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

function brokenLink(dir: string, name: string): void {
	const target = writeSkill(join(home.path, 'gone'), name, 'gone');
	link(target, join(dir, name));
	rmSync(target, {recursive: true, force: true});
}

async function section(root: 'agents' | 'claude'): Promise<SkillsSection> {
	const result = await snapshotSkillsSection({root});
	if (!result.ok) throw new Error(result.error);
	return result.data;
}

async function planOf(data: unknown) {
	const result = await planSkillsImport(data);
	if (!result.ok) throw new Error(result.error);
	return result.data.items;
}

async function exportSections(categories: readonly {tool: 'ccq' | 'cc'; category: 'skills'}[]): Promise<readonly BundleSection[]> {
	const exported = await planConfigTransferExport({categories, includeCredentials: true});
	if (!exported.ok) throw new Error(exported.error);
	return exported.data.sections;
}

function payloadOf(sections: readonly BundleSection[]): BundlePayload {
	const payload = parseBundlePayload({
		createdAt: 'now',
		createdBy: {name: 'ccq', version: 'test', platform: process.platform},
		containsCredentials: false,
		sections
	});
	if (!payload.ok) throw new Error(payload.error);
	return payload.data;
}

async function importSections(
	sections: readonly BundleSection[],
	decisions: readonly ConfigTransferCategoryDecision[] = [],
	options: ConfigTransferApplyOptions = {}
) {
	const payload = payloadOf(sections);
	const plan = await planConfigTransferImport(payload);
	if (!plan.ok) throw new Error(plan.error);
	return applyConfigTransferImport(payload, plan.data, decisions, options);
}

// 导入必须完全离线：任何子进程（skills add/update、npx、git）都直接失败。
let spawnSpy: Mock<typeof childProcess.spawn>;

beforeEach(() => {
	home = createTempHome('ccq-transfer-skills-');
	spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(() => {
		throw new Error('spawn forbidden in transfer tests');
	});
});

afterEach(() => {
	const calls = spawnSpy.mock.calls.length;
	spawnSpy.mockRestore();
	home.restore();
	home.cleanup();
	expect(calls).toBe(0);
});

describe('Skills 导出按分类独立快照', () => {
	test('断链警告带来源并归属对应分组；不扫描 ~/.pi/agent/skills', async () => {
		writeSkill(agentsDir(), 'shared', 'v1');
		link(join(agentsDir(), 'shared'), join(claudeSkillsDir(), 'shared'));
		brokenLink(agentsDir(), 'broken-a');
		brokenLink(claudeSkillsDir(), 'broken-c');
		brokenLink(join(home.path, '.pi', 'agent', 'skills'), 'broken-p');

		const plan = await planConfigTransferExport({categories: SKILLS, includeCredentials: true});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.data.sections.map(s => [s.tool, (s.data as SkillsSection).root])).toEqual([
			['ccq', 'agents'],
			['cc', 'claude']
		]);
		const [agents, claude] = plan.data.summaries;
		expect(agents?.warnings).toEqual(['Codex / Pi Skill 链接已断开：broken-a', 'Codex / Pi Skill 无官方来源记录，仅导出内容：shared']);
		expect(claude?.warnings).toEqual([
			'Claude Code Skill 链接已断开：broken-c',
			'Claude Code Skill 无官方来源记录，仅导出内容：shared'
		]);
		expect(agents?.itemCount).toBe(1);
		expect(claude?.itemCount).toBe(1);
		expect(JSON.stringify(plan.data)).not.toContain('broken-p');
	});
});

describe('Skills 导出附带官方来源跟踪', () => {
	const upstream = {
		source: 'vercel-labs/skills',
		sourceType: 'github',
		sourceUrl: 'https://github.com/vercel-labs/skills.git',
		ref: 'main',
		skillPath: 'skills/pdf/SKILL.md',
		skillFolderHash: 'upstream-tree-sha',
		installedAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z',
		futureV3Field: {kept: true}
	};
	const writeLock = (value: unknown, path = join(home.path, '.agents', '.skill-lock.json')) => {
		mkdirSync(join(path, '..'), {recursive: true});
		writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
	};

	test('修改过的远程 Skill 导出完整内容，lock 条目整条原样且不导出偏好/包外条目', async () => {
		const dir = writeSkill(agentsDir(), 'pdf', 'locally modified');
		mkdirSync(join(dir, 'scripts'));
		writeFileSync(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', {mode: 0o755});
		const binary = Buffer.from(Array.from({length: 256}, (_, i) => i));
		writeFileSync(join(dir, 'blob.bin'), binary);
		if (process.platform !== 'win32') symlinkSync('scripts/run.sh', join(dir, 'run-link'));
		writeLock({
			version: 3,
			skills: {pdf: upstream, 'outside-pkg': upstream},
			dismissed: {findSkillsPrompt: true},
			lastSelectedAgents: ['claude-code']
		});

		const result = await snapshotSkillsSection({root: 'agents'});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.warnings).toEqual([]);
		const [skill] = result.data.skills;
		expect(result.data.schema).toBe(2);
		expect(skill?.tracking).toEqual({kind: 'global-lock-v3', entry: upstream});
		const text = JSON.stringify(result.data);
		for (const leaked of ['outside-pkg', 'dismissed', 'lastSelectedAgents', home.path]) expect(text).not.toContain(leaked);
		const byPath = new Map(skill?.files.map(entry => [entry.path, entry]));
		const blob = byPath.get('pdf/blob.bin');
		expect(blob?.kind === 'file' && Buffer.from(blob.contentBase64, 'base64').equals(binary)).toBe(true);
		const md = byPath.get('pdf/SKILL.md');
		expect(md?.kind === 'file' && Buffer.from(md.contentBase64, 'base64').toString()).toContain('locally modified');
		if (process.platform !== 'win32') {
			expect(byPath.get('pdf/scripts/run.sh')).toMatchObject({mode: 0o755});
			expect(byPath.get('pdf/run-link')).toMatchObject({kind: 'symlink', target: 'scripts/run.sh'});
		}

		// 导入边界复用同一校验：v2 条目可解析且 tracking 不变。
		expect(parseSkillsSection(result.data)).toMatchObject({ok: true, data: result.data});
	});

	test('本机路径/内部快照/凭据/无记录只导出内容并脱敏提示', async () => {
		for (const name of ['local', 'stage', 'secret', 'none', 'nohash']) writeSkill(claudeSkillsDir(), name, 'x');
		const {skillFolderHash: _, ...nohash} = upstream;
		writeLock({
			version: 3,
			skills: {
				local: {...upstream, sourceType: 'local', source: 'D:\\skills\\local'},
				stage: {...upstream, sourceUrl: 'C:\\Temp\\ccq-skill-stage-ab12CD'},
				secret: {...upstream, sourceUrl: 'https://x-access-token:SENTINEL@github.com/o/r.git'},
				nohash
			}
		});
		const result = await snapshotSkillsSection({root: 'claude'});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.fromEntries(result.data.skills.map(skill => [skill.name, skill.tracking?.kind ?? null]))).toEqual({
			local: null,
			nohash: 'global-lock-v3',
			none: null,
			secret: null,
			stage: null
		});
		expect(result.warnings).toEqual([
			'Claude Code Skill 来源为本机路径或内部快照，无法跨机器恢复更新来源，仅导出内容：local',
			'Claude Code Skill 来源缺少更新基线，恢复后可能无法官方更新：nohash',
			'Claude Code Skill 无官方来源记录，仅导出内容：none',
			'Claude Code Skill 来源含疑似凭据，已省略来源，仅导出内容：secret',
			'Claude Code Skill 来源为本机路径或内部快照，无法跨机器恢复更新来源，仅导出内容：stage'
		]);
		const text = JSON.stringify(result);
		for (const leaked of ['SENTINEL', 'ccq-skill-stage', 'D:\\\\skills']) expect(text).not.toContain(leaked);
	});

	test('损坏或未知版本 lock 阻断导出；XDG_STATE_HOME 下的 lock 优先', async () => {
		writeSkill(agentsDir(), 'pdf', 'x');
		writeLock('{broken');
		expect(await snapshotSkillsSection({root: 'agents'})).toMatchObject({ok: false, kind: 'validation'});
		writeLock({version: 4, skills: {}});
		expect(await snapshotSkillsSection({root: 'agents'})).toMatchObject({ok: false, kind: 'validation'});

		process.env.XDG_STATE_HOME = join(home.path, 'xdg');
		writeLock({version: 3, skills: {pdf: upstream}}, join(home.path, 'xdg', 'skills', '.skill-lock.json'));
		const result = await snapshotSkillsSection({root: 'agents'});
		expect(result.ok && result.data.skills[0]?.tracking).toEqual({kind: 'global-lock-v3', entry: upstream});
	});

	test('另一侧同名不同内容或 sanitize 碰撞时不认领来源；shared 链接两侧都带来源', async () => {
		writeSkill(agentsDir(), 'pdf', 'a');
		writeSkill(claudeSkillsDir(), 'pdf', 'b');
		writeLock({version: 3, skills: {pdf: upstream, PDF: upstream}});
		let result = await snapshotSkillsSection({root: 'agents'});
		expect(result.ok && result.warnings).toEqual(['Codex / Pi Skill 的官方来源记录存在同名歧义，仅导出内容：pdf']);

		writeLock({version: 3, skills: {pdf: upstream}});
		result = await snapshotSkillsSection({root: 'agents'});
		expect(result.ok && result.data.skills[0]?.tracking).toBeNull();
		expect(result.ok && result.warnings).toEqual([
			'Codex / Pi Skill 与另一侧同名 Skill 内容不同，无法确定官方来源归属，仅导出内容：pdf'
		]);

		rmSync(join(claudeSkillsDir(), 'pdf'), {recursive: true});
		link(join(agentsDir(), 'pdf'), join(claudeSkillsDir(), 'pdf'));
		for (const root of ['agents', 'claude'] as const) {
			const shared = await snapshotSkillsSection({root});
			expect(shared.ok && shared.data.skills[0]?.tracking).toEqual({kind: 'global-lock-v3', entry: upstream});
		}
	});

	test('包内 v2 tracking 缺失/类型未知/含凭据拒绝；旧 v1 条目归一为无来源', async () => {
		writeSkill(agentsDir(), 'pdf', 'x');
		const exported = await section('agents');
		const [skill] = exported.skills;
		const withTracking = (tracking: unknown) => ({...exported, skills: [{...skill, tracking}]});
		const {tracking: _, ...untracked} = skill!;
		expect(parseSkillsSection({...exported, skills: [untracked]}).ok).toBe(false);
		expect(parseSkillsSection({...exported, schema: 3}).ok).toBe(false);
		expect(parseSkillsSection(withTracking({kind: 'other', entry: upstream})).ok).toBe(false);
		expect(parseSkillsSection(withTracking({kind: 'global-lock-v3', entry: upstream, extra: 1})).ok).toBe(false);
		expect(
			parseSkillsSection(withTracking({kind: 'global-lock-v3', entry: {...upstream, sourceUrl: 'https://u:p@h.com/o/r'}})).ok
		).toBe(false);
		expect(parseSkillsSection(withTracking({kind: 'global-lock-v3', entry: upstream})).ok).toBe(true);

		const legacy = parseSkillsSection({root: 'agents', skills: [{...untracked, tracking: {kind: 'global-lock-v3', entry: upstream}}]});
		expect(legacy.ok && legacy.data).toEqual({root: 'agents', skills: [{...untracked, tracking: null}]});
	});
});

describe('Skills 导入不删除另一侧', () => {
	test('公共模块 Skills：Claude 侧缺失/同内容/链接/不同内容', async () => {
		writeSkill(agentsDir(), 'x', 'v1');
		const data = await section('agents');
		rmSync(join(agentsDir(), 'x'), {recursive: true});

		expect(await planOf(data)).toMatchObject([{name: 'x', state: 'add', targets: {cc: false, cx: true}}]);

		writeSkill(claudeSkillsDir(), 'x', 'v1');
		expect(await planOf(data)).toMatchObject([{state: 'add', targets: {cc: true, cx: true}}]);

		writeSkill(claudeSkillsDir(), 'x', 'v2');
		expect(await planOf(data)).toMatchObject([{state: 'blocked', reason: 'Claude Code 中已有不同内容的同名 Skill：x'}]);

		// Claude 侧是指向 canonical 的投影：随 canonical 更新，不算冲突。
		rmSync(join(claudeSkillsDir(), 'x'), {recursive: true});
		writeSkill(agentsDir(), 'x', 'v3');
		link(join(agentsDir(), 'x'), join(claudeSkillsDir(), 'x'));
		expect(await planOf(data)).toMatchObject([{state: 'replace', targets: {cc: true, cx: true}}]);
	});

	test('Claude Code Skills：Codex / Pi 侧缺失/同内容/不同内容；本侧一致为 unchanged', async () => {
		writeSkill(claudeSkillsDir(), 'x', 'v1');
		const data = await section('claude');
		expect(await planOf(data)).toMatchObject([{state: 'unchanged'}]);
		rmSync(join(claudeSkillsDir(), 'x'), {recursive: true});

		expect(await planOf(data)).toMatchObject([{state: 'add', targets: {cc: true, cx: false}}]);

		writeSkill(agentsDir(), 'x', 'v1');
		expect(await planOf(data)).toMatchObject([{state: 'add', targets: {cc: true, cx: true}}]);

		writeSkill(agentsDir(), 'x', 'v2');
		expect(await planOf(data)).toMatchObject([{state: 'blocked', reason: 'Codex / Pi 中已有不同内容的同名 Skill：x'}]);

		// 本侧是指向不同 canonical 的链接：更新会改写 `.agents`，必须阻断。
		link(join(agentsDir(), 'x'), join(claudeSkillsDir(), 'x'));
		expect(await planOf(data)).toMatchObject([{state: 'blocked'}]);
	});

	test('两个分类依次导入恢复 shared 拓扑，本机其它 Skill 保留；离线且重复导入幂等', async () => {
		writeSkill(agentsDir(), 'x', 'v1');
		link(join(agentsDir(), 'x'), join(claudeSkillsDir(), 'x'));
		const sections = await exportSections(SKILLS);
		home.restore();
		home.cleanup();

		home = createTempHome('ccq-transfer-skills-import-');
		writeSkill(agentsDir(), 'keep-a', 'local');
		writeSkill(claudeSkillsDir(), 'keep-c', 'local');
		const outcome = await importSections(sections);
		expect(outcome.ok && outcome.data.status).toBe('complete');
		expect(lstatSync(join(claudeSkillsDir(), 'x')).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(claudeSkillsDir(), 'x', 'SKILL.md'), 'utf8')).toContain('v1');
		expect(existsSync(join(agentsDir(), 'keep-a'))).toBe(true);
		expect(existsSync(join(claudeSkillsDir(), 'keep-c'))).toBe(true);

		const again = await planConfigTransferImport(payloadOf(sections));
		expect(again.ok && again.data.items.map(item => item.status)).toEqual(['unchanged', 'unchanged']);
	});
});

describe('旧版 Skills 分类', () => {
	const bundle = (sections: unknown[]) => ({
		createdAt: 'now',
		createdBy: {name: 'ccq', version: 'old', platform: process.platform},
		containsCredentials: false,
		sections
	});

	test('cx/pi:skills 与无 root 的 cc:skills 跳过并提示，其它分类照常导入', async () => {
		const payload = parseBundlePayload(
			bundle([
				{tool: 'ccq', category: 'system-settings', data: {autoUpdate: true}},
				{tool: 'cc', category: 'skills', data: {skills: []}},
				{tool: 'cx', category: 'skills', data: {skills: []}},
				{tool: 'pi', category: 'skills', data: {skills: []}}
			])
		);
		expect(payload.ok).toBe(true);
		if (!payload.ok) return;
		const plan = await planConfigTransferImport(payload.data);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const skills = plan.data.items.filter(item => item.category === 'skills');
		expect(skills.map(item => [item.tool, item.status, item.defaultAction, item.reason])).toEqual([
			['cc', 'blocked', 'skip', '旧版 Skills 分类不再支持，已跳过'],
			['cx', 'blocked', 'skip', '旧版 Skills 分类不再支持，已跳过'],
			['pi', 'blocked', 'skip', '旧版 Skills 分类不再支持，已跳过']
		]);

		const outcome = await applyConfigTransferImport(payload.data, plan.data);
		expect(outcome.ok && outcome.data.status).toBe('complete');
		if (!outcome.ok) return;
		expect(outcome.data.completed).toEqual([{tool: 'ccq', category: 'system-settings'}]);
		expect(readFileSync(join(home.path, '.ccq', 'system-settings.json'), 'utf8')).toContain('"autoUpdate": true');
	});

	test('真正未知的分类仍整包拒绝', () => {
		const payload = parseBundlePayload(bundle([{tool: 'cx', category: 'bogus', data: {}}]));
		expect(payload.ok).toBe(false);
	});
});

describe('Skills 离线恢复内容与官方来源', () => {
	const upstream = {
		source: 'vercel-labs/skills',
		sourceType: 'github',
		sourceUrl: 'https://github.com/vercel-labs/skills.git',
		ref: 'main',
		skillPath: 'skills/pdf/SKILL.md',
		skillFolderHash: 'upstream-tree-sha',
		installedAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z'
	};
	const lockPath = () => join(home.path, '.agents', '.skill-lock.json');
	const writeLock = (value: unknown, path = lockPath()) => {
		mkdirSync(join(path, '..'), {recursive: true});
		writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
	};
	const readLock = (path = lockPath()) => JSON.parse(readFileSync(path, 'utf8'));
	const project = (target: string, path: string) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');

	/** 源机器：远程安装后本地修改的 shared Skill + 官方 lock；返回两个分类的导出 sections，并切到新的隔离 HOME。 */
	async function exportModifiedRemoteSkill(categories: readonly {tool: 'ccq' | 'cc'; category: 'skills'}[] = SKILLS) {
		const dir = writeSkill(agentsDir(), 'pdf', 'locally modified');
		mkdirSync(join(dir, 'scripts'));
		writeFileSync(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', {mode: 0o755});
		writeFileSync(join(dir, 'blob.bin'), Buffer.from(Array.from({length: 256}, (_, i) => i)));
		if (process.platform !== 'win32') symlinkSync('scripts/run.sh', join(dir, 'run-link'));
		link(dir, join(claudeSkillsDir(), 'pdf'));
		writeLock({version: 3, skills: {pdf: upstream, 'source-only': upstream}, dismissed: {findSkillsPrompt: true}});
		const sections = await exportSections(categories);
		const source = join(home.path, 'source-copy');
		cpSync(dir, source, {recursive: true, verbatimSymlinks: true});
		const sourceHome = home;
		sourceHome.restore();
		home = createTempHome('ccq-transfer-skills-target-');
		return {sections, source, cleanupSource: () => sourceHome.cleanup()};
	}

	test('spawn spy 生效：任何子进程调用都会失败', async () => {
		await expect(execCommand('npx', ['skills', 'add'])).rejects.toThrow('spawn forbidden');
		spawnSpy.mockClear();
	});

	test('跨 HOME 恢复修改后的远程 Skill：字节/脚本权限/内部链接一致，lock 条目原样写入且无关条目/偏好保留', async () => {
		const {sections, source, cleanupSource} = await exportModifiedRemoteSkill();
		try {
			writeLock({version: 3, skills: {unrelated: {...upstream, source: 'o/r'}}, lastSelectedAgents: ['claude-code'], futureTop: 1});
			const before = readLock();
			const outcome = await importSections(sections);
			expect(outcome.ok && outcome.data.status).toBe('complete');
			expect(outcome.ok && outcome.data.warnings).toContain(
				'Codex / Pi Skills 将离线恢复包内完整内容，不联网安装或更新；后续官方更新可能覆盖本地修改'
			);

			const restored = join(agentsDir(), 'pdf');
			for (const file of ['SKILL.md', 'blob.bin', 'scripts/run.sh']) {
				expect(readFileSync(join(restored, file)).equals(readFileSync(join(source, file)))).toBe(true);
			}
			if (process.platform !== 'win32') {
				expect(statSync(join(restored, 'scripts', 'run.sh')).mode & 0o777).toBe(0o755);
				expect(lstatSync(join(restored, 'run-link')).isSymbolicLink()).toBe(true);
			}
			expect(lstatSync(join(claudeSkillsDir(), 'pdf')).isSymbolicLink()).toBe(true);
			// 上游基线原值保留，不用本地内容 hash 冒充；只新增包内名称，其它字段原样。
			expect(readLock()).toEqual({...before, skills: {...before.skills, pdf: upstream}});
			expect(readFileSync(lockPath(), 'utf8')).not.toContain('ccq-skill-stage');
		} finally {
			cleanupSource();
		}
	});

	test('精确替换：包中已删除的旧文件不残留；XDG_STATE_HOME 下写 lock，不创建默认 lock', async () => {
		const {sections, cleanupSource} = await exportModifiedRemoteSkill([{tool: 'ccq', category: 'skills'}]);
		try {
			const stale = writeSkill(agentsDir(), 'pdf', 'old');
			writeFileSync(join(stale, 'stale.txt'), 'old');
			process.env.XDG_STATE_HOME = join(home.path, 'xdg');
			const outcome = await importSections(sections);
			expect(outcome.ok && outcome.data.status).toBe('complete');
			expect(existsSync(join(stale, 'stale.txt'))).toBe(false);
			expect(readFileSync(join(stale, 'SKILL.md'), 'utf8')).toContain('locally modified');
			expect(readLock(join(home.path, 'xdg', 'skills', '.skill-lock.json')).skills.pdf).toEqual(upstream);
			expect(existsSync(lockPath())).toBe(false);
		} finally {
			cleanupSource();
		}
	});

	test('内容一致但来源缺失/不同不算 unchanged：只补丁 lock，不重写内容', async () => {
		writeSkill(agentsDir(), 'pdf', 'x');
		writeLock({version: 3, skills: {pdf: upstream}});
		const [data] = await exportSections([{tool: 'ccq', category: 'skills'}]);
		expect(await planOf(data!.data as SkillsSection)).toMatchObject([{state: 'unchanged'}]);

		writeLock({version: 3, skills: {pdf: {...upstream, ref: 'other'}}});
		const items = await planOf(data!.data as SkillsSection);
		expect(items).toEqual([{id: expect.any(String), name: 'pdf', state: 'replace', lock: {name: 'pdf', entry: upstream}}]);
		const outcome = await importSections([data!]);
		expect(outcome.ok && outcome.data.status).toBe('complete');
		expect(readLock().skills.pdf).toEqual(upstream);
	});

	test('旧 v1 包只恢复内容：清理目标机陈旧同名来源并提示；另一侧不同实例共享该名称时阻断', async () => {
		writeSkill(agentsDir(), 'pdf', 'x');
		const [current] = await exportSections([{tool: 'ccq', category: 'skills'}]);
		const {schema: _, ...legacy} = current!.data as SkillsSection;
		const legacyData = {...legacy, skills: legacy.skills.map(({tracking: _t, ...skill}) => skill)};
		writeLock({version: 3, skills: {pdf: upstream}});

		const plan = await planSkillsImport(legacyData);
		expect(plan.ok && plan.data.items).toMatchObject([{state: 'replace', lock: {name: 'pdf', entry: null}}]);
		expect(plan.ok && plan.data.warnings).toEqual(['Codex / Pi Skills 来自旧版导出包，不含来源记录，恢复后为未知来源：pdf']);

		writeSkill(claudeSkillsDir(), 'pdf', 'different');
		expect(await planOf(legacyData)).toMatchObject([{state: 'blocked', reason: 'Claude Code 中已有不同内容的同名 Skill：pdf'}]);
	});

	test('跨分类同名来源提案不一致时双方阻断；未提供 peer（另一分类跳过）时按本分类重算', async () => {
		writeSkill(agentsDir(), 'pdf', 'x');
		writeSkill(claudeSkillsDir(), 'pdf', 'x');
		writeLock({version: 3, skills: {pdf: upstream}});
		const sections = await exportSections(SKILLS);
		rmSync(join(home.path, '.agents'), {recursive: true});
		rmSync(claudeSkillsDir(), {recursive: true});
		const [agents, claude] = sections.map(section => section.data as SkillsSection);
		const untracked = {...claude!, skills: claude!.skills.map(skill => ({...skill, tracking: null}))};

		const plan = await planConfigTransferImport(payloadOf([sections[0]!, {...sections[1]!, data: untracked}]));
		expect(plan.ok && plan.data.items.map(item => [item.status, item.reason])).toEqual([
			['blocked', '两个 Skills 分类中同名 Skill 的来源记录不一致：pdf'],
			['blocked', '两个 Skills 分类中同名 Skill 的来源记录不一致：pdf']
		]);
		expect(await planOf(agents!)).toMatchObject([{state: 'add', lock: {name: 'pdf', entry: upstream}}]);
		expect(existsSync(join(agentsDir(), 'pdf'))).toBe(false);
	});

	test('sanitize 别名、损坏 lock 与链接化 Skills 根在预览阶段阻断且零写盘', async () => {
		writeSkill(agentsDir(), 'pdf', 'x');
		const [data] = await exportSections([{tool: 'ccq', category: 'skills'}]);
		rmSync(join(agentsDir(), 'pdf'), {recursive: true});
		const section = data!.data as SkillsSection;

		writeLock({version: 3, skills: {PDF: upstream}});
		expect(await planOf(section)).toMatchObject([{state: 'blocked', reason: '官方 Skills 来源记录存在同名歧义：pdf'}]);

		writeLock('{broken');
		const plan = await planConfigTransferImport(payloadOf([data!]));
		expect(plan.ok && plan.data.items[0]).toMatchObject({status: 'blocked', defaultAction: 'skip'});
		expect(readFileSync(lockPath(), 'utf8')).toBe('{broken');

		writeLock({version: 3, skills: {}});
		const elsewhere = join(home.path, 'elsewhere');
		mkdirSync(elsewhere);
		rmSync(agentsDir(), {recursive: true});
		link(elsewhere, agentsDir());
		expect(await planSkillsImport(section)).toMatchObject({ok: false, kind: 'conflict'});
		expect(existsSync(join(elsewhere, 'pdf'))).toBe(false);
	});

	test('预览后官方 lock 被外部修改：apply 在任何写入前拒绝', async () => {
		const {sections, cleanupSource} = await exportModifiedRemoteSkill([{tool: 'ccq', category: 'skills'}]);
		try {
			const payload = payloadOf(sections);
			const plan = await planConfigTransferImport(payload);
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			writeLock({version: 3, skills: {external: upstream}});
			const outcome = await applyConfigTransferImport(payload, plan.data);
			expect(outcome).toMatchObject({ok: false, kind: 'conflict'});
			expect(existsSync(join(agentsDir(), 'pdf'))).toBe(false);
		} finally {
			cleanupSource();
		}
	});

	describe('失败注入：同分类恢复 roots + lock 原始字节', () => {
		/** 新 HOME：canonical 已有同内容，单独导入 Claude 分类 -> shared 投影 + lock 写入。 */
		async function prepareClaudeImport() {
			const exported = await exportModifiedRemoteSkill([{tool: 'cc', category: 'skills'}]);
			cpSync(exported.source, join(agentsDir(), 'pdf'), {recursive: true, verbatimSymlinks: true});
			writeLock({version: 3, skills: {unrelated: upstream}, dismissed: {x: true}});
			return {...exported, lockBytes: readFileSync(lockPath())};
		}

		const expectRestored = (lockBytes: Buffer) => {
			expect(readFileSync(lockPath()).equals(lockBytes)).toBe(true);
			expect(existsSync(join(claudeSkillsDir(), 'pdf'))).toBe(false);
			expect(readFileSync(join(agentsDir(), 'pdf', 'SKILL.md'), 'utf8')).toContain('locally modified');
		};

		test('投影创建失败（如 Windows 无链接权限）：如实失败并恢复', async () => {
			const {sections, lockBytes, cleanupSource} = await prepareClaudeImport();
			try {
				const outcome = await importSections(sections, [], {
					skills: {
						createProjection: () => {
							throw new Error('EPERM');
						}
					}
				});
				expect(outcome.ok && outcome.data.status).toBe('failed');
				expect(outcome.ok && outcome.data.failed).toMatchObject([
					{tool: 'cc', category: 'skills', error: 'Skill 共享投影创建失败（系统可能不允许创建链接）：pdf', restored: true}
				]);
				expectRestored(lockBytes);
			} finally {
				cleanupSource();
			}
		});

		test('投影未抛错却未建立：不误报 shared，Claude 侧实体恢复且不创建 lock', async () => {
			const {sections, source, cleanupSource} = await exportModifiedRemoteSkill([{tool: 'ccq', category: 'skills'}]);
			try {
				cpSync(source, join(claudeSkillsDir(), 'pdf'), {recursive: true, verbatimSymlinks: true});
				const outcome = await importSections(sections, [], {skills: {createProjection: () => {}}});
				expect(outcome.ok && outcome.data.failed).toMatchObject([{tool: 'ccq', category: 'skills', restored: true}]);
				expect(lstatSync(join(claudeSkillsDir(), 'pdf')).isDirectory()).toBe(true);
				expect(readFileSync(join(claudeSkillsDir(), 'pdf', 'SKILL.md'), 'utf8')).toContain('locally modified');
				expect(existsSync(join(agentsDir(), 'pdf'))).toBe(false);
				expect(existsSync(lockPath())).toBe(false);
			} finally {
				cleanupSource();
			}
		});

		test('目标原本没有 lock：已创建的 lock 在 postflight 失败后移除', async () => {
			const {sections, cleanupSource} = await prepareClaudeImport();
			try {
				rmSync(lockPath());
				const outcome = await importSections(sections, [], {
					skills: {
						createProjection: (target, path) => {
							project(target, path);
							writeSkill(agentsDir(), 'pdf', 'tampered');
						}
					}
				});
				expect(outcome.ok && outcome.data.failed[0]).toMatchObject({error: '导入结果校验失败：目标状态未确认', restored: true});
				expect(existsSync(lockPath())).toBe(false);
				expect(existsSync(join(claudeSkillsDir(), 'pdf'))).toBe(false);
			} finally {
				cleanupSource();
			}
		});

		test('lock 写入前被外部修改：停止写入并回滚', async () => {
			const {sections, lockBytes, cleanupSource} = await prepareClaudeImport();
			try {
				const outcome = await importSections(sections, [], {
					skills: {
						createProjection: (target, path) => {
							project(target, path);
							writeLock({version: 3, skills: {racing: upstream}});
						}
					}
				});
				expect(outcome.ok && outcome.data.failed[0]?.error).toContain('在导入期间被外部修改');
				expect(outcome.ok && outcome.data.failed[0]?.restored).toBe(true);
				// 已知限制：回滚按快照恢复，外部进程的并发写入不会保留。
				expectRestored(lockBytes);
			} finally {
				cleanupSource();
			}
		});

		test('取消：已写入内容回滚，lock 不再提交', async () => {
			const {sections, lockBytes, cleanupSource} = await prepareClaudeImport();
			try {
				const controller = new AbortController();
				const outcome = await importSections(sections, [], {
					signal: controller.signal,
					skills: {
						createProjection: (target, path) => {
							project(target, path);
							controller.abort();
						}
					}
				});
				expect(outcome.ok && outcome.data).toMatchObject({status: 'failed', cancelled: true});
				expect(outcome.ok && outcome.data.failed[0]?.restored).toBe(true);
				expectRestored(lockBytes);
			} finally {
				cleanupSource();
			}
		});

		test('postflight 不一致：lock 已写入也恢复原始字节', async () => {
			const {sections, lockBytes, cleanupSource} = await prepareClaudeImport();
			try {
				const outcome = await importSections(sections, [], {
					skills: {
						createProjection: (target, path) => {
							project(target, path);
							writeSkill(agentsDir(), 'pdf', 'tampered');
						}
					}
				});
				expect(outcome.ok && outcome.data.failed[0]).toMatchObject({error: '导入结果校验失败：目标状态未确认', restored: true});
				expectRestored(lockBytes);
			} finally {
				cleanupSource();
			}
		});

		test('第二个分类失败只回滚该分类，第一个分类的内容与来源保留', async () => {
			const {sections, cleanupSource} = await exportModifiedRemoteSkill();
			try {
				const outcome = await importSections(sections, [], {
					skills: {
						createProjection: () => {
							throw new Error('EPERM');
						}
					}
				});
				expect(outcome.ok && outcome.data).toMatchObject({
					status: 'partial',
					completed: [{tool: 'ccq', category: 'skills'}],
					failed: [{tool: 'cc', category: 'skills', restored: true}]
				});
				expect(readFileSync(join(agentsDir(), 'pdf', 'SKILL.md'), 'utf8')).toContain('locally modified');
				expect(existsSync(join(claudeSkillsDir(), 'pdf'))).toBe(false);
				expect(readLock().skills.pdf).toEqual(upstream);
			} finally {
				cleanupSource();
			}
		});
	});
});
