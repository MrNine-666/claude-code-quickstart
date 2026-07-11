import {
	detectComponents,
	installComponent,
	updateComponents,
	uninstallComponent,
	injectComponent,
	ejectComponent,
	type ComponentId,
	type ComponentInstallOutcome,
	type ComponentUninstallOutcome
} from '../core/tools-manage.js';
import type {ProgressCallback} from '../core/exec.js';
import type {AgentContext} from '../state/manage-state.js';
import {createToolsDetectionRunner, runToolsDetection} from '../services/view-detection.js';
import type {ToolsViewServices} from './ToolsView.js';

// 工具管理视图默认 service 装配：共享列表 + 显式 target inject/eject + 全量卸载。
export function createToolsViewServices(): ToolsViewServices {
	return {
		detectComponents: () => detectComponents(),
		installComponent: (id, onProgress, agentContext) => installComponent(id, onProgress, {agentContext}),
		installMultiple: (ids, onProgress, agentContext) => installMultipleComponents(ids, onProgress, agentContext),
		updateComponents: (components, onProgress, agentContext) => updateComponents(components, onProgress, {agentContext}),
		uninstallComponent: (id, onProgress, options) =>
			uninstallComponent(id, onProgress, {
				agentContext: options?.agentContext,
				fullUninstall: options?.fullUninstall
			}),
		injectComponent: (id, target, onProgress) => injectComponent(id, target, onProgress),
		ejectComponent: (id, target, onProgress) => ejectComponent(id, target, onProgress),
		createDetectionRunner: onChange => createToolsDetectionRunner(onChange),
		runDetection: runner => runToolsDetection(runner),
		refreshDetection: (runner, options) => runToolsDetection(runner, options)
	};
}

async function installMultipleComponents(
	ids: readonly ComponentId[],
	onProgress?: ProgressCallback,
	agentContext?: AgentContext
): Promise<readonly ComponentInstallOutcome[]> {
	const outcomes: ComponentInstallOutcome[] = [];
	for (const id of ids) {
		outcomes.push(await installComponent(id, onProgress, {agentContext}));
	}
	return outcomes;
}
