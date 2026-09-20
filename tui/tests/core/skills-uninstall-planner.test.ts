import {describe, expect, test} from 'bun:test';
import {join} from 'node:path';
import {groupInstalledSkillItems, type InstalledSkillItem} from '../../src/core/skills-installed.js';
import type {DetectionCache} from '../../src/hooks/use-detection-cache.js';
import type {TaskCancellation} from '../../src/hooks/use-task-cancellation.js';
import {uninstallSkillInstance} from '../../src/services/skills-service.js';
import {createInitialSkillsViewState, reduceSkillsViewState} from '../../src/state/skills-view-state.js';
import {runConfirmedUninstallAction} from '../../src/views/skills/skills-view-actions.js';
import type {SkillsDetection, SkillsViewServices} from '../../src/views/skills/skills-view-types.js';

// 载体迁移（P3b）：原 scripts/verify-skills-uninstall-planner.mjs 的 planner 纯决策段
// （U-1 / U-5 / U-9 / U-10，共 13 条静态断言）迁入；真实路径分类与真实目录判定段
// （U-2 / U-3 / U-4 / U-6 / U-7 / U-8，共 25 条）保留在 verify。
//
// 判据：迁走段的执行路径不读磁盘 —— U-1/U-5 走 `officialRemovalIsolated` 的官方
// remove 分支（exec 注入桩，storageOptions.homeDir 不参与），U-9/U-10 走注入的
// `uninstallInstances` + 注入 cache，断言只覆盖 outcome / mutation / 复检次数契约。

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`缺少 ${label}`);
	return value;
}

// 纯 planner 段不读磁盘，home 只用于拼装 Item projection 路径。
const homeDir = join('/fake-home', 'ccq-uninst-planner');

function makeExec() {
	const calls: {command: string; args: readonly string[]}[] = [];
	const exec = async (command: string, args: readonly string[]) => {
		calls.push({command, args});
		return {code: 0, stdout: '', stderr: ''};
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
		const timer = setTimeout(() => reject(new Error('等待 uninstall reconciliation 超时')), 2000);
		invoke(action => {
			if (action.type === 'uninstall-reconciled' || action.type === 'action-failed') {
				clearTimeout(timer);
				resolve(action);
			}
		});
	});
}

function uninstallConfirmState(installed: readonly InstalledSkillItem[]) {
	const loaded = reduceSkillsViewState(createInitialSkillsViewState(), {type: 'installed-loaded', installed});
	return reduceSkillsViewState(loaded, {type: 'request-uninstall'});
}

describe('Skills uninstall planner（services/skills-service.ts + views/skills/skills-view-actions.ts）', () => {
	// ── U-1 isolated：官方 remove 被调用，不直接删文件 ────────────────────────
	test('U-1 isolated：官方 remove，complete', async () => {
		const items = groupInstalledSkillItems([
			{name: 'pdf', path: join(homeDir, '.agents', 'skills', 'pdf'), scope: 'global', agents: ['Codex'], source: 'o/a'}
		]);
		const {exec, calls} = makeExec();
		const out = await uninstallSkillInstance(required(items[0], 'items[0]'), items, undefined, exec, {homeDir});
		expect(calls.length, 'isolated 必须走官方 remove 一次').toBe(1);
		expect(required(calls[0], 'calls[0]').args.includes('remove')).toBe(true);
		expect(out.outcome).toBe('complete');
		expect(out.mutated).toBe(true);
	});

	// ── U-5 isolated 官方 remove 失败 → failed 透传诊断 ────────────────────────
	test('U-5 官方 remove 失败：failed 透传且要求复检', async () => {
		const items = groupInstalledSkillItems([
			{name: 'fail', path: join(homeDir, '.agents', 'skills', 'fail'), scope: 'global', agents: ['Codex'], source: 'o/a'}
		]);
		const exec = async () => ({code: 1, stdout: '', stderr: 'boom'});
		const out = await uninstallSkillInstance(required(items[0], 'items[0]'), items, undefined, exec, {homeDir});
		expect(out.outcome).toBe('failed');
		expect(out.mutated, '官方命令已启动时必须复检，不能假定失败前毫无修改').toBe(true);
	});

	// ── U-9 mutation 后即使 partial 也必须完整复检并采用真实列表 ─────────────
	test('U-9 partial mutation：完整复检并保留真实诊断', async () => {
		const installed = groupInstalledSkillItems([
			{
				name: 'partial-view',
				path: join(homeDir, '.agents', 'skills', 'partial-view'),
				scope: 'global',
				agents: ['Codex'],
				source: 'o/a'
			}
		]);
		const refreshed = groupInstalledSkillItems([
			{name: 'other', path: join(homeDir, '.agents', 'skills', 'other'), scope: 'global', agents: ['Codex'], source: 'o/b'}
		]);
		let refreshCalls = 0;
		const cache = {
			async refreshAndWait() {
				refreshCalls++;
				return {status: 'success', result: refreshed};
			},
			refresh() {}
		} as unknown as DetectionCache<SkillsDetection>;
		const action = await terminalDispatch(dispatch =>
			runConfirmedUninstallAction(
				uninstallConfirmState(installed),
				{
					async uninstallInstances() {
						return {
							outcome: 'partial',
							mutated: true,
							error: '原实例残留',
							items: [
								{
									item: required(installed[0], 'installed[0]'),
									result: {outcome: 'partial', mutated: true, error: '原实例残留'}
								}
							]
						};
					}
				} as unknown as SkillsViewServices,
				dispatch as never,
				cache,
				taskCancellation()
			)
		);
		expect(refreshCalls, 'partial mutation 必须完整复检一次').toBe(1);
		expect(action.type).toBe('uninstall-reconciled');
		expect(action.installed).toBe(refreshed);
		expect(action.error).toBe('原实例残留');
	});

	// ── U-10 未 mutation 的安全预检失败不刷新，直接保留原列表 ──────────────────
	test('U-10 未 mutation 的预检失败：不刷新且保留诊断', async () => {
		const installed = groupInstalledSkillItems([
			{
				name: 'blocked-view',
				path: join(homeDir, '.agents', 'skills', 'blocked-view'),
				scope: 'global',
				agents: ['Codex'],
				source: 'o/a'
			}
		]);
		let refreshCalls = 0;
		const cache = {
			async refreshAndWait() {
				refreshCalls++;
				return {status: 'success', result: installed};
			},
			refresh() {}
		} as unknown as DetectionCache<SkillsDetection>;
		const action = await terminalDispatch(dispatch =>
			runConfirmedUninstallAction(
				uninstallConfirmState(installed),
				{
					async uninstallInstances() {
						return {
							outcome: 'failed',
							mutated: false,
							error: '路径歧义',
							items: [
								{
									item: required(installed[0], 'installed[0]'),
									result: {outcome: 'failed', mutated: false, error: '路径歧义'}
								}
							]
						};
					}
				} as unknown as SkillsViewServices,
				dispatch as never,
				cache,
				taskCancellation()
			)
		);
		expect(refreshCalls).toBe(0);
		expect(action.type).toBe('action-failed');
		expect(action.error).toBe('路径歧义');
	});
});
