import {describe, expect, test} from 'bun:test';
import {getToastSnapshot, resetToasts} from '../../src/components/toast-store.js';
import {TOOL_DEFINITIONS} from '../../src/core/tools-install.js';
import type {ManagedComponent} from '../../src/core/tools-manage.js';
import type {DetectionCache} from '../../src/hooks/use-detection-cache.js';
import type {TaskCancellation} from '../../src/hooks/use-task-cancellation.js';
import {createInitialToolsViewState, type ToolsViewAction} from '../../src/state/tools-view-state.js';
import {runPrimaryAction, runUninstall, updateAll} from '../../src/views/tools/tools-view-actions.js';
import type {ToolsViewServices} from '../../src/views/tools/tools-view-types.js';

// P4a 迁移自 scripts/verify-tools-failure-toast.mjs（6 条静态断言，纯进程内，无 fs / 子进程）。
// 失败 toast + 诊断入控制台 + 取消不误报：4 种操作 × 3 种失败方式（result / throw / cancel）。
// R9 去重核对：`tests/core/tools-view-actions.test.ts` 的 `updateAll 批量更新收尾` 只覆盖
// 「失败路径同样刷新真实状态」，未覆盖 toast 文案与诊断落点，本主题为本批新迁。

describe('工具失败 Toast 与诊断控制台', () => {
	test('安装/更新/批量更新/卸载失败：Toast 显示摘要，详细诊断写入控制台，取消不误报', async () => {
		const definition = TOOL_DEFINITIONS.find(item => item.id === 'PiCli');
		expect(definition, 'PiCli 必须存在于 TOOL_DEFINITIONS').toBeDefined();
		if (!definition) throw new Error('PiCli 定义缺失');

		for (const operation of ['install', 'update', 'batch', 'uninstall'] as const) {
			for (const failure of ['result', 'throw', 'cancel'] as const) {
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
				// 只注入被测路径实际调用的三个 service 缝，其余方法不参与该用例。
				const services = {
					installComponent: fail,
					updateComponents: fail,
					uninstallComponent: fail
				} as unknown as ToolsViewServices;
				const component = {
					...definition,
					installed: operation !== 'install',
					hasUpdate: operation !== 'install',
					currentVersion: '',
					latestVersion: ''
				};
				const view = {...createInitialToolsViewState(), components: [component], loaded: true};
				const actions: ToolsViewAction[] = [];
				const dispatch = (action: ToolsViewAction) => actions.push(action);
				const cache = {refresh: () => {}} as unknown as DetectionCache<ManagedComponent[]>;
				const cancellation = {
					start: () => controller.signal,
					finish: () => {}
				} as unknown as TaskCancellation;
				const diagnostics: string[] = [];
				const originalConsoleError = console.error;
				console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(' '));
				try {
					if (operation === 'batch') updateAll(view, services, dispatch, cache, cancellation, 'pi');
					else if (operation === 'uninstall') runUninstall(component, services, dispatch, cache, false, cancellation, 'pi');
					else runPrimaryAction(view, services, dispatch, cache, cancellation, 'pi');
					await new Promise(resolve => setTimeout(resolve, 0));
				} finally {
					console.error = originalConsoleError;
				}
				const errors = getToastSnapshot().filter(entry => entry.type === 'error');
				expect(errors.length, `${operation}/${failure} 失败提示数量`).toBe(failure === 'cancel' ? 0 : 1);
				if (failure !== 'cancel') {
					expect(errors[0]?.message.includes('请查看控制台'), 'Toast 不得提示查看控制台').toBe(false);
					expect(errors[0]?.message.includes(diagnostic), 'Toast 不得暴露底层诊断原文').toBe(false);
					expect(
						diagnostics.some(message => message.includes(diagnostic)),
						'底层失败诊断必须打印到控制台'
					).toBe(true);
					expect(actions.at(-1)?.type, `${operation}/${failure} 失败 action 类型`).toBe(
						operation === 'batch' ? 'batch-failed' : 'item-failed'
					);
				}
			}
		}
		resetToasts();
	});
});
