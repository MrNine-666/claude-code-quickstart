import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';

import {materializePortableTreeEntries} from '../../src/core/config-transfer-sections.js';
import {planSkillsImport, parseSkillsSection, snapshotSkillsSection, type ExportedSkill} from '../../src/core/config-transfer-skills.js';
import {cleanupSkillSnapshot, createSkillSnapshot} from '../../src/core/skills-storage.js';
import {importSkillsSection} from '../../src/services/config-transfer-skills-service.js';
import {materializeSkillTargetsFromSnapshot} from '../../src/services/skills-adoption.js';
import {createTempHome} from '../helpers/temp-home.js';

// Phase 2 Part B：Skills 共享内容快照 + 目标拓扑恢复 seam。全部使用临时 CCQ_HOME。

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, content, 'utf8');
}

function writeSkill(root: string, name: string, files: Readonly<Record<string, string>> = {}): void {
	writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`);
	for (const [relativePath, content] of Object.entries(files)) {
		writeFile(join(root, name, relativePath), content);
	}
}

function skillMd(name: string): string {
	return `---
name: ${name}
description: ${name} skill
---
# ${name}
`;
}

function skillEntry(name: string, targets: readonly ('cc' | 'cx' | 'pi')[], files: Readonly<Record<string, string>>): ExportedSkill {
	return {
		id: `${name}#test`,
		name,
		targets,
		files: Object.entries(files).map(([relativePath, content]) => ({
			kind: 'file' as const,
			root: 'agents' as const,
			path: `${name}/${relativePath}`,
			contentBase64: Buffer.from(content, 'utf8').toString('base64'),
			mode: 0o644
		}))
	};
}

