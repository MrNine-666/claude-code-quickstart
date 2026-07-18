import {
	chmodSync,
	closeSync,
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
import {createHash, randomBytes} from 'node:crypto';
import {spawn as nodeSpawn} from 'node:child_process';
import {resolveHome} from './paths.js';
import {parseSemver, semverCompare} from './semver.js';
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

export type SelfUpdatePlan = {
	readonly version: string;
	readonly assetName: string;
	readonly downloadUrl: string;
	readonly expectedSize: number;
	readonly expectedSha256: string;
};

export type DownloadedSelfUpdate = {
	readonly plan: SelfUpdatePlan;
	readonly targetPath: string;
	readonly tempPath: string;
};

export type SelfUpdateStage = 'check' | 'download' | 'apply';

export type SelfUpdateError = {
	readonly stage: SelfUpdateStage;
	readonly message: string;
	readonly cause?: string;
	readonly status?: number;
	readonly targetPath?: string;
	readonly tempPath?: string;
};

export type CheckLatestVersionResult =
	| {readonly ok: true; readonly hasUpdate: false; readonly currentVersion: string; readonly latestVersion: string}
	| {readonly ok: true; readonly hasUpdate: true; readonly currentVersion: string; readonly latestVersion: string; readonly plan: SelfUpdatePlan}
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
	readonly timeoutMs?: number;
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

		const data = await response.json() as LatestReleaseResponse;
		const latestVersion = data.tag_name?.trim().replace(/^v/i, '');
		if (!latestVersion) {
			return {ok: false, error: makeSelfUpdateError('check', 'GitHub Release 响应缺少 tag_name')};
		}
		if (!parseSemver(currentVersion) || !parseSemver(latestVersion)) {
			return {ok: false, error: makeSelfUpdateError('check', '当前版本或 Release 版本不是合法 semver')};
		}
		if (semverCompare(latestVersion, currentVersion) <= 0) {
			return {ok: true, hasUpdate: false, currentVersion, latestVersion};
		}

		let assetName: string;
		try {
			assetName = getAssetName(platform, arch);
		} catch (error) {
			return {ok: false, error: makeSelfUpdateError('check', '不支持当前平台或架构', {cause: errorCause(error)})};
		}
		const asset = (data.assets ?? []).find(item => item.name === assetName);
		if (!asset?.browser_download_url) {
			return {ok: false, error: makeSelfUpdateError('check', 'Release 缺少当前平台产物 ' + assetName)};
		}
		if (!Number.isSafeInteger(asset.size) || Number(asset.size) <= 0) {
			return {ok: false, error: makeSelfUpdateError('check', 'Release asset size 无效')};
		}
		const expectedSha256 = parseDigest(asset.digest);
		if (!expectedSha256) {
			return {ok: false, error: makeSelfUpdateError('check', 'Release asset 缺少合法 SHA-256 digest')};
		}

		return {
			ok: true,
			hasUpdate: true,
			currentVersion,
			latestVersion,
			plan: Object.freeze({
				version: latestVersion,
				assetName,
				downloadUrl: asset.browser_download_url,
				expectedSize: Number(asset.size),
				expectedSha256
			})
		};
	} catch (error) {
		const message = controller.signal.aborted ? '检查更新超时' : '无法连接 GitHub Release';
		return {ok: false, error: makeSelfUpdateError('check', message, {cause: errorCause(error)})};
	} finally {
		clearTimeout(timeout);
	}
}

