import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {render} from 'ink-testing-library';
import React from 'react';

// Phase 11E 回归门禁：P-11 强确认门控 + P-14 状态相关操作可用性（design TDR-11 / P-11 / P-14）。
// 分两层：
//   1. 状态机纯函数（tools-view-state reducer）：P-11 状态层守门 + P-14 操作可用性
//   2. 视图层 render（ToolsView + mock services/cache）：P-11 完整链路 + P-14 enterDefaultAction
// P-11 不变量：卸载强确认未通过时 SHALL NOT 执行任何卸载命令（uninstallComponent 零调用）。
// P-14 不变量：组件可用操作由状态推导——未安装仅 install；已安装仅 update(hasUpdate)/uninstall。

// ── 测试夹具：CCQ_HOME 隔离 + npm 缓存命中 TTL（避免真实联网）──────────────────
const home = mkdtempSync(join(tmpdir(), 'ccq-view-state-'));
process.env.CCQ_HOME = home;
mkdirSync(join(home, '.claude'), {recursive: true});
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({env: {}}), 'utf8');
writeFileSync(join(home, '.claude.json'), JSON.stringify({}), 'utf8');

const uid = process.getuid ? process.getuid() : process.pid;
const cacheDir = join(tmpdir(), `ccq-cache-${uid}`);
mkdirSync(cacheDir, {recursive: true});
writeFileSync(join(cacheDir, 'npm-outdated.json'), JSON.stringify({}), 'utf8');
writeFileSync(join(cacheDir, 'npm-view.json'), JSON.stringify({}), 'utf8');

const {
	createInitialToolsViewState,
	reduceToolsViewState,
	isUninstallConfirmed,
	selectedInstallTargets,
	updatableComponents
} = await import('../dist/state/tools-view-state.js');

// 构造 ManagedComponent 测试数据（字段对齐 ComponentDefinition + 检测填充）。
function makeComponent(overrides) {
	return {
		id: 'OpenSpec',
		name: 'OpenSpec',
		description: 'OpenSpec CLI',
		kind: 'npm',
		command: 'openspec',
		versionArgs: ['--version'],
		npmPackage: '@fission-ai/openspec',
		isBase: false,
		optional: true,
		installed: true,
		currentVersion: '1.0.0',
		latestVersion: '1.0.0',
		hasUpdate: false,
		...overrides
	};
}

const installedLatest = makeComponent({id: 'OpenSpec', name: 'OpenSpec', installed: true, hasUpdate: false});
const installedUpdatable = makeComponent({
	id: 'Ccline',
	name: 'Ccline',
	installed: true,
	currentVersion: '1.0.0',
	latestVersion: '2.0.0',
	hasUpdate: true
});
const notInstalled = makeComponent({
	id: 'CodexCli',
	name: 'CodexCli',
	installed: false,
	currentVersion: '',
	latestVersion: '',
	hasUpdate: null
});

// ── P-11 状态层：强确认门控（isUninstallConfirmed + confirm-uninstall reducer）────
{
	let state = createInitialToolsViewState();
	state = reduceToolsViewState(state, {type: 'components-loaded', components: [installedLatest]});
	state = reduceToolsViewState(state, {type: 'request-uninstall'}); // cursor=0 → OpenSpec
	assert.equal(state.mode, 'confirm-uninstall', 'request-uninstall 进 confirm-uninstall 模式');
	assert.equal(state.uninstallTarget, 'OpenSpec', 'uninstallTarget = cursor 组件 id');

	// 确认词不匹配 → isUninstallConfirmed=false
	state = reduceToolsViewState(state, {type: 'confirm-input', value: 'wrong'});
	assert.equal(isUninstallConfirmed(state), false, '确认词≠name → isUninstallConfirmed=false');

	// confirm-uninstall reducer：不匹配 → 不进 busy（mode 不变，busyAction 不设置，errorText 提示）
	const stateNoBusy = reduceToolsViewState(state, {type: 'confirm-uninstall'});
	assert.equal(stateNoBusy.mode, 'confirm-uninstall', 'P-11 不匹配时 mode 不变（不进 busy）');
	assert.equal(stateNoBusy.busyAction, undefined, 'P-11 不匹配时 busyAction 不设置');
	assert.match(stateNoBusy.errorText, /确认词不匹配/, 'P-11 不匹配时设置 errorText');

	// 确认词匹配（大小写不敏感）→ isUninstallConfirmed=true
	state = reduceToolsViewState(state, {type: 'confirm-input', value: 'openspec'});
	assert.equal(isUninstallConfirmed(state), true, '确认词大小写不敏感匹配 → true');

	// confirm-uninstall reducer：匹配 → 进 busy，busyAction=uninstall
	const stateBusy = reduceToolsViewState(state, {type: 'confirm-uninstall'});
	assert.equal(stateBusy.mode, 'busy', 'P-11 匹配时进 busy');
	assert.equal(stateBusy.busyAction, 'uninstall', 'P-11 匹配时 busyAction=uninstall');
	assert.equal(stateBusy.itemStatus['OpenSpec'], 'uninstalling', 'P-11 匹配时 itemStatus=uninstalling');
}
console.log('[PASS] P-11 状态层强确认门控（不匹配不进 busy / 匹配进 busy）');

