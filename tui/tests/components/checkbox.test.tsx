import {act} from 'react';
import {RGBA} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import {Checkbox} from '../../src/components/checkbox.js';
import {colors} from '../../src/theme/index.js';

// A 类改写（P1-G3）：verify-skills-render.mjs
//   23 Checkbox 启用态用主题 primary，disabled 用 muted（不反转背景色）
//   24 勾选内容与边框共用同一主题色

const primary = RGBA.fromHex(colors.primary);

function spansOf(setup: Awaited<ReturnType<typeof testRender>>) {
	return setup.captureSpans().lines.flatMap(line => line.spans);
}

describe('Checkbox 主题色', () => {
	test('focused/checked 时完整 bracket 与 checkmark 使用 primary color', async () => {
		const setup = await testRender(<Checkbox checked focused />, {width: 12, height: 1});
		try {
			await setup.renderOnce();
			const spans = spansOf(setup);
			const bracket = spans.filter(span => span.text.includes('[') || span.text.includes(']'));
			const checkmark = spans.find(span => span.text.includes('✓'));
			expect(bracket.length).toBeGreaterThan(0);
			expect(bracket.every(span => span.fg.equals(primary))).toBe(true);
			expect(checkmark).toBeDefined();
			expect(checkmark?.fg.equals(primary)).toBe(true);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('disabled 时退回 muted，不使用 primary，显示 —', async () => {
		const setup = await testRender(<Checkbox checked disabled />, {width: 12, height: 1});
		try {
			const frame = await setup.waitForFrame(output => output.includes('—'));
			const spans = spansOf(setup);
			expect(frame).toContain('[—]');
			expect(spans.every(span => !span.fg.equals(primary))).toBe(true);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
