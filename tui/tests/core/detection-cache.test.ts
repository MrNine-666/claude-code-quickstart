import {describe, expect, test} from 'bun:test';
import {refreshDetectionRunner} from '../../src/hooks/use-detection-cache.js';
import type {DetectionRunner} from '../../src/services/detection-runner.js';

// A 类改写（P1-G3）：verify-tools-manage.mjs
//   137 useDetectionCache「仅在服务提供 refreshDetection 时消费 refresh options」
//   138 useDetectionCache「无 refreshDetection 时不把 options 误传给 runDetection」

function fakeRunner(): DetectionRunner<string> {
	let state: {status: string} = {status: 'idle'};
	return {
		getState: () => state as never,
		reset: () => {
			state = {status: 'idle'};
			return state as never;
		},
		async run() {
			return state as never;
		}
	};
}

describe('refreshDetectionRunner 手动刷新路径', () => {
	test('服务提供 refreshDetection 时消费 refresh options，不再回落到 runDetection', async () => {
		const runner = fakeRunner();
		const calls: unknown[] = [];
		await refreshDetectionRunner(
			{
				createDetectionRunner() {
					throw new Error('不应创建 runner');
				},
				async runDetection() {
					calls.push('runDetection');
				},
				async refreshDetection(received, options) {
					calls.push(['refreshDetection', received === runner, options]);
				}
			},
			runner,
			{forceRefresh: true}
		);

		expect(calls).toEqual([['refreshDetection', true, {forceRefresh: true}]]);
	});

	test('无 refreshDetection 时只调用 runDetection，不把 options 误传', async () => {
		const runner = fakeRunner();
		const calls: unknown[] = [];
		await refreshDetectionRunner(
			{
				createDetectionRunner() {
					throw new Error('不应创建 runner');
				},
				async runDetection(received) {
					calls.push(['runDetection', received === runner]);
				}
			},
			runner,
			{forceRefresh: true}
		);

		expect(calls).toEqual([['runDetection', true]]);
	});
});
