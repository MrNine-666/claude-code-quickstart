import {
	detectComponents,
	ejectComponent,
	injectComponent,
	installComponent,
	type ComponentId,
	type ComponentInstallOutcome,
	uninstallComponent,
	updateComponents
} from '../../core/tools-manage.js';
import {bindExecSignal, type ProgressCallback} from '../../core/exec.js';
import {createToolsDetectionRunner, runToolsDetection} from '../../services/view-detection.js';
import type {AgentContext} from '../../state/manage-state.js';
import type {ToolsViewServices} from './tools-view-types.js';

export function createToolsViewServices(): ToolsViewServices {
	return {
		detectComponents: () => detectComponents(),
		installComponent: (id, onProgress, agentContext, signal) =>
			installComponent(id, onProgress, {
				agentContext,
				exec: signal ? bindExecSignal(signal) : undefined
			}),
		installMultiple: (ids, onProgress, agentContext, signal) => installMultipleComponents(ids, onProgress, agentContext, signal),
		updateComponents: (components, onProgress, agentContext, signal) =>
			updateComponents(components, onProgress, {
				agentContext,
				exec: signal ? bindExecSignal(signal) : undefined
			}),
		uninstallComponent: (id, onProgress, options) =>
			uninstallComponent(id, onProgress, {
				agentContext: options?.agentContext,
				fullUninstall: options?.fullUninstall,
				exec: options?.signal ? bindExecSignal(options.signal) : undefined
			}),
		injectComponent: (id, target, onProgress, signal) =>
			injectComponent(id, target, onProgress, {
				exec: signal ? bindExecSignal(signal) : undefined
			}),
		ejectComponent: (id, target, onProgress, signal) =>
			ejectComponent(id, target, onProgress, {
				exec: signal ? bindExecSignal(signal) : undefined
			}),
		createDetectionRunner: onChange => createToolsDetectionRunner(onChange),
		runDetection: runner => runToolsDetection(runner),
		refreshDetection: (runner, options) => runToolsDetection(runner, options)
	};
}

async function installMultipleComponents(
	ids: readonly ComponentId[],
	onProgress?: ProgressCallback,
	agentContext?: AgentContext,
	signal?: AbortSignal
): Promise<readonly ComponentInstallOutcome[]> {
	const outcomes: ComponentInstallOutcome[] = [];
	for (const id of ids) {
		outcomes.push(
			await installComponent(id, onProgress, {
				agentContext,
				exec: signal ? bindExecSignal(signal) : undefined
			})
		);
	}
	return outcomes;
}
