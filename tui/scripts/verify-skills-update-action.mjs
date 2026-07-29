import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {groupInstalledSkillItems} from '../src/core/skills-installed.ts';
import {updateSkillInstances} from '../src/services/skills-service.ts';
import {createInitialSkillsViewState, reduceSkillsViewState} from '../src/state/skills-view-state.ts';
import {runUpdateSelectedIfReadyAction} from '../src/views/skills/skills-view-actions.ts';

function recordingExec(stdout = 'updated', stderr = '', code = 0) {
	const calls = [];
	const exec = async (command, args) => {
		calls.push({command, args});
		return {code, stdout, stderr};
	};
	return {exec, calls};
}

function taskCancellation() {
	let controller;
	return {
		start() {
			controller = new AbortController();
			return controller.signal;
		},
		cancel() {
			controller?.abort();
			return Boolean(controller);
		},
		finish() {
			controller = undefined;
		}
	};
}

function terminalDispatch(invoke) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('等待 update reconciliation 超时')), 2000);
		invoke(action => {
			if (action.type === 'lifecycle-reconciled' || action.type === 'action-failed') {
				clearTimeout(timer);
				resolve(action);
			}
		});
	});
}

const items = groupInstalledSkillItems([
	{name: 'pdf', path: '/home/u/.agents/skills/pdf', scope: 'global', agents: ['Codex'], source: 'o/a'},
	{name: 'pdf', path: '/home/u/.claude/skills/pdf', scope: 'global', agents: ['Claude Code'], source: 'o/b'},
	{name: 'ghost', path: '/home/u/.agents/skills/ghost', scope: 'global', agents: ['Codex']},
	{name: 'docs', path: '/home/u/.agents/skills/docs', scope: 'global', agents: ['Codex'], source: 'o/c'}
]);

// 批量 update 只有名称级 selector：已知来源按首次出现去重，unknown 记录 skipped。
{
	const pdfItems = items.filter(item => item.name === 'pdf');
	const selected = [pdfItems[0], items.find(item => item.name === 'docs'), pdfItems[1], items.find(item => item.name === 'ghost')];
	const {exec, calls} = recordingExec();
	const result = await updateSkillInstances(selected, undefined, exec);
	assert.equal(calls.length, 1, '批量 update 必须合并为一次 CLI 调用');
	assert.equal(calls[0].command, 'npx');
	assert.deepEqual(calls[0].args, ['--yes', 'skills@latest', 'update', 'pdf', 'docs', '-g', '-y']);
	assert.deepEqual(result.updatedNames, ['pdf', 'docs'], '同名异源必须按首次出现稳定去重');
	assert.deepEqual(result.skippedInstanceIds, [items.find(item => item.name === 'ghost').id]);
	assert.equal(result.selectedCount, 4);
	assert.equal(result.success, true);
	console.log('[PASS] Skills 批量 update：unknown skip、名称稳定去重、单次 CLI 调用');
}

// 全 unknown 不得退化成空名单的「更新全部」。
{
	const unknown = items.filter(item => !item.capabilities.update);
	const {exec, calls} = recordingExec();
	const result = await updateSkillInstances(unknown, undefined, exec);
	assert.equal(result.success, false);
	assert.equal(calls.length, 0, '无可更新名称时不得 spawn');
	assert.match(result.error ?? '', /未知来源/);
	const actionSource = readFileSync(new URL('../src/views/skills/skills-view-actions.ts', import.meta.url), 'utf8');
	const serviceSource = readFileSync(new URL('../src/services/skills-service.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(actionSource, /runUpdateIfReadyAction|runUpdateOneIfReadyAction/, 'TUI 不得保留全量/旧单项 update 入口');
	assert.doesNotMatch(serviceSource, /updateAllSkillsBothSides/, 'view service 不得保留更新全部 seam');
	console.log('[PASS] Skills 列表无空名单/update-all 路径');
}

function busyState(installed, pickedIds) {
	const loaded = reduceSkillsViewState(createInitialSkillsViewState(), {type: 'installed-loaded', installed});
	return reduceSkillsViewState({...loaded, pickedInstalledIds: pickedIds}, {type: 'request-update'});
}

// 成功和失败的已启动 update 都只进行一次完整复检。
for (const scenario of [
	{label: '成功', result: {success: true, selectedCount: 2, updatedNames: ['pdf'], skippedInstanceIds: []}, error: undefined},
	{label: '失败', result: {success: false, error: 'boom', selectedCount: 2, updatedNames: ['pdf'], skippedInstanceIds: []}, error: 'boom'}
]) {
	const selected = items.filter(item => item.name === 'pdf');
	const state = busyState(items, selected.map(item => item.id));
	const refreshed = items.filter(item => item.name !== 'docs');
	let refreshCalls = 0;
	let receivedTargets;
	const cache = {
		async refreshAndWait() {
			refreshCalls++;
			return {status: 'success', result: refreshed};
		},
		refresh() {}
	};
	const action = await terminalDispatch(dispatch => runUpdateSelectedIfReadyAction(
		state,
		{async updateInstances(targets) { receivedTargets = targets; return scenario.result; }},
		dispatch,
		cache,
		taskCancellation()
	));
	assert.deepEqual(receivedTargets.map(item => item.id), selected.map(item => item.id), `${scenario.label}应使用 request-update 锁定的 Item 快照`);
	assert.equal(refreshCalls, 1, `${scenario.label}的已启动 update 必须且只能复检一次`);
	assert.equal(action.type, 'lifecycle-reconciled');
	assert.equal(action.installed, refreshed);
	assert.equal(action.error, scenario.error);
	console.log(`[PASS] Skills 批量 update ${scenario.label}：一次完整复检`);
}

console.log('[PASS] Skills update action 门禁全部通过');
