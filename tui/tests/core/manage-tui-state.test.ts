import {describe, expect, test} from 'bun:test';
import {
	AGENT_CONTEXT_LABELS,
	AGENT_CONTEXT_ORDER,
	createInitialManageState,
	menuItems,
	nextAgentContext,
	previousAgentContext,
	reduceManageState,
	selectedMenuItem
} from '../../src/state/manage-state.js';
import {agentCycleShortcuts, headerShortcuts, navShortcuts, viewShortcuts} from '../../src/state/shortcuts.js';
import {createTuiExitController} from '../../src/core/tui-exit.js';

// P5d 迁移自 scripts/verify-manage-tui-state.mjs 的纯段（45 条静态断言）。
// 判据：reducer / menuItems / agentContext 循环 / 退出控制器均为进程内纯逻辑（退出控制器用注入的
// exit 回调 + fake renderer，无真实进程退出）。源码文本正则段（11 条 Tools/MCP/Skills 隐藏 Header +
// 3 条 index/app 源码契约）按静态契约判据保留在 verify。

const keys = ['up', 'down', 'left', 'right', 'tab', 'shift-tab', 'enter', 'escape', 'ctrl-s', 'q', 'other'] as const;

describe('Manage TUI 初始状态不变量', () => {
	test('启动即聚焦右侧视图 + 7 菜单', () => {
		const state = createInitialManageState();
		expect(state.focus, '启动即聚焦右侧视图（首个菜单工具管理），无需先按 enter').toBe('view');
		expect(state.selectedIndex).toBe(0);
		expect(selectedMenuItem(state).label).toBe('工具管理');
		expect(menuItems.length, '工具管理/供应商/配置文件/全局规则/MCP/Skills/扩展管理共 7 项菜单（检查更新为底部按钮不计入）').toBe(7);
	});
});

describe('2.1/2.2 默认 Claude Code + agentContext=cc + 7 菜单顺序恒定', () => {
	test('默认 agentContext 与菜单顺序', () => {
		const state = createInitialManageState();
		expect(state.agentContext, '默认 agentContext 为 cc（Claude Code）').toBe('cc');
		expect(
			menuItems.map(item => item.id),
			'7 菜单顺序固定：工具管理/供应商/配置文件/全局规则/MCP/Skills/扩展管理'
		).toEqual(['tools', 'provider', 'config', 'prompts', 'mcp', 'skills', 'extensions']);
	});
});

describe('2.3 Header 全称标签（Claude Code / Codex，无 cc/cx 缩写）', () => {
	test('Agent 上下文顺序与可见标签', () => {
		expect(AGENT_CONTEXT_ORDER, 'Agent 上下文顺序：cc → cx → pi').toEqual(['cc', 'cx', 'pi']);
		expect(AGENT_CONTEXT_LABELS.cc, 'cc 可见标签为全称 Claude Code').toBe('Claude Code');
		expect(AGENT_CONTEXT_LABELS.cx, 'cx 可见标签为全称 Codex').toBe('Codex');
		expect(AGENT_CONTEXT_LABELS.pi, 'pi 可见标签为 Pi').toBe('Pi');
		for (const ctx of AGENT_CONTEXT_ORDER) {
			const label = AGENT_CONTEXT_LABELS[ctx];
			expect(Boolean(label && label.length > 0), `${ctx} 标签非空`).toBe(true);
			if (ctx !== 'pi') expect(/^(cc|cx)$/i.test(label), `Header 可见标签不得为内部缩写: ${label}`).toBe(false);
		}
	});
});

describe('2.5 Header 焦点切换：上键进入 + 左右循环 + 菜单顺序/选中不变', () => {
	test('焦点/agentContext 循环与菜单顺序不变量', () => {
		let s = createInitialManageState();
		const beforeSel = s.selectedIndex;
		const initialMenuIds = menuItems.map(item => item.id);
		s = reduceManageState(s, 'up' as never);
		expect(s.focus, 'view 上键应进入 Agent Header').toBe('header');
		s = reduceManageState(s, 'right' as never);
		expect(s.agentContext, 'Header 右键从 cc 切换到 cx').toBe('cx');
		expect(s.selectedIndex, '切换后左侧菜单选中项不变').toBe(beforeSel);
		expect(
			menuItems.map(item => item.id),
			'切换后 7 菜单顺序不变'
		).toEqual(initialMenuIds);
		s = reduceManageState(s, 'left' as never);
		expect(s.agentContext, 'Header 左键从 cx 循环回 cc').toBe('cc');
		s = reduceManageState(s, 'down' as never);
		expect(s.focus, 'Header 下键应返回右侧视图').toBe('view');
		s = reduceManageState(reduceManageState(s, 'up' as never), 'escape' as never);
		expect(s.focus, 'Header Esc 应返回右侧视图').toBe('view');
		expect(nextAgentContext('cc'), 'nextAgentContext: cc → cx').toBe('cx');
		expect(nextAgentContext('cx'), 'nextAgentContext: cx → pi').toBe('pi');
		expect(nextAgentContext('pi'), 'nextAgentContext: pi → cc').toBe('cc');
		expect(previousAgentContext('cc'), 'previousAgentContext: cc → pi').toBe('pi');
		expect(previousAgentContext('pi'), 'previousAgentContext: pi → cx').toBe('cx');
	});
});