describe('Skills 快照', () => {
	test('相同内容跨目标只打包一次并合并 targets；真实内容可往返', async () => {
		const home = createTempHome('ccq-transfer-skills-');
		const tempDir = join(home.path, 'stage');
		try {
			writeSkill(join(home.path, '.claude', 'skills'), 'pdf', {'scripts/run.sh': 'echo hi\n'});
			writeSkill(join(home.path, '.agents', 'skills'), 'pdf', {'scripts/run.sh': 'echo hi\n'});
			writeSkill(join(home.path, '.pi', 'agent', 'skills'), 'pi-only');

			const snapshot = await snapshotSkillsSection({targets: ['cc', 'cx', 'pi'], tempDir});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.skills.map(skill => skill.name)).toEqual(['pdf', 'pi-only']);
			const pdf = snapshot.data.skills.find(skill => skill.name === 'pdf');
			expect(pdf?.targets).toEqual(['cc', 'cx']);
			expect(pdf?.files.map(entry => entry.path).sort()).toEqual(['pdf/SKILL.md', 'pdf/scripts/run.sh']);
			expect(pdf?.files.every(entry => entry.root === 'agents')).toBe(true);

			const roundtrip = mkdtempSync(join(tmpdir(), 'ccq-skill-roundtrip-'));
			try {
				const materialized = materializePortableTreeEntries(roundtrip, pdf?.files ?? [], false);
				expect(materialized.ok).toBe(true);
				expect(readFileSync(join(roundtrip, 'pdf', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n');
				expect(readFileSync(join(roundtrip, 'pdf', 'SKILL.md'), 'utf8')).toContain('name: pdf');
			} finally {
				rmSync(roundtrip, {recursive: true, force: true});
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Skills 已知认证文件不进包；伪造包的认证文件拒绝导入', async () => {
		const home = createTempHome('ccq-transfer-skills-auth-');
		try {
			const root = join(home.path, '.agents', 'skills');
			writeSkill(root, 'safe', {
				'.env': 'OAUTH-SENTINEL',
				'nested/auth.json': 'OAUTH-SENTINEL',
				'scripts/run.ts': 'export default 1;'
			});
			const snapshot = await snapshotSkillsSection({targets: ['cx'], tempDir: join(home.path, 'stage')});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.skills[0]?.files.map(entry => entry.path).sort()).toEqual(['safe/SKILL.md', 'safe/scripts/run.ts']);
			expect(JSON.stringify(snapshot.data)).not.toContain('OAUTH-SENTINEL');
			expect(
				parseSkillsSection({skills: [skillEntry('safe', ['cx'], {'SKILL.md': skillMd('safe'), '.env': 'OAUTH-SENTINEL'})]}).ok
			).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('根 projection symlink 不作为内容导出', async () => {
		if (process.platform === 'win32') {
			return;
		}

		const home = createTempHome('ccq-transfer-skills-link-');
		const tempDir = join(home.path, 'stage');
		try {
			writeSkill(join(home.path, '.agents', 'skills'), 'pdf');
			mkdirSync(join(home.path, '.claude', 'skills'), {recursive: true});
			symlinkSync(join(home.path, '.agents', 'skills', 'pdf'), join(home.path, '.claude', 'skills', 'pdf'), 'dir');

			const snapshot = await snapshotSkillsSection({targets: ['cc'], tempDir});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			const pdf = snapshot.data.skills[0];
			expect(pdf?.targets).toEqual(['cc']);
			expect(pdf?.files.map(entry => `${entry.kind}:${entry.path}`)).toEqual(['file:pdf/SKILL.md']);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('无效 Skill 跳过并进入 warning；同名异构只保留一份', async () => {
		const home = createTempHome('ccq-transfer-skills-warn-');
		const tempDir = join(home.path, 'stage');
		try {
			writeFile(join(home.path, '.claude', 'skills', 'broken', 'SKILL.md'), '# no frontmatter\n');
			writeSkill(join(home.path, '.claude', 'skills'), 'same', {'a.txt': 'A'});
			writeSkill(join(home.path, '.agents', 'skills'), 'same', {'a.txt': 'B'});

			const snapshot = await snapshotSkillsSection({targets: ['cc', 'cx'], tempDir});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.skills.map(skill => skill.name)).toEqual(['same']);
			expect(snapshot.data.skills[0]?.targets).toEqual(['cc']);
			expect(snapshot.warnings.some(warning => warning.includes('broken'))).toBe(true);
			expect(snapshot.warnings.some(warning => warning.includes('同名但内容不同'))).toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('Skills 导入预览', () => {
	test('add/replace/unchanged/blocked 状态与零写盘', async () => {
		const home = createTempHome('ccq-transfer-skills-plan-');
		const tempDir = join(home.path, 'stage');
		try {
			writeSkill(join(home.path, '.agents', 'skills'), 'same');
			writeFile(join(home.path, '.claude', 'skills', 'broken', 'SKILL.md'), '# no frontmatter\n');

			const same = skillEntry('same', ['cx'], {
				'SKILL.md': readFileSync(join(home.path, '.agents', 'skills', 'same', 'SKILL.md'), 'utf8')
			});
			const plan = await planSkillsImport(
				{
					skills: [
						same,
						skillEntry('fresh', ['cc'], {'SKILL.md': skillMd('fresh')}),
						skillEntry('broken', ['cc'], {'SKILL.md': skillMd('broken')})
					]
				},
				{homeDir: home.path, tempDir}
			);
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.data.items.map(item => [item.name, item.state])).toEqual([
				['same', 'unchanged'],
				['fresh', 'add'],
				['broken', 'blocked']
			]);

			const blocked = await importSkillsSection(
				{skills: [skillEntry('broken', ['cc'], {'SKILL.md': skillMd('broken')})]},
				{homeDir: home.path, tempDir}
			);
			expect(blocked.ok).toBe(false);
			expect(readFileSync(join(home.path, '.claude', 'skills', 'broken', 'SKILL.md'), 'utf8')).toBe('# no frontmatter\n');

			const preview = await importSkillsSection(
				{skills: [skillEntry('fresh', ['cc'], {'SKILL.md': skillMd('fresh')})]},
				{homeDir: home.path, dryRun: true}
			);
			expect(preview.ok).toBe(true);
			expect(existsSync(join(home.path, '.claude', 'skills', 'fresh'))).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('导入只物化包内 Skill，包外本机 Skill 不删除', async () => {
		const home = createTempHome('ccq-transfer-skills-import-');
		const tempDir = join(home.path, 'stage');
		try {
			writeSkill(join(home.path, '.claude', 'skills'), 'keep-me');
			const calls: string[] = [];
			const imported = await importSkillsSection(
				{skills: [skillEntry('pdf', ['cc'], {'SKILL.md': '---\nname: pdf\ndescription: pdf\n---\n'})]},
				{
					homeDir: home.path,
					tempDir,
					materialize: async ({name, snapshot, targets}) => {
						calls.push(`${name}:${targets.join(',')}:${snapshot.manifest.length}`);
						return {ok: true};
					}
				}
			);
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.added).toEqual(['pdf#test']);
			expect(calls).toEqual(['pdf:cc:1']);
			expect(existsSync(join(home.path, '.claude', 'skills', 'keep-me')), '包外本机 Skill 必须保留').toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('Skills 分类校验', () => {
	test('lifecycle seam：命令 exit 0 但无文件事实时不得声称成功', async () => {
		const home = createTempHome('ccq-transfer-skills-seam-');
		const tempDir = join(home.path, 'stage');
		try {
			writeSkill(join(home.path, 'src'), 'pdf');
			const snapshot = await createSkillSnapshot(join(home.path, 'src', 'pdf'), 'pdf', {homeDir: home.path, tempDir});
			const result = await materializeSkillTargetsFromSnapshot(
				'pdf',
				snapshot,
				{cc: true, cx: false, pi: false},
				undefined,
				async () => ({code: 0, stdout: '', stderr: ''}),
				{homeDir: home.path, tempDir}
			);
			expect(result.success).toBe(false);
			expect(result.mutated).toBe(true);
			expect(result.outcome).not.toBe('complete');
			expect(result.recoveryPath).toBe(snapshot.skillPath);
			await cleanupSkillSnapshot(snapshot);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('拒绝不安全名称、越界路径、重复条目与未知目标', () => {
		const file = {
			kind: 'file',
			root: 'agents',
			path: 'pdf/SKILL.md',
			contentBase64: Buffer.from(skillMd('pdf'), 'utf8').toString('base64'),
			mode: 0o644
		};
		expect(parseSkillsSection({skills: [{id: 'a', name: '../escape', targets: ['cc'], files: [file]}]}).ok).toBe(false);
		expect(parseSkillsSection({skills: [{id: 'a', name: 'pdf', targets: ['cc'], files: [{...file, path: 'pdf/../../x'}]}]}).ok).toBe(
			false
		);
		expect(parseSkillsSection({skills: [{id: 'a', name: 'pdf', targets: ['cc'], files: [{...file, root: 'claude'}]}]}).ok).toBe(false);
		expect(parseSkillsSection({skills: [{id: 'a', name: 'pdf', targets: ['nope'], files: [file]}]}).ok).toBe(false);
		expect(
			parseSkillsSection({
				skills: [
					{id: 'a', name: 'pdf', targets: ['cc'], files: [file]},
					{id: 'b', name: 'pdf', targets: ['cx'], files: [file]}
				]
			}).ok
		).toBe(false);
		expect(parseSkillsSection({skills: [{id: 'a', name: 'pdf', targets: ['cc'], files: [file]}]}).ok).toBe(true);
		expect(
			parseSkillsSection({
				skills: [
					{
						id: 'a',
						name: 'pdf',
						targets: ['cc'],
						files: [{...file, contentBase64: Buffer.from('no frontmatter', 'utf8').toString('base64')}]
					}
				]
			}).ok,
			'包内 SKILL.md 无效必须在预览前拒绝'
		).toBe(false);
	});
});
