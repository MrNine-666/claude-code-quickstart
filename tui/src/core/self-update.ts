import {
	chmodSync,
	closeSync,
	createReadStream,
	createWriteStream,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync
} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {createHash, randomBytes, type Hash} from 'node:crypto';
import {spawn as nodeSpawn} from 'node:child_process';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {resolveHome} from './paths.js';
import {parseSemver, semverCompare} from './semver.js';
import {
	cleanupTransportCache,
	heartbeatTransportLease,
	openTransportCache,
	releaseTransportLease,
	removeTransportCacheEntry,
	type SelfUpdateTransportEncoding
} from './self-update-cache.js';
import {
	spawnDetachedPowerShell,
	uniqueWindowsHelperPath,
	WINDOWS_HELPER_INTERVAL_MS,
	WINDOWS_HELPER_MAX_ATTEMPTS,
	type SpawnProcess
} from './windows-deferred-operation.js';
import {CCQ_VERSION} from '../version.js';

const GITHUB_REPO = 'MrNine-666/claude-code-quickstart';
const RELEASE_API_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';
const CHECK_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 300000;
const SHA256_PATTERN = /^sha256:([a-f0-9]{64})$/i;
/** 手动重定向上限：GitHub asset -> 签名 CDN 通常只需 1 跳。 */
export const SELF_UPDATE_MAX_REDIRECTS = 5;
/** 单个 transport 的总尝试次数（含首次）。 */
export const SELF_UPDATE_MAX_ATTEMPTS = 4;
/** 可中止退避序列，对应第 2/3/4 次尝试。 */
export const SELF_UPDATE_BACKOFF_MS: readonly number[] = [250, 500, 1000];
/** 一次公开下载操作的总安全上限。 */
export const SELF_UPDATE_OVERALL_CAP_MS = 60 * 60 * 1000;

type ReleaseAsset = {
	readonly name?: string;
	readonly browser_download_url?: string;
	readonly size?: number;
	readonly digest?: string;
};

type LatestReleaseResponse = {
	readonly tag_name?: string;
	readonly assets?: readonly ReleaseAsset[];
};

/** 最终落盘可执行文件的完整性事实；永远来自 raw Release asset。 */
export type SelfUpdateAsset = {
	readonly assetName: string;
	readonly downloadUrl: string;
	readonly expectedSize: number;
	readonly expectedSha256: string;
};

/** 网络传输资产：gzip 为可选加速，identity 为必备回退。 */
export type SelfUpdateTransport = SelfUpdateAsset & {
	readonly encoding: SelfUpdateTransportEncoding;
};

/**
 * Release 能力：target 是最终 raw 可执行文件，transports 按优先级排列。
 * 两者的 size/SHA-256 是独立信任边界，不能互相推断。
 */
export type SelfUpdatePlan = {
	readonly version: string;
	readonly target: SelfUpdateAsset;
	readonly transports: readonly SelfUpdateTransport[];
};

export type DownloadedSelfUpdate = {
	readonly plan: SelfUpdatePlan;
	readonly targetPath: string;
	readonly tempPath: string;
};

/** 进度以“当前网络 transport”为总量；gzip→raw 回退是显式的 transport 变化。 */
export type DownloadUpdateProgress = {
	readonly downloadedBytes: number;
	readonly totalBytes: number;
	readonly percentage: number;
	readonly assetName: string;
	readonly encoding: SelfUpdateTransportEncoding;
};

export type DownloadProgressCallback = (progress: DownloadUpdateProgress) => void;

/** 首选 transport：用于 reducer 初始进度总量。 */
export function preferredTransport(plan: SelfUpdatePlan): SelfUpdateTransport {
	const first = plan.transports[0];
	if (first) return first;
	return {...plan.target, encoding: 'identity'};
}

export type SelfUpdateStage = 'check' | 'download' | 'apply';

export type SelfUpdateError = {
	readonly stage: SelfUpdateStage;
	readonly message: string;
	/** 当前阶段的前置事务已失效时，UI 应回到哪个阶段恢复。 */
	readonly retryStage?: SelfUpdateStage;
	readonly cause?: string;
	readonly status?: number;
	readonly targetPath?: string;
	readonly tempPath?: string;
};

export type CheckLatestVersionResult =
	| {readonly ok: true; readonly hasUpdate: false; readonly currentVersion: string; readonly latestVersion: string}
	| {
			readonly ok: true;
			readonly hasUpdate: true;
			readonly currentVersion: string;
			readonly latestVersion: string;
			readonly plan: SelfUpdatePlan;
	  }
	| {readonly ok: false; readonly error: SelfUpdateError};

export type DownloadUpdateResult =
	| {readonly ok: true; readonly transaction: DownloadedSelfUpdate}
	| {readonly ok: false; readonly error: SelfUpdateError};

export type ApplySelfUpdateResult =
	| {
			readonly ok: true;
			readonly state: 'applied' | 'scheduled';
			readonly targetPath: string;
			readonly restartStarted: boolean;
			readonly helperPath?: string;
	  }
	| {readonly ok: false; readonly error: SelfUpdateError};

