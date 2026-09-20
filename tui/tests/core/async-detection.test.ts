import {describe, expect, test} from 'bun:test';
import {createInitialDetectionState, reduceDetectionState, shouldStartDetection} from '../../src/services/async-detection.js';
import {createDetectionRunner, type DetectionRunner} from '../../src/services/detection-runner.js';
import {refreshDetectionRunner} from '../../src/hooks/use-detection-cache.js';

// P5d 迁移自 scripts/verify-async-detection.mjs（19 条静态断言，整体迁移，脚本删除）。
// 判据：全部为 reducer / runner 状态机的进程内行为，runner 的时钟与任务均注入，无真实 fs / 子进程 / 渲染。
// R9：refreshDetectionRunner 的「手动刷新路径」另有 tests/core/detection-cache.test.ts 覆盖
// （refreshDetection vs runDetection 分支选择）；本文件覆盖其返回值与 cache sink 一致性（不重复迁移分支选择）。

describe('并发异步检测 reducer', () => {
	test('idle → loading → success / error 状态迁移', () => {
		const idle = createInitialDetectionState<string[]>();
		expect(idle.status).toBe('idle');
		expect(shouldStartDetection(idle)).toBe(true);

		const loading = reduceDetectionState(idle, {type: 'start', now: 1});
		expect(loading.status).toBe('loading');
		expect(loading.startedAt).toBe(1);
		expect(shouldStartDetection(loading)).toBe(false);
		expect(reduceDetectionState(loading, {type: 'start', now: 2}), 'loading 中不得重复触发检测').toBe(loading);

		const success = reduceDetectionState(loading, {type: 'success', now: 3, result: ['ok']});
		expect(success.status).toBe('success');
		expect(success.result).toEqual(['ok']);
		expect(success.finishedAt).toBe(3);

		const failed = reduceDetectionState(loading, {type: 'error', now: 4, error: new Error('boom')});
		expect(failed.status).toBe('error');
		expect(failed.error).toBe('boom');
	});
});

describe('并发异步检测 runner', () => {
	test('并发中的第二次 run 复用 loading，最终以首个结果收敛', async () => {
		let ticks = 10;
		const states: {status: string}[] = [];
		const runner = createDetectionRunner(
			createInitialDetectionState<string>(),
			state => {
				states.push(state as {status: string});
			},
			() => ticks++
		);
		const first = runner.run(async () => 'first');
		const second = await runner.run(async () => 'second');
		expect(second.status, '并发中的第二次 run 应复用 loading 状态').toBe('loading');
		const final = await first;
		expect(final.status).toBe('success');
		expect(final.result).toBe('first');
		expect(states.map(state => state.status)).toEqual(['loading', 'success']);
	});
});

describe('可等待刷新与 cache sink 一致', () => {
	test('refreshDetectionRunner 返回 runner 最终状态对象，且与 sink 写入一致', async () => {
		let refreshedState: unknown;
		const refreshRunner = createDetectionRunner({status: 'success', result: ['stale']} as never, state => {
			refreshedState = state;
		});
		const refreshed = await refreshDetectionRunner(
			{
				createDetectionRunner: () => refreshRunner,
				runDetection: (runner: DetectionRunner<string[]>) => runner.run(async () => ['fresh'])
			} as never,
			refreshRunner,
			{forceRefresh: true}
		);
		expect(refreshed, '可等待刷新应返回该 runner 的最终状态对象').toBe(refreshRunner.getState());
		expect(refreshed, '可等待刷新返回值应与写入 cache sink 的状态一致').toBe(refreshedState as never);
		expect(refreshed.status).toBe('success');
		expect(refreshed.result).toEqual(['fresh']);
	});
});
