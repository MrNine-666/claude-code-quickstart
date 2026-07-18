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

async function waitForReadyFile(readyPath: string): Promise<void> {
	const deadline = Date.now() + WINDOWS_HELPER_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (existsSync(readyPath)) return;
		await new Promise(resolve => setTimeout(resolve, WINDOWS_HELPER_READY_POLL_MS));
	}
	throw new Error('Windows helper did not report ready state');
}

export async function spawnDetachedPowerShell(
	helperPath: string,
	args: readonly string[],
	spawnProcess: SpawnProcess = nodeSpawn
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
		await waitForSpawn(child);
		await waitForReadyFile(readyPath);
		child.unref();
	} finally {
		try { rmSync(readyPath, {force: true}); } catch {}
	}
}
