import {act} from 'react';
import {KeyEvent, type ParsedKey} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {expect, test} from 'bun:test';
import type {ManagedComponent} from '../../src/core/tools-manage.js';
import type {DetectionCache} from '../../src/hooks/use-detection-cache.js';
import {ToolsView} from '../../src/views/tools/ToolsView.js';
import type {ToolsViewServices} from '../../src/views/tools/tools-view-types.js';

// A 类改写（P1-G3）：verify-tools-manage.mjs
//   136 ToolsView r 刷新必须传 forceRefresh，绕过 npm outdated/npm view 缓存

function key(name: string, modifiers: Partial<ParsedKey> = {}): KeyEvent {
	return new KeyEvent({
		name,
		sequence: name,
		ctrl: false,
		shift: false,
		meta: false,
		option: false,
		number: false,
		raw: name,
		eventType: 'press',
		source: 'raw',
		repeated: false,
		...modifiers
	});
}

test('ToolsView r 手动刷新透传 forceRefresh', async () => {
	const refreshCalls: unknown[] = [];
	const cache = {
		state: {status: 'idle'},
		refresh(options?: unknown) {
			refreshCalls.push(options);
		},
		async refreshAndWait() {
			return cache.state;
		}
	} as unknown as DetectionCache<ManagedComponent[]>;
	const services = {} as unknown as ToolsViewServices;

	const setup = await testRender(<ToolsView services={services} cache={cache} agentContext="cc" contentWidth={80} active />, {
		width: 80,
		height: 24
	});
	try {
		await setup.renderOnce();
		await act(async () => {
			setup.renderer.keyInput.emit('keypress', key('r'));
			await setup.renderOnce();
		});
		expect(refreshCalls).toEqual([{forceRefresh: true}]);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
