import {act} from 'react';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/react/test-utils';
import {StatusDot} from '../../src/components/status-dot.js';

test('StatusDot renders a visible status label', async () => {
	const setup = await testRender(<StatusDot kind="latest" label="已是最新" />, {width: 24, height: 3});

	try {
		const frame = await setup.waitForFrame(output => output.includes('已是最新'));
		expect(frame).toContain('● 已是最新');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
