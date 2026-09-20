import {act, useState} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import {Card} from '../../src/components/card.js';
import {ScrollList} from '../../src/components/scroll-list.js';

// A 类改写（P1-G3）：verify-skills-render.mjs
//   26 ScrollList 必须把 item.bordered 透传给 Card
//   27 Card 只在 bordered 开启时渲染边框（分组标题等轻量行无边框）
//
// 回归（切 Agent 后卡片少一行）：Card 的横向/纵向分支根节点同为 <box>，React 会跨分支复用 host node，
// 而渲染器不清除已移除的布局属性，于是纵向分支 body 节点的 height={1} 会把横向分支的内容列压成 1 行。
// 修复是给两个分支根节点互斥 key 强制 remount；这里锁住可观察契约：切换布局族后 body 行必须仍在。

const ROUNDED_BORDER = '╭';

/** 取出卡片边框之间的内容行，用来断言卡片仍是「标题 + 描述」两行。 */
function cardContentLines(frame: string): readonly string[] {
	const lines = frame.split('\n');
	const top = lines.findIndex(line => line.includes(ROUNDED_BORDER));
	const bottom = lines.findLastIndex(line => line.includes('╰'));
	if (top < 0 || bottom <= top) return [];
	return lines.slice(top + 1, bottom);
}

let toggleLeading: ((value: boolean) => void) | null = null;

function CardLayoutHarness() {
	const [withLeading, setWithLeading] = useState(true);
	toggleLeading = setWithLeading;
	return (
		<Card title="glm" leading={withLeading ? <text>{'●'}</text> : undefined}>
			<text>{'https://api.example.test · sk-****'}</text>
		</Card>
	);
}

describe('Card / ScrollList 边框语义', () => {
	test('Card 仅 bordered 开启时渲染 rounded 边框', async () => {
		const withoutBorder = await testRender(<Card title="分组标题" bordered={false} />, {width: 24, height: 3});
		try {
			const frame = await withoutBorder.waitForFrame(output => output.includes('分组标题'));
			expect(frame).not.toContain(ROUNDED_BORDER);
		} finally {
			await act(async () => {
				withoutBorder.renderer.destroy();
			});
		}

		const withBorder = await testRender(<Card title="普通卡片" />, {width: 24, height: 3});
		try {
			const frame = await withBorder.waitForFrame(output => output.includes('普通卡片'));
			expect(frame).toContain(ROUNDED_BORDER);
		} finally {
			await act(async () => {
				withBorder.renderer.destroy();
			});
		}
	});

	test('ScrollList 把 item.bordered 透传给 Card', async () => {
		const setup = await testRender(
			<ScrollList
				cursor={0}
				items={[
					{key: 'group', title: '分组标题', bordered: false},
					{key: 'skill', title: '普通卡片'}
				]}
			/>,
			{width: 32, height: 8}
		);
		try {
			const frame = await setup.waitForFrame(output => output.includes('分组标题') && output.includes('普通卡片'));
			const lines = frame.split('\n');
			const groupLine = lines.findIndex(line => line.includes('分组标题'));
			const skillLine = lines.findIndex(line => line.includes('普通卡片'));
			expect(groupLine).toBeGreaterThanOrEqual(0);
			expect(skillLine).toBeGreaterThan(groupLine);
			expect(lines[groupLine]?.includes(ROUNDED_BORDER)).toBe(false);
			expect(lines[skillLine]?.includes(ROUNDED_BORDER)).toBe(false);
			expect(frame.slice(Math.max(0, skillLine - 1)).includes(ROUNDED_BORDER)).toBe(true);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('Card 在 leading 出现/消失间切换后仍保留 body 行（切换布局族不得复用旧布局节点）', async () => {
		const setup = await testRender(<CardLayoutHarness />, {width: 60, height: 4});
		try {
			await setup.flush();
			const withLeading = setup.captureCharFrame();
			expect(cardContentLines(withLeading)).toHaveLength(2);
			expect(withLeading).toContain('https://api.example.test · sk-****');

			await act(async () => {
				toggleLeading?.(false);
			});
			await setup.flush();
			const withoutLeading = setup.captureCharFrame();
			expect(cardContentLines(withoutLeading)).toHaveLength(2);
			expect(withoutLeading).toContain('https://api.example.test · sk-****');

			// 切回横向分支：正是 body 节点被复用为内容列、旧 height={1} 压掉描述行的路径。
			await act(async () => {
				toggleLeading?.(true);
			});
			await setup.flush();
			const backToLeading = setup.captureCharFrame();
			expect(cardContentLines(backToLeading)).toHaveLength(2);
			expect(backToLeading).toContain('https://api.example.test · sk-****');
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