describe('2.6 footer 不展示 Agent 项，Header 快捷键数据源保留', () => {
	test('footer 与 Header 快捷键派生', () => {
		const navKeys = navShortcuts().map(sc => sc.label);
		expect(
			navKeys.some(label => /Agent|Claude Code|Codex/.test(label)),
			'nav footer 不展示 Agent 切换项'
		).toBe(false);
		const viewKeys = viewShortcuts('tools', '').map(sc => sc.label);
		expect(
			viewKeys.some(label => /Agent|Claude Code|Codex/.test(label)),
			'view footer 不展示 Agent 切换项'
		).toBe(false);
		const cycleKeys = agentCycleShortcuts().map(sc => sc.key);
		const headerKeyTokens = headerShortcuts().flatMap(sc => sc.key.split('/'));
		expect(cycleKeys, 'agentCycleShortcuts 派生 Header 左右循环键位').toEqual(['←', '→']);
		expect(headerKeyTokens.includes('↓'), 'Header footer 派生下键返回视图').toBe(true);
		expect(headerKeyTokens.includes('Esc'), 'Header footer 派生 Esc 返回视图').toBe(true);
	});
});

// 种子化伪随机（LCG）：固定种子保证可复现，多种子覆盖多样 key 序列
function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		return s;
	};
}

const seeds = [1, 7, 42, 1337, 99991, 2654435761];
const stepsPerSeed = 600;

describe('Manage TUI 状态机 PBT 门禁（6 种子 × 600 轮）', () => {
	test('任意键序列后状态边界与菜单顺序恒定', () => {
		const validAgentContexts = new Set(AGENT_CONTEXT_ORDER);
		const initialMenuIds = menuItems.map(item => item.id);
		for (const seed of seeds) {
			const rng = makeRng(seed);
			let s2 = createInitialManageState();
			for (let i = 0; i < stepsPerSeed; i++) {
				const key = keys[rng() % keys.length];
				s2 = reduceManageState(s2, key as never);
				expect(s2.selectedIndex >= 0, `seed ${seed} step ${i}: selectedIndex 下界越界: ${s2.selectedIndex}`).toBe(true);
				expect(s2.selectedIndex <= menuItems.length, `seed ${seed} step ${i}: selectedIndex 上界越界: ${s2.selectedIndex}`).toBe(
					true
				);
				expect(
					['nav', 'header', 'view', 'form', 'modal'].includes(s2.focus),
					`seed ${seed} step ${i}: 未知焦点状态: ${s2.focus}`
				).toBe(true);
				expect(validAgentContexts.has(s2.agentContext), `seed ${seed} step ${i}: agentContext 越界: ${s2.agentContext}`).toBe(true);
				expect(s2.eventLog.length <= 6, `seed ${seed} step ${i}: 事件日志未裁剪: ${s2.eventLog.length}`).toBe(true);
				expect(
					menuItems.map(item => item.id),
					`seed ${seed} step ${i}: 菜单顺序被改变`
				).toEqual(initialMenuIds);
				if (s2.shouldExit) {
					s2 = createInitialManageState();
				}
			}
		}
	});

	test('底部检查更新按钮导航位可达', () => {
		let btnState = createInitialManageState();
		for (let i = 0; i < menuItems.length; i++) btnState = reduceManageState(btnState, 'down' as never);
		expect(btnState.selectedIndex, '从首项按下 N 次应到达底部按钮位').toBe(menuItems.length);
		expect(selectedMenuItem(btnState).id, '底部按钮 id 为 update').toBe('update');
	});

	test('孤立 Esc 从 view 返回 nav，nav 下不挂起', () => {
		let escState = reduceManageState(createInitialManageState(), 'escape' as never);
		expect(escState.focus, '孤立 Esc 应从 view 返回 nav').toBe('nav');
		escState = reduceManageState(reduceManageState(escState, 'tab' as never), 'escape' as never);
		expect(escState.focus, 'nav 下孤立 Esc 不应挂起或越界').toBe('nav');
	});
});

describe('TUI 退出在 renderer 清理后显式结束 ccq 进程', () => {
	test('退出控制器只在 renderer 完成 destroy 后结束进程', () => {
		const exitCodes: number[] = [];
		let destroyCalls = 0;
		const exitController = createTuiExitController(code => exitCodes.push(code));
		const fakeRenderer = {
			destroy() {
				destroyCalls++;
			}
		};
		exitController.handleRendererDestroyed();
		expect(exitCodes, '非退出场景的 renderer destroy 不得结束进程').toEqual([]);
		exitController.requestExit(fakeRenderer as never);
		expect(destroyCalls, '退出请求必须先销毁 renderer').toBe(1);
		expect(exitCodes, 'renderer 尚未完成 destroy 时不得提前结束进程').toEqual([]);
		exitController.handleRendererDestroyed();
		expect(exitCodes, 'renderer 清理完成后必须显式以 0 结束进程').toEqual([0]);
		exitController.requestExit(fakeRenderer as never);
		expect(destroyCalls, '重复退出请求不得重复销毁 renderer').toBe(1);
		expect(exitCodes, '重复退出请求不得重复结束进程').toEqual([0]);
	});
});
