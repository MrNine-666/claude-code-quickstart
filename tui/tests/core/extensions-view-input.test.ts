import {describe, expect, test} from 'bun:test';
import type {KeyEvent} from '@opentui/core';
import type {PiExtensionPackage} from '../../src/core/extensions.js';
import {
	createInitialExtensionsViewState,
	type ExtensionsViewAction,
	type ExtensionsViewState,
	type PendingExtensionAction
} from '../../src/state/extensions-view-state.js';
import {handleExtensionsKey, type ExtensionsViewInputHandlers} from '../../src/views/extensions/extensions-view-input.js';

// 迁自 scripts/verify-extensions-view.mjs 的 A 类源码正则断言：
// 按键/焦点/分页/确认弹窗行为改由 handlExtensionsKey 行为断言覆盖。

const extension = (name: string, installed: boolean): PiExtensionPackage => ({
	name,
	source: `npm:${name}`,
	version: '1.0.0',
	description: `${name} description`,
	type: 'extension',
	resourceTypes: ['extension'],
	author: 'community',
	repository: '',
	npmUrl: `https://www.npmjs.com/package/${name}`,
	catalogListed: true,
	piMaintained: false,
	installed,
	installCommand: `pi install npm:${name}`
});

const installed = [extension('alpha', true), extension('beta', true)];
const uninstalled = [extension('tool-a', false)];

const viewState = (overrides: Partial<ExtensionsViewState> = {}): ExtensionsViewState => ({
	...createInitialExtensionsViewState(),
	loading: false,
	...overrides
});

type TestKey = {name: string; defaultPrevented: boolean; preventDefault(): void};

function key(name: string): TestKey {
	return {
		name,
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		}
	};
}

function press(name: string, view: ExtensionsViewState, captured: ReturnType<typeof createCapture>, packages = installed): TestKey {
	const event = key(name);
	handleExtensionsKey(event as unknown as KeyEvent, view, captured.handlers, packages);
	return event;
}

function createCapture() {
	const dispatched: ExtensionsViewAction[] = [];
	const searches: number[] = [];
	const external: PiExtensionPackage[] = [];
	const confirmations: PendingExtensionAction[] = [];
	const runs: PendingExtensionAction[] = [];
	let exits = 0;
	const handlers: ExtensionsViewInputHandlers = {
		dispatch: action => {
			dispatched.push(action);
		},
		onSearch: page => {
			searches.push(page);
		},
		onOpenExternal: item => {
			external.push(item);
		},
		onOpenConfirm: action => {
			confirmations.push(action);
		},
		onRunConfirm: action => {
			runs.push(action);
		},
		onExitToNav: () => {
			exits += 1;
		}
	};
	return {dispatched, searches, external, confirmations, runs, exits: () => exits, handlers};
}

describe('扩展页 Tab 焦点循环', () => {
	test('搜索框 Tab 切到 Grid，Grid Tab 切回搜索框', () => {
		const searchFocus = createCapture();
		const searchTab = press('tab', viewState({focus: 'search'}), searchFocus);
		expect(searchTab.defaultPrevented).toBe(true);
		expect(searchFocus.dispatched).toEqual([{type: 'focus-grid'}]);

		const gridFocus = createCapture();
		press('tab', viewState({focus: 'grid'}), gridFocus);
		expect(gridFocus.dispatched).toEqual([{type: 'focus-search'}]);
	});

	test('搜索框 Enter 不由页面按键层处理，交给原生 input onSubmit', () => {
		const captured = createCapture();
		press('enter', viewState({focus: 'search', query: 'tool'}), captured);
		expect(captured.dispatched).toEqual([]);
		expect(captured.searches).toEqual([]);
		expect(captured.confirmations).toEqual([]);
	});
});

describe('扩展页详情与退出', () => {
	test('O 把当前扩展交给外部打开器', () => {
		const captured = createCapture();
		const event = press('o', viewState({focus: 'grid', cursor: 1, installed}), captured);
		expect(event.defaultPrevented).toBe(true);
		expect(captured.external.map(item => item.name)).toEqual(['beta']);
	});

	test('搜索框 Escape 不返回菜单，也不改变 View 状态', () => {
		const captured = createCapture();
		press('escape', viewState({focus: 'search', query: 'tool'}), captured);
		expect(captured.exits()).toBe(0);
		expect(captured.dispatched).toEqual([]);
	});

	test('Grid 首项左键返回菜单，非首项左键只移动 cursor', () => {
		const first = createCapture();
		const firstLeft = press('left', viewState({focus: 'grid', cursor: 0}), first);
		expect(first.exits()).toBe(1);
		expect(first.dispatched).toEqual([]);
		expect(firstLeft.defaultPrevented).toBe(true);

		const second = createCapture();
		press('left', viewState({focus: 'grid', cursor: 1}), second);
		expect(second.exits()).toBe(0);
		expect(second.dispatched).toEqual([{type: 'move', direction: 'left'}]);
	});
});

