import {randomBytes} from 'node:crypto';
import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';

export const WINDOWS_HELPER_MAX_ATTEMPTS = 20;
export const WINDOWS_HELPER_INTERVAL_MS = 250;

export type SpawnProcess = typeof nodeSpawn;

const WINDOWS_HELPER_READY_TIMEOUT_MS = 5000;
const WINDOWS_HELPER_READY_POLL_MS = 25;

export function uniqueWindowsHelperPath(directory: string, prefix: string): string {
	return join(directory, '.' + prefix + '-' + process.pid + '-' + randomBytes(6).toString('hex') + '.ps1');
}

function waitForSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const onSpawn = (): void => {
			child.off('error', onError);
			resolve();
		};
		const onError = (error: Error): void => {
			child.off('spawn', onSpawn);
			reject(error);
		};
		child.once('spawn', onSpawn);
		child.once('error', onError);
	});
}

// ready 文件握手仅作 best-effort 同步：确认 detached helper 已进入脚本体。
// helper 已 detached 且内部 `Wait-Process -ErrorAction SilentlyContinue` 能正确
// 处理父进程先退出的情形，故 ready 迟到（CI 冷启动 + Defender 扫描新 .ps1 可能 >5s）
// 不应否决一个本会完成的删除/替换——返回是否观察到 ready，调用方据此记录但不失败。
async function waitForReadyFile(readyPath: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(readyPath)) return true;
		await new Promise(resolve => setTimeout(resolve, WINDOWS_HELPER_READY_POLL_MS));
	}
	return false;
}

export async function spawnDetachedPowerShell(
	helperPath: string,
	args: readonly string[],
	spawnProcess: SpawnProcess = nodeSpawn,
	readyTimeoutMs: number = WINDOWS_HELPER_READY_TIMEOUT_MS
): Promise<void> {
	const readyPath = helperPath + '.ready';
	const child = spawnProcess('powershell.exe', [
		'-NoProfile',
		'-ExecutionPolicy',
		'Bypass',
		'-File',
		helperPath,
		'-ReadyPath',
		readyPath,
		...args
	], {
		detached: true,
		stdio: 'ignore',
		windowsHide: true
	});
	try {
		// spawn 事件是唯一的致命门槛：进程未能创建才是真正的调度失败。
		await waitForSpawn(child);
		// ready 超时非致命：helper 已在运行，会独立完成其延迟操作。
		await waitForReadyFile(readyPath, readyTimeoutMs);
		child.unref();
	} finally {
		try { rmSync(readyPath, {force: true}); } catch {}
	}
}