export type CheckLatestVersionDeps = {
	readonly fetch?: typeof fetch;
	readonly currentVersion?: string;
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
	readonly timeoutMs?: number;
};

export type DownloadUpdateDeps = {
	readonly fetch?: typeof fetch;
	readonly targetPath?: string;
	readonly platform?: NodeJS.Platform;
	/** 无进展超时（历史参数名保留，语义已从固定墙钟改为可重置）。 */
	readonly timeoutMs?: number;
	readonly noProgressTimeoutMs?: number;
	readonly overallTimeoutMs?: number;
	readonly maxAttempts?: number;
	readonly backoffMs?: readonly number[];
	readonly onProgress?: DownloadProgressCallback;
};

export type ApplyUpdateOptions = {
	readonly platform?: NodeJS.Platform;
	readonly restartAfterApply?: boolean;
	readonly spawnProcess?: SpawnProcess;
	readonly chmodFile?: (filePath: string, mode: number) => void;
	readonly openFile?: (filePath: string, flags: string) => number;
	readonly fsyncFile?: (fd: number) => void;
	readonly closeFile?: (fd: number) => void;
	readonly renameFile?: (source: string, destination: string) => void;
};

function errorCause(error: unknown): string | undefined {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	const text = String(error ?? '').trim();
	return text || undefined;
}

function safeDownloadCause(error: unknown): string | undefined {
	const cause = errorCause(error);
	if (!cause) return undefined;
	// fetch/stream 异常可能把带签名查询参数的 CDN URL 拼进 message；UI/日志只保留类别。
	return cause.replace(/https?:\/\/[^\s)\]>'"]+/gi, '[已隐藏下载地址]');
}

function makeSelfUpdateError(
	stage: SelfUpdateStage,
	message: string,
	options: Omit<SelfUpdateError, 'stage' | 'message'> = {}
): SelfUpdateError {
	return {stage, message, ...options};
}

export function formatSelfUpdateError(error: SelfUpdateError): string {
	const stageLabel: Record<SelfUpdateStage, string> = {
		check: '检查更新',
		download: '下载更新',
		apply: '应用更新'
	};
	const details: string[] = [];
	if (error.status !== undefined) details.push('HTTP ' + error.status);
	if (error.targetPath) details.push('目标: ' + error.targetPath);
	if (error.tempPath) details.push('临时文件: ' + error.tempPath);
	if (error.cause && error.cause !== error.message) details.push(error.cause);
	return details.length > 0
		? stageLabel[error.stage] + '失败：' + error.message + '（' + details.join('；') + '）'
		: stageLabel[error.stage] + '失败：' + error.message;
}

function getAssetName(platform: NodeJS.Platform, arch: string): string {
	if (arch !== 'x64' && arch !== 'arm64') {
		throw new Error('Unsupported architecture: ' + arch);
	}
	if (platform === 'win32') return 'ccq-windows-' + arch + '.exe';
	if (platform === 'darwin') return 'ccq-macos-' + arch;
	throw new Error('Unsupported platform: ' + platform + '-' + arch);
}

function parseDigest(digest: string | undefined): string | null {
	const match = digest?.trim().match(SHA256_PATTERN);
	return match?.[1]?.toLowerCase() ?? null;
}

/**
 * 把 Release asset 解析为可信资产；缺 URL/size/digest 一律返回 null。
 * raw target 返回 null 即 check 阶段 fail closed；gzip 返回 null 只是忽略加速。
 */
function parseReleaseAsset(asset: ReleaseAsset | undefined): SelfUpdateAsset | null {
	if (!asset?.name || !asset.browser_download_url) return null;
	if (!Number.isSafeInteger(asset.size) || Number(asset.size) <= 0) return null;
	const expectedSha256 = parseDigest(asset.digest);
	if (!expectedSha256) return null;
	return {
		assetName: asset.name,
		downloadUrl: asset.browser_download_url,
		expectedSize: Number(asset.size),
		expectedSha256
	};
}

export function getCcqExecutablePath(): string {
	const filename = process.platform === 'win32' ? 'ccq.exe' : 'ccq';
	return join(resolveHome(), '.local', 'bin', filename);
}

function isLikelyCcqExecutablePath(filePath: string): boolean {
	const name = basename(filePath).toLowerCase();
	return name === 'ccq' || name === 'ccq.exe' || /^ccq-.+(?:\.exe)?$/.test(name);
}

export function getSelfUpdateTargetPath(): string {
	return isLikelyCcqExecutablePath(process.execPath) ? process.execPath : getCcqExecutablePath();
}

