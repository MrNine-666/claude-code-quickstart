import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const tempHome = mkdtempSync(join(tmpdir(), 'ccq-self-update-'));
process.env.CCQ_HOME = tempHome;

function sha256(content) {
	return createHash('sha256').update(content).digest('hex');
}

function releaseFetch(version, asset) {
	return async () => new Response(JSON.stringify({
		tag_name: `v${version}`,
		assets: asset ? [asset] : []
	}), {
		status: 200,
		headers: {'content-type': 'application/json'}
	});
}

try {
	const {
		applyUpdate,
		buildWindowsUpdateHelperScript,
		checkLatestVersion,
		downloadUpdate
	} = await import('../src/core/update.ts');

	const platformAsset = {
		name: 'ccq-macos-arm64',
		browser_download_url: 'https://example.invalid/ccq',
		size: 10,
		digest: `sha256:${'a'.repeat(64)}`
	};

	// ── 版本/Release plan：只允许严格升级 ───────────────────────────────────────
	const downgrade = await checkLatestVersion({
		fetch: releaseFetch('2.3.1', platformAsset),
		currentVersion: '2.4.0-beta.1',
		platform: 'darwin',
		arch: 'arm64'
	});
	assert.deepEqual(downgrade, {
		ok: true,
		hasUpdate: false,
		currentVersion: '2.4.0-beta.1',
		latestVersion: '2.3.1'
	}, '较新 prerelease 不得被旧 stable 降级');

	const upgrade = await checkLatestVersion({
		fetch: releaseFetch('2.5.0', platformAsset),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'arm64'
	});
	assert.equal(upgrade.ok && upgrade.hasUpdate, true);
	assert.equal(upgrade.ok && upgrade.hasUpdate ? Object.isFrozen(upgrade.plan) : false, true,
		'SelfUpdatePlan 运行时也必须不可变');
	assert.deepEqual(upgrade.ok && upgrade.hasUpdate ? upgrade.plan : null, {
		version: '2.5.0',
		assetName: platformAsset.name,
		downloadUrl: platformAsset.browser_download_url,
		expectedSize: platformAsset.size,
		expectedSha256: 'a'.repeat(64)
	});

	const prereleaseNumericUpgrade = await checkLatestVersion({
		fetch: releaseFetch('2.4.0-beta.10', platformAsset),
		currentVersion: '2.4.0-beta.2',
		platform: 'darwin',
		arch: 'arm64'
	});
	assert.equal(prereleaseNumericUpgrade.ok && prereleaseNumericUpgrade.hasUpdate, true,
		'prerelease 数字段必须按数值比较：beta.10 > beta.2');

	const buildMetadataEqual = await checkLatestVersion({
		fetch: releaseFetch('2.4.0+release', platformAsset),
		currentVersion: '2.4.0+local',
		platform: 'darwin',
		arch: 'arm64'
	});
	assert.equal(buildMetadataEqual.ok && buildMetadataEqual.hasUpdate, false,
		'build metadata 不参与版本优先级');

	const missingDigest = await checkLatestVersion({
		fetch: releaseFetch('2.5.0', {...platformAsset, digest: undefined}),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'arm64'
	});
	assert.equal(missingDigest.ok, false, '缺 digest 必须 fail closed');

	for (const [label, asset] of [
		['缺 asset', undefined],
		['size=0', {...platformAsset, size: 0}],
		['size 非整数', {...platformAsset, size: 1.5}],
		['digest 算法错误', {...platformAsset, digest: `sha512:${'a'.repeat(64)}`}],
		['digest 长度错误', {...platformAsset, digest: `sha256:${'a'.repeat(63)}`}]
	]) {
		const invalidRelease = await checkLatestVersion({
			fetch: releaseFetch('2.5.0', asset),
			currentVersion: '2.4.0',
			platform: 'darwin',
			arch: 'arm64'
		});
		assert.equal(invalidRelease.ok, false, `${label} 必须在 check 阶段 fail closed`);
	}

	const unsupportedArch = await checkLatestVersion({
		fetch: releaseFetch('2.5.0', platformAsset),
		currentVersion: '2.4.0',
		platform: 'darwin',
		arch: 'ia32'
	});
	assert.equal(unsupportedArch.ok, false, '未知架构不得回退 x64');
	console.log('[PASS] ccq 自更新：semver 防降级 + Release plan 严格校验');

	// ── 流式下载事务：unique temp + size/hash ───────────────────────────────────
	const targetDir = join(tempHome, '.local', 'bin');
	mkdirSync(targetDir, {recursive: true});
	const targetPath = join(targetDir, 'ccq');
	writeFileSync(targetPath, 'old-binary', 'utf8');
	const originalTargetMode = statSync(targetPath).mode & 0o777;
	const legacyFixedTemp = join(targetDir, '.ccq-update.tmp');
	let legacyFixedTempIsSymlink = false;
	try {
		symlinkSync(targetPath, legacyFixedTemp);
		legacyFixedTempIsSymlink = true;
	} catch (error) {
		if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
		writeFileSync(legacyFixedTemp, 'legacy-temp-sentinel', 'utf8');
	}
	const binary = Buffer.from('new-binary');
	const plan = {
		version: '2.5.0',
		assetName: 'ccq-macos-arm64',
		downloadUrl: 'https://example.invalid/ccq',
		expectedSize: binary.byteLength,
		expectedSha256: sha256(binary)
	};
	const {
		isSelfUpdateCancellable,
		reduceSelfUpdateScreen
	} = await import('../src/state/self-update-state.ts');
	const stateTransaction = Object.freeze({
		plan,
		targetPath,
		tempPath: join(targetDir, '.ccq.update-state.tmp')
	});
	let screen = reduceSelfUpdateScreen({kind: 'checking'}, {type: 'updateAvailable', plan});
	screen = reduceSelfUpdateScreen(screen, {type: 'downloadStarted', plan});
	assert.equal(isSelfUpdateCancellable(screen), true);
	screen = reduceSelfUpdateScreen(screen, {type: 'cancelRequested'});
	assert.equal(screen.kind === 'updating' ? screen.stage : '', 'cancelling');
	screen = reduceSelfUpdateScreen(screen, {type: 'downloadReady', transaction: stateTransaction});
	screen = reduceSelfUpdateScreen(screen, {type: 'applyStarted', transaction: stateTransaction});
	assert.equal(isSelfUpdateCancellable(screen), false, 'applying 阶段不可取消');
	assert.equal(reduceSelfUpdateScreen(screen, {type: 'cancelRequested'}), screen,
		'applying 阶段的 cancel action 必须保持原状态');
	screen = reduceSelfUpdateScreen(screen, {type: 'applyCompleted', version: plan.version});
	assert.deepEqual(screen, {kind: 'updated', version: plan.version});
	const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
	assert.match(appSource, /const restartUpdatedApp[\s\S]*?renderer\?\.destroy\(\);[\s\S]*?await restartExecutable\(\)/,
		'TUI POSIX restart 必须先 destroy renderer 再 spawn');
	const fetchBinary = async () => new Response(binary, {status: 200});
	const first = await downloadUpdate(plan, undefined, {fetch: fetchBinary, targetPath, platform: 'darwin'});
	const second = await downloadUpdate(plan, undefined, {fetch: fetchBinary, targetPath, platform: 'darwin'});
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(first.ok ? Object.isFrozen(first.transaction) : false, true);
	assert.notEqual(first.ok ? first.transaction.tempPath : '', second.ok ? second.transaction.tempPath : '');
	assert.equal(first.ok ? readFileSync(first.transaction.tempPath).equals(binary) : false, true);
	if (legacyFixedTempIsSymlink) {
		assert.equal(lstatSync(legacyFixedTemp).isSymbolicLink(), true, '不得跟随或覆盖旧固定 temp symlink');
	} else {
		assert.equal(readFileSync(legacyFixedTemp, 'utf8'), 'legacy-temp-sentinel',
			'无 symlink 权限时仍不得覆盖旧固定 temp 哨兵文件');
	}
	assert.equal(readFileSync(targetPath, 'utf8'), 'old-binary');

	const badPlan = {...plan, expectedSha256: '0'.repeat(64)};
	const badDownload = await downloadUpdate(badPlan, undefined, {fetch: fetchBinary, targetPath, platform: 'darwin'});
	assert.equal(badDownload.ok, false);
	assert.equal(readdirSync(targetDir).some(name => name.includes(badPlan.expectedSha256)), false);
	assert.equal(readFileSync(targetPath, 'utf8'), 'old-binary');

	const beforeFailureTemps = readdirSync(targetDir).filter(name => name.includes('.update-')).sort();
	const sizeMismatch = await downloadUpdate({...plan, expectedSize: binary.byteLength + 1}, undefined, {
		fetch: fetchBinary,
		targetPath,
		platform: 'darwin'
	});
	assert.equal(sizeMismatch.ok, false);
	assert.deepEqual(readdirSync(targetDir).filter(name => name.includes('.update-')).sort(), beforeFailureTemps,
		'size mismatch 只能清理自己的事务 temp');

	const preAborted = new AbortController();
	preAborted.abort();
	const cancelled = await downloadUpdate(plan, preAborted.signal, {
		fetch: async (_url, init) => {
			assert.equal(init?.signal?.aborted, true, '预先取消的 signal 必须在 fetch 前生效');
			throw new DOMException('cancelled', 'AbortError');
		},
		targetPath,
		platform: 'darwin'
	});
	assert.equal(cancelled.ok, false);
	assert.match(cancelled.ok ? '' : cancelled.error.message, /取消/);

	const httpFailure = await downloadUpdate(plan, undefined, {
		fetch: async () => new Response('unavailable', {status: 503}),
		targetPath,
		platform: 'darwin'
	});
	assert.equal(httpFailure.ok, false);
	assert.equal(httpFailure.ok ? 0 : httpFailure.error.status, 503);

	const timedOut = await downloadUpdate(plan, undefined, {
		fetch: async (_url, init) => await new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), {once: true});
		}),
		targetPath,
		platform: 'darwin',
		timeoutMs: 10
	});
	assert.equal(timedOut.ok, false);
	assert.match(timedOut.ok ? '' : timedOut.error.message, /超时/);
	console.log('[PASS] ccq 自更新：唯一下载事务 + size/SHA-256 fail closed');

	// 100 MiB 以 1 MiB chunk 流式产生，避免先把完整响应装入内存。
	const chunk = new Uint8Array(1024 * 1024);
	const chunkCount = 100;
	const largeHash = createHash('sha256');
	for (let index = 0; index < chunkCount; index++) largeHash.update(chunk);
	const largePlan = {
		...plan,
		expectedSize: chunk.byteLength * chunkCount,
		expectedSha256: largeHash.digest('hex')
	};
	let emittedChunks = 0;
	const largeTarget = join(targetDir, 'ccq-large');
	const largeDownload = await downloadUpdate(largePlan, undefined, {
		fetch: async () => new Response(new ReadableStream({
			pull(controller) {
				if (emittedChunks >= chunkCount) {
					controller.close();
					return;
				}
				controller.enqueue(chunk);
				emittedChunks++;
			}
		}), {status: 200}),
		targetPath: largeTarget,
		platform: 'darwin'
	});
	assert.equal(largeDownload.ok, true);
	assert.equal(largeDownload.ok ? statSync(largeDownload.transaction.tempPath).size : 0, largePlan.expectedSize);
	if (largeDownload.ok) rmSync(largeDownload.transaction.tempPath, {force: true});
	console.log('[PASS] ccq 自更新：100 MiB response 按 chunk 流式写盘');

	// ── POSIX apply：rename 是最后的变更步骤 ───────────────────────────────────
	if (second.ok) {
		writeFileSync(second.transaction.tempPath, Buffer.alloc(binary.byteLength, 0x78));
		const rejected = await applyUpdate(second.transaction, {platform: 'darwin', restartAfterApply: false});
		assert.equal(rejected.ok, false);
		assert.equal(readFileSync(targetPath, 'utf8'), 'old-binary', 'apply 校验失败不得改变旧目标');
		assert.equal(existsSync(second.transaction.tempPath), true, 'apply 前失败保留 temp 供诊断');
	}
	for (const [label, options] of [
		['chmod', {chmodFile: () => { throw new Error('chmod failed'); }}],
		['fsync', {fsyncFile: () => { throw new Error('fsync failed'); }}],
		['rename', {renameFile: () => { throw new Error('rename failed'); }}]
	]) {
		const candidate = await downloadUpdate(plan, undefined, {fetch: fetchBinary, targetPath, platform: 'darwin'});
		assert.equal(candidate.ok, true);
		if (!candidate.ok) continue;
		const failedApply = await applyUpdate(candidate.transaction, {
			platform: 'darwin',
			restartAfterApply: false,
			...options
		});
		assert.equal(failedApply.ok, false, `${label} 注入失败必须返回 apply error`);
		assert.equal(readFileSync(targetPath, 'utf8'), 'old-binary');
		assert.equal(statSync(targetPath).mode & 0o777, originalTargetMode);
		assert.equal(existsSync(candidate.transaction.tempPath), true);
		rmSync(candidate.transaction.tempPath, {force: true});
	}
	assert.equal(first.ok, true);
	if (first.ok) {
		const applied = await applyUpdate(first.transaction, {
			platform: 'darwin',
			restartAfterApply: false,
			chmodFile: process.platform === 'win32' ? () => {} : undefined,
			fsyncFile: process.platform === 'win32' ? () => {} : undefined,
			renameFile: process.platform === 'win32'
				? (source, destination) => {
					rmSync(destination, {force: true});
					renameSync(source, destination);
				}
				: undefined
		});
		assert.equal(applied.ok, true, applied.ok ? undefined : `${applied.error.message}: ${applied.error.cause ?? ''}`);
		assert.equal(readFileSync(targetPath).equals(binary), true);
		if (process.platform !== 'win32') {
			assert.equal(statSync(targetPath).mode & 0o777, 0o755);
		}
		assert.equal(existsSync(first.transaction.tempPath), false);
	}
	if (second.ok) {
		rmSync(second.transaction.tempPath, {force: true});
	}
	console.log('[PASS] ccq 自更新：POSIX 原子应用 + 可执行权限');

	// ── Windows helper restart policy/hash 参数 ─────────────────────────────────
	const helper = buildWindowsUpdateHelperScript();
	assert.match(helper, /Wait-Process -Id \$ParentPid/);
	assert.match(helper, /ExpectedSha256/);
	assert.match(helper, /System\.Security\.Cryptography\.SHA256/);
	assert.equal(/Get-FileHash/.test(helper), false, 'PS5.1 helper 不得依赖模块自动加载的 Get-FileHash');
	assert.match(helper, /Set-Content -LiteralPath \$ReadyPath/, 'helper 必须在等待父进程前报告 ready');
	assert.match(helper, /if \(\$RestartAfterApply\)/);

	const windowsTarget = join(targetDir, 'ccq.exe');
	writeFileSync(windowsTarget, 'old-windows-binary', 'utf8');
	const windowsDownload = await downloadUpdate(plan, undefined, {
		fetch: fetchBinary,
		targetPath: windowsTarget,
		platform: 'win32'
	});
	assert.equal(windowsDownload.ok, true);
	if (windowsDownload.ok) {
		const spawnFailure = (..._args) => {
			const child = new EventEmitter();
			child.unref = () => {};
			queueMicrotask(() => child.emit('error', new Error('spawn failed')));
			return child;
		};
		const scheduled = await applyUpdate(windowsDownload.transaction, {
			platform: 'win32',
			restartAfterApply: false,
			spawnProcess: spawnFailure
		});
		assert.equal(scheduled.ok, false, '异步 spawn error 不得误报 scheduled');
		assert.equal(existsSync(windowsDownload.transaction.tempPath), true, 'spawn 失败保留已验证 temp');
		rmSync(windowsDownload.transaction.tempPath, {force: true});
	}

	const {runUpdate} = await import('../src/cli/commands/update.ts');
	const cliPlan = Object.freeze({...plan});
	const cliTransaction = Object.freeze({
		plan: cliPlan,
		targetPath: windowsTarget,
		tempPath: join(targetDir, '.ccq.exe.update-test.tmp')
	});
	let downloadCalls = 0;
	const originalCheckOnlyLog = console.log;
	let checkOnlyCode;
	console.log = () => {};
	try {
		checkOnlyCode = await runUpdate(true, {
			check: async () => ({
				ok: true,
				hasUpdate: true,
				currentVersion: '2.4.0',
				latestVersion: cliPlan.version,
				plan: cliPlan
			}),
			download: async () => {
				downloadCalls++;
				return {ok: true, transaction: cliTransaction};
			}
		});
	} finally {
		console.log = originalCheckOnlyLog;
	}
	assert.equal(checkOnlyCode, 0);
	assert.equal(downloadCalls, 0, '--check 必须保持零下载');

	let applyOptions = null;
	const cliOutput = [];
	const originalLog = console.log;
	console.log = (...args) => cliOutput.push(args.join(' '));
	try {
		const updateCode = await runUpdate(false, {
			check: async () => ({
				ok: true,
				hasUpdate: true,
				currentVersion: '2.4.0',
				latestVersion: cliPlan.version,
				plan: cliPlan
			}),
			download: async () => ({ok: true, transaction: cliTransaction}),
			apply: async (_transaction, options) => {
				applyOptions = options;
				return {
					ok: true,
					state: 'scheduled',
					targetPath: windowsTarget,
					restartStarted: false
				};
			}
		});
		assert.equal(updateCode, 0);
	} finally {
		console.log = originalLog;
	}
	assert.equal(applyOptions?.restartAfterApply, false, 'CLI update 必须显式禁止 helper 重启 TUI');
	assert.equal(cliOutput.some(line => line.includes('已安排更新')), true);
	assert.equal(cliOutput.some(line => line.includes('替换并重启')), false);
	console.log('[PASS] ccq 自更新：Windows helper 完整性与可选重启契约');
} finally {
	rmSync(tempHome, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
}
