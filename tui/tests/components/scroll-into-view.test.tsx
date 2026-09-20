import {act} from 'react';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/react/test-utils';
import type {ScrollBoxRenderable} from '@opentui/core';
import {ThemedScrollbox} from '../../src/components/themed-scrollbox.js';
import {scrollTargetIntoView, type ScrollableBox} from '../../src/utils/scroll-into-view.js';

function run(viewportHeight: number, target: {y: number; height: number}): {x: number; y: number}[] {
	const calls: {x: number; y: number}[] = [];
	const box: ScrollableBox = {
		viewport: {y: 0, height: viewportHeight},
		scrollBy: delta => calls.push(delta),
		findDescendantById: () => target
	};
	scrollTargetIntoView(box, 'target');
	return calls;
}

test('scrollTargetIntoView：高于视口顶对齐、能放下则完整露出', () => {
	// 目标高于视口 → 顶对齐，从列表开头看起
	expect(run(10, {y: 40, height: 14})).toEqual([{x: 0, y: 40}]);
	// 目标高度恰好等于视口高度 → 必须滚动（OpenTUI scrollChildIntoView 在此返回 0）
	expect(run(14, {y: 100, height: 14})).toEqual([{x: 0, y: 100}]);
	// 目标在下方且能放下 → 底对齐
	expect(run(20, {y: 100, height: 14})).toEqual([{x: 0, y: 94}]);
	// 目标在上方 → 上滚露出顶部
	expect(run(20, {y: -5, height: 4})).toEqual([{x: 0, y: -5}]);
	// 已完整可见 → 不动
	expect(run(20, {y: 3, height: 4})).toEqual([]);

	const empty: ScrollableBox = {
		viewport: {y: 0, height: 20},
		scrollBy: () => {
			throw new Error('找不到目标时不得滚动');
		}
	};
	scrollTargetIntoView(empty, 'missing');
});

test('表单级滚动：列表 box 高度等于表单视口高度时仍必须滚动', async () => {
	const outer: {current: ScrollBoxRenderable | null} = {current: null};
	const setup = await testRender(
		<box flexDirection="column" height={14}>
			<ThemedScrollbox
				ref={renderable => {
					outer.current = renderable as ScrollBoxRenderable | null;
				}}
				style={{flexGrow: 1, minHeight: 0}}
				viewportCulling
			>
				<box flexDirection="column">
					{Array.from({length: 40}, (_, index) => (
						<text key={index}>{`field-${index}`}</text>
					))}
					<box id="list-box" height={14} flexShrink={0}>
						<text>model list</text>
					</box>
				</box>
			</ThemedScrollbox>
		</box>,
		{width: 80, height: 14}
	);

	const settle = async () => {
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 40));
		});
	};

	try {
		await setup.waitForFrame(() => outer.current !== null);
		await settle();
		expect(outer.current?.scrollTop).toBe(0);

		await act(async () => {
			if (outer.current) scrollTargetIntoView(outer.current, 'list-box');
		});
		await settle();
		expect(outer.current?.scrollTop ?? 0).toBeGreaterThan(0);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
