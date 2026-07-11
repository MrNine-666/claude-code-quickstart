import assert from 'node:assert/strict';
import {
	AGENT_CONTEXT_LABELS,
	AGENT_CONTEXT_ORDER,
	createInitialManageState,
	menuItems,
	nextAgentContext,
	previousAgentContext,
	reduceManageState,
	selectedMenuItem
} from '../src/state/manage-state.ts';
import {navShortcuts, viewShortcuts, agentCycleShortcuts, headerShortcuts} from '../src/state/shortcuts.ts';

const keys = ['up', 'down', 'left', 'right', 'tab', 'shift-tab', 'enter', 'escape', 'ctrl-s', 'q', 'other'];

// 初始状态不变量
let state = createInitialManageState();
assert.equal(state.focus, 'view', '启动即聚焦右侧视图（首个菜单工具管理），无需先按 enter');
assert.equal(state.selectedIndex, 0);
assert.equal(selectedMenuItem(state).label, '工具管理');
assert.equal(menuItems.length, 6, '工具管理/供应商/配置文件/全局规则/MCP/Skills 共 6 项菜单（检查更新为底部按钮不计入）');

// ── Phase 2：agentContext Header 不变量（tasks 2.1/2.2/2.3/2.5/2.6）──────────────
// 2.1/2.2 默认 Claude Code + agentContext=cc + 6 菜单顺序恒定
assert.equal(state.agentContext, 'cc', '默认 agentContext 为 cc（Claude Code）');
const initialMenuIds = menuItems.map(item => item.id);
assert.deepEqual(
	initialMenuIds,
	['tools', 'provider', 'config', 'prompts', 'mcp', 'skills'],
	'6 菜单顺序固定：工具管理/供应商/配置文件/全局规则/MCP/Skills'
);
console.log('[PASS] 2.1/2.2 默认 Claude Code + agentContext=cc + 6 菜单顺序恒定');

// 2.3 Header 全称标签：Claude Code / Codex，禁止 cc/cx 缩写作为可见标签
assert.deepEqual(AGENT_CONTEXT_ORDER, ['cc', 'cx'], 'Agent 上下文顺序：cc → cx');
assert.equal(AGENT_CONTEXT_LABELS.cc, 'Claude Code', 'cc 可见标签为全称 Claude Code');
assert.equal(AGENT_CONTEXT_LABELS.cx, 'Codex', 'cx 可见标签为全称 Codex');
for (const ctx of AGENT_CONTEXT_ORDER) {
	const label = AGENT_CONTEXT_LABELS[ctx];
	assert.ok(label && label.length > 2, `${ctx} 标签非空且非缩写`);
	assert.equal(/^(cc|cx)$/i.test(label), false, `Header 可见标签不得为 cc/cx 缩写: ${label}`);
}
console.log('[PASS] 2.3 Header 全称标签（Claude Code / Codex，无 cc/cx 缩写）');

// 2.5 Header 焦点切换：view 上键进入 Header，Header 左右循环 Agent，菜单顺序/选中不变
let s = createInitialManageState();
const beforeSel = s.selectedIndex;
s = reduceManageState(s, 'up');
assert.equal(s.focus, 'header', 'view 上键应进入 Agent Header');
s = reduceManageState(s, 'right');
assert.equal(s.agentContext, 'cx', 'Header 右键从 cc 切换到 cx');
assert.equal(s.selectedIndex, beforeSel, '切换后左侧菜单选中项不变');
assert.deepEqual(menuItems.map(item => item.id), initialMenuIds, '切换后 6 菜单顺序不变');
s = reduceManageState(s, 'left');
assert.equal(s.agentContext, 'cc', 'Header 左键从 cx 循环回 cc');
s = reduceManageState(s, 'down');
assert.equal(s.focus, 'view', 'Header 下键应返回右侧视图');
s = reduceManageState(reduceManageState(s, 'up'), 'escape');
assert.equal(s.focus, 'view', 'Header Esc 应返回右侧视图');
assert.equal(nextAgentContext('cc'), 'cx', 'nextAgentContext: cc → cx');
assert.equal(nextAgentContext('cx'), 'cc', 'nextAgentContext: cx → cc');
assert.equal(previousAgentContext('cc'), 'cx', 'previousAgentContext: cc → cx');
assert.equal(previousAgentContext('cx'), 'cc', 'previousAgentContext: cx → cc');
console.log('[PASS] 2.5 Header 焦点切换：上键进入 + 左右循环 + 菜单顺序/选中不变');

// 2.6 footer 不展示 Agent 切换项；Agent 快捷键仅由 Header 提示，避免 footer 溢出。
const navKeys = navShortcuts().map(sc => sc.label);
assert.equal(navKeys.some(label => /Agent|Claude Code|Codex/.test(label)), false, 'nav footer 不展示 Agent 切换项');
const viewKeys = viewShortcuts('tools', '').map(sc => sc.label);
assert.equal(viewKeys.some(label => /Agent|Claude Code|Codex/.test(label)), false, 'view footer 不展示 Agent 切换项');
const cycleKeys = agentCycleShortcuts().map(sc => sc.key);
const headerKeyTokens = headerShortcuts().flatMap(sc => sc.key.split('/'));
assert.deepEqual(cycleKeys, ['←', '→'], 'agentCycleShortcuts 派生 Header 左右循环键位');
assert.ok(headerKeyTokens.includes('↓'), 'Header footer 派生下键返回视图');
assert.ok(headerKeyTokens.includes('Esc'), 'Header footer 派生 Esc 返回视图');
console.log('[PASS] 2.6 footer 不展示 Agent 项，Header 快捷键数据源保留');

