import assert from 'node:assert/strict';
import {createInitialManageState, menuItems, reduceManageState, selectedMenuItem} from '../dist/state/manage-state.js';

const keys = ['up', 'down', 'left', 'right', 'tab', 'shift-tab', 'enter', 'escape', 'ctrl-s', 'q', 'other'];

// 初始状态不变量
let state = createInitialManageState();
assert.equal(state.focus, 'nav');
assert.equal(state.selectedIndex, 0);
assert.equal(selectedMenuItem(state).label, '供应商');
assert.equal(menuItems.length, 6, '工具安装/检查更新合并后菜单应为 6 项');

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

for (const seed of seeds) {
	const rng = makeRng(seed);
	let s = createInitialManageState();
	for (let i = 0; i < stepsPerSeed; i++) {
		const key = keys[rng() % keys.length];
		s = reduceManageState(s, key);
		assert.ok(s.selectedIndex >= 0, `seed ${seed} step ${i}: selectedIndex 下界越界: ${s.selectedIndex}`);
		assert.ok(s.selectedIndex < menuItems.length, `seed ${seed} step ${i}: selectedIndex 上界越界: ${s.selectedIndex}`);
		assert.ok(['nav', 'view', 'form', 'modal'].includes(s.focus), `seed ${seed} step ${i}: 未知焦点状态: ${s.focus}`);
		assert.ok(s.eventLog.length <= 6, `seed ${seed} step ${i}: 事件日志未裁剪: ${s.eventLog.length}`);
		if (s.shouldExit) {
			s = createInitialManageState();
		}
		totalSteps++;
	}
}

// 孤立 Esc 回归（nodejs/node#38663/#49588）：从 view 返回 nav，nav 下不挂起
let escState = reduceManageState(reduceManageState(createInitialManageState(), 'enter'), 'escape');
assert.equal(escState.focus, 'nav', '孤立 Esc 应从 view 返回 nav');
escState = reduceManageState(reduceManageState(escState, 'tab'), 'escape');
assert.equal(escState.focus, 'nav', 'nav 下孤立 Esc 不应挂起或越界');

console.log(`[PASS] Manage TUI 状态机 PBT 门禁通过（${seeds.length} 种子 × ${stepsPerSeed} 轮 = ${totalSteps} 步随机序列）`);
