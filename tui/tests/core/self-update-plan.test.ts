import {afterEach, beforeEach, expect, test} from 'bun:test';
import {runUpdate} from '../../src/cli/commands/update.js';
import {checkLatestVersion, formatSelfUpdateError, type SelfUpdatePlan} from '../../src/core/self-update.js';
import {isSelfUpdateCancellable, reduceSelfUpdateScreen} from '../../src/state/self-update-state.js';
import {createTempHome, type TempHome} from '../helpers/temp-home.js';

// checkLatestVersion 的 fetch 依赖类型是 Bun 的 `typeof fetch`（含 preconnect）；
// 测试只注入返回 Response 的 seam，用本包装收窄调用点类型。
type CheckDeps = Omit<NonNullable<Parameters<typeof checkLatestVersion>[0]>, 'fetch'> & {
	readonly fetch?: () => Response | Promise<Response>;
};

function checkLatest(deps: CheckDeps) {
	return checkLatestVersion(deps as unknown as Parameters<typeof checkLatestVersion>[0]);
}

// P5a 迁移自 scripts/verify-self-update.mjs 的纯段（48 条静态断言）：
//   - 版本比较 / Release plan / gzip transport 优先级 / Release API 错误分类与脱敏（21）
//   - semver 防降级 + Release plan 严格校验（7）
//   - 自更新状态机 reducer 与失败重试阶段（13）
//   - ccq update CLI 下载进度条（7）
// 真实落盘字节 / 真实解压 / 严格 Range 续传 / 缓存 lease/TTL / POSIX 原子应用 /
// Windows helper 契约仍留在 scripts/verify-self-update.mjs。

// checkLatestVersion 内部会调用 cleanupTransportCache()（真实 fs，路径由 CCQ_HOME 决定）；
// 用临时 home 隔离，避免触碰真实用户目录。
let tempHome: TempHome;
beforeEach(() => {
	tempHome = createTempHome('ccq-self-update-plan-');
});
afterEach(() => {
	tempHome.restore();
	tempHome.cleanup();
});

const platformAsset = {
	name: 'ccq-macos-arm64',
	browser_download_url: 'https://example.invalid/ccq',
	size: 10,
	digest: `sha256:${'a'.repeat(64)}`
};

const gzipAsset = {
	name: 'ccq-macos-arm64.gz',
	browser_download_url: 'https://example.invalid/ccq.gz',
	size: 4,
	digest: `sha256:${'b'.repeat(64)}`
};

function releaseFetch(version: string, asset?: unknown) {
	return async () =>
		new Response(JSON.stringify({tag_name: `v${version}`, assets: asset ? [asset] : []}), {
			status: 200,
			headers: {'content-type': 'application/json'}
		});
}

function rawOnlyPlan(expectedSize: number): SelfUpdatePlan {
	const asset = Object.freeze({
		assetName: 'ccq-macos-arm64',
		downloadUrl: 'https://example.invalid/ccq',
		expectedSize,
		expectedSha256: 'a'.repeat(64)
	});
	return Object.freeze({
		version: '2.5.0',
		target: asset,
		transports: Object.freeze([Object.freeze({...asset, encoding: 'identity' as const})])
	});
}

