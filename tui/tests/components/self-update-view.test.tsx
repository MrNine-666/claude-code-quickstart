import {act} from 'react';
import {KeymapProvider} from '@opentui/keymap/react';
import {createTestKeymap} from '@opentui/keymap/testing';
import {testRender} from '@opentui/react/test-utils';
import {expect, test} from 'bun:test';
import {UpdateDialog, UpdateProgressBar} from '../../src/app.js';
import type {SelfUpdatePlan} from '../../src/core/self-update.js';

// P5a 迁移自 scripts/verify-self-update.mjs 的 render 段（12 条静态断言）：
//   - OpenTUI 更新错误 / 最新 / fallback 交互真实渲染与按键（9）
//   - OpenTUI 更新进度条真实渲染（2）
//   - error modal Enter 必须真实触发 retry（1，见下）
// 每个 testRender 用例固定 terminal 尺寸，并在 finally 的 act() 内销毁 renderer。
// 真实 fs / 子进程段（含失效 apply 事务引导重下载）仍留在 scripts/verify-self-update.mjs。

const fallbackPlan: SelfUpdatePlan = {
	version: '2.5.0',
	target: {
		assetName: 'ccq-macos-arm64',
		downloadUrl: 'https://example.invalid/ccq',
		expectedSize: 10,
		expectedSha256: 'a'.repeat(64)
	},
	transports: [
		{
			assetName: 'ccq-macos-arm64.gz',
			downloadUrl: 'https://example.invalid/ccq.gz',
			expectedSize: 4,
			expectedSha256: 'b'.repeat(64),
			encoding: 'gzip'
		},
		{
			assetName: 'ccq-macos-arm64',
			downloadUrl: 'https://example.invalid/ccq',
			expectedSize: 10,
			expectedSha256: 'a'.repeat(64),
			encoding: 'identity'
		}
	]
};

type KeymapProp = Parameters<typeof KeymapProvider>[0]['keymap'];
const keymapProp = (harness: ReturnType<typeof createTestKeymap>): KeymapProp => harness.keymap as unknown as KeymapProp;

const noop = () => {};

