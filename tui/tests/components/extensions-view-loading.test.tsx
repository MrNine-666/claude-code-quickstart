import React, {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import type {PiExtensionPackage} from '../../src/core/extensions.js';
import type {ExtensionsService} from '../../src/services/extensions-service.js';
import {ExtensionsView} from '../../src/views/extensions/ExtensionsView.js';

// 加载门禁：读取已安装列表期间不得渲染搜索框。
// 若搜索框仍在，用户可在 installed 请求未落地时提交搜索，抢走安装列表请求，
// installed-loaded 永不派发 → loading 卡在 true（安装标记全变「○ 未安装」）。

function serviceWith(loadInstalled: () => Promise<readonly PiExtensionPackage[]>): ExtensionsService {
	return {
		loadInstalled,
		search: async () => ({items: [], page: 0, pageSize: 20, total: 0, hasPrevious: false, hasNext: false}),
		inspect: async () => null,
		install: async () => ({ok: false, error: 'unused'}),
		update: async () => {},
		remove: async () => {},
		installMcpAdapter: async () => ({ok: false, error: 'unused'})
	};
}

describe('扩展管理加载门禁', () => {
	test('读取已安装列表期间不渲染搜索框，落地后才恢复', async () => {
		let resolveInstalled: (items: readonly PiExtensionPackage[]) => void = () => {};
		const pending = new Promise<readonly PiExtensionPackage[]>(resolve => {
			resolveInstalled = resolve;
		});
		const setup = await testRender(
			<ExtensionsView
				active
				agentContext="pi"
				contentWidth={80}
				service={serviceWith(() => pending)}
				onBusyStateChange={() => {}}
				onExitToNav={() => {}}
			/>,
			{width: 90, height: 20}
		);
		try {
			await setup.waitForFrame(frame => frame.includes('正在读取已安装的 Pi 扩展'));
			const loadingFrame = setup.captureCharFrame();
			expect(loadingFrame, '加载中必须展示读取提示').toContain('正在读取已安装的 Pi 扩展');
			expect(loadingFrame, '加载中不得渲染搜索框').not.toContain('输入关键词，按 Enter 搜索 Pi 官方扩展商店');

			await act(async () => {
				resolveInstalled([]);
			});
			await setup.waitForFrame(frame => frame.includes('输入关键词，按 Enter 搜索 Pi 官方扩展商店'));
			expect(setup.captureCharFrame(), '加载完成后必须恢复搜索框').toContain('输入关键词，按 Enter 搜索 Pi 官方扩展商店');
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
