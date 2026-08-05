/** Runtime dependencies for launch-class CLI commands. */
export type LaunchRuntime = {
	readonly platform: NodeJS.Platform;
	readonly which: (command: string) => string | null;
	readonly execve?: (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never;
	readonly spawn: (argv: string[], options: {stdio: ['inherit', 'inherit', 'inherit']}) => {exited: Promise<number>};
};

/** Production runtime; tests can pass a fake runtime to runWithInheritedTty. */
export const defaultLaunchRuntime: LaunchRuntime = {
	platform: process.platform,
	which: command => Bun.which(command),
	execve: process.execve?.bind(process),
	spawn: (argv, options) => Bun.spawn(argv, options)
};

function reportNonExecveWarning(warning: Error): void {
	const warningName = warning.name || 'Warning';
	console.error(`${warningName}: ${warning.message}`);
}

function isExecveExperimentalWarning(warning: Error): boolean {
	return warning.name === 'ExperimentalWarning' && warning.message.includes('process.execve');
}

/**
 * Launch a command with inherited TTYs, replacing this process on POSIX when possible.
 * A failed or unavailable execve intentionally falls back to Bun.spawn so callers keep
 * their existing ENOENT and child-exit-code behavior.
 */
export async function runWithInheritedTty(
	command: string,
	args: readonly string[],
	runtime: LaunchRuntime = defaultLaunchRuntime
): Promise<number> {
	if (runtime.platform !== 'win32' && runtime.execve) {
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
