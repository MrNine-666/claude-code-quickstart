import {describe, expect, test} from 'bun:test';
import {COMPONENT_DEFINITIONS, type ComponentId, type ManagedComponent} from '../../src/core/tools-manage.js';
import type {DetectionCache} from '../../src/hooks/use-detection-cache.js';
import type {TaskCancellation} from '../../src/hooks/use-task-cancellation.js';
import {createInitialToolsViewState} from '../../src/state/tools-view-state.js';
import {
	groupToolsForHome,
	runPrimaryAction,
	runUninstall,
	successfulInstallPatch,
	successfulUpdatePatch,
	toolStatusDot,
	updateAll
} from '../../src/views/tools/tools-view-actions.js';
import type {ToolsViewAction} from '../../src/state/tools-view-state.js';
import type {ToolsViewServices} from '../../src/views/tools/tools-view-types.js';

// A 类改写（P1-G3）：verify-tools-manage.mjs / verify-tools-view.mjs / verify-tools-shared-projection.mjs
//   89/90/91 版本号与预发布 warning 分离
//   144 ToolsHomeView 走 groupToolsForHome 领域分组
//   159/164/169 单项 install/update/uninstall 成功后同步 App 检测缓存
//   518/519/520 updateAll 先用本地结果结算，不等待二次全量检测，失败/成功都刷新

function component(id: ComponentId, over: Partial<ManagedComponent> = {}): ManagedComponent {
	const def = COMPONENT_DEFINITIONS.find(entry => entry.id === id);
	if (!def) throw new Error(`未知组件 ${id}`);
	return {...def, installed: false, currentVersion: '', latestVersion: '', hasUpdate: null, ...over};
}

function taskCancellation(): TaskCancellation {
	return {
		start: () => new AbortController().signal,
		cancel: () => false,
		finish() {}
	} as unknown as TaskCancellation;
}

function recordingCache(components: readonly ManagedComponent[] = []) {
	const refreshCalls: unknown[] = [];
	const cache = {
		state: {status: 'success', result: components},
		refresh(options?: unknown) {
			refreshCalls.push(options);
		},
		async refreshAndWait() {
			return cache.state;
		}
	} as unknown as DetectionCache<ManagedComponent[]>;
	return {cache, refreshCalls};
}

const idleTick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('toolStatusDot 版本号与预发布 warning 分离', () => {
	test('已安装且最新时版本标签只使用原始版本号', () => {
		const latest = toolStatusDot(component('OpenSpec', {installed: true, currentVersion: '1.2.3', hasUpdate: false}) as never, 'idle');
		expect(latest.label).toBe('1.2.3');
		expect(latest.label).not.toMatch(/预发布/);
	});

	test('可更新时版本标签为 current → latest 原始版本号', () => {
		const updatable = toolStatusDot(
			component('OpenSpec', {installed: true, currentVersion: '1.0.0', latestVersion: '2.0.0', hasUpdate: true}) as never,
			'idle'
		);
		expect(updatable.label).toBe('1.0.0 → 2.0.0');
		expect(updatable.label).not.toMatch(/预发布/);
	});

	test('预发布风险通过独立 statusHint 字段表达，不并入版本号', () => {
		const patch = successfulInstallPatch(component('DeepSeekHarness'), '1.0.0', {
			state: 'managed',
			prereleaseWarning: '预发布版本，注意兼容性'
		} as never);
		expect(patch.currentVersion).toBe('1.0.0');
		expect(patch.currentVersion).not.toMatch(/预发布/);
		expect(patch.statusHint).toBe('预发布版本，注意兼容性');
	});

	test('DSH 更新后的 lifecycle 预发布 warning 进入 statusHint 而非版本号', () => {
		const patch = successfulUpdatePatch(component('DeepSeekHarness', {installed: true, currentVersion: '1.0.0'}), {
			state: 'managed',
			prereleaseWarning: '预发布风险'
		} as never);
		expect(patch.statusHint).toBe('预发布风险');
		expect(String(patch.currentVersion ?? '')).not.toMatch(/预发布/);
	});
});

describe('groupToolsForHome 领域分组', () => {
	test('按 Agent / 全局伴随工具 / 工作流 / 代码知识图谱顺序分组', () => {
		const sections = groupToolsForHome([
			component('GitNexus'),
			component('CodeGraph'),
			component('ClaudeCode'),
			component('Ccline'),
			component('OpenSpec')
		]).map(section => section.label);
		expect(sections).toEqual(['Agent', '全局伴随工具', '工作流', '代码知识图谱']);
	});
});

