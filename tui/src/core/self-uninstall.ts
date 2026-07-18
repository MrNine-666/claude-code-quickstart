import {existsSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {
	spawnDetachedPowerShell,
	uniqueWindowsHelperPath,
	WINDOWS_HELPER_INTERVAL_MS,
	WINDOWS_HELPER_MAX_ATTEMPTS
} from './windows-deferred-operation.js';

export type SelfUninstallError = {
	readonly message: string;
	readonly cause?: string;
	readonly targetPath: string;
	readonly helperPath?: string;
};

export type SelfUninstallResult =
	| {
		readonly ok: true;
		readonly state: 'absent' | 'deleted' | 'scheduled';
		readonly targetPath: string;
		readonly helperPath?: string;
	}
	| {readonly ok: false; readonly error: SelfUninstallError};

export type StartWindowsUninstallArgs = {
	readonly targetPath: string;
	readonly parentPid: number;
};

export type SelfUninstallDeps = {
	readonly platform?: NodeJS.Platform;
	readonly execPath?: string;
	readonly removeFile?: typeof rmSync;
	readonly startWindowsHelper?: (args: StartWindowsUninstallArgs) => Promise<{readonly helperPath: string}>;
};

function errorCause(error: unknown): string | undefined {
	return error instanceof Error ? error.message : String(error ?? '').trim() || undefined;
}

function canonicalPath(filePath: string, platform: NodeJS.Platform): string {
	let canonical: string;
	try {
		canonical = realpathSync.native(filePath);
	} catch {
		canonical = resolve(filePath);
	}
	return platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function sameExecutablePath(first: string, second: string, platform: NodeJS.Platform): boolean {
	return canonicalPath(first, platform) === canonicalPath(second, platform);
}

export function buildWindowsUninstallHelperScript(): string {
	return [
		'param(',
		'  [int]$ParentPid,',
		'  [string]$TargetPath,',
		'  [string]$ReadyPath',
		')',
		'$ErrorActionPreference = "Stop"',
		'$logPath = Join-Path $env:TEMP "ccq-uninstall.log"',
		'function Write-UninstallLog($msg) {',
		'  try { Add-Content -LiteralPath $logPath -Value ("[{0}] [pid {1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $PID, $msg) -ErrorAction SilentlyContinue } catch {}',
		'}',
		'function Exit-Uninstall($code) {',
		'  if ($ReadyPath) { Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue }',
		'  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
		'  exit $code',
		'}',
		'Write-UninstallLog "helper start: parent=$ParentPid"',
		'if ($ReadyPath) { Set-Content -LiteralPath $ReadyPath -Value $PID -NoNewline }',
		'Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue',
		'for ($i = 1; $i -le ' + WINDOWS_HELPER_MAX_ATTEMPTS + '; $i++) {',
		'  try {',
		'    Remove-Item -LiteralPath $TargetPath -Force -ErrorAction Stop',
		'    if (-not (Test-Path -LiteralPath $TargetPath)) {',
		'      Write-UninstallLog "delete succeeded on attempt $i"',
		'      Exit-Uninstall 0',
		'    }',
		'  } catch {',
		'    Write-UninstallLog "delete attempt $i failed"',
		'  }',
		'  Start-Sleep -Milliseconds ' + WINDOWS_HELPER_INTERVAL_MS,
		'}',
		'Write-UninstallLog "delete failed after all attempts"',
		'Exit-Uninstall 1',
		''
	].join('\r\n');
}

export async function startWindowsUninstallHelper(
	args: StartWindowsUninstallArgs
): Promise<{readonly helperPath: string}> {
	const helperPath = uniqueWindowsHelperPath(tmpdir(), 'ccq-uninstall');
	try {
		writeFileSync(helperPath, buildWindowsUninstallHelperScript(), {encoding: 'utf8', flag: 'wx'});
		await spawnDetachedPowerShell(helperPath, [
			'-ParentPid', String(args.parentPid),
			'-TargetPath', args.targetPath
		]);
		return {helperPath};
	} catch (error) {
		try { rmSync(helperPath, {force: true}); } catch {}
		throw error;
	}
}

export async function uninstallSelfExecutable(
	targetPath: string,
	deps: SelfUninstallDeps = {}
): Promise<SelfUninstallResult> {
	if (!existsSync(targetPath)) {
		return {ok: true, state: 'absent', targetPath};
	}

	const platform = deps.platform ?? process.platform;
	const execPath = deps.execPath ?? process.execPath;
	if (platform === 'win32' && sameExecutablePath(targetPath, execPath, platform)) {
		try {
			const startHelper = deps.startWindowsHelper ?? startWindowsUninstallHelper;
			const {helperPath} = await startHelper({targetPath, parentPid: process.pid});
			return {ok: true, state: 'scheduled', targetPath, helperPath};
		} catch (error) {
			return {ok: false, error: {
				message: '无法启动 Windows 延迟卸载助手',
				cause: errorCause(error),
				targetPath
			}};
		}
	}

	try {
		(deps.removeFile ?? rmSync)(targetPath, {force: true});
		return {ok: true, state: 'deleted', targetPath};
	} catch (error) {
		return {ok: false, error: {
			message: '删除 ccq 可执行文件失败',
			cause: errorCause(error),
			targetPath
		}};
	}
}
