// [P5a 迁走] 纯函数 / reducer / CLI 进度条段 → tests/core/self-update-plan.test.ts；
//            render 段 → tests/components/self-update-view.test.tsx。
// 本脚本只保留真实字节 / 真实子进程 / 真实缓存 lease 段（下载事务、Range 续传、
// gzip 物化、POSIX 原子应用、Windows helper 契约）与 5 条 app.tsx 源码正则（P1-G4 归类 B）。
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';

const tempHome = mkdtempSync(join(tmpdir(), 'ccq-self-update-'));
process.env.CCQ_HOME = tempHome;

function sha256(content) {
	return createHash('sha256').update(content).digest('hex');
}

/** 只有 raw target 的计划：模拟旧 Release（无 .gz）时的兼容直升路径。 */
function rawOnlyPlan(binary, overrides = {}) {
	const target = Object.freeze({
		assetName: 'ccq-macos-arm64',
		downloadUrl: 'https://example.invalid/ccq',
		expectedSize: binary.byteLength,
		expectedSha256: sha256(binary),
		...overrides
	});
	return Object.freeze({
		version: '2.5.0',
		target,
		transports: Object.freeze([Object.freeze({...target, encoding: 'identity'})])
	});
}

/** gzip 优先 + raw 回退的计划：两个 transport 各自持有独立完整性事实。 */
function gzipPlan(rawBinary, gzipBytes, overrides = {}) {
	const target = Object.freeze({
		assetName: 'ccq-macos-arm64',
		downloadUrl: 'https://example.invalid/ccq',
		expectedSize: rawBinary.byteLength,
		expectedSha256: sha256(rawBinary)
	});
	const gzipTransport = Object.freeze({
		assetName: 'ccq-macos-arm64.gz',
		downloadUrl: 'https://example.invalid/ccq.gz',
		expectedSize: gzipBytes.byteLength,
		expectedSha256: sha256(gzipBytes),
		encoding: 'gzip',
		...overrides
	});
	return Object.freeze({
		version: '2.5.0',
		target,
		transports: Object.freeze([gzipTransport, Object.freeze({...target, encoding: 'identity'})])
	});
}

/** 同时改写 target 与 identity transport 的字段，用于制造完整性失败场景。 */
function mutatePlan(plan, overrides) {
	const target = Object.freeze({...plan.target, ...overrides});
	return Object.freeze({
		...plan,
		target,
		transports: Object.freeze(
			plan.transports.map(transport =>
				transport.encoding === 'identity' ? Object.freeze({...target, encoding: 'identity'}) : transport
			)
		)
	});
}

function transportCacheIdentity(plan, transport = plan.transports[0], platform = 'darwin') {
	return {
		version: plan.version,
		platform,
		assetName: transport.assetName,
		encoding: transport.encoding,
		expectedSize: transport.expectedSize,
		expectedSha256: transport.expectedSha256,
		targetSha256: plan.target.expectedSha256
	};
}

