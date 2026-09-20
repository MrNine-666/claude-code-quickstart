import {describe, expect, test} from 'bun:test';
import {
	COMPONENT_DEFINITIONS,
	COMPONENT_META,
	filterVisibleComponents,
	isComponentVisible,
	projectSharedToolComponents,
	TOOL_GROUP_ORDER,
	visibleComponentDefinitions,
	type ComponentId,
	type ManagedComponent
} from '../../src/core/tools-manage.js';

// P4a 迁移自 scripts/verify-tools-context.mjs（40 条静态断言，纯进程内，无 fs / 子进程）。
// Task 1.5 → Phase 3：工具分组与可见性（design D3/PBT-3），断言真实 COMPONENT_META。
// 本文件覆盖两条并存的 API：
//   1) legacy filterVisibleComponents / visibleComponentDefinitions —— 按 agentContext 过滤（CLI/门禁兼容路径）；
//   2) shared list projectSharedToolComponents —— Tools UI 主路径，不按上下文过滤，Ccline 常显。
// 双态独立/显式 target 的更强不变量见 tools-shared-projection.test.ts。

function component(id: ComponentId, installed: boolean): ManagedComponent {
	const definition = COMPONENT_DEFINITIONS.find(entry => entry.id === id);
	if (!definition) throw new Error(`未知组件 ${id}`);
	return {...definition, installed, currentVersion: '', latestVersion: '', hasUpdate: null};
}

describe('tools 组件分组归属（唯一真理源 = COMPONENT_META）', () => {
	test('COMPONENT_META 的 group 归属：agent / companion / workflow / knowledge-graph', () => {
		expect(COMPONENT_META.ClaudeCode.group, 'ClaudeCode 属 agent 组').toBe('agent');
		expect(COMPONENT_META.CodexCli.group, 'CodexCli 属 agent 组').toBe('agent');
		expect(COMPONENT_META.AntigravityCli.group, 'AntigravityCli 属 agent 组').toBe('agent');
		expect(COMPONENT_META.DeepSeekHarness.group, 'DeepSeekHarness 属 agent 组').toBe('agent');
		expect(COMPONENT_META.Ccline.group, 'Ccline 属 companion 组').toBe('companion');
		expect(COMPONENT_META.PiCli.group, 'PiCli 属 agent 组').toBe('agent');
		expect(COMPONENT_META.PiWeb.group, 'PiWeb 属 companion 组').toBe('companion');
		expect(COMPONENT_META.OpenSpec.group, 'OpenSpec 属 workflow 组').toBe('workflow');
		expect(COMPONENT_META.CcgWorkflow.group, 'CcgWorkflow 属 workflow 组').toBe('workflow');
		expect(COMPONENT_META.CodeGraph.group, 'CodeGraph 属 knowledge-graph 组').toBe('knowledge-graph');
		expect(COMPONENT_META.GitNexus.group, 'GitNexus 属 knowledge-graph 组').toBe('knowledge-graph');
	});

	test('分组展示顺序固定：agent → companion → workflow → knowledge-graph', () => {
		expect(TOOL_GROUP_ORDER, '分组展示顺序固定').toEqual(['agent', 'companion', 'workflow', 'knowledge-graph']);
	});
});

