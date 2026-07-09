import React from 'react';
import {testRender} from '@opentui/react/test-utils';

// 临时探针：cc 模式（agentContext='cc'）ConfigView/PromptsView 的 view 态布局。
// 先看默认 view 态（有 settings.json/CLAUDE.md 内容）的渲染，实测对齐问题。
process.env.CCQ_HOME = process.cwd();

async function probe(name, mod) {
	const View = (await import(mod)).default ?? (await import(mod))[name];
	const {renderer, captureCharFrame, flush, mockInput} = await testRender(
		React.createElement(View, {
			agentContext: 'cc',
			active: true,
			viewportHeight: 16,
			onExitToNav: () => {},
			onExitToHeader: () => {}
		}),
		{width: 100, height: 24}
	);
	await flush();
	const lines = captureCharFrame().split('\n');
	console.log('=== ' + name + ' (view 态) ===');
	lines.forEach((line, i) => {
		console.log(String(i).padStart(2, ' '), '|' + line + '|');
	});
	renderer.destroy?.();
}

await probe('ConfigView', '../src/views/ConfigView.tsx');
await probe('PromptsView', '../src/views/PromptsView.tsx');
