import {RGBA} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {act, useState} from 'react';
import {expect, test} from 'bun:test';
import {SelectField} from '../../src/components/form/SelectField.js';
import {colors, getActiveTheme, setActiveTheme} from '../../src/theme/index.js';

test('横向选择器在浅色主题中使用可读的焦点背景与选中配色', async () => {
	const previousTheme = getActiveTheme().mode;
	setActiveTheme('light');
	const setup = await testRender(
		<SelectField
			label="是否加密"
			value="no"
			options={[
				{value: 'yes', label: '是'},
				{value: 'no', label: '否'}
			]}
			focused
			onChange={() => {}}
		/>,
		{width: 40, height: 5}
	);
	try {
		await setup.waitForFrame(frame => frame.includes('是') && frame.includes('否'));
		const spans = setup.captureSpans().lines.flatMap(line => line.spans);
		const unselected = spans.find(span => span.text.trim() === '是');
		const selected = spans.find(span => span.text.trim() === '否');
		expect(unselected?.bg.toInts()).toEqual(RGBA.fromHex(colors.focusedBackground).toInts());
		expect(unselected?.fg.toInts()).toEqual(RGBA.fromHex(colors.text).toInts());
		expect(selected?.bg.toInts()).toEqual(RGBA.fromHex(colors.primary).toInts());
		expect(selected?.fg.toInts()).toEqual(RGBA.fromHex(colors.navSelectedForeground).toInts());
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
		setActiveTheme(previousTheme);
	}
});

test('失焦选中项在明暗主题中保留清晰且不同于导航的底色', async () => {
	const previousTheme = getActiveTheme().mode;
	try {
		for (const [mode, expectedBg] of [
			['dark', '#624436'],
			['light', '#E0B49B']
		] as const) {
			setActiveTheme(mode);
			const setup = await testRender(
				<SelectField
					label="是否加密"
					value="no"
					options={[
						{value: 'yes', label: '是'},
						{value: 'no', label: '否'}
					]}
					focused={false}
					onChange={() => {}}
				/>,
				{width: 40, height: 5}
			);
			try {
				await setup.waitForFrame(frame => frame.includes('是') && frame.includes('否'));
				const selected = setup
					.captureSpans()
					.lines.flatMap(line => line.spans)
					.find(span => span.text.trim() === '否');
				expect(selected?.bg.toInts()).toEqual(RGBA.fromHex(expectedBg).toInts());
				expect(selected?.bg.toInts()).toEqual(RGBA.fromHex(colors.selectInactiveBackground).toInts());
				expect(selected?.fg.toInts()).toEqual(RGBA.fromHex(colors.text).toInts());
				expect(selected?.bg.toInts()).not.toEqual(RGBA.fromHex(colors.navInactiveSelectedBackground).toInts());
			} finally {
				await act(async () => setup.renderer.destroy());
			}
		}
	} finally {
		setActiveTheme(previousTheme);
	}
});

test('横向选择器在运行中切换明暗主题时更新选中配色', async () => {
	const previousTheme = getActiveTheme().mode;
	setActiveTheme('dark');
	let refresh!: () => void;
	function Harness() {
		const [, setRevision] = useState(0);
		refresh = () => setRevision(value => value + 1);
		return (
			<SelectField
				label="自动更新"
				value="yes"
				options={[
					{value: 'yes', label: '是'},
					{value: 'no', label: '否'}
				]}
				focused
				onChange={() => {}}
			/>
		);
	}
	const setup = await testRender(<Harness />, {width: 40, height: 5});
	try {
		for (const mode of ['dark', 'light', 'dark'] as const) {
			setActiveTheme(mode);
			await act(async () => refresh());
			await setup.renderOnce();
			const spans = setup.captureSpans().lines.flatMap(line => line.spans);
			const selected = spans.find(span => span.text.trim() === '是');
			expect(selected?.bg.toInts()).toEqual(RGBA.fromHex(colors.primary).toInts());
			expect(selected?.fg.toInts()).toEqual(RGBA.fromHex(colors.navSelectedForeground).toInts());
		}
	} finally {
		await act(async () => setup.renderer.destroy());
		setActiveTheme(previousTheme);
	}
});
