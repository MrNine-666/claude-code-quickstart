import {act} from 'react';
import {KeyEvent} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {expect, spyOn, test} from 'bun:test';
import {toast} from '../../src/components/toast.js';
import {McpFormView} from '../../src/views/mcp/McpFormView.js';

test('MCP 保存重名只发 toast，不渲染底部错误、不退出表单', async () => {
	const error = 'exa: Server ID 已存在，请使用编辑';
	const feedback = spyOn(toast, 'error').mockImplementation(() => {});
	let saved = false;
	const setup = await testRender(
		<McpFormView
			model={{mode: 'edit', serverId: 'exa', initialJson: '{"command":"npx"}', templates: []}}
			active
			validateJson={() => undefined}
			onSubmit={() => ({ok: false, error})}
			onSaved={() => {
				saved = true;
			}}
			onCancel={() => {}}
		/>,
		{width: 80, height: 24}
	);
	try {
		await act(async () => {
			setup.renderer.keyInput.emit(
				'keypress',
				new KeyEvent({
					name: 's',
					ctrl: true,
					super: true,
					shift: false,
					meta: false,
					option: false,
					number: false,
					sequence: 's',
					raw: 's',
					eventType: 'press',
					source: 'raw',
					repeated: false
				})
			);
			await setup.renderOnce();
		});
		expect(feedback).toHaveBeenCalledTimes(1);
		expect(feedback).toHaveBeenCalledWith(error);
		expect(setup.captureCharFrame()).not.toContain(error);
		expect(saved).toBe(false);
	} finally {
		feedback.mockRestore();
		await act(async () => setup.renderer.destroy());
	}
});