// 种子化伪随机（LCG）：固定种子保证可复现，多种子覆盖多样 key 序列
function makeRng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		return s;
	};
}

const seeds = [1, 7, 42, 1337, 99991, 2654435761];
const stepsPerSeed = 600;
let totalSteps = 0;
const validAgentContexts = new Set(AGENT_CONTEXT_ORDER);

for (const seed of seeds) {
	const rng = makeRng(seed);
	let s2 = createInitialManageState();
	for (let i = 0; i < stepsPerSeed; i++) {
		const key = keys[rng() % keys.length];
		s2 = reduceManageState(s2, key);
		assert.ok(s2.selectedIndex >= 0, `seed ${seed} step ${i}: selectedIndex 下界越界: ${s2.selectedIndex}`);
		assert.ok(s2.selectedIndex <= menuItems.length, `seed ${seed} step ${i}: selectedIndex 上界越界: ${s2.selectedIndex}`);
		assert.ok(['nav', 'header', 'view', 'form', 'modal'].includes(s2.focus), `seed ${seed} step ${i}: 未知焦点状态: ${s2.focus}`);
		assert.ok(validAgentContexts.has(s2.agentContext), `seed ${seed} step ${i}: agentContext 越界: ${s2.agentContext}`);
		assert.ok(s2.eventLog.length <= 6, `seed ${seed} step ${i}: 事件日志未裁剪: ${s2.eventLog.length}`);
		// Header 切换不改菜单顺序（PBT 不变量：任意键序列后 menuItems 顺序恒定）
		assert.deepEqual(menuItems.map(item => item.id), initialMenuIds, `seed ${seed} step ${i}: 菜单顺序被改变`);
		if (s2.shouldExit) {
			s2 = createInitialManageState();
		}
		totalSteps++;
	}
}

// 底部「检查更新」按钮导航位可达：从首项按下 menuItems.length 次到达按钮位（index === menuItems.length）
let btnState = createInitialManageState();
for (let i = 0; i < menuItems.length; i++) btnState = reduceManageState(btnState, 'down');
assert.equal(btnState.selectedIndex, menuItems.length, '从首项按下 N 次应到达底部按钮位');
assert.equal(selectedMenuItem(btnState).id, 'update', '底部按钮 id 为 update');

// 孤立 Esc 回归（nodejs/node#38663/#49588）：从 view 返回 nav，nav 下不挂起
// 初始已在 view，按 escape 应回到 nav（无需先 enter）
let escState = reduceManageState(createInitialManageState(), 'escape');
assert.equal(escState.focus, 'nav', '孤立 Esc 应从 view 返回 nav');
escState = reduceManageState(reduceManageState(escState, 'tab'), 'escape');
assert.equal(escState.focus, 'nav', 'nav 下孤立 Esc 不应挂起或越界');

console.log(`[PASS] Manage TUI 状态机 PBT 门禁通过（${seeds.length} 种子 × ${stepsPerSeed} 轮 = ${totalSteps} 步随机序列）`);

// ── Tools 隐藏 Header（shared-resource-injection-ui Task 2.1/2.2/2.3）───────────
// Header 隐藏与顶行 ↑ 停首项在 App 层/ToolsView 落地（reducer 与菜单无关），断言源码契约：
//   1) app.tsx：displayMenuId==='tools' 不渲染 AgentHeader，且 header 焦点被 coerce 回 view；
//   2) ToolsView：顶行 ↑ 不再调用 onExitToHeader（已移除该 prop）。
const {readFileSync} = await import('node:fs');
const appSrc = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const toolsSrc = readFileSync(new URL('../src/views/ToolsView.tsx', import.meta.url), 'utf8');

assert.match(appSrc, /toolsModuleActive\s*\?\s*null\s*:\s*\(\s*<AgentHeader/, 'Tools 模块不渲染 AgentHeader');
assert.match(appSrc, /displayMenuId === 'tools' && state\.focus === 'header'/, 'Tools 下 header 焦点被 coerce 回 view');
assert.match(appSrc, /toolsModuleActive\s*\?\s*0\s*:\s*AGENT_HEADER_ROWS/, 'Tools 隐藏 Header 时不预留 Header 行');
assert.doesNotMatch(toolsSrc, /onExitToHeader/, 'ToolsView 不得再引用 onExitToHeader（顶行 ↑ 停首项，不进 header）');
assert.doesNotMatch(appSrc, /<ToolsView[^>]*onExitToHeader/, 'app.tsx 渲染 ToolsView 时不得再传 onExitToHeader');
console.log('[PASS] Tools 模块隐藏 Agent Header + 顶行 ↑ 停首项（不进 header）');
