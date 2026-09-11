import assert from 'node:assert/strict';
import {getToastSnapshot, resetToasts} from '../src/components/toast-store.ts';
import {TOOL_DEFINITIONS} from '../src/core/tools-install.ts';
import {createInitialToolsViewState} from '../src/state/tools-view-state.ts';
import {runPrimaryAction, runUninstall, updateAll} from '../src/views/tools/tools-view-actions.ts';

const definition = TOOL_DEFINITIONS.find(item => item.id === 'PiCli');
assert.ok(definition);
for (const operation of ['install', 'update', 'batch', 'uninstall']) {
	for (const failure of ['result', 'throw', 'cancel']) {
		resetToasts();
		const controller = new AbortController();
		const diagnostic = 'Pi Agent CLI 要求 Node.js >= 22.19.0，当前为 22.18.9';
		const fail = async () => {
			if (failure === 'cancel') controller.abort();
			if (failure === 'throw') throw new Error(diagnostic);
			return operation === 'update' || operation === 'batch'
				? {updatedItems: [`failed::PiCli::${diagnostic}`]}
				: {id: 'PiCli', success: false, error: diagnostic};
		};
		const services = {installComponent: fail, updateComponents: fail, uninstallComponent: fail};
		const component = {
			...definition,
			installed: operation !== 'install',
			hasUpdate: operation !== 'install',
			currentVersion: '',
			latestVersion: ''
		};
		const view = {...createInitialToolsViewState(), components: [component], loaded: true};
		const actions = [];
		const dispatch = action => actions.push(action);
		const cache = {refresh: () => {}};
		const cancellation = {start: () => controller.signal, finish: () => {}};
		const diagnostics = [];
		const originalConsoleError = console.error;
		console.error = (...args) => diagnostics.push(args.map(String).join(' '));
		try {
			if (operation === 'batch') updateAll(view, services, dispatch, cache, cancellation, 'pi');
			else if (operation === 'uninstall') runUninstall(component, services, dispatch, cache, false, cancellation, 'pi');
			else runPrimaryAction(view, services, dispatch, cache, cancellation, 'pi');
			await new Promise(resolve => setTimeout(resolve, 0));
		} finally {
			console.error = originalConsoleError;
		}
		const errors = getToastSnapshot().filter(entry => entry.type === 'error');
		assert.equal(errors.length, failure === 'cancel' ? 0 : 1, `${operation}/${failure} 失败提示数量`);
		if (failure !== 'cancel') {
			assert.match(errors[0].message, /请查看控制台$/, 'Toast 只展示可理解的失败摘要');
			assert.equal(errors[0].message.includes(diagnostic), false, 'Toast 不得暴露底层诊断原文');
			assert.ok(diagnostics.some(message => message.includes(diagnostic)), '底层失败诊断必须打印到控制台');
			assert.equal(actions.at(-1)?.type, operation === 'batch' ? 'batch-failed' : 'item-failed');
		}
	}
}
resetToasts();
console.log('[PASS] 工具安装/更新/批量更新/卸载失败：Toast 仅显示摘要，详细诊断写入控制台，取消不误报');
