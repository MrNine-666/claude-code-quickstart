import {cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {parseBundlePayload} from '../../src/core/config-transfer.js';
import {applyConfigTransferImport, planConfigTransferExport, planConfigTransferImport} from '../../src/core/config-transfer-plan.js';
import {planSkillsImport, snapshotSkillsSection, type SkillsSection} from '../../src/core/config-transfer-skills.js';
import type {SkillMaterializeFn} from '../../src/services/config-transfer-skills-service.js';
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

async function planOf(data: SkillsSection) {
	const result = await planSkillsImport(data);
	if (!result.ok) throw new Error(result.error);
	return result.data.items;
}

beforeEach(() => {
	home = createTempHome('ccq-transfer-skills-');
});

afterEach(() => {
	home.restore();
	home.cleanup();
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
		expect(agents?.warnings).toEqual(['Codex / Pi Skill 链接已断开：broken-a']);
		expect(claude?.warnings).toEqual(['Claude Code Skill 链接已断开：broken-c']);
		expect(agents?.itemCount).toBe(1);
		expect(claude?.itemCount).toBe(1);
		expect(JSON.stringify(plan.data)).not.toContain('broken-p');
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

	test('两个分类依次导入恢复 shared 拓扑，本机其它 Skill 保留', async () => {
		writeSkill(agentsDir(), 'x', 'v1');
		link(join(agentsDir(), 'x'), join(claudeSkillsDir(), 'x'));
		const exported = await planConfigTransferExport({categories: SKILLS, includeCredentials: true});
		expect(exported.ok).toBe(true);
		if (!exported.ok) return;
		home.restore();
		home.cleanup();

		home = createTempHome('ccq-transfer-skills-import-');
		writeSkill(agentsDir(), 'keep-a', 'local');
		writeSkill(claudeSkillsDir(), 'keep-c', 'local');
		const calls: unknown[] = [];
		// 测试替身：按目标拓扑落盘，不调用真实 skills CLI。
		const materialize: SkillMaterializeFn = async ({name, snapshot, targets}) => {
			calls.push({name, targets});
			if (targets.cx) cpSync(snapshot.skillPath, join(agentsDir(), name), {recursive: true});
			if (targets.cc && targets.cx) link(join(agentsDir(), name), join(claudeSkillsDir(), name));
			else if (targets.cc) cpSync(snapshot.skillPath, join(claudeSkillsDir(), name), {recursive: true});
			return {ok: true};
		};
		const payload = parseBundlePayload({
			createdAt: 'now',
			createdBy: {name: 'ccq', version: 'test', platform: process.platform},
			containsCredentials: false,
			sections: exported.data.sections
		});
		expect(payload.ok).toBe(true);
		if (!payload.ok) return;
		const plan = await planConfigTransferImport(payload.data);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const outcome = await applyConfigTransferImport(payload.data, plan.data, [], {skills: {materialize}});
		expect(outcome.ok && outcome.data.status).toBe('complete');
		expect(calls).toEqual([
			{name: 'x', targets: {cc: false, cx: true}},
			{name: 'x', targets: {cc: true, cx: true}}
		]);
		expect(lstatSync(join(claudeSkillsDir(), 'x')).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(claudeSkillsDir(), 'x', 'SKILL.md'), 'utf8')).toContain('v1');
		expect(existsSync(join(agentsDir(), 'keep-a'))).toBe(true);
		expect(existsSync(join(claudeSkillsDir(), 'keep-c'))).toBe(true);
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