export async function checkLatestVersion(deps: CheckLatestVersionDeps = {}): Promise<CheckLatestVersionResult> {
	const fetchRelease = deps.fetch ?? fetch;
	const currentVersion = deps.currentVersion ?? CCQ_VERSION;
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? CHECK_TIMEOUT_MS);
	try {
		const response = await fetchRelease(RELEASE_API_URL, {
			headers: {'User-Agent': 'ccq-update-checker'},
			signal: controller.signal
		});
		if (!response.ok) {
			return {ok: false, error: makeSelfUpdateError('check', 'GitHub Release API 请求失败', {status: response.status})};
		}

		const data = (await response.json()) as LatestReleaseResponse;
		const latestVersion = data.tag_name?.trim().replace(/^v/i, '');
		if (!latestVersion) {
			return {ok: false, error: makeSelfUpdateError('check', 'GitHub Release 响应缺少 tag_name')};
		}
		if (!parseSemver(currentVersion) || !parseSemver(latestVersion)) {
			return {ok: false, error: makeSelfUpdateError('check', '当前版本或 Release 版本不是合法 semver')};
		}
		if (semverCompare(latestVersion, currentVersion) <= 0) {
			cleanupTransportCache();
			return {ok: true, hasUpdate: false, currentVersion, latestVersion};
		}

		let assetName: string;
		try {
			assetName = getAssetName(platform, arch);
		} catch (error) {
			return {ok: false, error: makeSelfUpdateError('check', '不支持当前平台或架构', {cause: errorCause(error)})};
		}
		const assets = data.assets ?? [];
		const rawAsset = parseReleaseAsset(assets.find(item => item.name === assetName));
		if (!rawAsset) {
			return {ok: false, error: makeSelfUpdateError('check', 'Release 缺少当前平台产物 ' + assetName)};
		}

		// gzip 是可选加速：缺失或元数据无效时忽略，保持旧 Release 与回滚兼容。
		const gzipAsset = parseReleaseAsset(assets.find(item => item.name === assetName + '.gz'));
		const transports: SelfUpdateTransport[] = [];
		if (gzipAsset) transports.push(Object.freeze({...gzipAsset, encoding: 'gzip' as const}));
		transports.push(Object.freeze({...rawAsset, encoding: 'identity' as const}));

		const plan: SelfUpdatePlan = Object.freeze({
			version: latestVersion,
			target: Object.freeze(rawAsset),
			transports: Object.freeze(transports)
		});
		// 新 Release 出现即清理不再需要的旧 digest 分片。
		cleanupTransportCache({keepDigests: new Set(transports.map(item => item.expectedSha256))});

		return {ok: true, hasUpdate: true, currentVersion, latestVersion, plan};
	} catch (error) {
		const message = controller.signal.aborted ? '检查更新超时' : '无法连接 GitHub Release';
		return {ok: false, error: makeSelfUpdateError('check', message, {cause: errorCause(error)})};
	} finally {
		clearTimeout(timeout);
	}
}

