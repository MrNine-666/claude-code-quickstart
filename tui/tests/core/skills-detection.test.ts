import {describe, expect, test} from 'bun:test';
import {detectInstalledSkillItems, type InstalledSkillItem} from '../../src/core/skills-installed.js';
import type {DetectionState} from '../../src/services/async-detection.js';
import {createSkillsDetectionRunner} from '../../src/services/view-detection.js';

// 载体迁移（P3a）：原 scripts/verify-skills-view.mjs 的 7.10 段（8 条静态断言）迁入。
// owner 模块：services/view-detection.ts（skills 检测状态机）。
// 覆盖：进行中不重复触发底层检测，loading → success/error 迁移与 reset。

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`缺少 ${label}`);
	return value;
}

describe('Skills 异步检测状态机（services/view-detection.ts）', () => {
	test('7.10 异步检测进行中不重复触发，loading → success/error 正确迁移', async () => {
		let runCount = 0;
		const states: DetectionState<readonly InstalledSkillItem[]>[] = [];
		const okExec = async () => {
			runCount++;
			return {
				code: 0,
				stdout: JSON.stringify([
					{name: 'installed-x', path: '/home/.agents/skills/installed-x', scope: 'global', agents: ['Codex']}
				]),
				stderr: ''
			};
		};
		const runner = createSkillsDetectionRunner(state => states.push(state));
		const first = runner.run(() => detectInstalledSkillItems(okExec));
		const second = await runner.run(() => detectInstalledSkillItems(okExec));
		expect(second.status, '检测进行中第二次触发应复用 loading').toBe('loading');
		const final = await first;
		expect(final.status).toBe('success');
		expect(required(final.result?.[0], 'final.result[0]').name).toBe('installed-x');
		expect(runCount, '进行中不得重复触发底层检测').toBe(1);
		expect(states.map(state => state.status)).toEqual(['loading', 'success']);

		const errStates: DetectionState<readonly InstalledSkillItem[]>[] = [];
		const errRunner = createSkillsDetectionRunner(state => errStates.push(state));
		const failed = await errRunner.run(async () => {
			throw new Error('npx 不可用');
		});
		expect(failed.status).toBe('error');
		expect(failed.error).toBe('npx 不可用');
		const reset = errRunner.reset();
		expect(reset.status).toBe('idle');
	});
});
