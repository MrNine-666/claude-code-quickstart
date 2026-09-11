import {act} from 'react';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/react/test-utils';
import {CodePreview} from '../../src/components/code-preview.js';

const longValue =
	'C:\\Users\\Administrator\\AppData\\Local\\OpenAI\\Codex\\runtimes\\node_modules\\@opentui\\bin\\windows\\codex-computer-use.exe';

test('CodePreview keeps line numbers aligned with wrapped highlighted lines', async () => {
	const content = ['first = "short"', `notif = ["${longValue}", "turn-ended"]`, 'last = true'].join('\n');
	const setup = await testRender(<CodePreview content={content} filetype="toml" />, {width: 48, height: 8});

	try {
		const frame = await setup.waitForFrame(output => output.includes('last = true'));
		const lines = frame.split('\n');
		const lastLineIndex = lines.findIndex(line => line.startsWith('  3 │ last = true'));

		expect(lines[0]).toMatch(/^  1 │ first = "short"/);
		expect(lines[1]).toMatch(/^  2 │ notif = \["C:\\Users\\Administrator\\/);
		expect(lastLineIndex).toBe(5);
		expect(lines.slice(2, lastLineIndex).every(line => line.startsWith('      '))).toBe(true);
		expect(lines[4]).toContain('exe", "turn-ended"]');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
