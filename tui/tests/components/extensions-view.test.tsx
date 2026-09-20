import {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import {RGBA} from '@opentui/core';
import {Card} from '../../src/components/card.js';
import {ExtensionCard} from '../../src/views/extensions/ExtensionsView.js';

// P5d 迁移自 scripts/verify-extensions-view.mjs 的真实渲染段（3 条静态断言），按 R10 归位 tests/components。
// 判据：断言对象是真实渲染帧的 Span 背景色与换行裁剪，去掉真实渲染后不成立。
// 固定 terminal 尺寸，renderer 在 finally 的 act() 内 destroy。
// R9：同脚本的 reducer / input / footer 断言已由 tests/core/extensions-view-state.test.ts 与
// tests/core/extensions-view-input.test.ts 覆盖，保留在 verify 待 P5e 去重。

const focusedBackground = RGBA.fromHex('#2A1A10');

describe('Extensions View 渲染', () => {
	test('聚焦 Card 的标题和正文使用主题 focusedBackground', async () => {
		const setup = await testRender(
			<Card title="alpha" focused width={20}>
				<text>body</text>
			</Card>,
			{width: 24, height: 6}
		);
		try {
			await setup.waitForFrame(frame => frame.includes('alpha') && frame.includes('body'));
			const focusedSpans = setup
				.captureSpans()
				.lines.flatMap(line => line.spans)
				.filter(span => span.text.includes('alpha') || span.text.includes('body'));
			expect(focusedSpans.length > 0, '聚焦 Card 必须渲染标题和正文 Span').toBe(true);
			expect(
				focusedSpans.every(span => span.bg.equals(focusedBackground)),
				'聚焦 Card 的标题和正文必须使用主题 focusedBackground'
			).toBe(true);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('扩展简介超过三行时必须隐藏第四行', async () => {
		const setup = await testRender(
			<ExtensionCard
				item={{
					name: 'long-description',
					source: 'npm:long-description',
					version: '1.0.0',
					description: '第一行\n第二行\n第三行\n第四行',
					type: 'extension',
					resourceTypes: ['extension'],
					author: 'community',
					repository: '',
					npmUrl: 'https://www.npmjs.com/package/long-description',
					catalogListed: true,
					piMaintained: false,
					installed: false,
					installCommand: 'pi install npm:long-description'
				}}
				installed={false}
				focused={false}
				width={50}
			/>,
			{width: 54, height: 12}
		);
		try {
			const frame = await setup.waitForFrame(current => current.includes('第一行'));
			expect(frame.includes('第四行'), '扩展简介超过三行时必须隐藏第四行').toBe(false);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
