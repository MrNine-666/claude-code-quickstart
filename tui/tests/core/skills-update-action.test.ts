import {describe, expect, test} from 'bun:test';
import {groupInstalledSkillItems, type InstalledSkillItem} from '../../src/core/skills-installed.js';
import type {DetectionCache} from '../../src/hooks/use-detection-cache.js';
import type {TaskCancellation} from '../../src/hooks/use-task-cancellation.js';
import {updateSkillInstances} from '../../src/services/skills-service.js';
import {createInitialSkillsViewState, reduceSkillsViewState} from '../../src/state/skills-view-state.js';
import {runUpdateSelectedIfReadyAction} from '../../src/views/skills/skills-view-actions.js';
import type {SkillsDetection, SkillsViewServices} from '../../src/views/skills/skills-view-types.js';

// 载体迁移（P3a）：原 scripts/verify-skills-update-action.mjs（15 条静态断言）整体迁入。
// 覆盖：名称级 selector 稳定去重 + unknown skip + 单次 CLI 调用、无 update-all 空名单路径、
// 成功/失败的已启动 update 都恰好一次完整复检。

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`缺少 ${label}`);
	return value;
}

function recordingExec(stdout = 'updated', stderr = '', code = 0) {
	const calls: {command: string; args: readonly string[]}[] = [];
	const exec = async (command: string, args: readonly string[]) => {
		calls.push({command, args});
		return {code, stdout, stderr};
	};
	return {exec, calls};
}

function taskCancellation(): TaskCancellation {
	let controller: AbortController | undefined;
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

function terminalDispatch(invoke: (dispatch: (action: {type: string; [key: string]: unknown}) => void) => void) {
	return new Promise<{type: string; [key: string]: unknown}>((resolve, reject) => {
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

describe('Skills 批量 update（services/skills-service.ts + views/skills/skills-view-actions.ts）', () => {
	test('Skills 批量 update：unknown skip、名称稳定去重、单次 CLI 调用', async () => {
		const pdfItems = items.filter(item => item.name === 'pdf');
		const selected = [
			required(pdfItems[0], 'pdf[0]'),
			required(
				items.find(item => item.name === 'docs'),
				'docs'
			),
			required(pdfItems[1], 'pdf[1]'),
			required(
				items.find(item => item.name === 'ghost'),
				'ghost'
			)
		];
		const {exec, calls} = recordingExec();
		const result = await updateSkillInstances(selected, undefined, exec);
		expect(calls.length, '批量 update 必须合并为一次 CLI 调用').toBe(1);
		expect(required(calls[0], 'calls[0]').command).toBe('npx');
		expect(required(calls[0], 'calls[0]').args).toEqual(['--yes', 'skills@latest', 'update', 'pdf', 'docs', '-g', '-y']);
		expect(result.updatedNames, '同名异源必须按首次出现稳定去重').toEqual(['pdf', 'docs']);
		expect(result.skippedInstanceIds).toEqual([
			required(
				items.find(item => item.name === 'ghost'),
				'ghost'
			).id
		]);
		expect(result.selectedCount).toBe(4);
		expect(result.success).toBe(true);
	});

	test('Skills 列表无空名单/update-all 路径', async () => {
		const unknown = items.filter(item => !item.capabilities.update);
		const {exec, calls} = recordingExec();
		const result = await updateSkillInstances(unknown, undefined, exec);
		expect(result.success).toBe(false);
		expect(calls.length, '无可更新名称时不得 spawn').toBe(0);
		expect(result.error ?? '').toMatch(/未知来源/);
		// 已废弃全量/旧单项 update seam 的静态守卫已迁往
		// scripts/verify-view-architecture.mjs 的 P1-G3 段（同时由本文件上文的
		// updateSkillInstances 行为断言覆盖「无空名单/update-all 路径」）。
	});

	function busyState(installed: readonly InstalledSkillItem[], pickedIds: readonly string[]) {
		const loaded = reduceSkillsViewState(createInitialSkillsViewState(), {type: 'installed-loaded', installed});
		return reduceSkillsViewState({...loaded, pickedInstalledIds: pickedIds}, {type: 'request-update'});
	}

	// 成功和失败的已启动 update 都只进行一次完整复检。
	for (const scenario of [
		{label: '成功', result: {success: true, selectedCount: 2, updatedNames: ['pdf'], skippedInstanceIds: []}, error: undefined},
		{
			label: '失败',
			result: {success: false, error: 'boom', selectedCount: 2, updatedNames: ['pdf'], skippedInstanceIds: []},
			error: 'boom'
		}
	]) {
		test(`Skills 批量 update ${scenario.label}：一次完整复检`, async () => {
			const selected = items.filter(item => item.name === 'pdf');
			const state = busyState(
				items,
				selected.map(item => item.id)
			);
			const refreshed = items.filter(item => item.name !== 'docs');
			let refreshCalls = 0;
			let receivedTargets: readonly InstalledSkillItem[] | undefined;
			const cache = {
				async refreshAndWait() {
					refreshCalls++;
					return {status: 'success', result: refreshed};
				},
				refresh() {}
			} as unknown as DetectionCache<SkillsDetection>;
			const action = await terminalDispatch(dispatch =>
				runUpdateSelectedIfReadyAction(
					state,
					{
						async updateInstances(targets: readonly InstalledSkillItem[]) {
							receivedTargets = targets;
							return scenario.result;
						}
					} as unknown as SkillsViewServices,
					dispatch as never,
					cache,
					taskCancellation()
				)
			);
			expect(
				required(receivedTargets, 'receivedTargets').map(item => item.id),
				`${scenario.label}应使用 request-update 锁定的 Item 快照`
			).toEqual(selected.map(item => item.id));
			expect(refreshCalls, `${scenario.label}的已启动 update 必须且只能复检一次`).toBe(1);
			expect(action.type).toBe('lifecycle-reconciled');
			expect(action.installed).toBe(refreshed);
			expect(action.error).toBe(scenario.error);
		});
	}
});
