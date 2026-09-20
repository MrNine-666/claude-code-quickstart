import {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import type {KeyEvent} from '@opentui/core';
import {Spinner, busyActionTitle} from '../../src/components/spinner.js';

// P5d 迁移自 scripts/verify-layout-shell.mjs 的 busy overlay 段（7 条静态断言：2 纯投影 + 5 真实渲染）。
// 判据：busyActionTitle 为纯函数；BusyOverlay 段断言真实渲染帧的换行、窄终端不溢出与 Esc 取消行为，
// 去掉真实渲染后不成立，按 R10 归位 tests/components（固定尺寸 40×16，finally 的 act() 内 destroy）。
// 保留在 verify 的 2 条为静态契约（app.tsx 三个 layout active 边框接线正则 + 旧 ProgressLog 组件文件缺席）。

describe('busyActionTitle 纯投影', () => {
	test('update / install 动作标题', () => {
		expect(busyActionTitle('update', '工具')).toBe('正在更新工具');
		expect(busyActionTitle('install', ' Skill')).toBe('正在安装 Skill');
	});
});

describe('BusyOverlay 真实渲染', () => {
	test('窄终端完整展示真实指令、不横向溢出，Esc 只发一次取消意图并隐藏 overlay', async () => {
		let cancelCount = 0;
		const setup = await testRender(
			<Spinner
				variant="overlay"
				label="正在更新工具"
				message="CodeGraph · npm install -g @acme/codegraph"
				terminalWidth={40}
				onCancel={() => {
					cancelCount += 1;
				}}
			/>,
			{width: 40, height: 16}
		);
		try {
			const frame = await setup.waitForFrame(value => value.includes('正在更新工具') && value.includes('npm install'));
			expect(frame, 'BusyOverlay 第二行必须展示外部组件上报的当前真实指令').toMatch(/CodeGraph · npm install -g/);
			expect(frame, 'BusyOverlay 必须完整保留窄终端中换行后的命令参数').toMatch(/@acme\/codegraph/);
			expect(
				frame.split('\n').every(line => line.length <= 40),
				'BusyOverlay 在窄终端不得横向溢出'
			).toBe(true);
			await act(async () => {
				setup.renderer.keyInput.emit('keypress', {
					name: 'escape',
					sequence: '\u001b',
					ctrl: false,
					shift: false,
					meta: false,
					option: false,
					eventType: 'press',
					repeated: false
				} as unknown as KeyEvent);
				await setup.renderOnce();
			});
			const cancelledFrame = await setup.waitForFrame(value => !value.includes('正在更新工具'));
			expect(cancelCount, 'Spinner Esc 只向父组件发送一次取消意图').toBe(1);
			expect(cancelledFrame.includes('Esc 取消任务'), 'Spinner Esc 后应立即隐藏 overlay').toBe(false);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