describe('isComponentVisible / visibleComponentDefinitions', () => {
	test('ClaudeCode/CodexCli/AntigravityCli/DeepSeekHarness 在两种上下文都常显', () => {
		for (const id of ['ClaudeCode', 'CodexCli', 'AntigravityCli', 'DeepSeekHarness'] as const) {
			expect(isComponentVisible(id, 'cc'), `${id} 在 Claude Code 上下文常显`).toBe(true);
			expect(isComponentVisible(id, 'cx'), `${id} 在 Codex 上下文常显`).toBe(true);
		}
	});

	test('Ccline 仅 Claude Code 上下文显示', () => {
		expect(isComponentVisible('Ccline', 'cc'), 'Ccline 在 Claude Code 上下文显示').toBe(true);
		expect(isComponentVisible('Ccline', 'cx'), 'Ccline 不在 Codex 上下文显示').toBe(false);
	});

	test('Pi 上下文只显示 Pi 原生 Agent 与其全局伴随 Pi Web', () => {
		expect(isComponentVisible('PiCli', 'pi'), 'PiCli 在 Pi 上下文显示').toBe(true);
		expect(isComponentVisible('PiWeb', 'pi'), 'PiWeb 在 Pi 上下文显示').toBe(true);
		expect(isComponentVisible('ClaudeCode', 'pi'), 'ClaudeCode 不在 Pi 上下文显示').toBe(false);
		expect(isComponentVisible('CodexCli', 'pi'), 'CodexCli 不在 Pi 上下文显示').toBe(false);
		expect(
			visibleComponentDefinitions('pi').map(definition => definition.id),
			'Pi 上下文只显示 PiCli/PiWeb'
		).toEqual(['PiCli', 'PiWeb']);
	});

	test('OpenSpec/Trellis/CcgWorkflow/CodeGraph/GitNexus 两上下文都可见', () => {
		for (const id of ['OpenSpec', 'Trellis', 'CcgWorkflow', 'CodeGraph', 'GitNexus'] as const) {
			expect(isComponentVisible(id, 'cc'), `${id} 在 Claude Code 上下文可见`).toBe(true);
			expect(isComponentVisible(id, 'cx'), `${id} 在 Codex 上下文可见`).toBe(true);
		}
	});
});

describe('visibleComponentDefinitions 数量与顺序', () => {
	test('Claude Code 上下文可见 12 项（含 Ccline / Pi CLI / Pi Web）', () => {
		const ccVisible = visibleComponentDefinitions('cc').map(definition => definition.id);
		expect(ccVisible.length, 'Claude Code 上下文可见 12 项').toBe(12);
		expect(ccVisible.includes('Ccline'), 'Claude Code 上下文含 Ccline').toBe(true);
		expect(ccVisible.includes('PiCli'), 'Claude Code 上下文含 PiCli').toBe(true);
		expect(ccVisible.includes('PiWeb'), 'Claude Code 上下文含 PiWeb').toBe(true);
	});

	test('Codex 上下文可见 11 项（不含 Ccline，保留全局 PiWeb）', () => {
		const cxVisible = visibleComponentDefinitions('cx').map(definition => definition.id);
		expect(cxVisible.length, 'Codex 上下文可见 11 项').toBe(11);
		expect(cxVisible.includes('Ccline'), 'Codex 上下文不含 Ccline').toBe(false);
		expect(cxVisible.includes('PiCli'), 'Codex 上下文含 PiCli').toBe(true);
		expect(cxVisible.includes('PiWeb'), 'Codex 上下文含 PiWeb').toBe(true);
	});

	test('两种上下文都含 ClaudeCode/CodexCli/PiCli/AntigravityCli/DeepSeekHarness/OpenSpec/Trellis/CcgWorkflow/CodeGraph/GitNexus', () => {
		const ccVisible = visibleComponentDefinitions('cc').map(definition => definition.id);
		const cxVisible = visibleComponentDefinitions('cx').map(definition => definition.id);
		for (const id of [
			'ClaudeCode',
			'CodexCli',
			'PiCli',
			'AntigravityCli',
			'DeepSeekHarness',
			'OpenSpec',
			'Trellis',
			'CcgWorkflow',
			'CodeGraph',
			'GitNexus'
		] as const) {
			expect(ccVisible.includes(id), `Claude Code 含 ${id}`).toBe(true);
			expect(cxVisible.includes(id), `Codex 含 ${id}`).toBe(true);
		}
	});

	test('可见列表按工具管理分组展示顺序排序', () => {
		const ccVisible = visibleComponentDefinitions('cc').map(definition => definition.id);
		const cxVisible = visibleComponentDefinitions('cx').map(definition => definition.id);
		expect(ccVisible, 'Claude Code 可见列表按分组展示顺序排序').toEqual([
			'ClaudeCode',
			'CodexCli',
			'PiCli',
			'AntigravityCli',
			'DeepSeekHarness',
			'Ccline',
			'PiWeb',
			'OpenSpec',
			'Trellis',
			'CcgWorkflow',
			'CodeGraph',
			'GitNexus'
		]);
		expect(cxVisible, 'Codex 可见列表隐藏 Ccline 并保持分组展示顺序').toEqual([
			'ClaudeCode',
			'CodexCli',
			'PiCli',
			'AntigravityCli',
			'DeepSeekHarness',
			'PiWeb',
			'OpenSpec',
			'Trellis',
			'CcgWorkflow',
			'CodeGraph',
			'GitNexus'
		]);
	});

	test('静态定义仍保留安装定义原始顺序', () => {
		expect(
			COMPONENT_DEFINITIONS.map(definition => definition.id),
			'静态定义仍保留安装定义原始顺序'
		).toEqual([
			'ClaudeCode',
			'Ccline',
			'PiCli',
			'PiWeb',
			'CcgWorkflow',
			'OpenSpec',
			'Trellis',
			'CodeGraph',
			'GitNexus',
			'CodexCli',
			'AntigravityCli',
			'DeepSeekHarness'
		]);
	});
});

