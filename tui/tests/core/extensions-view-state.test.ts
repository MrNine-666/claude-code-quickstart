import {expect, test} from 'bun:test';
import type {PiExtensionPackage} from '../../src/core/extensions.js';
import {
	createInitialExtensionsViewState,
	extensionsSubMode,
	isExtensionInstalled,
	reduceExtensionsViewState,
	selectedExtension,
	visibleExtensions,
	type ExtensionsViewState
} from '../../src/state/extensions-view-state.js';

// 迁自 scripts/verify-extensions-view.mjs 的 A 类源码正则断言：
// visibleExtensions 投影与 footer 子模式改由 reducer/纯函数行为断言覆盖。

const extension = (name: string, installed: boolean, overrides: Partial<PiExtensionPackage> = {}): PiExtensionPackage => ({
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
	installCommand: `pi install npm:${name}`,
	...overrides
});

const installed = [extension('alpha', true), extension('beta', true)];
const shop = [extension('tool-a', false), extension('tool-b', false), extension('tool-c', false)];

const loaded = (overrides: Partial<ExtensionsViewState> = {}): ExtensionsViewState => ({
	...reduceExtensionsViewState(createInitialExtensionsViewState(), {type: 'installed-loaded', items: installed}),
	...overrides
});

const searchPage = (overrides: Partial<ExtensionsViewState> = {}): ExtensionsViewState => ({
	...loaded({
		mode: 'search',
		focus: 'grid',
		query: 'tool',
		searchResults: shop,
		page: 1,
		total: 41,
		hasPrevious: true,
		hasNext: true,
		...overrides
	})
});

test('空搜索展示已安装集合，有关键词时展示搜索结果', () => {
	expect(visibleExtensions(loaded()).map(item => item.name)).toEqual(['alpha', 'beta']);

	const queried = reduceExtensionsViewState(loaded(), {type: 'query-input', value: 'tool'});
	const searched = reduceExtensionsViewState(queried, {
		type: 'search-done',
		result: {items: shop, page: 0, pageSize: 20, total: 3, hasPrevious: false, hasNext: false}
	});
	expect(visibleExtensions(searched).map(item => item.name)).toEqual(['tool-a', 'tool-b', 'tool-c']);
	expect(selectedExtension(searched)?.name).toBe('tool-a');
});

test('isExtensionInstalled 按已安装标记与 source 身份识别', () => {
	expect(isExtensionInstalled(extension('anything', true), [])).toBe(true);
	expect(isExtensionInstalled(extension('alpha', false, {source: 'npm:alpha@1.0.0'}), installed)).toBe(true);
	expect(
		isExtensionInstalled(extension('@scope/pkg', false, {source: 'npm:@scope/pkg@latest'}), [
			extension('@scope/pkg', false, {source: 'npm:@scope/pkg@2.1.0'})
		])
	).toBe(true);
	expect(isExtensionInstalled(extension('@scope/pkg', false, {source: 'npm:@scope/pkg'}), [])).toBe(false);
	expect(isExtensionInstalled(extension('gamma', false), installed)).toBe(false);
});

test('installed-loaded / installed-failed / query-input 更新列表、模式与分页字段', () => {
	const loading = createInitialExtensionsViewState();
	expect(loading.loading).toBe(true);

	const failed = reduceExtensionsViewState(loading, {type: 'installed-failed', error: 'boom'});
	expect(failed.loading).toBe(false);
	expect(failed.errorText).toBe('boom');

	const searched = searchPage();
	const cleared = reduceExtensionsViewState(searched, {type: 'query-input', value: '  '});
	expect(cleared.mode).toBe('installed');
	expect(cleared.query).toBe('  ');
	expect(cleared.searchResults).toEqual(shop);
	expect(cleared.page).toBe(0);
	expect(cleared.total).toBe(0);
	expect(cleared.hasPrevious).toBe(false);
	expect(cleared.hasNext).toBe(false);

	const typed = reduceExtensionsViewState(searched, {type: 'query-input', value: 'tool'});
	expect(typed.mode).toBe('search');
	expect(typed.searchResults).toEqual([]);
});

test('focus-search / focus-grid 在 confirm 态保持不变', () => {
	expect(reduceExtensionsViewState(searchPage({focus: 'search'}), {type: 'focus-grid'}).focus).toBe('grid');
	expect(reduceExtensionsViewState(loaded({focus: 'grid'}), {type: 'focus-search'}).focus).toBe('search');

	const confirm = loaded({mode: 'confirm'});
	expect(reduceExtensionsViewState(confirm, {type: 'focus-search'})).toBe(confirm);
	expect(reduceExtensionsViewState(confirm, {type: 'focus-grid'})).toBe(confirm);
});

