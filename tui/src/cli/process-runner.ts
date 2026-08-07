import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {win32} from 'node:path';

export type LaunchProcess = {
	readonly exited: Promise<number>;
	readonly unref: () => void;
};

export type LaunchOptions = {
	readonly stdio: ['inherit', 'inherit', 'inherit'];
	readonly detached?: boolean;
};

/** Runtime dependencies for launch-class CLI commands. */
export type LaunchRuntime = {
	readonly platform: NodeJS.Platform;
	readonly which: (command: string) => string | null;
	readonly execve?: (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never;
	readonly spawn: (argv: string[], options: LaunchOptions) => LaunchProcess;
	readonly readFile?: (path: string) => string;
	readonly fileExists?: (path: string) => boolean;
	readonly listDirectory?: (path: string) => readonly string[];
	readonly localAppData?: string;
};

/** Production runtime; tests can pass a fake runtime to runWithInheritedTty. */
export const defaultLaunchRuntime: LaunchRuntime = {
	platform: process.platform,
	which: command => Bun.which(command),
	execve: process.execve?.bind(process),
	spawn: (argv, options) => Bun.spawn(argv, options),
	readFile: path => readFileSync(path, 'utf8'),
	fileExists: path => existsSync(path),
	listDirectory: path => readdirSync(path),
	localAppData: process.env.LOCALAPPDATA || win32.join(homedir(), 'AppData', 'Local')
};

function isAbsoluteExecutablePath(value: string): boolean {
	const normalized = normalizeWindowsPath(value);
	return normalized.toLowerCase().endsWith('.exe') && win32.isAbsolute(normalized);
}

function isWindowsAppsPath(value: string): boolean {
	return /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(value);
}

function normalizeWindowsPath(value: string): string {
	return win32.normalize(value.trim().replace(/^"|"$/g, '').replace(/\//g, '\\'));
}

function pathIsWithin(parentPath: string, childPath: string): boolean {
	const relative = win32.relative(win32.resolve(parentPath), win32.resolve(childPath));
	return (
		relative.length > 0 &&
		relative !== '..' &&
		!relative.startsWith('..\\') &&
		!relative.startsWith('../') &&
		!win32.isAbsolute(relative)
	);
}

function canReadExistingFile(fileExists: (path: string) => boolean, path: string): boolean {
	try {
		return fileExists(path);
	} catch {
		return false;
	}
}

function resolveWrapperExecutable(
	wrapperPath: string,
	readFile: (path: string) => string,
	fileExists: (path: string) => boolean
): string | null {
	const normalizedWrapperPath = normalizeWindowsPath(wrapperPath);
	let content: string;
	try {
		content = readFile(normalizedWrapperPath);
	} catch {
		return null;
	}

	const matches = [...content.matchAll(/^\s*"(%~?dp0%)([^"\r\n]+?\.exe)"(?:\s+%\*)?\s*$/gim)];
	const match = matches[0];
	if (matches.length !== 1 || !match || !match[2]) {
		return null;
	}

	const wrapperDirectory = win32.dirname(normalizedWrapperPath);
	const target = normalizeWindowsPath(win32.join(wrapperDirectory, match[2]));
	return isAbsoluteExecutablePath(target) &&
		!isWindowsAppsPath(target) &&
		pathIsWithin(wrapperDirectory, target) &&
		canReadExistingFile(fileExists, target)
		? target
		: null;
}

function findUserLocalCodexExecutable(
	localAppData: string | undefined,
	listDirectory: (path: string) => readonly string[],
	fileExists: (path: string) => boolean
): string | null {
	if (!localAppData) {
		return null;
	}

	const binDirectory = win32.join(localAppData, 'OpenAI', 'Codex', 'bin');
	let entries: readonly string[];
	try {
		entries = listDirectory(binDirectory);
	} catch {
		return null;
	}

	const candidates = [...entries]
		.filter(entry => entry.length > 0 && entry !== '.' && entry !== '..' && !/[\\/:]/.test(entry))
		.sort((left, right) => (left === right ? 0 : left < right ? 1 : -1))
		.map(entry => win32.join(binDirectory, entry, 'codex.exe'))
		.filter(
			candidate =>
				isAbsoluteExecutablePath(candidate) &&
				!isWindowsAppsPath(candidate) &&
				pathIsWithin(binDirectory, candidate) &&
				canReadExistingFile(fileExists, candidate)
		);

	return candidates[0] ?? null;
}

/**
 * Resolve a Windows launch-class command to a directly executable absolute `.exe`.
 * Shell wrappers are read only; they are never passed to Bun.spawn.
 */
export function resolveWindowsExecutable(command: string, runtime: LaunchRuntime = defaultLaunchRuntime): string | null {
	const fileExists = runtime.fileExists ?? existsSync;
	const readFile = runtime.readFile ?? (path => readFileSync(path, 'utf8'));
	const listDirectory = runtime.listDirectory ?? (path => readdirSync(path));
	let candidate: string | null = null;
	try {
		candidate = runtime.which(command);
	} catch {
		// PATH probing is best effort on Windows; continue to the Codex user-local fallback.
	}
	const normalizedCandidate = candidate ? normalizeWindowsPath(candidate) : null;

	if (
		normalizedCandidate &&
		isAbsoluteExecutablePath(normalizedCandidate) &&
		!isWindowsAppsPath(normalizedCandidate) &&
		canReadExistingFile(fileExists, normalizedCandidate)
	) {
		return normalizedCandidate;
	}

	if (normalizedCandidate && /\.cmd$/i.test(normalizedCandidate) && !isWindowsAppsPath(normalizedCandidate)) {
		const wrapperExecutable = resolveWrapperExecutable(normalizedCandidate, readFile, fileExists);
		if (wrapperExecutable) {
			return wrapperExecutable;
		}
	}

	if (command.toLowerCase() === 'codex') {
		return findUserLocalCodexExecutable(runtime.localAppData, listDirectory, fileExists);
	}

	return null;
}

function reportNonExecveWarning(warning: Error): void {
	const warningName = warning.name || 'Warning';
	console.error(`${warningName}: ${warning.message}`);
}

function isExecveExperimentalWarning(warning: Error): boolean {
	return warning.name === 'ExperimentalWarning' && warning.message.includes('process.execve');
}

/**
 * Launch a command with inherited TTYs, replacing this process on POSIX when possible.
 * POSIX keeps the inherited-stdio/exit-code contract. Windows launch-class commands are
 * fire-and-forget: they resolve a real `.exe`, detach it, unref the process handle, and
 * return immediately after the OS accepts the spawn request.
 */
export async function runWithInheritedTty(
	command: string,
	args: readonly string[],
	runtime: LaunchRuntime = defaultLaunchRuntime
): Promise<number> {
	if (runtime.platform === 'win32') {
		const executable = resolveWindowsExecutable(command, runtime);
		if (!executable) {
			throw new Error(`Executable not found: ${command}`);
		}

		const proc = runtime.spawn([executable, ...args], {
			stdio: ['inherit', 'inherit', 'inherit'],
			detached: true
		});
		proc.unref();
		return 0;
	}

	if (runtime.execve) {
		let executable: string | null = null;
		try {
			executable = runtime.which(command);
		} catch {
			// PATH 解析异常按命令不可用处理，交给 spawn/ENOENT 既有错误映射。
		}

		if (executable) {
			const argv = [command, ...args];
			const warningHandler = (warning: Error): void => {
				if (!isExecveExperimentalWarning(warning)) {
					reportNonExecveWarning(warning);
				}
			};

			process.on('warning', warningHandler);
			try {
				runtime.execve(executable, argv, process.env);
			} catch {
				// Bun may emit the experimental warning on a later turn after execve throws.
				process.nextTick(() => process.off('warning', warningHandler));
				return await runWithSpawn(command, args, runtime);
			}

			// execve is typed as never, but a runtime seam can return unexpectedly.
			process.nextTick(() => process.off('warning', warningHandler));
		}
	}

	return await runWithSpawn(command, args, runtime);
}

async function runWithSpawn(command: string, args: readonly string[], runtime: LaunchRuntime): Promise<number> {
	const proc = runtime.spawn([command, ...args], {
		stdio: ['inherit', 'inherit', 'inherit']
	});
	return await proc.exited;
}
