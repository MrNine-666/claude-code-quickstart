import {act, useState} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {expect, spyOn, test} from 'bun:test';
import * as actions from '../../src/views/mcp/mcp-view-actions.js';
import McpView from '../../src/views/mcp/McpView.js';

test('MCP 菜单预览无焦点也加载列表，获得焦点不重复检测', async () => {
	let resolveRows!: (rows: Awaited<ReturnType<typeof actions.loadMcpRowsActionAsync>>) => void;
	const pending = new Promise<Awaited<ReturnType<typeof actions.loadMcpRowsActionAsync>>>(resolve => {
		resolveRows = resolve;
	});
	const load = spyOn(actions, 'loadMcpRowsActionAsync').mockReturnValue(pending);
	const rows: Awaited<ReturnType<typeof actions.loadMcpRowsActionAsync>> = [
		{
			Id: 'preview-server',
			Name: 'preview-server',
			McpType: 'http',
			HasCredentials: false,
			hasDefinition: true,
			injectByAgent: {
				cc: {active: false, disabled: false, supported: true},
				cx: {active: false, disabled: false, supported: true},
				pi: {active: false, disabled: false, supported: true}
			}
		}
	];
	let focusView!: () => void;
	function Harness() {
		const [active, setActive] = useState(false);
		focusView = () => setActive(true);
		return <McpView active={active} onExitToNav={() => {}} />;
	}
	let setup: Awaited<ReturnType<typeof testRender>> | undefined;
	try {
		setup = await testRender(<Harness />, {width: 80, height: 24});
		await act(async () => {
			resolveRows(rows);
			await pending;
		});
		await setup.waitForFrame(output => output.includes('preview-server'));
		expect(load).toHaveBeenCalledTimes(1);
		await act(async () => {
			focusView();
			await setup!.renderOnce();
		});
		expect(setup.captureCharFrame()).toContain('preview-server');
		expect(load).toHaveBeenCalledTimes(1);
	} finally {
		if (setup) await act(async () => setup!.renderer.destroy());
		load.mockRestore();
	}
});