function uniqueTempUpdatePath(targetPath: string): string {
	return join(dirname(targetPath), '.' + basename(targetPath) + '.update-' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp');
}

function writeChunk(fd: number, chunk: Uint8Array): void {
	let offset = 0;
	while (offset < chunk.byteLength) {
		const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
		if (written <= 0) throw new Error('写入更新临时文件时没有取得进展');
		offset += written;
	}
}

function removeFileBestEffort(filePath: string): void {
	try {
		rmSync(filePath, {force: true});
	} catch {
		// Primary operation returns the structured error; cleanup is best-effort.
	}
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * 手动跟随最多 5 跳 HTTPS 重定向。Bun 自动重定向在
 * `github.com -> release-assets.githubusercontent.com` 上会 abort/socket closed，
 * 因此每一跳都自己发起，并保留 Range 与 AbortSignal。
 */
async function fetchFollowingRedirects(
	fetchImpl: typeof fetch,
	originalUrl: string,
	rangeFrom: number,
	signal: AbortSignal
): Promise<Response> {
	const visited = new Set<string>();
	let currentUrl: string;
	try {
		const parsed = new URL(originalUrl);
		if (parsed.protocol !== 'https:') throw new Error('protocol');
		currentUrl = parsed.toString();
	} catch {
		throw new Error('Release 下载地址必须是可解析的 HTTPS URL');
	}
	for (let hop = 0; hop <= SELF_UPDATE_MAX_REDIRECTS; hop++) {
		if (visited.has(currentUrl)) throw new Error('Release 下载重定向出现循环');
		visited.add(currentUrl);
		const headers: Record<string, string> = {'User-Agent': 'ccq-update-downloader'};
		if (rangeFrom > 0) headers.Range = 'bytes=' + rangeFrom + '-';
		const response = await fetchImpl(currentUrl, {redirect: 'manual', headers, signal});
		if (!REDIRECT_STATUS.has(response.status)) return response;

		const location = response.headers.get('location');
		if (!location) {
			await response.body?.cancel().catch(() => {});
			throw new Error('Release 下载重定向缺少 Location');
		}
		let next: URL;
		try {
			next = new URL(location, currentUrl);
		} catch {
			await response.body?.cancel().catch(() => {});
			throw new Error('Release 下载重定向 Location 无法解析');
		}
		if (next.protocol !== 'https:') {
			await response.body?.cancel().catch(() => {});
			throw new Error('Release 下载重定向协议降级被拒绝');
		}
		await response.body?.cancel().catch(() => {});
		currentUrl = next.toString();
	}
	throw new Error('Release 下载重定向超过 ' + SELF_UPDATE_MAX_REDIRECTS + ' 跳');
}

type TransportFetchOutcome =
	| {readonly kind: 'complete'; readonly digest: string; readonly size: number}
	| {readonly kind: 'retryable'; readonly cause: string; readonly status?: number}
	| {readonly kind: 'permanent'; readonly cause: string; readonly status?: number};

async function waitForBackoff(delayMs: number, signal: AbortSignal): Promise<void> {
	if (delayMs <= 0 || signal.aborted) return;
	await new Promise<void>(settle => {
		const onAbort = (): void => {
			clearTimeout(timer);
			settle();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			settle();
		}, delayMs);
		signal.addEventListener('abort', onAbort, {once: true});
	});
}

/**
 * 把单个 transport 下载进持久缓存分片。
 * offset > 0 时必须取得起点/总长一致的 `206 Content-Range` 才允许追加。
 */
async function fetchTransportIntoCache(
	transport: SelfUpdateTransport,
	payloadPath: string,
	leasePath: string,
	startOffset: number,
	runningHash: Hash,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
	onBytes: (total: number) => void
): Promise<TransportFetchOutcome> {
	let offset = startOffset;
	let response: Response;
	try {
		response = await fetchFollowingRedirects(fetchImpl, transport.downloadUrl, offset, signal);
	} catch (error) {
		if (signal.aborted) return {kind: 'permanent', cause: safeDownloadCause(error) ?? '已取消'};
		const cause = safeDownloadCause(error) ?? '网络请求失败';
		// 重定向本身非法属于永久失败，网络抖动可重试。
		const permanent = /重定向/.test(cause);
		return {kind: permanent ? 'permanent' : 'retryable', cause};
	}

	if (offset > 0) {
		if (response.status === 200) {
			// 服务端忽略 Range：作废分片后从零重启，绝不把整体响应拼到旧字节后面。
			await response.body?.cancel().catch(() => {});
			return {kind: 'retryable', cause: 'Range 被忽略，需要重新下载', status: 200};
		}
		if (response.status !== 206) {
			const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
			await response.body?.cancel().catch(() => {});
			return {kind: retryable ? 'retryable' : 'permanent', cause: '续传请求被拒绝', status: response.status};
		}
		const contentRange = response.headers.get('content-range') ?? '';
		const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
		if (!match) {
			await response.body?.cancel().catch(() => {});
			return {kind: 'permanent', cause: 'Content-Range 无法解析', status: 206};
		}
		const start = Number(match[1]);
		const end = Number(match[2]);
		const total = Number(match[3]);
		if (start !== offset || total !== transport.expectedSize || end !== transport.expectedSize - 1) {
			await response.body?.cancel().catch(() => {});
			return {kind: 'permanent', cause: 'Content-Range 与请求或 Release 声明不一致', status: 206};
		}
		const declaredLength = response.headers.get('content-length');
		if (declaredLength !== null && Number(declaredLength) !== transport.expectedSize - offset) {
			await response.body?.cancel().catch(() => {});
			return {kind: 'permanent', cause: 'Content-Length 与续传区间不一致', status: 206};
		}
	} else if (!response.ok) {
		const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
		await response.body?.cancel().catch(() => {});
		return {kind: retryable ? 'retryable' : 'permanent', cause: '下载 Release asset 失败', status: response.status};
	}

	if (!response.body) return {kind: 'retryable', cause: '下载响应没有可读取内容', status: response.status};
	// 只有严格验证过续传响应后，UI 才能把已缓存 offset 计入当前进度。
	if (offset > 0) onBytes(offset);

	let fd: number;
	try {
		fd = openSync(payloadPath, offset > 0 ? 'a' : 'w', 0o600);
	} catch (error) {
		await response.body.cancel().catch(() => {});
		return {kind: 'permanent', cause: safeDownloadCause(error) ?? '无法打开更新缓存文件'};
	}
	const reader = response.body.getReader();
	let lastHeartbeat = Date.now();
	let bodyEnded = false;
	try {
		while (true) {
			const {done, value} = await reader.read();
			if (done) {
				bodyEnded = true;
				break;
			}
			if (!value) continue;
			const nextOffset = offset + value.byteLength;
			if (nextOffset > transport.expectedSize) {
				return {kind: 'permanent', cause: '下载字节超过 Release 声明'};
			}
			try {
				writeChunk(fd, value);
			} catch (error) {
				return {kind: 'permanent', cause: safeDownloadCause(error) ?? '写入更新缓存失败'};
			}
			runningHash.update(value);
			offset = nextOffset;
			onBytes(offset);
			const now = Date.now();
			if (now - lastHeartbeat >= 5000) {
				lastHeartbeat = now;
				try {
					heartbeatTransportLease(leasePath);
				} catch (error) {
					return {kind: 'permanent', cause: safeDownloadCause(error) ?? '更新缓存 lease 已丢失'};
				}
			}
		}
		try {
			fsyncSync(fd);
		} catch (error) {
			return {kind: 'permanent', cause: safeDownloadCause(error) ?? '同步更新缓存失败'};
		}
	} catch (error) {
		if (signal.aborted) return {kind: 'permanent', cause: safeDownloadCause(error) ?? '已取消'};
		// 保留已落盘分片，下次从精确 offset 续传。
		return {kind: 'retryable', cause: safeDownloadCause(error) ?? '响应流中断'};
	} finally {
		if (!bodyEnded) await reader.cancel().catch(() => {});
		try {
			closeSync(fd);
		} catch {
			// 分片状态由 metadata/rehash 兜底。
		}
	}

	if (offset !== transport.expectedSize) {
		return {kind: 'retryable', cause: '响应提前结束，已保留可续传分片'};
	}
	const digest = runningHash.copy().digest('hex');
	if (digest !== transport.expectedSha256.toLowerCase()) {
		return {kind: 'permanent', cause: 'transport SHA-256 校验失败'};
	}
	return {kind: 'complete', digest, size: offset};
}

/**
 * 把已验证的 transport 分片物化成目标目录下唯一的 raw temp。
 * gzip 流式解压，输出超过 raw expected size 立即中止，最终必须 size/digest 双匹配。
 */
async function materializeRawTemp(
	payloadPath: string,
	encoding: SelfUpdateTransportEncoding,
	target: SelfUpdateAsset,
	tempPath: string,
	signal: AbortSignal
): Promise<{readonly ok: true} | {readonly ok: false; readonly cause: string}> {
	const hash = createHash('sha256');
	let written = 0;
	const measure = new Transform({
		transform(chunk, _encoding, callback) {
			written += chunk.byteLength;
			if (written > target.expectedSize) {
				callback(new Error('解压输出超过 Release 声明的可执行文件大小'));
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		}
	});
	try {
		const source = createReadStream(payloadPath);
		const sink = createWriteStream(tempPath, {flags: 'wx', mode: 0o700});
		await (encoding === 'gzip' ? pipeline(source, createGunzip(), measure, sink, {signal}) : pipeline(source, measure, sink, {signal}));
	} catch (error) {
		return {ok: false, cause: errorCause(error) ?? '物化更新文件失败'};
	}
	if (written !== target.expectedSize) return {ok: false, cause: '物化后文件大小与 Release 声明不一致'};
	if (hash.digest('hex') !== target.expectedSha256.toLowerCase()) {
		return {ok: false, cause: '物化后文件 SHA-256 校验失败'};
	}
	try {
		const fd = openSync(tempPath, 'r+');
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		return {ok: false, cause: errorCause(error) ?? 'fsync 更新文件失败'};
	}
	return {ok: true};
}

export async function downloadUpdate(
	plan: SelfUpdatePlan,
	signal?: AbortSignal,
	deps: DownloadUpdateDeps = {}
): Promise<DownloadUpdateResult> {
	const fetchImpl = deps.fetch ?? fetch;
	const targetPath = deps.targetPath ?? getSelfUpdateTargetPath();
	const platform = deps.platform ?? process.platform;
	const maxAttempts = Math.max(1, Math.floor(deps.maxAttempts ?? SELF_UPDATE_MAX_ATTEMPTS));
	const backoffMs = deps.backoffMs ?? SELF_UPDATE_BACKOFF_MS;
	const noProgressMs = deps.timeoutMs ?? deps.noProgressTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
	const overallCapMs = deps.overallTimeoutMs ?? SELF_UPDATE_OVERALL_CAP_MS;

	const controller = new AbortController();
	let timedOut = false;
	const abortFromCaller = (): void => controller.abort();
	signal?.addEventListener('abort', abortFromCaller, {once: true});
	if (signal?.aborted) controller.abort();

	// 无进展超时可重置：慢但持续前进的下载不会被固定墙钟误杀。
	let noProgressTimer: ReturnType<typeof setTimeout> | null = null;
	const armNoProgress = (): void => {
		if (noProgressTimer) clearTimeout(noProgressTimer);
		noProgressTimer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, noProgressMs);
	};
	const overallTimer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, overallCapMs);
	armNoProgress();

	let lastError = '下载或写入更新文件失败';
	let lastStatus: number | undefined;
	try {
		mkdirSync(dirname(targetPath), {recursive: true, mode: 0o700});
		cleanupTransportCache();
		const transports = plan.transports.length > 0 ? plan.transports : [{...plan.target, encoding: 'identity' as const}];

		for (const transport of transports) {
			armNoProgress();
			const opened = openTransportCache({
				version: plan.version,
				platform,
				assetName: transport.assetName,
				encoding: transport.encoding,
				expectedSize: transport.expectedSize,
				expectedSha256: transport.expectedSha256,
				targetSha256: plan.target.expectedSha256
			});
			if (!opened.ok) {
				lastError = opened.message;
				if (opened.reason === 'busy') break;
				continue;
			}

			// 每个 transport 是显式的进度总量：切换时重置为该 transport 的字节数。
			let lastPercentage = -1;
			let lastReportedBytes = -1;
			const report = (bytes: number): void => {
				if (bytes < lastReportedBytes) return;
				const percentage = Math.min(100, Math.floor((bytes / transport.expectedSize) * 100));
				if (percentage === lastPercentage) return;
				lastPercentage = percentage;
				lastReportedBytes = bytes;
				deps.onProgress?.(
					Object.freeze({
						downloadedBytes: bytes,
						totalBytes: transport.expectedSize,
						percentage,
						assetName: transport.assetName,
						encoding: transport.encoding
					})
				);
			};
			report(0);

			try {
				let outcome: TransportFetchOutcome | null = null;
				let offset = opened.offset;
				let hash = opened.hash;
				if (offset === transport.expectedSize) {
					const digest = hash.copy().digest('hex');
					outcome =
						digest === transport.expectedSha256.toLowerCase()
							? {kind: 'complete', digest, size: offset}
							: {kind: 'permanent', cause: 'transport SHA-256 校验失败'};
					if (outcome.kind === 'complete') report(offset);
				} else {
					for (let attempt = 0; attempt < maxAttempts; attempt++) {
						outcome = await fetchTransportIntoCache(
							transport,
							opened.payloadPath,
							opened.leasePath,
							offset,
							hash,
							fetchImpl,
							controller.signal,
							bytes => {
								offset = bytes;
								armNoProgress();
								report(bytes);
							}
						);
						if (outcome.kind !== 'retryable') break;
						lastError = outcome.cause;
						lastStatus = outcome.status;
						if (controller.signal.aborted) break;
						if (outcome.status === 200) {
							// Range 被忽略：作废分片，下一次尝试从零开始；公开进度保持单调。
							removeFileBestEffort(opened.payloadPath);
							offset = 0;
							hash = createHash('sha256');
						}
						if (attempt + 1 < maxAttempts) {
							const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 1000;
							heartbeatTransportLease(opened.leasePath);
							await waitForBackoff(delay, controller.signal);
						}
						if (controller.signal.aborted) break;
					}
				}

				if (controller.signal.aborted) {
					// 只有 caller cancel 删除当前 transport；timeout/进程退出保留。
					if (signal?.aborted) removeTransportCacheEntry(transport.expectedSha256);
					break;
				}
				if (!outcome || outcome.kind !== 'complete') {
					if (outcome) {
						lastError = outcome.cause;
						lastStatus = outcome.status;
						// 永久性 transport 失败（含完整性不符）作废分片，再尝试下一个 transport。
						if (outcome.kind === 'permanent') removeTransportCacheEntry(transport.expectedSha256);
					}
					continue;
				}

				const tempPath = uniqueTempUpdatePath(targetPath);
				const materialized = await materializeRawTemp(
					opened.payloadPath,
					transport.encoding,
					plan.target,
					tempPath,
					controller.signal
				);
				if (!materialized.ok) {
					removeFileBestEffort(tempPath);
					if (controller.signal.aborted) {
						// timeout 保留已验证 transport；caller cancel 才显式删除。
						if (signal?.aborted) removeTransportCacheEntry(transport.expectedSha256);
						lastError = materialized.cause;
						break;
					}
					removeTransportCacheEntry(transport.expectedSha256);
					lastError = materialized.cause;
					continue;
				}

				if (platform !== 'win32') chmodSync(tempPath, 0o755);
				// 只有拿到已验证 raw transaction 之后才删除已消费缓存。
				removeTransportCacheEntry(transport.expectedSha256);
				return {ok: true, transaction: Object.freeze({plan, targetPath, tempPath})};
			} finally {
				releaseTransportLease(opened.leasePath);
			}
		}

		const cancelled = signal?.aborted === true;
		const message = cancelled ? '下载已取消' : timedOut ? '下载超时' : lastError;
		return {
			ok: false,
			error: makeSelfUpdateError('download', message, {
				status: lastStatus,
				targetPath
			})
		};
	} catch (error) {
		const cancelled = signal?.aborted === true;
		const message = cancelled ? '下载已取消' : timedOut ? '下载超时' : '下载或写入更新文件失败';
		return {
			ok: false,
			error: makeSelfUpdateError('download', message, {cause: safeDownloadCause(error), targetPath})
		};
	} finally {
		if (noProgressTimer) clearTimeout(noProgressTimer);
		clearTimeout(overallTimer);
		signal?.removeEventListener('abort', abortFromCaller);
	}
}