describe('filterVisibleComponents 运行时组件过滤（供 ToolsView 消费）', () => {
	test('Claude Code 过滤保留 Ccline，并按分组展示顺序排序', () => {
		const runtime = [
			component('ClaudeCode', true),
			component('Ccline', false),
			component('CcgWorkflow', true),
			component('CodexCli', false)
		];
		expect(
			filterVisibleComponents(runtime, 'cc').map(item => item.id),
			'Claude Code 过滤保留 Ccline，并按分组展示顺序排序'
		).toEqual(['ClaudeCode', 'CodexCli', 'Ccline', 'CcgWorkflow']);
	});

	test('Codex 过滤掉 Ccline，并按分组展示顺序排序', () => {
		const runtime = [
			component('ClaudeCode', true),
			component('Ccline', false),
			component('CcgWorkflow', true),
			component('CodexCli', false)
		];
		expect(
			filterVisibleComponents(runtime, 'cx').map(item => item.id),
			'Codex 过滤掉 Ccline，并按分组展示顺序排序'
		).toEqual(['ClaudeCode', 'CodexCli', 'CcgWorkflow']);
	});
});

describe('shared list 与 legacy filter API 拆分', () => {
	test('shared list 常显 Ccline 且展示组件全集（不随 agentContext 过滤）', () => {
		const sharedIds = projectSharedToolComponents([]).map(item => item.id);
		expect(sharedIds.includes('Ccline'), 'shared list 常显 Ccline（不随 agentContext 过滤）').toBe(true);
		expect(sharedIds.length, 'shared list 展示组件全集').toBe(COMPONENT_DEFINITIONS.length);
	});

	// P4c 迁移自 scripts/verify-tools-shared-projection.mjs（原「6.1 列表 agentContext 不变性」段）：
	// 投影不接受 context 参数，且全集按分组展示顺序排列 —— 由本文件独占承载。
	test('shared list 全集按分组展示顺序排列（含 Pi CLI / Pi Web）', () => {
		const detected = COMPONENT_DEFINITIONS.map(definition => component(definition.id, definition.id === 'CodeGraph'));
		expect(
			projectSharedToolComponents(detected).map(item => item.id),
			'共享投影返回全 12 组件并按分组顺序排列（含 Pi CLI / Pi Web）'
		).toEqual([
			'ClaudeCode',
			'CodexCli',
			'PiCli',
			'AntigravityCli',
			'DeepSeekHarness',
			'Ccline',
			'PiWeb',
			'OpenSpec',
			'Trellis',
			'CcgWorkflow',
			'CodeGraph',
			'GitNexus'
		]);
	});
});