test('Release API 错误分类与安全建议', async () => {
	const downgrade = await checkLatest({
		fetch: releaseFetch('2.3.1', platformAsset),
		currentVersion: '2.4.0-beta.1',
		platform: 'darwin',
		arch: 'arm64'
	});
	expect(downgrade, '较新 prerelease 不得被旧 stable 降级').toEqual({
		ok: true,
		hasUpdate: false,
		currentVersion: '2.4.0-beta.1',
		latestVersion: '2.3.1'
	});

	const upgrade = await checkLatest({
		fetch: releaseFetch('2.5.0', platformAsset),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'arm64'
	});
	expect(upgrade.ok && upgrade.hasUpdate).toBe(true);
	if (!upgrade.ok || !upgrade.hasUpdate) throw new Error('expected update plan');
	expect(Object.isFrozen(upgrade.plan), 'SelfUpdatePlan 运行时也必须不可变').toBe(true);
	expect(upgrade.plan, '无 gzip 资产时 plan 只含 target 与 identity transport').toEqual({
		version: '2.5.0',
		target: {
			assetName: platformAsset.name,
			downloadUrl: platformAsset.browser_download_url,
			expectedSize: platformAsset.size,
			expectedSha256: 'a'.repeat(64)
		},
		transports: [
			{
				assetName: platformAsset.name,
				downloadUrl: platformAsset.browser_download_url,
				expectedSize: platformAsset.size,
				expectedSha256: 'a'.repeat(64),
				encoding: 'identity'
			}
		]
	});

	// 有 gzip 资产：优先 gzip transport，raw 保留为回退 target。
	const withGzip = await checkLatest({
		fetch: async () =>
			new Response(JSON.stringify({tag_name: 'v2.5.0', assets: [platformAsset, gzipAsset]}), {
				status: 200,
				headers: {'content-type': 'application/json'}
			}),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'arm64'
	});
	expect(withGzip.ok && withGzip.hasUpdate).toBe(true);
	expect(
		withGzip.ok && withGzip.hasUpdate ? withGzip.plan.transports.map(t => [t.encoding, t.assetName]) : null,
		'gzip 必须排在 identity 之前，target 仍是 raw'
	).toEqual([
		['gzip', 'ccq-macos-arm64.gz'],
		['identity', 'ccq-macos-arm64']
	]);
	expect(withGzip.ok && withGzip.hasUpdate ? withGzip.plan.target.assetName : '', 'target 必须始终是 raw 可执行文件').toBe(
		'ccq-macos-arm64'
	);

	// gzip 元数据无效必须被忽略，raw 直升不受影响（旧 Release/回滚兼容）。
	const badGzip = await checkLatest({
		fetch: async () =>
			new Response(JSON.stringify({tag_name: 'v2.5.0', assets: [platformAsset, {...gzipAsset, digest: undefined}]}), {
				status: 200,
				headers: {'content-type': 'application/json'}
			}),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'arm64'
	});
	expect(
		badGzip.ok && badGzip.hasUpdate ? badGzip.plan.transports.map(t => t.encoding) : null,
		'无效 gzip 元数据必须被忽略，仅保留 identity transport'
	).toEqual(['identity']);

	// Release API 错误：分类、建议与不可信正文隔离。
	const rateLimitedCheck = await checkLatest({
		fetch: async () =>
			new Response(JSON.stringify({message: 'API rate limit exceeded for 203.0.113.7'}), {
				status: 403,
				headers: {
					'content-type': 'application/json',
					'x-ratelimit-remaining': '0'
				}
			}),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'arm64'
	});
	expect(rateLimitedCheck.ok).toBe(false);
	const rateLimitedMessage = rateLimitedCheck.ok ? '' : formatSelfUpdateError(rateLimitedCheck.error);
	expect(rateLimitedMessage).toMatch(/GitHub API 请求额度已用完/);
	expect(rateLimitedMessage).toMatch(/未认证请求按出口 IP 计数/);
	expect(rateLimitedMessage).toMatch(/HTTP 403/);
	expect(rateLimitedMessage, 'GitHub 响应正文不得原样进入用户错误').not.toMatch(/203\.0\.113\.7/);

	const proxyBlockedCheck = await checkLatest({
		fetch: async () =>
			new Response('<html>Access Denied proxy-secret-marker</html>', {
				status: 403,
				headers: {'content-type': 'text/html', server: 'example-gateway'}
			}),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'arm64'
	});
	expect(proxyBlockedCheck.ok).toBe(false);
	const proxyBlockedMessage = proxyBlockedCheck.ok ? '' : formatSelfUpdateError(proxyBlockedCheck.error);
	expect(proxyBlockedMessage).toMatch(/代理或网络网关拒绝了 GitHub 请求/);
	expect(proxyBlockedMessage).toMatch(/切换代理节点或启用 TUN/);
	expect(proxyBlockedMessage, '代理 HTML 正文不得进入用户错误').not.toMatch(/proxy-secret-marker/);

	const serviceUnavailableCheck = await checkLatest({
		fetch: async () => new Response('upstream internal marker', {status: 503}),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'arm64'
	});
	expect(serviceUnavailableCheck.ok).toBe(false);
	const serviceUnavailableMessage = serviceUnavailableCheck.ok ? '' : formatSelfUpdateError(serviceUnavailableCheck.error);
	expect(serviceUnavailableMessage).toMatch(/GitHub 服务暂时不可用/);
	expect(serviceUnavailableMessage).toMatch(/稍后重新检查更新/);
	expect(serviceUnavailableMessage).not.toMatch(/upstream internal marker/);
});

