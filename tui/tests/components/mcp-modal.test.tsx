import {act, useState} from 'react';
import {KeyEvent, type ParsedKey} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import type {McpSharedRow} from '../../src/core/mcp.js';
import {AGENT_CONTEXT_ORDER} from '../../src/state/manage-state.js';
import {McpHomeView, type McpHomeMode} from '../../src/views/mcp/McpHomeView.js';
import {moveMcpGridCursor} from '../../src/views/mcp/mcp-view-actions.js';

// P2b 载体迁移：verify-mcp-shared-projection.mjs 第 6 段 testRender 断言。
//   1) MCP 网格首行并排显示两个 Server 卡片（(1/N) 起点）；
//   2) 下键移动到下一行同列（计数跳到 (3/N)）；
//   3) 目标 Modal 打开后上下键只移动 Modal 目标，不穿透背景 MCP 列表。
// 载体：tests/components（真实 OpenTUI 渲染 + 键盘交互）；固定 80x24，
// 并在 finally 的 act() 内销毁 setup.renderer。

function inject(overrides: Partial<McpSharedRow['injectByAgent']['cc']> = {}): McpSharedRow['injectByAgent']['cc'] {
	return {active: false, disabled: false, supported: true, ...overrides};
}

const ROWS: readonly McpSharedRow[] = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(Id => ({
	Id,
	Name: Id,
	McpType: 'stdio',
	HasCredentials: false,
	hasDefinition: true,
	injectByAgent: {
		cc: inject({active: Id === 'alpha'}),
		cx: inject({active: Id === 'beta'}),
		pi: inject({supported: false, reason: 'adapter-not-installed'})
	}
}));

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

// 与 McpView 相同的选择态接线：list 模式的方向键走 moveMcpGridCursor，
// Modal 模式的方向键走 toggleIndex，两条输入链路互不串线。
function McpHarness({mode, initialIndex = 0}: {readonly mode: McpHomeMode; readonly initialIndex?: number}) {
	const [selected, setSelected] = useState(initialIndex);
	const [toggleIndex, setToggleIndex] = useState(0);
	return (
		<McpHomeView
			rows={ROWS}
			selectedIndex={selected}
			current={ROWS[selected] ?? null}
			mode={mode}
			active
			toggleDraft={{cc: false, cx: false, pi: false}}
			toggleIndex={toggleIndex}
			onMove={delta => setSelected(previous => moveMcpGridCursor(previous, ROWS.length, delta < 0 ? 'up' : 'down'))}
			onMoveHorizontal={direction => setSelected(previous => moveMcpGridCursor(previous, ROWS.length, direction))}
			onMoveToggle={delta => setToggleIndex(previous => (previous + delta + AGENT_CONTEXT_ORDER.length) % AGENT_CONTEXT_ORDER.length)}
			onOpenToggle={() => {}}
			onAdd={() => {}}
			onEdit={() => {}}
			onDelete={() => {}}
			onExit={() => {}}
			onToggleDraft={() => {}}
			onApplyToggle={() => {}}
			onCancelModal={() => {}}
			onConfirmRemove={() => {}}
		/>
	);
}

function renderHarness(mode: McpHomeMode, initialIndex = 0) {
	return testRender(<McpHarness mode={mode} initialIndex={initialIndex} />, {width: 80, height: 24});
}

async function pressDown(setup: Awaited<ReturnType<typeof renderHarness>>): Promise<void> {
	await act(async () => {
		setup.renderer.keyInput.emit('keypress', key('down'));
		await setup.renderOnce();
	});
}

describe('MCP 网格与目标 Modal 输入隔离', () => {
	test('MCP 网格首行并排显示两个 Server 卡片', async () => {
		const setup = await renderHarness('list');
		try {
			const frame = await setup.waitForFrame(output => /\(1\/\d+\)/.test(output));
			const firstRow = frame.split('\n').find(line => line.includes('alpha') && line.includes('beta'));
			expect(firstRow).toBeDefined();
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('MCP 网格下键移动到下一行同列', async () => {
		const setup = await renderHarness('list');
		try {
			await setup.waitForFrame(output => /\(1\/\d+\)/.test(output));
			await pressDown(setup);
			const selectedFrame = await setup.waitForFrame(output => /\(3\/\d+\)/.test(output));
			expect(selectedFrame).toMatch(/\(3\/5\)/);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('Modal 上下键只移动 Modal 目标，不穿透背景列表', async () => {
		const setup = await renderHarness('select-toggle-target', 2);
		try {
			const modalOpenFrame = await setup.waitForFrame(output => output.includes('管理开关'));
			const backgroundCounter = modalOpenFrame.match(/\(3\/5\)/)?.[0] ?? '';
			expect(backgroundCounter).toBe('(3/5)');
			await pressDown(setup);
			const modalFrame = await setup.waitForFrame(output => output.includes('Codex'));
			expect(modalFrame).toContain(backgroundCounter);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