function sha256File(filePath: string): string {
	const hash = createHash('sha256');
	const fd = openSync(filePath, 'r');
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		while (true) {
			const count = readSync(fd, buffer, 0, buffer.byteLength, null);
			if (count === 0) break;
			hash.update(buffer.subarray(0, count));
		}
		return hash.digest('hex');
	} finally {
		closeSync(fd);
	}
}

function validateTransaction(transaction: DownloadedSelfUpdate): void {
	const targetDirectory = dirname(resolve(transaction.targetPath));
	const tempDirectory = dirname(resolve(transaction.tempPath));
	const expectedPrefix = '.' + basename(transaction.targetPath) + '.update-';
	if (targetDirectory !== tempDirectory || !basename(transaction.tempPath).startsWith(expectedPrefix)) {
		throw new Error('更新事务路径不匹配');
	}
	if (!existsSync(transaction.tempPath)) {
		throw new Error('更新临时文件不存在，请重新下载');
	}
	const stat = statSync(transaction.tempPath);
	if (stat.size !== transaction.plan.target.expectedSize) {
		throw new Error('更新临时文件大小校验失败');
	}
	if (sha256File(transaction.tempPath) !== transaction.plan.target.expectedSha256.toLowerCase()) {
		throw new Error('更新临时文件 SHA-256 校验失败');
	}
}