test('semver 防降级 + Release plan 严格校验', async () => {
	const prereleaseNumericUpgrade = await checkLatest({
		fetch: releaseFetch('2.4.0-beta.10', platformAsset),
		currentVersion: '2.4.0-beta.2',
		platform: 'darwin',
		arch: 'arm64'
	});
	expect(prereleaseNumericUpgrade.ok && prereleaseNumericUpgrade.hasUpdate, 'prerelease 数字段必须按数值比较：beta.10 > beta.2').toBe(
		true
	);

	const buildMetadataEqual = await checkLatest({
		fetch: releaseFetch('2.4.0+release', platformAsset),
		currentVersion: '2.4.0+local',
		platform: 'darwin',
		arch: 'arm64'
	});
	expect(buildMetadataEqual.ok && buildMetadataEqual.hasUpdate, 'build metadata 不参与版本优先级').toBe(false);

	const missingDigest = await checkLatest({
		fetch: releaseFetch('2.5.0', {...platformAsset, digest: undefined}),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'arm64'
	});
	expect(missingDigest.ok, '缺 digest 必须 fail closed').toBe(false);

	for (const [label, asset] of [
		['缺 asset', undefined],
		['size=0', {...platformAsset, size: 0}],
		['size 非整数', {...platformAsset, size: 1.5}],
		['digest 算法错误', {...platformAsset, digest: `sha512:${'a'.repeat(64)}`}],
		['digest 长度错误', {...platformAsset, digest: `sha256:${'a'.repeat(63)}`}]
	] as const) {
		const invalidRelease = await checkLatest({
			fetch: releaseFetch('2.5.0', asset),
			currentVersion: '2.4.0',
			platform: 'darwin',
			arch: 'arm64'
		});
		expect(invalidRelease.ok, `${label} 必须在 check 阶段 fail closed`).toBe(false);
	}

	const unsupportedArch = await checkLatest({
		fetch: releaseFetch('2.5.0', platformAsset),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'ia32'
	});
	expect(unsupportedArch.ok, '未知架构不得回退 x64').toBe(false);

	for (const [platform, arch, assetName] of [
		['win32', 'x64', 'ccq-windows-x64.exe'],
		['win32', 'arm64', 'ccq-windows-arm64.exe'],
		['darwin', 'x64', 'ccq-macos-x64'],
		['darwin', 'arm64', 'ccq-macos-arm64']
	] as const) {
		const raw = {...platformAsset, name: assetName, browser_download_url: `https://example.invalid/${assetName}`};
		const gzip = {...gzipAsset, name: `${assetName}.gz`, browser_download_url: `https://example.invalid/${assetName}.gz`};
		const selected = await checkLatest({
			fetch: async () =>
				new Response(JSON.stringify({tag_name: 'v2.5.0', assets: [raw, gzip]}), {
					status: 200,
					headers: {'content-type': 'application/json'}
				}),
			currentVersion: '2.4.0',
			platform,
			arch
		});
		expect(selected.ok && selected.hasUpdate, `${platform}/${arch} 必须可选择 Release asset`).toBe(true);
		expect(
			selected.ok && selected.hasUpdate ? selected.plan.transports.map(item => item.assetName) : [],
			`${platform}/${arch} 必须使用 gzip 优先 + raw 回退`
		).toEqual([`${assetName}.gz`, assetName]);
	}
});

