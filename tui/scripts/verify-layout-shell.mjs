import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

// Layout shell 回归门禁（P1-G1 静态断言治理后）：
// - Agent Header 投影/宽度、active layout 边框、Config split 等分与溢出收缩、全局 busy
//   蒙层的源码结构不变量已并入 scripts/verify-view-architecture.mjs（P1-G1b 段）；
// - 本脚本只保留 layout active 边框接线与旧 ProgressLog 组件文件删除两条静态契约。
//
// [P5d 迁走] busyActionTitle 纯投影 + BusyOverlay 真实渲染段（7 条）→
//   tests/components/layout-shell.test.tsx（R10：固定 40×16 尺寸，finally 的 act() 内 destroy）。
// 判据：其余两条为源码文本正则（app.tsx 三个 activeBorderChars 接线）与真实 fs 存在性，
// 去掉源码 / fs 后不成立，按静态契约判据留 verify。

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');

assert.equal(
	(appSource.match(/customBorderChars=\{[^}]*activeBorderChars[^}]*\}/g) ?? []).length,
	3,
	'侧边栏、content 卡片、AgentHeader 三个 layout active 边框都应使用 activeBorderChars'
);
assert.equal(existsSync(new URL('../src/components/progress-log.tsx', import.meta.url)), false, '旧 ProgressLog 组件文件必须删除');

console.log('[PASS] layout shell：边框接线 + 旧 ProgressLog 组件删除（busy overlay 渲染见 tests/components/layout-shell.test.tsx）');
