import {describe, expect, test} from 'bun:test';
import {createStagedUpdateExit} from '../../src/core/staged-update-exit.js';
import type {DownloadedSelfUpdate, SelfUpdatePlan} from '../../src/core/self-update.js';

// 统一退出生命周期门禁：q 与更新弹窗共享同一入口；有已验证下载必须先应用再退出；
// 应用失败不退出、不误报；重复请求/迟到 settle 不得 double-apply 或 double-exit。

const plan: SelfUpdatePlan = {
	version: '2.5.0',
	target: {
		assetName: 'ccq-macos-arm64',
		downloadUrl: 'https://example.invalid/ccq',
		expectedSize: 10,
		expectedSha256: 'a'.repeat(64)
	},
	transports: []
};

const transaction: DownloadedSelfUpdate = {plan, targetPath: '/tmp/ccq', tempPath: '/tmp/ccq.tmp'};

describe('staged-update-exit：单一退出入口', () => {
	test('无 staged 直接退出，重复请求只退出一次', () => {
		let exits = 0;
		const coordinator = createStagedUpdateExit({apply: async () => true, onExit: () => (exits += 1)});
		expect(coordinator.hasStaged()).toBe(false);
		coordinator.requestExit();
		coordinator.requestExit();
		expect(exits).toBe(1);
		expect(coordinator.isExitRequested()).toBe(true);
	});

	test('有 staged：先 apply 再 onExit，且事务被领取清空', async () => {
		const events: string[] = [];
		const coordinator = createStagedUpdateExit({
			apply: async received => {
				events.push(`apply:${received.plan.version}`);
				return true;
			},
			onExit: () => events.push('exit')
		});
		coordinator.setStaged(transaction);
		expect(coordinator.hasStaged()).toBe(true);
		coordinator.requestExit();
		expect(coordinator.isExitRequested()).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(events, 'apply 必须先于 onExit').toEqual(['apply:2.5.0', 'exit']);
		expect(coordinator.hasStaged(), '事务必须被领取清空，防止二次覆盖').toBe(false);
	});

	test('apply 失败：不退出、释放闩锁，用户放弃后再次退出直接走 onExit', async () => {
		let exits = 0;
		let applyCalls = 0;
		const coordinator = createStagedUpdateExit({
			apply: async () => {
				applyCalls += 1;
				return false;
			},
			onExit: () => (exits += 1)
		});
		coordinator.setStaged(transaction);
		coordinator.requestExit();
		await Promise.resolve();
		await Promise.resolve();
		expect(applyCalls).toBe(1);
		expect(exits, '应用失败不得退出或谎报成功').toBe(0);
		expect(coordinator.hasStaged(), '失败后清空 staged 以便重试/放弃').toBe(false);
		expect(coordinator.isExitRequested(), '失败后释放闩锁允许重试').toBe(false);

		coordinator.requestExit();
		expect(exits, '放弃更新时无 staged 直接退出').toBe(1);
	});

	test('应用进行中的重复 requestExit 不得 double-apply', async () => {
		let applyCalls = 0;
		let exits = 0;
		const pending: {resolve?: (value: boolean) => void} = {};
		const coordinator = createStagedUpdateExit({
			apply: () =>
				new Promise<boolean>(resolve => {
					applyCalls += 1;
					pending.resolve = resolve;
				}),
			onExit: () => (exits += 1)
		});
		coordinator.setStaged(transaction);
		coordinator.requestExit();
		coordinator.requestExit();
		coordinator.requestExit();
		expect(applyCalls).toBe(1);
		pending.resolve?.(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(exits).toBe(1);
	});
});
