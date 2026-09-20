import {describe, expect, test} from 'bun:test';
import {
	classifySkillsStorageRoot,
	detectInstalledSkillItems,
	groupInstalledSkillItems,
	mergeInstalledSkillItems,
	needsManagedMigration,
	skillDeletionCandidatePaths
} from '../../src/core/skills-installed.js';
import {runSkillsAdd, runSkillsRemove} from '../../src/core/skills-actions.js';
import {getInstalledSkills, skillsAgentOf} from '../../src/core/skills.js';
import {targetRootsOfDraft} from '../../src/state/skills-view-state.js';

// 载体迁移（P3a）：原 scripts/verify-skills-pi.mjs（19 条静态断言）整体迁入。
// Pi Skills 集成门禁：低层 core 区分 Codex .agents、Pi 全局 projection 与项目 native
// scope/物理根；Skills TUI 只把 Pi global 作为 Pi 管理目标，项目 scope 仅保留 CLI 兼容性。

type Call = {command: string; args: readonly string[]};

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`缺少 ${label}`);
	return value;
}

describe('Skills Pi 集成（core/skills-installed.ts + core/skills-actions.ts）', () => {
	test('Pi agent 映射、全局/项目 root 分类与 target 草稿', () => {
		expect(skillsAgentOf('pi')).toBe('pi');
		expect(classifySkillsStorageRoot('/Users/demo/.pi/agent/skills/pdf')).toBe('pi-global');
		expect(classifySkillsStorageRoot('/workspace/project/.pi/skills/pdf')).toBe('pi-project');
		expect(classifySkillsStorageRoot('C:\\Users\\demo\\.pi\\agent\\skills\\pdf')).toBe('pi-global');

		expect(targetRootsOfDraft({cc: false, cx: false, pi: true})).toEqual(['agents', 'pi-global']);
		expect(targetRootsOfDraft({cc: false, cx: true, pi: true})).toEqual(['agents', 'pi-global']);
	});

	test('Pi global 旧源迁移判定、global/project 逻辑合并与删除候选路径', () => {
		const globalItems = groupInstalledSkillItems([
			{name: 'pdf', path: '/h/.pi/agent/skills/pdf', scope: 'global', agents: ['Pi'], source: 'owner/repo'}
		]);
		expect(needsManagedMigration(required(globalItems[0], 'global item'), 'codex-only'), 'Pi global 旧源应进入 .agents 收编迁移').toBe(
			true
		);
		const projectItems = groupInstalledSkillItems([
			{name: 'pdf', path: '/workspace/.pi/skills/pdf', scope: 'project', agents: ['Pi'], source: 'owner/repo'}
		]);
		const merged = mergeInstalledSkillItems(globalItems, projectItems);
		expect(merged.length, '同一 source 的 Pi global/project 应合并为一个逻辑实例').toBe(1);
		expect(
			required(merged[0], 'merged item').projections.map(projection => projection.root),
			'两个 Pi scope 的物理投影都必须保留'
		).toEqual(['pi-global', 'pi-project']);
		const candidates = skillDeletionCandidatePaths(required(merged[0], 'merged item'), '/h', '/workspace');
		expect(candidates.some(path => path.endsWith('/.pi/agent/skills/pdf'))).toBe(true);
		expect(candidates.some(path => path.endsWith('/.pi/skills/pdf'))).toBe(true);
	});

	test('Pi CLI argv：add/remove 的 -g 与 --agent，及 project scope 检测兼容', async () => {
		const calls: Call[] = [];
		const fakeExec = async (command: string, args: readonly string[]) => {
			calls.push({command, args: [...args]});
			return {code: 0, stdout: '', stderr: ''};
		};
		const lastArgs = () => calls.at(-1)?.args ?? [];

		await runSkillsAdd({source: 'owner/repo', skillNames: ['pdf'], agents: ['cx', 'pi'], scope: 'global'}, undefined, fakeExec);
		expect(lastArgs()).toEqual([
			'--yes',
			'skills@latest',
			'add',
			'owner/repo',
			'--yes',
			'--agent',
			'codex',
			'--agent',
			'pi',
			'-g',
			'--skill',
			'pdf'
		]);

		await runSkillsAdd({source: 'owner/repo', skillNames: ['pdf'], agents: ['pi'], scope: 'project'}, undefined, fakeExec);
		expect(lastArgs().includes('-g'), 'Pi 项目 native 安装不得带 -g').toBe(false);
		expect(lastArgs().slice(0, 8)).toEqual(['--yes', 'skills@latest', 'add', 'owner/repo', '--yes', '--agent', 'pi', '--skill']);

		await runSkillsRemove({skillNames: ['pdf'], agents: ['pi'], scope: 'project'}, undefined, fakeExec);
		expect(lastArgs().includes('-g'), 'Pi 项目 native 卸载不得带 -g').toBe(false);
		expect(lastArgs().slice(0, 7)).toEqual(['--yes', 'skills@latest', 'remove', 'pdf', '--agent', 'pi', '--yes']);

		const listExec = async (_command: string, args: readonly string[]) => {
			expect(args).toEqual(['--yes', 'skills', 'list', '--agent', 'pi', '--json']);
			return {
				code: 0,
				stdout: JSON.stringify([{name: 'pdf', path: '/workspace/.pi/skills/pdf', scope: 'project', agents: ['Pi']}]),
				stderr: ''
			};
		};
		const projectRecords = await detectInstalledSkillItems(listExec, 'project', 'pi');
		expect(required(required(projectRecords[0], 'project record').projections[0], 'projection').root).toBe('pi-project');

		const projectSkills = await getInstalledSkills('pi', listExec, 'project');
		expect(required(projectSkills[0], 'project skill').path).toBe('/workspace/.pi/skills/pdf');
	});
});