// P-11 边界：无 uninstallTarget → isUninstallConfirmed=false
{
	const state = createInitialToolsViewState();
	assert.equal(isUninstallConfirmed(state), false, '无 uninstallTarget → false');
}
console.log('[PASS] P-11 isUninstallConfirmed 无目标边界');

// ── P-14：状态相关操作可用性 ────────────────────────────────────────────────────
// request-uninstall：未安装组件 → 不进 confirm，设 errorText（无卸载入口）
{
	let state = createInitialToolsViewState();
	state = reduceToolsViewState(state, {type: 'components-loaded', components: [notInstalled, installedLatest]});
	// cursor=0 → CodexCli (未安装)
	state = reduceToolsViewState(state, {type: 'request-uninstall'});
	assert.equal(state.mode, 'grid', 'P-14 未安装组件 request-uninstall 不进 confirm');
	assert.equal(state.uninstallTarget, undefined, 'P-14 未安装组件不设 uninstallTarget');
	assert.match(state.errorText, /未安装/, 'P-14 未安装组件设 errorText');
}
console.log('[PASS] P-14 未安装组件无卸载入口');

// request-uninstall：已安装组件 → 进 confirm
{
	let state = createInitialToolsViewState();
	state = reduceToolsViewState(state, {type: 'components-loaded', components: [installedLatest]});
	state = reduceToolsViewState(state, {type: 'request-uninstall'});
	assert.equal(state.mode, 'confirm-uninstall', 'P-14 已安装组件可进 confirm');
}
console.log('[PASS] P-14 已安装组件有卸载入口');

// toggle-select：已安装组件不可选（无重复 install 误导）
{
	let state = createInitialToolsViewState();
	state = reduceToolsViewState(state, {type: 'components-loaded', components: [installedLatest]});
	state = reduceToolsViewState(state, {type: 'toggle-select'});
	assert.equal(state.selected.length, 0, 'P-14 已安装组件不可多选（无 install 误导）');
}
console.log('[PASS] P-14 已安装组件不可多选');

// toggle-select：未安装组件可选
{
	let state = createInitialToolsViewState();
	state = reduceToolsViewState(state, {type: 'components-loaded', components: [notInstalled]});
	state = reduceToolsViewState(state, {type: 'toggle-select'});
	assert.equal(state.selected.includes('CodexCli'), true, 'P-14 未安装组件可多选');
}
console.log('[PASS] P-14 未安装组件可多选安装');

// selectedInstallTargets：仅返回 selected 中未安装的（已装项被过滤，避免重复 install）
{
	let state = createInitialToolsViewState();
	state = reduceToolsViewState(state, {type: 'components-loaded', components: [notInstalled, installedLatest]});
	state = {...state, selected: ['CodexCli', 'OpenSpec']};
	const targets = selectedInstallTargets(state);
	assert.deepEqual(targets, ['CodexCli'], 'P-14 selectedInstallTargets 仅未安装项');
}
console.log('[PASS] P-14 selectedInstallTargets 仅未安装');

// updatableComponents：仅 hasUpdate=true 且非进行中（未安装项不出现，无 update 误导）
{
	let state = createInitialToolsViewState();
	state = reduceToolsViewState(state, {
		type: 'components-loaded',
		components: [installedLatest, installedUpdatable, notInstalled]
	});
	const updatable = updatableComponents(state);
	assert.equal(updatable.length, 1, 'P-14 updatableComponents 仅可更新项');
	assert.equal(updatable[0].id, 'Ccline', 'P-14 updatableComponents = Ccline');
}
console.log('[PASS] P-14 updatableComponents 仅 hasUpdate=true');

