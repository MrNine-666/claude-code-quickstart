import {randomBytes} from 'node:crypto';
import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';

export const WINDOWS_HELPER_MAX_ATTEMPTS = 20;
export const WINDOWS_HELPER_INTERVAL_MS = 250;

export type SpawnProcess = typeof nodeSpawn;

export const WINDOWS_HELPER_READY_TIMEOUT_MS = 30000;
const WINDOWS_HELPER_READY_POLL_MS = 25;

export function uniqueWindowsHelperPath(directory: string, prefix: string): string {
	return join(directory, '.' + prefix + '-' + process.pid + '-' + randomBytes(6).toString('hex') + '.ps1');
}

function waitForBootstrap(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = (): void => {
			child.off('error', onError);
			child.off('exit', onExit);
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			cleanup();
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Windows helper bootstrap failed: ${code ?? signal ?? 'unknown exit'}`));
		};
		child.once('error', onError);
		child.once('exit', onExit);
	});
}

async function waitForReadyFile(readyPath: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(readyPath)) return;
		await new Promise(resolve => setTimeout(resolve, WINDOWS_HELPER_READY_POLL_MS));
	}
	throw new Error('Windows helper did not report ready state');
}

function quotePowerShellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function encodePowerShellInvocation(helperPath: string, readyPath: string, args: readonly string[]): string {
	const renderedArgs = args.map(arg => (/^-[A-Za-z][A-Za-z0-9-]*$/.test(arg) ? arg : quotePowerShellLiteral(arg)));
	const command = [`& ${quotePowerShellLiteral(helperPath)}`, `-ReadyPath ${quotePowerShellLiteral(readyPath)}`, ...renderedArgs].join(
		' '
	);
	return Buffer.from(command, 'utf16le').toString('base64');
}

export async function spawnDetachedPowerShell(
	helperPath: string,
	args: readonly string[],
	spawnProcess: SpawnProcess = nodeSpawn,
	readyTimeoutMs: number = WINDOWS_HELPER_READY_TIMEOUT_MS
): Promise<void> {
	const readyPath = helperPath + '.ready';
	const encodedCommand = encodePowerShellInvocation(helperPath, readyPath, args);
	// Bun 1.3.14 keeps detached Windows children in its kill-on-close job object.
	// `start` creates the helper outside that job so it can outlive the ccq process.
	const child = spawnProcess(
		'cmd.exe',
		['/d', '/c', 'start', '', '/b', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
		{
			stdio: 'ignore',
			windowsHide: true
		}
	);
	try {
		await waitForBootstrap(child);
		await waitForReadyFile(readyPath, readyTimeoutMs);
	} finally {
		try {
			rmSync(readyPath, {force: true});
		} catch {}
	}
}