export const WINDOWS_HELPER_COPY_MAX_ATTEMPTS = WINDOWS_HELPER_MAX_ATTEMPTS;
export const WINDOWS_HELPER_COPY_INTERVAL_MS = WINDOWS_HELPER_INTERVAL_MS;

export function buildWindowsUpdateHelperScript(): string {
	return [
		'param(',
		'  [int]$ParentPid,',
		'  [string]$TempPath,',
		'  [string]$TargetPath,',
		'  [string]$WorkingDirectory,',
		'  [long]$ExpectedSize,',
		'  [string]$ExpectedSha256,',
		'  [string]$ReadyPath,',
		'  [switch]$RestartAfterApply',
		')',
		'$ErrorActionPreference = "Stop"',
		'$logPath = Join-Path $env:TEMP "ccq-update.log"',
		'function Write-UpdateLog($msg) {',
		'  try { Add-Content -LiteralPath $logPath -Value ("[{0}] [pid {1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $PID, $msg) -ErrorAction SilentlyContinue } catch {}',
		'}',
		'function Exit-Update($code) {',
		'  if ($ReadyPath) { Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue }',
		'  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
		'  exit $code',
		'}',
		'function Get-Sha256($Path) {',
		'  $stream = [System.IO.File]::OpenRead($Path)',
		'  try {',
		'    $sha256 = [System.Security.Cryptography.SHA256]::Create()',
		'    try {',
		'      return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()',
		'    } finally {',
		'      $sha256.Dispose()',
		'    }',
		'  } finally {',
		'    $stream.Dispose()',
		'  }',
		'}',
		'$BackupPath = $PSCommandPath + ".backup"',
		'function Test-ExpectedFile($Path) {',
		'  try {',
		'    if (-not (Test-Path -LiteralPath $Path)) { return $false }',
		'    return ((Get-Item -LiteralPath $Path).Length -eq $ExpectedSize -and (Get-Sha256 $Path) -eq $ExpectedSha256.ToLowerInvariant())',
		'  } catch {',
		'    return $false',
		'  }',
		'}',
		'function Restore-Target {',
		'  if (-not (Test-Path -LiteralPath $BackupPath)) { return $false }',
		'  try {',
		'    if (Test-Path -LiteralPath $TargetPath) {',
		'      [System.IO.File]::Replace($BackupPath, $TargetPath, $null, $true)',
		'    } else {',
		'      [System.IO.File]::Move($BackupPath, $TargetPath)',
		'    }',
		'    Write-UpdateLog "target restore succeeded"',
		'    return $true',
		'  } catch {',
		'    Write-UpdateLog "target restore failed"',
		'    return $false',
		'  }',
		'}',
		'try {',
		'  Write-UpdateLog "helper start: parent=$ParentPid restart=$RestartAfterApply"',
		'  if ($ReadyPath) { Set-Content -LiteralPath $ReadyPath -Value $PID -NoNewline }',
		'  Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue',
		'  if (-not (Test-Path -LiteralPath $TempPath)) { Write-UpdateLog "temp missing"; Exit-Update 1 }',
		'  $tempSize = (Get-Item -LiteralPath $TempPath).Length',
		'  $tempHash = Get-Sha256 $TempPath',
		'  if ($tempSize -ne $ExpectedSize -or $tempHash -ne $ExpectedSha256.ToLowerInvariant()) {',
		'    Write-UpdateLog "temp verification failed"',
		'    Exit-Update 1',
		'  }',
		'  $targetDir = Split-Path -Parent $TargetPath',
		'  if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }',
		'  $replaced = $false',
		'  for ($i = 1; $i -le ' + WINDOWS_HELPER_MAX_ATTEMPTS + '; $i++) {',
		'    try {',
		'      if (Test-Path -LiteralPath $TargetPath) {',
		'        [System.IO.File]::Replace($TempPath, $TargetPath, $BackupPath, $true)',
		'      } else {',
		'        [System.IO.File]::Move($TempPath, $TargetPath)',
		'      }',
		'      $replaced = $true',
		'      Write-UpdateLog "replace succeeded on attempt $i"',
		'      break',
		'    } catch {',
		'      if (Test-ExpectedFile $TargetPath) {',
		'        $replaced = $true',
		'        Write-UpdateLog "replace completed despite reported error"',
		'        break',
		'      }',
		'      Write-UpdateLog "replace attempt $i failed"',
		'      Start-Sleep -Milliseconds ' + WINDOWS_HELPER_INTERVAL_MS,
		'    }',
		'  }',
		'  if (-not $replaced) { Write-UpdateLog "replace failed after all attempts, keeping temp file"; Exit-Update 1 }',
		'  if (-not (Test-ExpectedFile $TargetPath)) {',
		'    Write-UpdateLog "target verification failed, restoring old target"',
		'    [void](Restore-Target)',
		'    Exit-Update 1',
		'  }',
		'  Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue',
		'  Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue',
		'  if ($RestartAfterApply) {',
		'    Write-UpdateLog "starting updated executable"',
		'    if ($WorkingDirectory -and (Test-Path -LiteralPath $WorkingDirectory)) {',
		'      Start-Process -FilePath $TargetPath -WorkingDirectory $WorkingDirectory',
		'    } else {',
		'      Start-Process -FilePath $TargetPath',
		'    }',
		'  }',
		'  Write-UpdateLog "update completed"',
		'  Exit-Update 0',
		'} catch {',
		'  Write-UpdateLog "helper failed"',
		'  [void](Restore-Target)',
		'  Exit-Update 1',
		'}',
		''
	].join('\r\n');
}