// ── P-11 视图层 render：强确认守门 → uninstallComponent 零调用 / 匹配调用 ──────────
const {ToolsView} = await import('../dist/views/ToolsView.js');

function makeMockServices() {
	const uninstallCalls = [];
	const installCalls = [];
	const services = {
		detectComponents: async () => [installedLatest],
		installComponent: async id => {
			installCalls.push(id);
			return {id, success: true};
		},
		installMultiple: async ids => ids.map(id => ({id, success: true})),
		updateComponents: async () => ({snapshotPath: '/tmp/snap', updatedItems: []}),
		uninstallComponent: async id => {
			uninstallCalls.push(id);
			return {id, success: true};
		},
		createDetectionRunner: () => ({reset() {}, run() {}}),
		runDetection: async () => {}
	};
	return {services, uninstallCalls, installCalls};
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// P-11：不匹配确认词 → uninstallComponent 零调用（execCommand/fs.rm 零调用）
{
	const {services, uninstallCalls} = makeMockServices();
	const cache = {
		state: {status: 'success', result: [installedLatest]},
		refresh: () => {}
	};
	const {stdin, unmount} = render(React.createElement(ToolsView, {services, cache, active: true}));
	await wait(80); // 等 useEffect dispatch components-loaded

	stdin.write('u'); // request-uninstall（cursor=0 → OpenSpec installed）
	await wait(60);
	stdin.write('wrongword'); // 输入不匹配确认词
	await wait(60);
	stdin.write('\r'); // Enter（matched=false → 不调 runUninstall）
	await wait(80);

	assert.equal(uninstallCalls.length, 0, 'P-11 不匹配确认词 → uninstallComponent 零调用');
	unmount();
}
console.log('[PASS] P-11 视图层不匹配确认词 → uninstallComponent 零调用');

// P-11：匹配确认词 → uninstallComponent 被调用
{
	const {services, uninstallCalls} = makeMockServices();
	const cache = {
		state: {status: 'success', result: [installedLatest]},
		refresh: () => {}
	};
	const {stdin, unmount} = render(React.createElement(ToolsView, {services, cache, active: true}));
	await wait(80);

	stdin.write('u');
	await wait(60);
	stdin.write('OpenSpec'); // 输入匹配确认词（= 组件 name）
	await wait(60);
	stdin.write('\r'); // Enter（matched=true → runUninstall → uninstallComponent）
	await wait(100);

	assert.equal(uninstallCalls.length, 1, 'P-11 匹配确认词 → uninstallComponent 被调用');
	assert.equal(uninstallCalls[0], 'OpenSpec', 'P-11 卸载目标 = 聚焦组件');
	unmount();
}
console.log('[PASS] P-11 视图层匹配确认词 → uninstallComponent 被调用');

// P-14：已安装最新组件按 Enter → installComponent 零调用（无重复 install 误导，走 notice）
{
	const {services, installCalls} = makeMockServices();
	const cache = {
		state: {status: 'success', result: [installedLatest]},
		refresh: () => {}
	};
	const {stdin, unmount} = render(React.createElement(ToolsView, {services, cache, active: true}));
	await wait(80);

	stdin.write('\r'); // Enter（cursor=0 → OpenSpec installed & hasUpdate=false → notice）
	await wait(80);

	assert.equal(installCalls.length, 0, 'P-14 已安装最新组件按 Enter 不触发 install（无重复 install 误导）');
	unmount();
}
console.log('[PASS] P-14 已安装组件按 Enter 无重复 install 误导');

// P-14：未安装组件按 Enter → installComponent 被调用（未安装仅 install 入口）
{
	const {services, installCalls} = makeMockServices();
	const cache = {
		state: {status: 'success', result: [notInstalled]},
		refresh: () => {}
	};
	const {stdin, unmount} = render(React.createElement(ToolsView, {services, cache, active: true}));
	await wait(80);

	stdin.write('\r'); // Enter（cursor=0 → CodexCli 未安装 → installOne）
	await wait(100);

	assert.equal(installCalls.length, 1, 'P-14 未安装组件按 Enter 触发 install');
	assert.equal(installCalls[0], 'CodexCli', 'P-14 install 目标 = 聚焦未安装组件');
	unmount();
}
console.log('[PASS] P-14 未安装组件按 Enter 触发 install');

rmSync(home, {recursive: true, force: true});
console.log('[PASS] Phase 11E P-11/P-14 门禁全部通过');
