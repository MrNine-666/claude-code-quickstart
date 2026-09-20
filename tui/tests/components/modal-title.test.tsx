import React, {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import {Modal} from '../../src/components/modal.js';
import {colors, PRIMARY} from '../../src/theme/index.js';

// 迁自 scripts/verify-modal-title.mjs 的源码正则段（P1-G1 后半 A 类）。
// Modal 标题必须交给 OpenTUI box title 渲染（随边框行、按 tone 强调色着色），
// 不得再把 title 当内容首行二次渲染（会被边框裁剪）。
// 每个 testRender 用例固定 terminal 尺寸，并在 finally 的 act() 内销毁 renderer。

describe('Modal 标题渲染', () => {
	test('标题必须渲染在顶部边框行，而不是内容首行', async () => {
		const setup = await testRender(
			<Modal active title="确认删除配置">
				<text>正文内容</text>
			</Modal>,
			{width: 60, height: 16}
		);
		try {
			const frame = await setup.waitForFrame(value => value.includes('确认删除配置'));
			const titleLine = frame.split('\n').find(line => line.includes('确认删除配置'));
			expect(titleLine).toBeDefined();
			// 顶部边框（╭─...─╮）与标题同一行，才说明标题由 box title 承载。
			expect(/[╭─]/.test(titleLine ?? '')).toBe(true);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('标题不得作为内容首行二次渲染：全帧只出现一次', async () => {
		const setup = await testRender(
			<Modal active title="确认删除配置">
				<text>正文内容</text>
			</Modal>,
			{width: 60, height: 16}
		);
		try {
			const frame = await setup.waitForFrame(value => value.includes('确认删除配置'));
			expect(frame.match(/确认删除配置/g) ?? []).toHaveLength(1);
			const lines = frame.split('\n');
			// 内容行只承载 children，不含标题文案。
			expect(lines.some(line => line.includes('正文内容'))).toBe(true);
			expect(lines.filter(line => line.includes('确认删除配置')).length).toBe(1);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('标题强调色必须跟随 tone（danger 用 danger 色，default 用主色）', async () => {
		const danger = await testRender(
			<Modal active title="危险标题" tone="danger">
				<text fg={colors.danger}>DANGER_REF</text>
			</Modal>,
			{width: 60, height: 16}
		);
		try {
			await danger.waitForFrame(value => value.includes('危险标题'));
			const spans = danger.captureSpans().lines.flatMap(line => line.spans);
			const titleSpan = spans.find(span => span.text.includes('危险标题'));
			const refSpan = spans.find(span => span.text.includes('DANGER_REF'));
			expect(titleSpan).toBeDefined();
			expect(refSpan).toBeDefined();
			expect(titleSpan?.fg.equals(refSpan?.fg ?? titleSpan!.fg)).toBe(true);
		} finally {
			await act(async () => {
				danger.renderer.destroy();
			});
		}

		const standard = await testRender(
			<Modal active title="普通标题" tone="default">
				<text fg={PRIMARY}>PRIMARY_REF</text>
			</Modal>,
			{width: 60, height: 16}
		);
		try {
			await standard.waitForFrame(value => value.includes('普通标题'));
			const spans = standard.captureSpans().lines.flatMap(line => line.spans);
			const titleSpan = spans.find(span => span.text.includes('普通标题'));
			const refSpan = spans.find(span => span.text.includes('PRIMARY_REF'));
			expect(titleSpan).toBeDefined();
			expect(refSpan).toBeDefined();
			expect(titleSpan?.fg.equals(refSpan?.fg ?? titleSpan!.fg)).toBe(true);
		} finally {
			await act(async () => {
				standard.renderer.destroy();
			});
		}
	});
});