async function startWindowsUpdateHelper(
	transaction: DownloadedSelfUpdate,
	restartAfterApply: boolean,
	spawnProcess?: SpawnProcess
): Promise<ApplySelfUpdateResult> {
	const helperPath = uniqueWindowsHelperPath(dirname(transaction.targetPath), 'ccq-update');
	try {
		writeFileSync(helperPath, buildWindowsUpdateHelperScript(), {encoding: 'utf8', flag: 'wx'});
		const args = [
			'-ParentPid',
			String(process.pid),
			'-TempPath',
			transaction.tempPath,
			'-TargetPath',
			transaction.targetPath,
			'-WorkingDirectory',
			process.cwd(),
			'-ExpectedSize',
			String(transaction.plan.target.expectedSize),
			'-ExpectedSha256',
			transaction.plan.target.expectedSha256
		];
		if (restartAfterApply) args.push('-RestartAfterApply');
		await spawnDetachedPowerShell(helperPath, args, spawnProcess);
		return {
			ok: true,
			state: 'scheduled',
			targetPath: transaction.targetPath,
			restartStarted: restartAfterApply,
			helperPath
		};
	} catch (error) {
		removeFileBestEffort(helperPath);
		return {
			ok: false,
			error: makeSelfUpdateError('apply', '启动 Windows 更新 helper 失败', {
				cause: errorCause(error),
				targetPath: transaction.targetPath,
				tempPath: transaction.tempPath
			})
		};
	}
}