function uniqueTempUpdatePath(targetPath: string): string {
	return join(
		dirname(targetPath),
		'.' + basename(targetPath) + '.update-' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp'
	);
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

export async function downloadUpdate(
	plan: SelfUpdatePlan,
	signal?: AbortSignal,
	deps: DownloadUpdateDeps = {}
): Promise<DownloadUpdateResult> {
	const fetchAsset = deps.fetch ?? fetch;
	const targetPath = deps.targetPath ?? getSelfUpdateTargetPath();
	const platform = deps.platform ?? process.platform;
	const tempPath = uniqueTempUpdatePath(targetPath);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
	const abortFromCaller = (): void => controller.abort();
	signal?.addEventListener('abort', abortFromCaller, {once: true});
	if (signal?.aborted) controller.abort();
	let fd: number | null = null;
	try {
		mkdirSync(dirname(targetPath), {recursive: true, mode: 0o700});
		const response = await fetchAsset(plan.downloadUrl, {signal: controller.signal});
		if (!response.ok) {
			return {ok: false, error: makeSelfUpdateError('download', '下载 Release asset 失败', {
				status: response.status,
				targetPath,
				tempPath
			})};
		}
		if (!response.body) {
			return {ok: false, error: makeSelfUpdateError('download', '下载响应没有可读取内容', {targetPath, tempPath})};
		}

		fd = openSync(tempPath, 'wx', 0o700);
		const reader = response.body.getReader();
		const hash = createHash('sha256');
		let size = 0;
		while (true) {
			const {done, value} = await reader.read();
			if (done) break;
			if (!value) continue;
			size += value.byteLength;
			if (size > plan.expectedSize) {
				throw new Error('下载文件大小超过 Release 声明');
			}
			hash.update(value);
			writeChunk(fd, value);
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = null;

		const digest = hash.digest('hex');
		if (size !== plan.expectedSize) {
			throw new Error('下载文件大小与 Release 声明不一致');
		}
		if (digest !== plan.expectedSha256.toLowerCase()) {
			throw new Error('下载文件 SHA-256 校验失败');
		}
		if (platform !== 'win32') chmodSync(tempPath, 0o755);
		return {ok: true, transaction: Object.freeze({plan, targetPath, tempPath})};
	} catch (error) {
		if (fd !== null) {
			try { closeSync(fd); } catch {}
		}
		removeFileBestEffort(tempPath);
		const cancelled = signal?.aborted === true;
		const timedOut = controller.signal.aborted && !cancelled;
		const message = cancelled ? '下载已取消' : (timedOut ? '下载超时' : '下载或写入更新文件失败');
		return {ok: false, error: makeSelfUpdateError('download', message, {
			cause: errorCause(error),
			targetPath,
			tempPath
		})};
	} finally {
		clearTimeout(timeout);
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
	if (stat.size !== transaction.plan.expectedSize) {
		throw new Error('更新临时文件大小校验失败');
	}
	if (sha256File(transaction.tempPath) !== transaction.plan.expectedSha256.toLowerCase()) {
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
		'Write-UpdateLog "helper start: parent=$ParentPid restart=$RestartAfterApply"',
		'if ($ReadyPath) { Set-Content -LiteralPath $ReadyPath -Value $PID -NoNewline }',
		'Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue',
		'if (-not (Test-Path -LiteralPath $TempPath)) { Write-UpdateLog "temp missing"; Exit-Update 1 }',
		'$tempSize = (Get-Item -LiteralPath $TempPath).Length',
		'$tempHash = Get-Sha256 $TempPath',
		'if ($tempSize -ne $ExpectedSize -or $tempHash -ne $ExpectedSha256.ToLowerInvariant()) {',
		'  Write-UpdateLog "temp verification failed"',
		'  Exit-Update 1',
		'}',
		'$targetDir = Split-Path -Parent $TargetPath',
		'if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }',
		'$copied = $false',
		'for ($i = 1; $i -le ' + WINDOWS_HELPER_MAX_ATTEMPTS + '; $i++) {',
		'  try {',
		'    Copy-Item -LiteralPath $TempPath -Destination $TargetPath -Force',
		'    $copied = $true',
		'    Write-UpdateLog "copy succeeded on attempt $i"',
		'    break',
		'  } catch {',
		'    Write-UpdateLog "copy attempt $i failed"',
		'    Start-Sleep -Milliseconds ' + WINDOWS_HELPER_INTERVAL_MS,
		'  }',
		'}',
		'if (-not $copied) { Write-UpdateLog "copy failed after all attempts, keeping temp file"; Exit-Update 1 }',
		'$targetSize = (Get-Item -LiteralPath $TargetPath).Length',
		'$targetHash = Get-Sha256 $TargetPath',
		'if ($targetSize -ne $ExpectedSize -or $targetHash -ne $ExpectedSha256.ToLowerInvariant()) {',
		'  Write-UpdateLog "target verification failed, keeping temp file"',
		'  Exit-Update 1',
		'}',
		'Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue',
		'if ($RestartAfterApply) {',
		'  Write-UpdateLog "starting updated executable"',
		'  if ($WorkingDirectory -and (Test-Path -LiteralPath $WorkingDirectory)) {',
		'    Start-Process -FilePath $TargetPath -WorkingDirectory $WorkingDirectory',
		'  } else {',
		'    Start-Process -FilePath $TargetPath',
		'  }',
		'}',
		'Write-UpdateLog "update completed"',
		'Exit-Update 0',
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
			'-ParentPid', String(process.pid),
			'-TempPath', transaction.tempPath,
			'-TargetPath', transaction.targetPath,
			'-WorkingDirectory', process.cwd(),
			'-ExpectedSize', String(transaction.plan.expectedSize),
			'-ExpectedSha256', transaction.plan.expectedSha256
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
		return {ok: false, error: makeSelfUpdateError('apply', '启动 Windows 更新 helper 失败', {
			cause: errorCause(error),
			targetPath: transaction.targetPath,
			tempPath: transaction.tempPath
		})};
	}
}

export async function applyUpdate(
	transaction: DownloadedSelfUpdate,
	options: ApplyUpdateOptions = {}
): Promise<ApplySelfUpdateResult> {
	const platform = options.platform ?? process.platform;
	try {
		validateTransaction(transaction);
		if (platform === 'win32') {
			return startWindowsUpdateHelper(
				transaction,
				options.restartAfterApply ?? false,
				options.spawnProcess
			);
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
		return {ok: false, error: makeSelfUpdateError('apply', '替换 ccq 可执行文件失败', {
			cause: errorCause(error),
			targetPath: transaction.targetPath,
			tempPath: transaction.tempPath
		})};
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
		return {ok: false, error: makeSelfUpdateError('apply', '重启 ccq 失败，请手动重新运行 ccq', {
			cause: errorCause(error),
			targetPath
		})};
	}
}