test('OpenTUI 更新进度条真实渲染', async () => {
	const setup = await testRender(
		<UpdateProgressBar
			progress={{downloadedBytes: 5, totalBytes: 10, percentage: 50, assetName: 'ccq-macos-arm64', encoding: 'identity'}}
		/>,
		{width: 40, height: 4}
	);
	try {
		const frame = await setup.waitForFrame(output => output.includes('50%'));
		expect(frame, '进度条必须使用固定 24 列轨道展示 50%').toMatch(/\[============------------\]\s+50%/);
		expect(frame, '进度条必须展示已下载与总字节').toMatch(/5 B \/ 10 B/);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('OpenTUI 更新错误交互真实渲染与按键', async () => {
	const harness = createTestKeymap({defaultKeys: true});
	let retryCount = 0;
	let closeCount = 0;
	const setup = await testRender(
		<KeymapProvider keymap={keymapProp(harness)}>
			<UpdateDialog
				active
				onClose={() => {
					closeCount += 1;
				}}
				onUpdate={noop}
				onApplyUpdate={noop}
				onCancelUpdate={noop}
				onExit={noop}
				onRetry={() => {
					retryCount += 1;
				}}
				screen={{
					kind: 'error',
					message: '检查更新失败：GitHub 拒绝了版本检查请求（HTTP 403）\n建议：切换代理节点后重试',
					retry: {stage: 'check'}
				}}
			/>
		</KeymapProvider>,
		{width: 72, height: 12}
	);
	try {
		const errorFrame = await setup.waitForFrame(frame => frame.includes('重新检查更新'));
		expect(errorFrame, '错误弹窗应直接展示阶段错误').toMatch(/✗ 检查更新失败/);
		expect(errorFrame, '错误弹窗应展示可执行建议').toMatch(/建议：切换代理节点后重试/);
		expect(errorFrame, '错误弹窗不得重复“更新失败”前缀').not.toMatch(/✗ 更新失败：检查更新失败/);
		await act(async () => {
			harness.host.press('enter');
			await setup.renderOnce();
		});
		expect(retryCount, 'error modal Enter 必须真实触发 retry').toBe(1);
		expect(closeCount, 'error modal Enter 不得误关闭').toBe(0);
		await act(async () => {
			harness.host.press('escape');
			await setup.renderOnce();
		});
		expect(closeCount, 'error modal Esc 必须真实触发关闭').toBe(1);
	} finally {
		await act(async () => setup.renderer.destroy());
		harness.cleanup();
	}
});

test('OpenTUI 更新最新态不得永久显示处理中', async () => {
	const harness = createTestKeymap({defaultKeys: true});
	const setup = await testRender(
		<KeymapProvider keymap={keymapProp(harness)}>
			<UpdateDialog
				active
				onClose={noop}
				onUpdate={noop}
				onApplyUpdate={noop}
				onCancelUpdate={noop}
				onExit={noop}
				onRetry={noop}
				screen={{kind: 'latest'}}
			/>
		</KeymapProvider>,
		{width: 48, height: 8}
	);
	try {
		const latestFrame = await setup.waitForFrame(frame => frame.includes('已是最新版本'));
		expect(latestFrame, 'check retry 返回无更新时 modal 不得永久显示处理中').not.toMatch(/处理中/);
	} finally {
		await act(async () => setup.renderer.destroy());
		harness.cleanup();
	}
});

test('OpenTUI 更新完成态 Enter 退出而非关闭浮窗', async () => {
	const harness = createTestKeymap({defaultKeys: true});
	let closeCount = 0;
	let exitCount = 0;
	const setup = await testRender(
		<KeymapProvider keymap={keymapProp(harness)}>
			<UpdateDialog
				active
				onClose={() => {
					closeCount += 1;
				}}
				onUpdate={noop}
				onApplyUpdate={noop}
				onCancelUpdate={noop}
				onExit={() => {
					exitCount += 1;
				}}
				onRetry={noop}
				screen={{kind: 'updated', version: '2.5.0'}}
			/>
		</KeymapProvider>,
		{width: 64, height: 8}
	);
	try {
		const updatedFrame = await setup.waitForFrame(frame => frame.includes('更新已应用'));
		expect(updatedFrame, '更新完成态必须提示 Enter 退出').toMatch(/Enter\s+退出/);
		const closeCountBeforeExit = closeCount;
		await act(async () => {
			harness.host.press('enter');
			await setup.renderOnce();
		});
		expect(exitCount, '更新完成态 Enter 必须退出 TUI，不得重启 ccq').toBe(1);
		expect(closeCount, '更新完成态 Enter 不得只关闭浮窗').toBe(closeCountBeforeExit);
	} finally {
		await act(async () => setup.renderer.destroy());
		harness.cleanup();
	}
});

test('OpenTUI 更新 gzip→raw 回退提示真实渲染', async () => {
	const harness = createTestKeymap({defaultKeys: true});
	const setup = await testRender(
		<KeymapProvider keymap={keymapProp(harness)}>
			<UpdateDialog
				active
				onClose={noop}
				onUpdate={noop}
				onApplyUpdate={noop}
				onCancelUpdate={noop}
				onExit={noop}
				onRetry={noop}
				screen={{
					kind: 'updating',
					stage: 'downloading',
					plan: fallbackPlan,
					progress: {
						downloadedBytes: 1,
						totalBytes: 10,
						percentage: 1,
						assetName: fallbackPlan.target.assetName,
						encoding: 'identity'
					}
				}}
			/>
		</KeymapProvider>,
		{width: 64, height: 12}
	);
	try {
		await setup.waitForFrame(frame => frame.includes('已回退 raw 完整包'));
	} finally {
		await act(async () => setup.renderer.destroy());
		harness.cleanup();
	}
});