test('自更新状态机 reducer：下载 / 取消 / 应用与失败重试阶段', () => {
	const planTotal = 10;
	const plan = rawOnlyPlan(planTotal);
	const transport = plan.transports[0]!;
	const stateTransaction = Object.freeze({
		plan,
		targetPath: '/tmp/ccq',
		tempPath: '/tmp/.ccq.update-state.tmp'
	});

	let screen = reduceSelfUpdateScreen({kind: 'checking'}, {type: 'updateAvailable', plan});
	screen = reduceSelfUpdateScreen(screen, {type: 'downloadStarted', plan});
	expect(isSelfUpdateCancellable(screen)).toBe(true);
	if (!isSelfUpdateCancellable(screen)) throw new Error('expected cancellable downloading state');
	expect(screen.progress, '初始进度总量必须来自首选 transport').toEqual({
		downloadedBytes: 0,
		totalBytes: planTotal,
		percentage: 0,
		assetName: transport.assetName,
		encoding: 'identity'
	});
	screen = reduceSelfUpdateScreen(screen, {
		type: 'downloadProgress',
		progress: {
			downloadedBytes: planTotal,
			totalBytes: planTotal,
			percentage: 100,
			assetName: transport.assetName,
			encoding: 'identity'
		}
	});
	expect(isSelfUpdateCancellable(screen) ? screen.progress.percentage : -1, '下载进度 action 必须更新屏幕状态').toBe(100);
	screen = reduceSelfUpdateScreen(screen, {type: 'cancelRequested'});
	expect(screen.kind === 'updating' ? screen.stage : '', '取消后进入 cancelling 阶段').toBe('cancelling');
	screen = reduceSelfUpdateScreen(screen, {type: 'downloadReady', transaction: stateTransaction});
	screen = reduceSelfUpdateScreen(screen, {type: 'applyStarted', transaction: stateTransaction});
	expect(isSelfUpdateCancellable(screen), 'applying 阶段不可取消').toBe(false);
	expect(reduceSelfUpdateScreen(screen, {type: 'cancelRequested'}), 'applying 阶段的 cancel action 必须保持原状态').toBe(screen);
	screen = reduceSelfUpdateScreen(screen, {type: 'applyCompleted', version: plan.version});
	expect(screen).toEqual({kind: 'updated', version: plan.version});

	// 失败态必须携带可重试阶段：Enter 重试而非只能关闭。
	for (const [label, retry] of [
		['check', {stage: 'check'}],
		['download', {stage: 'download', plan}],
		['apply', {stage: 'apply', transaction: stateTransaction}]
	] as const) {
		const failed = reduceSelfUpdateScreen({kind: 'checking'}, {type: 'failed', message: `${label} 阶段失败`, retry});
		expect(failed.kind).toBe('error');
		if (failed.kind !== 'error') throw new Error('expected error state');
		expect(failed.retry, `${label} 失败态必须保留重跑该阶段所需的完整入参`).toEqual(retry);
	}
	const recheckedAfterFailure = reduceSelfUpdateScreen(
		{kind: 'error', message: 'check 阶段失败', retry: {stage: 'check'}},
		{type: 'checkStarted'}
	);
	expect(recheckedAfterFailure, '失败态必须可离开 error 屏重新进入检查').toEqual({kind: 'checking'});
	const redownloadedAfterFailure = reduceSelfUpdateScreen(
		{kind: 'error', message: 'download 阶段失败', retry: {stage: 'download', plan}},
		{type: 'downloadStarted', plan}
	);
	expect(isSelfUpdateCancellable(redownloadedAfterFailure), '失败后重新下载必须回到可取消的 downloading 状态').toBe(true);
	if (!isSelfUpdateCancellable(redownloadedAfterFailure)) throw new Error('expected cancellable retry state');
	expect(redownloadedAfterFailure.progress.downloadedBytes, '重试下载必须从 0 字节重新计量进度').toBe(0);
	expect(redownloadedAfterFailure.progress.totalBytes, '重试下载总量仍为首选 transport 字节数').toBe(planTotal);
});

test('ccq update CLI 下载进度条', async () => {
	const plan = rawOnlyPlan(10);
	const transport = plan.transports[0]!;
	const cliTransaction = Object.freeze({plan, targetPath: '/tmp/ccq.exe', tempPath: '/tmp/.ccq.exe.update-test.tmp'});
	const checkResult = () => ({
		ok: true as const,
		hasUpdate: true as const,
		currentVersion: '2.4.0',
		latestVersion: plan.version,
		plan
	});

	let downloadCalls = 0;
	const originalCheckOnlyLog = console.log;
	let checkOnlyCode = -1;
	console.log = () => {};
	try {
		checkOnlyCode = await runUpdate(true, {
			check: async () => checkResult(),
			download: async () => {
				downloadCalls++;
				return {ok: true, transaction: cliTransaction};
			}
		});
	} finally {
		console.log = originalCheckOnlyLog;
	}
	expect(checkOnlyCode).toBe(0);
	expect(downloadCalls, '--check 必须保持零下载').toBe(0);

	const applyOptionsSeen: {readonly restartAfterApply?: boolean}[] = [];
	const cliOutput: string[] = [];
	const cliProgressOutput: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => cliOutput.push(args.join(' '));
	try {
		const updateCode = await runUpdate(false, {
			check: async () => checkResult(),
			download: async (_plan, _signal, options) => {
				options?.onProgress?.({
					downloadedBytes: 5,
					totalBytes: 10,
					percentage: 50,
					assetName: transport.assetName,
					encoding: transport.encoding
				});
				return {ok: true, transaction: cliTransaction};
			},
			apply: async (_transaction, options) => {
				applyOptionsSeen.push(options ?? {});
				return {ok: true, state: 'scheduled', targetPath: '/tmp/ccq.exe', restartStarted: false};
			},
			progressOutput: {isTTY: true, write: text => cliProgressOutput.push(text)}
		});
		expect(updateCode).toBe(0);
	} finally {
		console.log = originalLog;
	}
	expect(applyOptionsSeen[0]?.restartAfterApply, 'CLI update 必须显式禁止 helper 重启 TUI').toBe(false);
	expect(cliOutput.some(line => line.includes('已安排更新'))).toBe(true);
	expect(cliOutput.some(line => line.includes('替换并重启'))).toBe(false);
	expect(cliProgressOutput.join('')).toMatch(/\r\[============------------\]\s+50%\s+5 B \/ 10 B\s+raw\n/);
});
