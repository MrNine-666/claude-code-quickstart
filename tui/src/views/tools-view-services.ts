import {
	detectComponents,
	installComponent,
	updateComponents,
	uninstallComponent,
	type ComponentId,
	type ComponentInstallOutcome
} from '../core/tools-manage.js';
import type {ProgressCallback} from '../core/exec.js';
import type {AgentContext} from '../state/manage-state.js';
import {createToolsDetectionRunner, runToolsDetection} from '../services/view-detection.js';
import type {ToolsViewServices} from './ToolsView.js';

// 工具管理视图默认 service 装配（Phase 11D）：连接 tools-manage core 四入口 + detection runner。
// 测试与 fallback 可传入自定义实现替换（保持组件与具体 IO 解耦，对齐 skills-view-services）。
export function createToolsViewServices(): ToolsViewServices {
	return {
		detectComponents: () => detectComponents(),
		// agentContext 透传给 core：CodeGraph 接入目标 / CcgWorkflow Codex 分支按当前上下文解析（design D3-D5）。
		installComponent: (id, onProgress, agentContext) => installComponent(id, onProgress, {agentContext}),
		installMultiple: (ids, onProgress, agentContext) => installMultipleComponents(ids, onProgress, agentContext),
		updateComponents: (components, onProgress) => updateComponents(components, onProgress),
		uninstallComponent: (id, onProgress, agentContext) => uninstallComponent(id, onProgress, {agentContext}),
		createDetectionRunner: onChange => createToolsDetectionRunner(onChange),
		runDetection: runner => runToolsDetection(runner)
	};
}

/** 批量安装（串行 + 失败隔离 P-6），带进度上报。 */
async function installMultipleComponents(
	ids: readonly ComponentId[],
	onProgress?: ProgressCallback,
	agentContext?: AgentContext
): Promise<readonly ComponentInstallOutcome[]> {
	const outcomes: ComponentInstallOutcome[] = [];
	for (const id of ids) {
		const outcome = await installComponent(id, onProgress, {agentContext});
		outcomes.push(outcome);
	}

	return outcomes;
}