test('search-start / search-done / search-failed 切换 searching 与 typed metadata', () => {
	const started = reduceExtensionsViewState(searchPage(), {type: 'search-start', page: 2});
	expect(started.searching).toBe(true);
	expect(started.focus).toBe('grid');
	expect(started.searchResults).toEqual([]);
	expect(started.page).toBe(2);

	const done = reduceExtensionsViewState(started, {
		type: 'search-done',
		result: {items: shop, page: 1, pageSize: 20, total: 41, hasPrevious: true, hasNext: true}
	});
	expect(done.searching).toBe(false);
	expect(done.focus, 'search-done 后焦点仍在 Grid').toBe('grid');
	expect(done.searchResults).toEqual(shop);
	expect(done.page).toBe(1);
	expect(done.total).toBe(41);
	expect(done.hasPrevious).toBe(true);
	expect(done.hasNext).toBe(true);

	const failed = reduceExtensionsViewState(started, {type: 'search-failed', error: 'network'});
	expect(failed.searching).toBe(false);
	expect(failed.searchResults).toEqual([]);
	expect(failed.errorText).toBe('network');
});

test('move 只在 Grid 焦点下按两列语义移动 cursor', () => {
	const many = Array.from({length: 8}, (_, index) => extension(`tool-${index}`, false));
	const base = searchPage({cursor: 4, searchResults: many});
	expect(reduceExtensionsViewState(base, {type: 'move', direction: 'up'}).cursor).toBe(2);
	expect(reduceExtensionsViewState(base, {type: 'move', direction: 'down'}).cursor).toBe(6);
	expect(reduceExtensionsViewState(base, {type: 'move', direction: 'left'}).cursor).toBe(3);
	expect(reduceExtensionsViewState(base, {type: 'move', direction: 'right'}).cursor).toBe(5);

	// 边界钳制与空列表
	expect(reduceExtensionsViewState(searchPage({cursor: 0}), {type: 'move', direction: 'up'}).cursor).toBe(0);
	expect(reduceExtensionsViewState(searchPage({cursor: 2}), {type: 'move', direction: 'down'}).cursor).toBe(2);
	expect(reduceExtensionsViewState(searchPage({cursor: 0, searchResults: []}), {type: 'move', direction: 'right'}).cursor).toBe(0);

	// confirm 态与输入焦点不移动
	const confirm = searchPage({mode: 'confirm'});
	expect(reduceExtensionsViewState(confirm, {type: 'move', direction: 'right'})).toBe(confirm);
	const filtering = searchPage({focus: 'search'});
	expect(reduceExtensionsViewState(filtering, {type: 'move', direction: 'right'})).toBe(filtering);
});

test('open-confirm / cancel-confirm / mutation 生命周期恢复正确模式', () => {
	const action = {kind: 'remove', name: 'alpha', source: 'npm:alpha'} as const;
	const opened = reduceExtensionsViewState(searchPage(), {type: 'open-confirm', action});
	expect(opened.mode).toBe('confirm');
	expect(opened.pendingAction).toEqual(action);

	const cancelled = reduceExtensionsViewState(opened, {type: 'cancel-confirm'});
	expect(cancelled.mode).toBe('search');
	expect(cancelled.pendingAction).toBeUndefined();

	expect(reduceExtensionsViewState(loaded(), {type: 'cancel-confirm'}).mode).toBe('installed');

	const mutating = reduceExtensionsViewState(opened, {type: 'mutation-start'});
	expect(mutating.mutating).toBe(true);
	expect(reduceExtensionsViewState(mutating, {type: 'mutation-done'}).mutating).toBe(false);
	expect(reduceExtensionsViewState(mutating, {type: 'mutation-done'}).pendingAction).toBeUndefined();

	const failed = reduceExtensionsViewState(mutating, {type: 'mutation-failed', error: 'nope'});
	expect(failed.mutating).toBe(false);
	expect(failed.errorText).toBe('nope');
	expect(failed.mode).toBe('search');
	expect(reduceExtensionsViewState(loaded({mode: 'confirm', mutating: true}), {type: 'mutation-failed', error: 'x'}).mode).toBe(
		'installed'
	);
});

test('extensionsSubMode 按确认/执行/焦点/安装状态投影 footer 子模式', () => {
	expect(extensionsSubMode(loaded({mode: 'confirm'}))).toBe('confirm');
	expect(extensionsSubMode(loaded({mutating: true}))).toBe('mutating');
	expect(extensionsSubMode(loaded({searching: true}))).toBe('searching');
	expect(extensionsSubMode(loaded({focus: 'search'}))).toBe('search');
	expect(extensionsSubMode(loaded())).toBe('installed-grid');
	expect(extensionsSubMode(searchPage())).toBe('grid-uninstalled');
	expect(extensionsSubMode(searchPage({searchResults: [extension('alpha', false)]}))).toBe('grid');
	expect(extensionsSubMode(searchPage({searchResults: [extension('tool-a', false)], installed: []}))).toBe('grid-uninstalled');
	expect(extensionsSubMode(searchPage({searchResults: [], cursor: 0}))).toBe('grid');
});
