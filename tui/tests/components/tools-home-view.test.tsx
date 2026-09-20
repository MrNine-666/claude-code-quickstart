import {act} from 'react';
import {describe, expect, test} from 'bun:test';
import {testRender} from '@opentui/react/test-utils';
import {COMPONENT_DEFINITIONS, type ComponentId, type ManagedComponent} from '../../src/core/tools-manage.js';
import {createInitialToolsViewState} from '../../src/state/tools-view-state.js';
import {ToolsHomeView} from '../../src/views/tools/ToolsHomeView.js';

// A 类改写（P1-G3）：verify-tools-manage.mjs / verify-tools-view.mjs
//   83 工具卡片渲染 statusHint
//   85 状态提示固定单行并截断长诊断
//   144/145 ToolsHomeView 按领域分组渲染 label（走单一 groupToolsForHome 投影）

function component(id: ComponentId, over: Partial<ManagedComponent> = {}): ManagedComponent {
	const def = COMPONENT_DEFINITIONS.find(entry => entry.id === id);
	if (!def) throw new Error(`未知组件 ${id}`);
	return {...def, installed: false, currentVersion: '', latestVersion: '', hasUpdate: null, ...over};
}

async function renderHome(components: readonly ManagedComponent[], height = 24) {
	const view = {...createInitialToolsViewState(), components, loaded: true};
	return testRender(<ToolsHomeView view={view} detectionStatus="success" scrollRef={{current: null}} active />, {width: 96, height});
}

describe('ToolsHomeView 领域分组与 statusHint', () => {
	test('按 Agent / 全局伴随工具 / 工作流 / 代码知识图谱顺序渲染分组 label', async () => {
		const setup = await renderHome([component('OpenSpec'), component('ClaudeCode'), component('CodeGraph'), component('Ccline')], 60);
		try {
			const frame = await setup.waitForFrame(output => output.includes('代码知识图谱'));
			const labels = ['Agent', '全局伴随工具', '工作流', '代码知识图谱'].map(label => frame.indexOf(label));
			expect(labels.every(index => index >= 0)).toBe(true);
			expect(labels).toEqual([...labels].sort((a, b) => a - b));
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('卡片渲染 statusHint 并保持固定单行裁剪长诊断', async () => {
		const longHint = `外部安装的 dsh 覆盖了受管版本，TAIL_SENTINEL_${'x'.repeat(200)}`;
		const setup = await renderHome([
			component('CodeGraph', {
				sharingKind: 'shared-cli-per-agent-inject',
				statusHint: longHint
			} as never)
		] as never);
		try {
			const frame = await setup.waitForFrame(output => output.includes('外部安装的 dsh'));
			expect(frame).toContain('外部安装的 dsh');
			expect(frame).not.toContain('TAIL_SENTINEL');
			for (const line of frame.split('\n')) {
				expect(line.length).toBeLessThanOrEqual(96);
			}
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
