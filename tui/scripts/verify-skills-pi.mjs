import assert from 'node:assert/strict';
import {
	classifySkillsStorageRoot,
	detectInstalledSkillItems,
	groupInstalledSkillItems,
	mergeInstalledSkillItems,
	skillDeletionCandidatePaths,
	needsManagedMigration
} from '../src/core/skills-installed.ts';
import {runSkillsAdd, runSkillsRemove} from '../src/core/skills-actions.ts';
import {getInstalledSkills, skillsAgentOf} from '../src/core/skills.ts';
import {targetRootsOfDraft} from '../src/state/skills-view-state.ts';

// Pi Skills 集成门禁：低层 core 区分 Codex .agents、Pi 全局 projection 与项目 native
// scope/物理根；Skills TUI 只把 Pi global 作为 Pi 管理目标，项目 scope 仅保留 CLI 兼容性。

assert.equal(skillsAgentOf('pi'), 'pi');
assert.equal(classifySkillsStorageRoot('/Users/demo/.pi/agent/skills/pdf'), 'pi-global');
assert.equal(classifySkillsStorageRoot('/workspace/project/.pi/skills/pdf'), 'pi-project');
assert.equal(classifySkillsStorageRoot('C:\\Users\\demo\\.pi\\agent\\skills\\pdf'), 'pi-global');

assert.deepEqual(targetRootsOfDraft({cc: false, cx: false, pi: true}), ['agents', 'pi-global']);
assert.deepEqual(targetRootsOfDraft({cc: false, cx: true, pi: true}), ['agents', 'pi-global']);

const globalItems = groupInstalledSkillItems([
	{name: 'pdf', path: '/h/.pi/agent/skills/pdf', scope: 'global', agents: ['Pi'], source: 'owner/repo'}
]);
assert.equal(needsManagedMigration(globalItems[0], 'codex-only'), true, 'Pi global 旧源应进入 .agents 收编迁移');
const projectItems = groupInstalledSkillItems([
	{name: 'pdf', path: '/workspace/.pi/skills/pdf', scope: 'project', agents: ['Pi'], source: 'owner/repo'}
]);
const merged = mergeInstalledSkillItems(globalItems, projectItems);
assert.equal(merged.length, 1, '同一 source 的 Pi global/project 应合并为一个逻辑实例');
assert.deepEqual(
	merged[0].projections.map(projection => projection.root),
	['pi-global', 'pi-project'],
	'两个 Pi scope 的物理投影都必须保留'
);
assert.ok(skillDeletionCandidatePaths(merged[0], '/h', '/workspace').some(path => path.endsWith('/.pi/agent/skills/pdf')));
assert.ok(skillDeletionCandidatePaths(merged[0], '/h', '/workspace').some(path => path.endsWith('/.pi/skills/pdf')));

const calls = [];
const fakeExec = async (command, args) => {
	calls.push({command, args: [...args]});
	return {code: 0, stdout: '', stderr: ''};
};

await runSkillsAdd(
	{source: 'owner/repo', skillNames: ['pdf'], agents: ['cx', 'pi'], scope: 'global'},
	undefined,
	fakeExec
);
assert.deepEqual(calls.at(-1).args, [
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

await runSkillsAdd(
	{source: 'owner/repo', skillNames: ['pdf'], agents: ['pi'], scope: 'project'},
	undefined,
	fakeExec
);
assert.equal(calls.at(-1).args.includes('-g'), false, 'Pi 项目 native 安装不得带 -g');
assert.deepEqual(calls.at(-1).args.slice(0, 8), [
	'--yes',
	'skills@latest',
	'add',
	'owner/repo',
	'--yes',
	'--agent',
	'pi',
	'--skill'
]);

await runSkillsRemove({skillNames: ['pdf'], agents: ['pi'], scope: 'project'}, undefined, fakeExec);
assert.equal(calls.at(-1).args.includes('-g'), false, 'Pi 项目 native 卸载不得带 -g');
assert.deepEqual(calls.at(-1).args.slice(0, 7), [
	'--yes',
	'skills@latest',
	'remove',
	'pdf',
	'--agent',
	'pi',
	'--yes'
]);

const listExec = async (_command, args) => {
	assert.deepEqual(args, ['--yes', 'skills', 'list', '--agent', 'pi', '--json']);
	return {
		code: 0,
		stdout: JSON.stringify([
			{name: 'pdf', path: '/workspace/.pi/skills/pdf', scope: 'project', agents: ['Pi']}
		]),
		stderr: ''
	};
};
const projectRecords = await detectInstalledSkillItems(listExec, 'project', 'pi');
assert.equal(projectRecords[0].projections[0].root, 'pi-project');

const projectSkills = await getInstalledSkills('pi', listExec, 'project');
assert.equal(projectSkills[0].path, '/workspace/.pi/skills/pdf');

console.log('[PASS] Skills Pi：agent 映射、全局 UI 根与低层 project scope 兼容门禁全部通过');
