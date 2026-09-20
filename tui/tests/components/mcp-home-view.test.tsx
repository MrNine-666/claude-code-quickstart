import {act} from 'react';
import {KeyEvent, type ParsedKey} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import type {McpSharedRow} from '../../src/core/mcp.js';
import {McpHomeView, type McpHomeMode, type McpHomeViewProps} from '../../src/views/mcp/McpHomeView.js';

// A 类改写（P1-G3）：verify-mcp-shared-projection.mjs 源码正则段
//   132 unsupported badge 只展示 Agent 名称
//   133 卡片不得把 Pi 扩展原因挤进内容
//   134 MCP Enter 弹窗提示先安装 Pi adapter 扩展
//   135/140 列表与目标 Modal 的输入处理器只在对应模式生效

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

const row: McpSharedRow = {
	Id: 'alpha',
	Name: 'alpha',
	McpType: 'http',
	HasCredentials: false,
	hasDefinition: true,
	injectByAgent: {
		cc: {active: true, disabled: false, supported: true},
		cx: {active: false, disabled: false, supported: true},
		pi: {active: false, disabled: false, supported: false, reason: 'adapter-not-installed'}
	}
};

function renderHome(mode: McpHomeMode, handlers: Partial<McpHomeViewProps> = {}) {
	return testRender(
		<McpHomeView
			rows={[row]}
			selectedIndex={0}
			current={row}
			mode={mode}
			active
			toggleDraft={{cc: true, cx: false, pi: false}}
			toggleIndex={0}
			onMove={handlers.onMove ?? (() => {})}
			onMoveHorizontal={handlers.onMoveHorizontal ?? (() => {})}
			onOpenToggle={handlers.onOpenToggle ?? (() => {})}
			onAdd={handlers.onAdd ?? (() => {})}
			onEdit={handlers.onEdit ?? (() => {})}
			onDelete={handlers.onDelete ?? (() => {})}
			onExit={handlers.onExit ?? (() => {})}
			onMoveToggle={handlers.onMoveToggle ?? (() => {})}
			onToggleDraft={handlers.onToggleDraft ?? (() => {})}
			onApplyToggle={handlers.onApplyToggle ?? (() => {})}
			onCancelModal={handlers.onCancelModal ?? (() => {})}
			onConfirmRemove={handlers.onConfirmRemove ?? (() => {})}
		/>,
		{width: 80, height: 24}
	);
}

describe('McpHomeView unsupported badge 与输入隔离', () => {
	test('unsupported badge 只展示 Agent 名称，不把 Pi 扩展原因写进卡片', async () => {
		const setup = await renderHome('list');
		try {
			const frame = await setup.waitForFrame(output => output.includes('alpha'));
			expect(frame).toContain('⊘ Pi');
			expect(frame).not.toContain('adapter-not-installed');
			expect(frame).not.toContain('需先安装');
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('目标 Modal 提示先安装 Pi adapter 扩展', async () => {
		const setup = await renderHome('select-toggle-target');
		try {
			const frame = await setup.waitForFrame(output => output.includes('管理开关'));
			expect(frame).toContain('需先安装 pi-mcp-adapter 扩展');
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('list 模式下上下键只移动背景列表', async () => {
		const moves: number[] = [];
		const modalMoves: number[] = [];
		const setup = await renderHome('list', {
			onMove: delta => moves.push(delta),
			onMoveToggle: delta => modalMoves.push(delta)
		});
		try {
			await setup.renderOnce();
			await act(async () => {
				setup.renderer.keyInput.emit('keypress', key('down'));
				await setup.renderOnce();
			});
			expect(moves).toEqual([1]);
			expect(modalMoves).toEqual([]);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('select-toggle-target 模式下上下键只移动 Modal 目标，不穿透背景列表', async () => {
		const moves: number[] = [];
		const modalMoves: number[] = [];
		const setup = await renderHome('select-toggle-target', {
			onMove: delta => moves.push(delta),
			onMoveToggle: delta => modalMoves.push(delta)
		});
		try {
			await setup.waitForFrame(output => output.includes('管理开关'));
			await act(async () => {
				setup.renderer.keyInput.emit('keypress', key('down'));
				await setup.renderOnce();
			});
			expect(modalMoves).toEqual([1]);
			expect(moves).toEqual([]);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