export async function applyUpdate(transaction: DownloadedSelfUpdate, options: ApplyUpdateOptions = {}): Promise<ApplySelfUpdateResult> {
	const platform = options.platform ?? process.platform;
	try {
		validateTransaction(transaction);
	} catch (error) {
		return {
			ok: false,
			error: makeSelfUpdateError('apply', '更新事务已失效，请重新下载', {
				retryStage: 'download',
				cause: errorCause(error),
				targetPath: transaction.targetPath,
				tempPath: transaction.tempPath
			})
		};
	}
	try {
		if (platform === 'win32') {
			return startWindowsUpdateHelper(transaction, options.restartAfterApply ?? false, options.spawnProcess);
		}
		const chmodFile = options.chmodFile ?? chmodSync;
		const openFile = options.openFile ?? ((filePath: string, flags: string) => openSync(filePath, flags));
		const fsyncFile = options.fsyncFile ?? fsyncSync;
		const closeFile = options.closeFile ?? closeSync;
		const renameFile = options.renameFile ?? renameSync;
		chmodFile(transaction.tempPath, 0o755);
		const fd = openFile(transaction.tempPath, 'r');
		try {
			fsyncFile(fd);
		} finally {
			closeFile(fd);
		}
		renameFile(transaction.tempPath, transaction.targetPath);
		return {
			ok: true,
			state: 'applied',
			targetPath: transaction.targetPath,
			restartStarted: false
		};
	} catch (error) {
		return {
			ok: false,
			error: makeSelfUpdateError('apply', '替换 ccq 可执行文件失败', {
				cause: errorCause(error),
				targetPath: transaction.targetPath,
				tempPath: transaction.tempPath
			})
		};
	}
}

export async function cleanupTempUpdate(transaction?: DownloadedSelfUpdate): Promise<void> {
	if (transaction) removeFileBestEffort(transaction.tempPath);
}

export async function restartExecutable(
	targetPath = getSelfUpdateTargetPath(),
	spawnProcess: SpawnProcess = nodeSpawn
): Promise<ApplySelfUpdateResult> {
	try {
		const child = spawnProcess(targetPath, [], {
			detached: true,
			stdio: 'inherit',
			cwd: process.cwd()
		});
		await new Promise<void>((resolve, reject) => {
			child.once('spawn', resolve);
			child.once('error', reject);
		});
		child.unref();
		return {ok: true, state: 'scheduled', targetPath, restartStarted: true};
	} catch (error) {
		return {
			ok: false,
			error: makeSelfUpdateError('apply', '重启 ccq 失败，请手动重新运行 ccq', {
				cause: errorCause(error),
				targetPath
			})
		};
	}
}