describe('扩展页分页门控', () => {
	test('PageUp/PageDown 仅在关键词搜索且有上下页时触发远端翻页', () => {
		const captured = createCapture();
		const view = viewState({
			mode: 'search',
			focus: 'grid',
			query: 'tool',
			page: 1,
			hasPrevious: true,
			hasNext: true,
			searchResults: uninstalled
		});
		press('pageup', view, captured);
		press('pagedown', view, captured);
		expect(captured.searches).toEqual([0, 2]);
	});

	test('无搜索关键词时不触发翻页', () => {
		const captured = createCapture();
		const view = viewState({mode: 'installed', focus: 'grid', query: '', page: 1, hasPrevious: true, hasNext: true});
		press('pageup', view, captured);
		press('pagedown', view, captured);
		expect(captured.searches).toEqual([]);
	});
});

describe('扩展页主操作与批量确认', () => {
	test('Enter 已安装项打开更新确认，未安装项打开安装确认', () => {
		const installedCapture = createCapture();
		press('enter', viewState({focus: 'grid', cursor: 0, installed}), installedCapture);
		expect(installedCapture.confirmations).toEqual([{kind: 'update', name: 'alpha', source: 'npm:alpha'}]);

		const shopCapture = createCapture();
		const shopView = viewState({
			mode: 'search',
			focus: 'grid',
			query: 'tool',
			searchResults: uninstalled
		});
		press('enter', shopView, shopCapture, []);
		expect(shopCapture.confirmations).toEqual([{kind: 'install', name: 'tool-a', source: 'npm:tool-a'}]);
	});

	test('D 仅对已安装项打开卸载确认', () => {
		const installedCapture = createCapture();
		press('d', viewState({focus: 'grid', cursor: 0, installed}), installedCapture);
		expect(installedCapture.confirmations).toEqual([{kind: 'remove', name: 'alpha', source: 'npm:alpha'}]);

		const shopCapture = createCapture();
		const shopView = viewState({mode: 'search', focus: 'grid', query: 'tool', searchResults: uninstalled});
		press('d', shopView, shopCapture, []);
		expect(shopCapture.confirmations).toEqual([]);
	});

	test('A 基于已安装扩展快照打开全部更新确认，无已安装项时忽略', () => {
		const captured = createCapture();
		const event = press('a', viewState({focus: 'grid'}), captured);
		expect(event.defaultPrevented, 'A 必须阻止继续冒泡').toBe(true);
		expect(captured.confirmations).toEqual([
			{
				kind: 'update-all',
				targets: [
					{name: 'alpha', source: 'npm:alpha'},
					{name: 'beta', source: 'npm:beta'}
				]
			}
		]);

		const empty = createCapture();
		press('a', viewState({focus: 'grid'}), empty, []);
		expect(empty.confirmations).toEqual([]);
	});

	describe('扩展页确认态', () => {
		const pending = {kind: 'remove', name: 'alpha', source: 'npm:alpha'} as const;

		test('Escape 取消确认，Enter 执行确认', () => {
			const cancel = createCapture();
			press('escape', viewState({mode: 'confirm', pendingAction: pending}), cancel);
			expect(cancel.dispatched).toEqual([{type: 'cancel-confirm'}]);

			const run = createCapture();
			press('enter', viewState({mode: 'confirm', pendingAction: pending}), run);
			expect(run.runs).toEqual([pending]);
		});

		test('无 pendingAction 的 Enter 不执行，其它按键被忽略', () => {
			const captured = createCapture();
			press('enter', viewState({mode: 'confirm'}), captured);
			press('tab', viewState({mode: 'confirm', pendingAction: pending}), captured);
			expect(captured.runs).toEqual([]);
			expect(captured.dispatched).toEqual([]);
		});
	});

	test('Grid Escape 返回菜单', () => {
		const captured = createCapture();
		press('escape', viewState({focus: 'grid', cursor: 1}), captured);
		expect(captured.exits()).toBe(1);
		expect(captured.dispatched).toEqual([]);
	});

	test('方向键只做 Grid 移动，不再进入 Header', () => {
		const captured = createCapture();
		press('up', viewState({focus: 'grid', cursor: 2, installed}), captured);
		press('down', viewState({focus: 'grid', cursor: 2, installed}), captured);
		press('right', viewState({focus: 'grid', cursor: 2, installed}), captured);
		expect(captured.dispatched).toEqual([
			{type: 'move', direction: 'up'},
			{type: 'move', direction: 'down'},
			{type: 'move', direction: 'right'}
		]);
	});

	test('mutating 期间忽略全部按键', () => {
		const captured = createCapture();
		press('tab', viewState({focus: 'grid', mutating: true}), captured);
		press('enter', viewState({focus: 'grid', mutating: true}), captured);
		expect(captured.dispatched).toEqual([]);
		expect(captured.confirmations).toEqual([]);
	});
});