describe('单项生命周期成功后同步 App 检测缓存', () => {
	test('安装成功后刷新检测缓存，避免切换 Agent 回退安装态', async () => {
		const target = component('OpenSpec');
		const {cache, refreshCalls} = recordingCache([target]);
		const actions: ToolsViewAction[] = [];
		const services = {
			async installComponent() {
				return {id: 'OpenSpec', success: true, version: '1.0.0'};
			}
		} as unknown as ToolsViewServices;
		const view = {...createInitialToolsViewState(), components: [target], loaded: true};

		runPrimaryAction(view, services, action => actions.push(action), cache, taskCancellation(), 'cc');
		await idleTick();

		expect(actions.at(-1)?.type).toBe('item-patched');
		expect(refreshCalls).toEqual([undefined]);
	});

	test('单项更新成功后刷新检测缓存，避免切换 Agent 回退到旧版本号', async () => {
		const target = component('OpenSpec', {installed: true, currentVersion: '1.0.0', latestVersion: '2.0.0', hasUpdate: true});
		const {cache, refreshCalls} = recordingCache([target]);
		const actions: ToolsViewAction[] = [];
		const services = {
			async updateComponents() {
				return {snapshotPath: '/tmp/snap', updatedItems: []};
			}
		} as unknown as ToolsViewServices;
		const view = {...createInitialToolsViewState(), components: [target], loaded: true};

		runPrimaryAction(view, services, action => actions.push(action), cache, taskCancellation(), 'cc');
		await idleTick();

		expect(actions.at(-1)?.type).toBe('item-patched');
		expect(refreshCalls).toEqual([undefined]);
	});

	test('单项卸载成功后刷新检测缓存，避免切换 Agent 回退安装态', async () => {
		const target = component('OpenSpec', {installed: true, currentVersion: '1.0.0'});
		const {cache, refreshCalls} = recordingCache([target]);
		const actions: ToolsViewAction[] = [];
		const services = {
			async uninstallComponent() {
				return {success: true};
			}
		} as unknown as ToolsViewServices;

		runUninstall(target, services, action => actions.push(action), cache, false, taskCancellation(), 'cc');
		await idleTick();

		expect(actions.at(-1)?.type).toBe('item-patched');
		expect(refreshCalls).toEqual([undefined]);
	});
});

describe('updateAll 批量更新收尾', () => {
	test('先用本地结果结算并刷新缓存，不等待二次全量检测', async () => {
		const updatable = component('OpenSpec', {installed: true, currentVersion: '1.0.0', latestVersion: '2.0.0', hasUpdate: true});
		const untouched = component('ClaudeCode', {installed: true, currentVersion: '3.0.0', hasUpdate: false});
		const {cache, refreshCalls} = recordingCache([updatable, untouched]);
		const dispatchCalls: ToolsViewAction[] = [];
		let detectCalls = 0;
		const services = {
			async updateComponents() {
				return {snapshotPath: '/tmp/snap', updatedItems: []};
			},
			async detectComponents() {
				detectCalls++;
				return [];
			}
		} as unknown as ToolsViewServices;
		const view = {...createInitialToolsViewState(), components: [updatable, untouched], loaded: true};

		updateAll(view, services, action => dispatchCalls.push(action), cache, taskCancellation(), 'cc');
		await idleTick();

		const batchDone = dispatchCalls.find(action => action.type === 'batch-done');
		expect(batchDone).toBeDefined();
		const settled = (batchDone as {components: readonly ManagedComponent[]}).components.find(entry => entry.id === 'OpenSpec');
		expect(settled?.hasUpdate).toBe(false);
		expect(settled?.currentVersion).toBe('2.0.0');
		expect(detectCalls).toBe(0);
		expect(refreshCalls).toEqual([undefined]);
	});

	test('批量更新失败路径同样刷新真实状态', async () => {
		const updatable = component('OpenSpec', {installed: true, currentVersion: '1.0.0', latestVersion: '2.0.0', hasUpdate: true});
		const {cache, refreshCalls} = recordingCache([updatable]);
		const dispatchCalls: ToolsViewAction[] = [];
		const services = {
			async updateComponents() {
				throw new Error('boom');
			}
		} as unknown as ToolsViewServices;
		const view = {...createInitialToolsViewState(), components: [updatable], loaded: true};

		updateAll(view, services, action => dispatchCalls.push(action), cache, taskCancellation(), 'cc');
		await idleTick();

		expect(dispatchCalls.some(action => action.type === 'batch-failed')).toBe(true);
		expect(refreshCalls).toEqual([undefined]);
	});
});