try {
	const {applyUpdate, buildWindowsUpdateHelperScript, checkLatestVersion, downloadUpdate, formatSelfUpdateError} = await import(
		'../src/core/update.ts'
	);
	const {
		cleanupTransportCache,
		openTransportCache,
		releaseTransportLease,
		removeTransportCacheEntry,
		SELF_UPDATE_CACHE_TTL_MS,
		SELF_UPDATE_LEASE_STALE_MS,
		transportCacheEntryDir
	} = await import('../src/core/self-update-cache.ts');

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
	const plan = rawOnlyPlan(binary);
	const planTotal = plan.transports[0].expectedSize;
	const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
	assert.match(
		appSource,
		/screen\.kind === 'error'[\s\S]{0,160}?onRetry\(screen\.retry\)/,
		'error 屏的 Enter 必须触发按阶段重试，不能只关闭浮窗'
	);
	assert.match(
		appSource,
		/const retryUpdate[\s\S]*?case 'check':[\s\S]*?case 'download':[\s\S]*?case 'apply':/,
		'TUI 必须为三个失败阶段各自提供重试入口'
	);
	assert.match(appSource, /<UpdateDialog[\s\S]*?onRetry=\{/, '更新浮窗必须接线 onRetry');
	assert.match(appSource, /onProgress:\s*progress =>/, 'TUI 下载必须把 core 进度接入 reducer');
	assert.match(appSource, /<UpdateProgressBar[^>]*progress=\{screen\.progress\}/, '更新 Modal 必须渲染下载进度条');
	assert.match(appSource, /applyUpdate\(transaction, \{restartAfterApply: false\}\)/, 'TUI 应用更新必须禁止 Windows helper 自动重启');
	assert.doesNotMatch(appSource, /restartExecutable/, 'TUI 更新流程不得再启动新的 ccq 进程');
	const fetchBinary = async () => new Response(binary, {status: 200});
	const first = await downloadUpdate(plan, undefined, {fetch: fetchBinary, targetPath, platform: 'darwin'});
	const second = await downloadUpdate(plan, undefined, {fetch: fetchBinary, targetPath, platform: 'darwin'});
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(first.ok ? Object.isFrozen(first.transaction) : false, true);
	assert.notEqual(first.ok ? first.transaction.tempPath : '', second.ok ? second.transaction.tempPath : '');
	assert.equal(first.ok ? readFileSync(first.transaction.tempPath).equals(binary) : false, true);
	const progressEvents = [];
	const progressTarget = join(targetDir, 'ccq-progress');
	const progressDownload = await downloadUpdate(plan, undefined, {
		fetch: fetchBinary,
		targetPath: progressTarget,
		platform: 'darwin',
		onProgress: progress => progressEvents.push(progress)
	});
	assert.equal(progressDownload.ok, true);
	assert.equal(progressEvents[0]?.downloadedBytes, 0, '下载进度必须从 0 字节开始');
	assert.equal(progressEvents.at(-1)?.downloadedBytes, planTotal, '下载完成必须上报完整字节数');
	assert.equal(progressEvents.at(-1)?.percentage, 100, '下载完成必须上报 100%');
	for (let index = 1; index < progressEvents.length; index++) {
		assert.ok(progressEvents[index].downloadedBytes >= progressEvents[index - 1].downloadedBytes, '下载字节进度不得倒退');
	}
	if (progressDownload.ok) rmSync(progressDownload.transaction.tempPath, {force: true});
	if (legacyFixedTempIsSymlink) {
		assert.equal(lstatSync(legacyFixedTemp).isSymbolicLink(), true, '不得跟随或覆盖旧固定 temp symlink');
	} else {
		assert.equal(readFileSync(legacyFixedTemp, 'utf8'), 'legacy-temp-sentinel', '无 symlink 权限时仍不得覆盖旧固定 temp 哨兵文件');
	}
	assert.equal(readFileSync(targetPath, 'utf8'), 'old-binary');

	const badPlan = mutatePlan(plan, {expectedSha256: '0'.repeat(64)});
	const badDownload = await downloadUpdate(badPlan, undefined, {fetch: fetchBinary, targetPath, platform: 'darwin'});
	assert.equal(badDownload.ok, false);
	assert.equal(
		readdirSync(targetDir).some(name => name.includes('0'.repeat(64))),
		false
	);
	assert.equal(readFileSync(targetPath, 'utf8'), 'old-binary');

	const beforeFailureTemps = readdirSync(targetDir)
		.filter(name => name.includes('.update-'))
		.sort();
	const sizeMismatch = await downloadUpdate(mutatePlan(plan, {expectedSize: binary.byteLength + 1}), undefined, {
		fetch: fetchBinary,
		targetPath,
		platform: 'darwin'
	});
	assert.equal(sizeMismatch.ok, false);
	assert.deepEqual(
		readdirSync(targetDir)
			.filter(name => name.includes('.update-'))
			.sort(),
		beforeFailureTemps,
		'size mismatch 只能清理自己的事务 temp'
	);

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
		fetch: async (_url, init) =>
			await new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), {once: true});
			}),
		targetPath,
		platform: 'darwin',
		timeoutMs: 10
	});
	assert.equal(timedOut.ok, false);
	assert.match(timedOut.ok ? '' : timedOut.error.message, /超时/);

	const overallTimedOut = await downloadUpdate(rawOnlyPlan(Buffer.from('overall-timeout')), undefined, {
		fetch: async (_url, init) =>
			await new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('overall timeout', 'AbortError')), {once: true});
			}),
		targetPath: join(targetDir, 'ccq-overall-timeout'),
		platform: 'darwin',
		noProgressTimeoutMs: 1000,
		overallTimeoutMs: 10
	});
	assert.equal(overallTimedOut.ok, false);
	assert.match(overallTimedOut.ok ? '' : overallTimedOut.error.message, /超时/, '60 分钟总上限的注入路径必须保持超时语义');

	const slowBytes = Buffer.from('slow-but-progressing');
	const slowChunkDelayMs = 20;
	const slowNoProgressTimeoutMs = 250;
	const slowOverallTimeoutMs = 5000;
	const slowTotalDurationMs = slowBytes.byteLength * slowChunkDelayMs;
	assert.ok(slowChunkDelayMs < slowNoProgressTimeoutMs, '单个 chunk 间隔必须小于无进展阈值');
	assert.ok(slowNoProgressTimeoutMs < slowTotalDurationMs, '总下载时间必须大于无进展阈值，证明计时器持续重置');
	assert.ok(slowTotalDurationMs < slowOverallTimeoutMs, '慢速成功 fixture 必须小于 overall timeout');
	let slowIndex = 0;
	const slowDownload = await downloadUpdate(rawOnlyPlan(slowBytes), undefined, {
		fetch: async () =>
			new Response(
				new ReadableStream({
					async pull(controller) {
						await new Promise(resolve => setTimeout(resolve, slowChunkDelayMs));
						if (slowIndex >= slowBytes.byteLength) {
							controller.close();
							return;
						}
						controller.enqueue(new Uint8Array(slowBytes.subarray(slowIndex, slowIndex + 1)));
						slowIndex += 1;
					}
				}),
				{status: 200}
			),
		targetPath: join(targetDir, 'ccq-slow-progress'),
		platform: 'darwin',
		noProgressTimeoutMs: slowNoProgressTimeoutMs,
		overallTimeoutMs: slowOverallTimeoutMs
	});
	assert.equal(slowDownload.ok, true, '持续收到字节必须重置无进展计时器');
	if (slowDownload.ok) rmSync(slowDownload.transaction.tempPath, {force: true});

	const cancelBytes = Buffer.from('cancel-cleanup-partial');
	const cancelPlan = rawOnlyPlan(cancelBytes);
	const callerAbort = new AbortController();
	const cancelledMidStream = await downloadUpdate(cancelPlan, callerAbort.signal, {
		fetch: async (_url, init) =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(cancelBytes.subarray(0, 6)));
						init?.signal?.addEventListener('abort', () => controller.error(new DOMException('cancelled', 'AbortError')), {
							once: true
						});
					}
				}),
				{status: 200}
			),
		targetPath: join(targetDir, 'ccq-cancel-partial'),
		platform: 'darwin',
		onProgress: progress => {
			if (progress.downloadedBytes > 0) callerAbort.abort();
		}
	});
	assert.equal(cancelledMidStream.ok, false);
	assert.match(cancelledMidStream.ok ? '' : cancelledMidStream.error.message, /取消/);
	assert.equal(
		existsSync(transportCacheEntryDir(cancelPlan.transports[0].expectedSha256)),
		false,
		'caller cancel 必须删除当前 transport 分片'
	);

	const backoffAbort = new AbortController();
	let backoffCalls = 0;
	const backoffStarted = Date.now();
	const abortedBackoffPromise = downloadUpdate(rawOnlyPlan(Buffer.from('abort-backoff')), backoffAbort.signal, {
		fetch: async () => {
			backoffCalls += 1;
			queueMicrotask(() => backoffAbort.abort());
			return new Response('retry', {status: 503});
		},
		targetPath: join(targetDir, 'ccq-abort-backoff'),
		platform: 'darwin',
		backoffMs: [1000, 1000, 1000]
	});
	const abortedBackoff = await abortedBackoffPromise;
	assert.equal(abortedBackoff.ok, false);
	assert.equal(backoffCalls, 1, '退避期间取消不得发起下一次请求');
	assert.ok(Date.now() - backoffStarted < 500, '退避必须可立即中止');
	console.log('[PASS] ccq 自更新：唯一下载事务 + size/SHA-256 fail closed');

	// 100 MiB 以 1 MiB chunk 流式产生，避免先把完整响应装入内存。
	const chunk = new Uint8Array(1024 * 1024);
	const chunkCount = 100;
	const largeHash = createHash('sha256');
	for (let index = 0; index < chunkCount; index++) largeHash.update(chunk);
	const largeBytesLength = chunk.byteLength * chunkCount;
	const largePlan = rawOnlyPlan(Buffer.alloc(0), {
		expectedSize: largeBytesLength,
		expectedSha256: largeHash.digest('hex')
	});
	let emittedChunks = 0;
	const largeTarget = join(targetDir, 'ccq-large');
	const largeDownload = await downloadUpdate(largePlan, undefined, {
		fetch: async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						if (emittedChunks >= chunkCount) {
							controller.close();
							return;
						}
						controller.enqueue(chunk);
						emittedChunks++;
					}
				}),
				{status: 200}
			),
		targetPath: largeTarget,
		platform: 'darwin'
	});
	assert.equal(largeDownload.ok, true);
	assert.equal(largeDownload.ok ? statSync(largeDownload.transaction.tempPath).size : 0, largeBytesLength);
	if (largeDownload.ok) rmSync(largeDownload.transaction.tempPath, {force: true});
	console.log('[PASS] ccq 自更新：100 MiB response 按 chunk 流式写盘');

	// ── 手动 HTTPS 重定向：Bun 自动跟随在 GitHub CDN 上会 0% 断流 ─────────────
	const redirectTarget = join(targetDir, 'ccq-redirect');
	const redirectHops = [];
	const redirectDownload = await downloadUpdate(plan, undefined, {
		fetch: async (url, init) => {
			redirectHops.push({url: String(url), redirect: init?.redirect, range: init?.headers?.Range});
			if (String(url) === plan.target.downloadUrl) {
				return new Response(null, {status: 302, headers: {location: 'https://cdn.invalid/signed/ccq'}});
			}
			return new Response(binary, {status: 200});
		},
		targetPath: redirectTarget,
		platform: 'darwin'
	});
	assert.equal(redirectDownload.ok, true, '手动跟随 302 必须能完成下载');
	assert.equal(redirectHops.length, 2, '必须自己发起第二跳，而不是依赖运行时自动重定向');
	for (const hop of redirectHops) {
		assert.equal(hop.redirect, 'manual', '每一跳都必须禁用自动重定向');
	}
	if (redirectDownload.ok) rmSync(redirectDownload.transaction.tempPath, {force: true});

	for (const [label, headers] of [
		['缺 Location', {}],
		['Location 无法解析', {location: 'https://['}],
		['协议降级', {location: 'http://cdn.invalid/ccq'}],
		['重定向循环', {location: 'https://example.invalid/ccq'}]
	]) {
		const rejected = await downloadUpdate(plan, undefined, {
			fetch: async () => new Response(null, {status: 302, headers}),
			targetPath: join(targetDir, 'ccq-redirect-bad'),
			platform: 'darwin',
			maxAttempts: 1
		});
		assert.equal(rejected.ok, false, label + ' 必须 fail closed');
	}

	let hopCount = 0;
	const tooManyHops = await downloadUpdate(plan, undefined, {
		fetch: async () => {
			hopCount++;
			return new Response(null, {status: 302, headers: {location: 'https://cdn.invalid/hop-' + hopCount}});
		},
		targetPath: join(targetDir, 'ccq-redirect-loop'),
		platform: 'darwin',
		maxAttempts: 1
	});
	assert.equal(tooManyHops.ok, false, '超过跳数上限必须失败');
	assert.ok(hopCount <= 6, '重定向跳数必须有硬上限');
	const insecureOrigin = await downloadUpdate(rawOnlyPlan(binary, {downloadUrl: 'http://example.invalid/ccq'}), undefined, {
		fetch: async () => new Response(binary, {status: 200}),
		targetPath: join(targetDir, 'ccq-insecure-origin'),
		platform: 'darwin',
		maxAttempts: 1
	});
	assert.equal(insecureOrigin.ok, false, 'transport 原始地址也必须是 HTTPS');
	const signedUrlFailure = await downloadUpdate(
		rawOnlyPlan(binary, {
			downloadUrl: 'https://example.invalid/ccq-redacted'
		}),
		undefined,
		{
			fetch: async () => {
				throw new Error('socket failed at https://release-assets.invalid/file?sig=TOP_SECRET');
			},
			targetPath: join(targetDir, 'ccq-redacted'),
			platform: 'darwin',
			maxAttempts: 1
		}
	);
	assert.equal(signedUrlFailure.ok, false);
	assert.doesNotMatch(
		signedUrlFailure.ok ? '' : formatSelfUpdateError(signedUrlFailure.error),
		/TOP_SECRET|release-assets\.invalid/,
		'下载错误不得泄露签名 CDN URL'
	);
	console.log('[PASS] ccq 自更新：手动 HTTPS 重定向 + 非法跳转 fail closed');

	// ── 跨调用严格 Range 续传：TUI 重启不得从零开始 ───────────────────────────
	const resumeBytes = Buffer.from('resume-me-please-0123456789');
	const resumePlan = rawOnlyPlan(resumeBytes);
	const resumeTotal = resumeBytes.byteLength;
	const resumeSplit = 10;
	const resumeTarget = join(targetDir, 'ccq-resume');

	const firstRun = await downloadUpdate(resumePlan, undefined, {
		fetch: async () => {
			let stage = 0;
			return new Response(
				new ReadableStream({
					pull(controller) {
						if (stage === 0) {
							stage = 1;
							controller.enqueue(new Uint8Array(resumeBytes.subarray(0, resumeSplit)));
							return;
						}
						controller.error(new Error('socket closed'));
					}
				}),
				{status: 200}
			);
		},
		targetPath: resumeTarget,
		platform: 'darwin',
		maxAttempts: 1
	});
	assert.equal(firstRun.ok, false, '中途断流必须报告失败');
	assert.equal(existsSync(transportCacheEntryDir(resumePlan.transports[0].expectedSha256)), true, '网络失败必须保留持久分片');

	const resumeRequests = [];
	const secondRun = await downloadUpdate(resumePlan, undefined, {
		fetch: async (_url, init) => {
			const range = init?.headers?.Range;
			resumeRequests.push(range);
			const start = Number(
				String(range ?? 'bytes=0-')
					.replace(/^bytes=/, '')
					.split('-')[0]
			);
			return new Response(resumeBytes.subarray(start), {
				status: 206,
				headers: {'content-range': 'bytes ' + start + '-' + (resumeTotal - 1) + '/' + resumeTotal}
			});
		},
		targetPath: resumeTarget,
		platform: 'darwin'
	});
	assert.equal(secondRun.ok, true, '新一次调用必须从缓存 offset 续传完成');
	assert.equal(resumeRequests[0], 'bytes=' + resumeSplit + '-', '续传必须从精确 offset 发出 Range');
	if (secondRun.ok) {
		assert.equal(readFileSync(secondRun.transaction.tempPath).equals(resumeBytes), true, '续传结果必须等于完整 raw 字节');
		rmSync(secondRun.transaction.tempPath, {force: true});
	}

	const badRangeBytes = Buffer.from('bad-range-payload-abcdefghij');
	const badRangePlan = rawOnlyPlan(badRangeBytes);
	const badRangeTarget = join(targetDir, 'ccq-bad-range');
	const badRangeFirst = await downloadUpdate(badRangePlan, undefined, {
		fetch: async () => {
			let stage = 0;
			return new Response(
				new ReadableStream({
					pull(controller) {
						if (stage === 0) {
							stage = 1;
							controller.enqueue(new Uint8Array(badRangeBytes.subarray(0, 8)));
							return;
						}
						controller.error(new Error('socket closed'));
					}
				}),
				{status: 200}
			);
		},
		targetPath: badRangeTarget,
		platform: 'darwin',
		maxAttempts: 1
	});
	assert.equal(badRangeFirst.ok, false);
	const badRangeProgress = [];
	const badRangeSecond = await downloadUpdate(badRangePlan, undefined, {
		fetch: async () =>
			new Response(badRangeBytes.subarray(8), {
				status: 206,
				headers: {
					'content-range': 'bytes 99-' + (badRangeBytes.byteLength - 1) + '/' + badRangeBytes.byteLength
				}
			}),
		targetPath: badRangeTarget,
		platform: 'darwin',
		maxAttempts: 1,
		onProgress: progress => badRangeProgress.push(progress)
	});
	assert.equal(badRangeSecond.ok, false, '起点不符的 Content-Range 必须拒绝追加');
	assert.deepEqual(
		badRangeProgress.map(item => item.downloadedBytes),
		[0],
		'缓存 offset 只能在 206 Content-Range 严格验证后公开'
	);
	console.log('[PASS] ccq 自更新：持久严格 Range 续传 + 非法区间拒绝');

	// ── 完整缓存、metadata、lease、TTL 与 new-release 清理 ──────────────────────
	const cachedBytes = Buffer.from('already-complete-cache-payload');
	const cachedPlan = rawOnlyPlan(cachedBytes);
	const cachedIdentity = transportCacheIdentity(cachedPlan);
	const cachedEntry = openTransportCache(cachedIdentity);
	assert.equal(cachedEntry.ok, true);
	if (cachedEntry.ok) {
		writeFileSync(cachedEntry.payloadPath, cachedBytes);
		releaseTransportLease(cachedEntry.leasePath);
	}
	let unexpectedFetches = 0;
	const fromCompleteCache = await downloadUpdate(cachedPlan, undefined, {
		fetch: async () => {
			unexpectedFetches += 1;
			throw new Error('完整缓存不应重新发起网络请求');
		},
		targetPath: join(targetDir, 'ccq-complete-cache'),
		platform: 'darwin'
	});
	assert.equal(fromCompleteCache.ok, true, '完整缓存必须直接校验并物化');
	assert.equal(unexpectedFetches, 0, '完整缓存不得发送 bytes=size- 的非法 Range');
	assert.equal(existsSync(transportCacheEntryDir(cachedPlan.transports[0].expectedSha256)), false, '成功物化后必须删除已消费缓存');
	if (fromCompleteCache.ok) rmSync(fromCompleteCache.transaction.tempPath, {force: true});

	const metadataBytes = Buffer.from('metadata-recovery-payload');
	const metadataPlan = rawOnlyPlan(metadataBytes);
	const metadataIdentity = transportCacheIdentity(metadataPlan);
	const metadataEntry = openTransportCache(metadataIdentity);
	assert.equal(metadataEntry.ok, true);
	if (metadataEntry.ok) {
		writeFileSync(metadataEntry.payloadPath, metadataBytes.subarray(0, 5));
		releaseTransportLease(metadataEntry.leasePath);
		writeFileSync(metadataEntry.metadataPath, JSON.stringify({schema: 1, expectedSha256: 7}), 'utf8');
	}
	const recoveredMetadata = openTransportCache(metadataIdentity);
	assert.equal(recoveredMetadata.ok, true, '损坏 metadata 必须作废后从零恢复，不能永久报错');
	assert.equal(recoveredMetadata.ok ? recoveredMetadata.offset : -1, 0);
	if (recoveredMetadata.ok) {
		assert.equal(existsSync(recoveredMetadata.payloadPath), false, 'metadata 不匹配必须删除旧 payload');
		const concurrent = openTransportCache(metadataIdentity);
		assert.deepEqual(concurrent.ok ? null : concurrent.reason, 'busy', '同一进程的第二个 writer 也不得抢占 lease');
		cleanupTransportCache({keepDigests: new Set()});
		assert.equal(existsSync(recoveredMetadata.entryDir), true, '活跃 lease 必须阻止 new-release cleanup 删除 writer');
		releaseTransportLease(recoveredMetadata.leasePath);
		cleanupTransportCache({keepDigests: new Set()});
		assert.equal(existsSync(recoveredMetadata.entryDir), false, 'writer 释放后 new-release cleanup 应删除旧 digest');
	}

	const staleBytes = Buffer.from('stale-lease-payload');
	const stalePlan = rawOnlyPlan(staleBytes);
	const staleIdentity = transportCacheIdentity(stalePlan);
	const staleEntry = openTransportCache(staleIdentity);
	assert.equal(staleEntry.ok, true);
	if (staleEntry.ok) {
		releaseTransportLease(staleEntry.leasePath);
		writeFileSync(staleEntry.leasePath, '{broken', 'utf8');
		const staleTime = new Date(Date.now() - SELF_UPDATE_LEASE_STALE_MS - 1000);
		utimesSync(staleEntry.leasePath, staleTime, staleTime);
		const reclaimed = openTransportCache(staleIdentity);
		assert.equal(reclaimed.ok, true, '崩溃遗留的停滞 lease 必须可回收');
		if (reclaimed.ok) releaseTransportLease(reclaimed.leasePath);
		const oldTime = new Date(Date.now() - SELF_UPDATE_CACHE_TTL_MS - 1000);
		utimesSync(staleEntry.entryDir, oldTime, oldTime);
		cleanupTransportCache({keepDigests: new Set([stalePlan.transports[0].expectedSha256])});
		assert.equal(existsSync(staleEntry.entryDir), false, '当前 digest 的无人使用缓存也不得超过 7 天');
	}
	removeTransportCacheEntry(metadataPlan.transports[0].expectedSha256);
	removeTransportCacheEntry(stalePlan.transports[0].expectedSha256);
	console.log('[PASS] ccq 自更新缓存：完整恢复 + metadata + lease + TTL/new-release 清理');

	// ── 有界 HTTP 重试、ignored Range 重启与单 transport 单调进度 ───────────────
	const retryBytes = Buffer.from('bounded-http-retry-payload');
	const retryPlan = rawOnlyPlan(retryBytes);
	const retryStatuses = [408, 429, 503, 200];
	let retryCalls = 0;
	const retriedHttp = await downloadUpdate(retryPlan, undefined, {
		fetch: async () => {
			const status = retryStatuses[retryCalls++] ?? 500;
			return status === 200 ? new Response(retryBytes, {status}) : new Response('retry', {status});
		},
		targetPath: join(targetDir, 'ccq-http-retry'),
		platform: 'darwin',
		backoffMs: [0, 0, 0]
	});
	assert.equal(retriedHttp.ok, true, '408/429/5xx 必须在四次上限内重试');
	assert.equal(retryCalls, 4, '默认总尝试次数必须精确为 4');
	if (retriedHttp.ok) rmSync(retriedHttp.transaction.tempPath, {force: true});
	let permanentCalls = 0;
	const permanent404 = await downloadUpdate(rawOnlyPlan(Buffer.from('permanent-404')), undefined, {
		fetch: async () => {
			permanentCalls += 1;
			return new Response('missing', {status: 404});
		},
		targetPath: join(targetDir, 'ccq-http-404'),
		platform: 'darwin',
		backoffMs: [0, 0, 0]
	});
	assert.equal(permanent404.ok, false);
	assert.equal(permanentCalls, 1, '永久 4xx 不得在同一 transport 内重试');

	const restartBytes = Buffer.from('ignored-range-must-restart-without-progress-regression');
	const restartPlan = rawOnlyPlan(restartBytes);
	const restartSplit = 12;
	let restartCalls = 0;
	const restartProgress = [];
	const restartedRange = await downloadUpdate(restartPlan, undefined, {
		fetch: async () => {
			restartCalls += 1;
			if (restartCalls === 1) {
				let emitted = false;
				return new Response(
					new ReadableStream({
						pull(controller) {
							if (!emitted) {
								emitted = true;
								controller.enqueue(new Uint8Array(restartBytes.subarray(0, restartSplit)));
								return;
							}
							controller.error(new Error('stream reset'));
						}
					}),
					{status: 200}
				);
			}
			// 第二次忽略 Range；第三次从零提供完整响应。
			return new Response(restartBytes, {status: 200});
		},
		targetPath: join(targetDir, 'ccq-range-restart'),
		platform: 'darwin',
		maxAttempts: 3,
		backoffMs: [0, 0],
		onProgress: progress => restartProgress.push(progress)
	});
	assert.equal(restartedRange.ok, true, '服务端忽略 Range 时必须安全从零重启');
	assert.equal(restartCalls, 3);
	for (let index = 1; index < restartProgress.length; index++) {
		assert.ok(
			restartProgress[index].downloadedBytes >= restartProgress[index - 1].downloadedBytes,
			'同一 transport 的公开进度不得因 Range 重启而倒退'
		);
	}
	if (restartedRange.ok) rmSync(restartedRange.transaction.tempPath, {force: true});
	console.log('[PASS] ccq 自更新传输：HTTP 重试有界 + ignored Range 安全重启');

	// ── gzip 优先 + 双重完整性 + raw 回退 ─────────────────────────────────────
	const gzipRaw = Buffer.from('gzip-materialized-binary-payload');
	const gzipBytes = gzipSync(gzipRaw, {level: 9});
	const gzipPlanValue = gzipPlan(gzipRaw, gzipBytes);
	const gzipTarget = join(targetDir, 'ccq-gzip');
	const gzipRequested = [];
	const gzipProgress = [];
	const gzipDownload = await downloadUpdate(gzipPlanValue, undefined, {
		fetch: async url => {
			gzipRequested.push(String(url));
			return new Response(gzipBytes, {status: 200});
		},
		targetPath: gzipTarget,
		platform: 'darwin',
		onProgress: progress => gzipProgress.push(progress)
	});
	assert.equal(gzipDownload.ok, true, 'gzip transport 必须能物化出 raw 事务');
	assert.equal(gzipRequested[0], gzipPlanValue.transports[0].downloadUrl, '必须优先选择 gzip transport');
	assert.equal(gzipProgress[0]?.encoding, 'gzip', '进度必须携带当前 transport encoding');
	assert.equal(gzipProgress.at(-1)?.totalBytes, gzipBytes.byteLength, '进度总量是网络 transport 字节，不是解压后字节');
	if (gzipDownload.ok) {
		assert.equal(readFileSync(gzipDownload.transaction.tempPath).equals(gzipRaw), true, '解压结果必须逐字节等于 raw');
		rmSync(gzipDownload.transaction.tempPath, {force: true});
	}

	const tamperedGzip = Buffer.from(gzipBytes);
	tamperedGzip[tamperedGzip.length - 1] ^= 0xff;
	const fallbackTarget = join(targetDir, 'ccq-fallback');
	const fallbackProgress = [];
	const fallbackDownload = await downloadUpdate(gzipPlanValue, undefined, {
		fetch: async url =>
			String(url).endsWith('.gz') ? new Response(tamperedGzip, {status: 200}) : new Response(gzipRaw, {status: 200}),
		targetPath: fallbackTarget,
		platform: 'darwin',
		maxAttempts: 1,
		onProgress: progress => fallbackProgress.push(progress)
	});
	assert.equal(fallbackDownload.ok, true, 'gzip 不可用时必须自动回退 raw');
	assert.equal(
		fallbackProgress.some(item => item.encoding === 'gzip'),
		true
	);
	assert.equal(fallbackProgress.at(-1)?.encoding, 'identity', '回退后进度必须切到 identity transport');
	assert.equal(fallbackProgress.at(-1)?.totalBytes, gzipRaw.byteLength, '回退必须显式重置为 raw 总量');
	if (fallbackDownload.ok) {
		assert.equal(readFileSync(fallbackDownload.transaction.tempPath).equals(gzipRaw), true);
		rmSync(fallbackDownload.transaction.tempPath, {force: true});
	}

	for (const [label, badTransport] of [
		['gzip decoder 失败', Buffer.from('not-a-gzip-stream')],
		['gzip 输出超长', gzipSync(Buffer.concat([gzipRaw, Buffer.from('-overflow')]), {level: 9})]
	]) {
		const decoderPlan = gzipPlan(gzipRaw, badTransport);
		const decoderFallback = await downloadUpdate(decoderPlan, undefined, {
			fetch: async url =>
				String(url).endsWith('.gz') ? new Response(badTransport, {status: 200}) : new Response(gzipRaw, {status: 200}),
			targetPath: join(targetDir, `ccq-${label.includes('decoder') ? 'decoder' : 'overflow'}`),
			platform: 'darwin',
			maxAttempts: 1
		});
		assert.equal(decoderFallback.ok, true, `${label}必须安全回退 raw`);
		if (decoderFallback.ok) {
			assert.equal(readFileSync(decoderFallback.transaction.tempPath).equals(gzipRaw), true);
			rmSync(decoderFallback.transaction.tempPath, {force: true});
		}
	}

	const partialGzipPlan = gzipPlan(gzipRaw, gzipBytes);
	let partialGzipStage = 0;
	const partialGzipFallback = await downloadUpdate(partialGzipPlan, undefined, {
		fetch: async url => {
			if (!String(url).endsWith('.gz')) return new Response(gzipRaw, {status: 200});
			return new Response(
				new ReadableStream({
					pull(controller) {
						if (partialGzipStage === 0) {
							partialGzipStage = 1;
							controller.enqueue(new Uint8Array(gzipBytes.subarray(0, 8)));
							return;
						}
						controller.error(new Error('gzip network interrupted'));
					}
				}),
				{status: 200}
			);
		},
		targetPath: join(targetDir, 'ccq-partial-gzip-fallback'),
		platform: 'darwin',
		maxAttempts: 1
	});
	assert.equal(partialGzipFallback.ok, true, 'gzip 网络失败后当前调用可回退 raw');
	assert.equal(
		existsSync(transportCacheEntryDir(partialGzipPlan.transports[0].expectedSha256)),
		true,
		'gzip 网络失败留下的合法分片必须供下一次重试续传'
	);
	removeTransportCacheEntry(partialGzipPlan.transports[0].expectedSha256);
	if (partialGzipFallback.ok) rmSync(partialGzipFallback.transaction.tempPath, {force: true});

	const wrongInner = Buffer.from('this-is-not-the-declared-binary!');
	const wrongInnerGzip = gzipSync(wrongInner, {level: 9});
	const wrongInnerPlan = Object.freeze({
		version: '2.5.0',
		target: gzipPlanValue.target,
		transports: Object.freeze([
			Object.freeze({
				assetName: 'ccq-macos-arm64.gz',
				downloadUrl: 'https://example.invalid/ccq.gz',
				expectedSize: wrongInnerGzip.byteLength,
				expectedSha256: sha256(wrongInnerGzip),
				encoding: 'gzip'
			})
		])
	});
	const wrongInnerTarget = join(targetDir, 'ccq-wrong-inner');
	writeFileSync(wrongInnerTarget, 'old-inner-binary', 'utf8');
	const wrongInnerDownload = await downloadUpdate(wrongInnerPlan, undefined, {
		fetch: async () => new Response(wrongInnerGzip, {status: 200}),
		targetPath: wrongInnerTarget,
		platform: 'darwin',
		maxAttempts: 1
	});
	assert.equal(wrongInnerDownload.ok, false, '解压后 raw digest 不符必须 fail closed');
	assert.equal(readFileSync(wrongInnerTarget, 'utf8'), 'old-inner-binary', '任何失败路径都不得触碰目标文件');
	assert.equal(
		readdirSync(targetDir).some(name => name.startsWith('.ccq-wrong-inner.update-')),
		false,
		'物化失败必须删除 raw temp'
	);
	console.log('[PASS] ccq 自更新：gzip 物化 + 双重完整性 + raw 回退');

	// ── POSIX apply：rename 是最后的变更步骤 ───────────────────────────────────
	if (second.ok) {
		writeFileSync(second.transaction.tempPath, Buffer.alloc(binary.byteLength, 0x78));
		const rejected = await applyUpdate(second.transaction, {platform: 'darwin', restartAfterApply: false});
		assert.equal(rejected.ok, false);
		assert.equal(readFileSync(targetPath, 'utf8'), 'old-binary', 'apply 校验失败不得改变旧目标');
		assert.equal(existsSync(second.transaction.tempPath), true, 'apply 前失败保留 temp 供诊断');
	}
	for (const [label, options] of [
		[
			'chmod',
			{
				chmodFile: () => {
					throw new Error('chmod failed');
				}
			}
		],
		[
			'fsync',
			{
				fsyncFile: () => {
					throw new Error('fsync failed');
				}
			}
		],
		[
			'rename',
			{
				renameFile: () => {
					throw new Error('rename failed');
				}
			}
		]
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
			renameFile:
				process.platform === 'win32'
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
	assert.match(
		helper,
		/\[System\.IO\.File\]::Replace\(\$TempPath, \$TargetPath, \$BackupPath, \$true\)/,
		'Windows helper 必须使用同目录原子 Replace，避免原地 Copy-Item 破坏旧目标'
	);
	assert.doesNotMatch(
		helper,
		/Copy-Item -LiteralPath \$TempPath -Destination \$TargetPath -Force/,
		'Windows helper 不得用 Copy-Item -Force 原地覆盖正在更新的目标'
	);
	assert.match(helper, /target restore/, '替换后校验失败必须尝试恢复旧目标');

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

	const invalidTransaction = {
		plan,
		targetPath,
		tempPath: join(targetDir, '.ccq.update-missing.tmp')
	};
	const invalidApply = await applyUpdate(invalidTransaction, {platform: 'darwin'});
	assert.equal(invalidApply.ok, false);
	assert.equal(
		invalidApply.ok ? undefined : invalidApply.error.retryStage,
		'download',
		'失效 apply 事务必须引导重新下载，不能无限重试同一 temp'
	);
	console.log('[PASS] ccq 自更新：Windows helper 完整性与可选重启契约');
} finally {
	rmSync(tempHome, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
}
