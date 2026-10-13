import {describe, expect, test} from 'bun:test';
import type {KeyEvent} from '@opentui/core';
import {installedPiPackagePlaceholder, piExtensionUpdateStatus, type PiExtensionPackage} from '../../src/core/extensions.js';
import {createInitialExtensionsViewState, type PendingExtensionAction} from '../../src/state/extensions-view-state.js';
import {handleExtensionsKey, type ExtensionsViewInputHandlers} from '../../src/views/extensions/extensions-view-input.js';

function item(name: string, current: string, latest: string): PiExtensionPackage {
	return {...installedPiPackagePlaceholder(`npm:${name}@latest`), installedVersion: current, version: latest};
}
function press(key: string, installed: readonly PiExtensionPackage[], searchResults?: readonly PiExtensionPackage[]) {
	const actions: PendingExtensionAction[] = [];
	let skipped = 0;
	const handlers: ExtensionsViewInputHandlers = {
		dispatch: () => {},
		onSearch: () => {},
		onOpenExternal: () => {},
		onOpenConfirm: action => actions.push(action),
		onRunConfirm: () => {},
		onAlreadyCurrent: () => {
			skipped += 1;
		},
		onExitToNav: () => {}
	};
	const state = {
		...createInitialExtensionsViewState(),
		loading: false,
		installed,
		...(searchResults ? {query: 'test', searchResults} : {})
	};
	handleExtensionsKey({name: key, preventDefault: () => {}} as unknown as KeyEvent, state, handlers, installed);
	return {actions, skipped};
}

describe('extension update eligibility', () => {
	test.each([
		['1.0.0', '1.1.0', 'available'],
		['1.0.0', '1.0.0', 'current'],
		['2.0.0', '1.0.0', 'current'],
		['1.0.0-beta.1', '1.0.0', 'available'],
		['1.0.0+local', '1.0.0+remote', 'current'],
		['', '1.0.0', 'unknown'],
		['1.0.0', '', 'unknown'],
		['bad', '1.0.0', 'unknown'],
		['1.0.0', 'bad', 'unknown']
	] as const)('%s → %s is %s', (current, latest, status) => {
		expect(piExtensionUpdateStatus(item('extension', current!, latest!))).toBe(status);
	});
	test('all-update includes only newer or unknown versions, preserving exact sources', () => {
		const newer = item('newer', '1.0.0', '2.0.0');
		const unknown = item('unknown', '', '2.0.0');
		const offline = item('offline', '1.0.0', '');
		const result = press('a', [newer, item('current', '1.0.0', '1.0.0'), item('ahead', '3.0.0', '2.0.0'), unknown, offline]);
		expect(result.actions).toEqual([
			{kind: 'update-all', targets: [newer, unknown, offline].map(({name, source}) => ({name, source}))}
		]);
	});
	test('all-current single/all update never opens a mutation', () => {
		const current = item('current', '1.0.0', '1.0.0');
		for (const key of ['a', 'enter']) expect(press(key, [current])).toEqual({actions: [], skipped: 1});
	});
	test('single unknown version remains eligible', () => {
		const unknown = item('unknown', '', '2.0.0');
		expect(press('enter', [unknown]).actions).toEqual([{kind: 'update', name: unknown.name, source: unknown.source}]);
	});
	test('search uses installed version and exact installed source, not catalog source', () => {
		const local = {...item('extension', '1.0.0', '1.0.0'), source: 'npm:extension@^1.0.0'};
		const remote = {...local, installed: false, installedVersion: undefined, source: 'npm:extension', version: '2.0.0'};
		expect(press('enter', [local], [remote]).actions).toEqual([{kind: 'update', name: local.name, source: local.source}]);
		expect(press('enter', [local], [{...remote, version: '1.0.0'}])).toEqual({actions: [], skipped: 1});
	});
});
