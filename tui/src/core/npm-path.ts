import {execCommand, type ProgressCallback} from './exec.js';

const NPM_PREFIX_TIMEOUT_MS = 5000;

export function pathDelimiter(platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? ';' : ':';
}

function samePathEntry(left: string, right: string, platform: NodeJS.Platform): boolean {
	return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Read PATH with Windows' case-insensitive Path/PATH spelling treated explicitly. */
export function environmentPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
	const values = platform === 'win32' ? [env.Path, env.PATH] : [env.PATH];
	return values.filter((value): value is string => typeof value === 'string').join(pathDelimiter(platform));
}

/** Return a child-process environment with PATH updated without changing Windows key casing. */
export function withEnvironmentPath(
	env: NodeJS.ProcessEnv,
	pathValue: string,
	platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
	if (platform !== 'win32') return {...env, PATH: pathValue};

	const hasPath = typeof env.Path === 'string';
	const hasPATH = typeof env.PATH === 'string';
	if (hasPath && hasPATH) return {...env, Path: pathValue, PATH: pathValue};
	if (hasPath) return {...env, Path: pathValue};
	return {...env, PATH: pathValue};
}

/** npm global prefix → 可执行文件目录；Windows shim 在 prefix 根目录，POSIX 在 prefix/bin。 */
export function npmGlobalBinFromPrefix(prefix: string, platform: NodeJS.Platform = process.platform): string | null {
	const normalized = prefix.trim();
	if (!normalized) {
		return null;
	}

	return platform === 'win32' ? normalized : `${normalized.replace(/\/$/, '')}/bin`;
}

/** 把目录前置到当前进程 PATH（去重），让本次安装后的 npm shim 立即可被后续检测命令发现。 */
export function prependPathForCurrentProcess(binDir: string, platform: NodeJS.Platform = process.platform): void {
	const delimiter = pathDelimiter(platform);
	const segments = environmentPath(process.env, platform).split(delimiter).filter(Boolean);
	const nextPath = [binDir, ...segments]
		.filter((entry, index, all) => all.findIndex(candidate => samePathEntry(candidate, entry, platform)) === index)
		.join(delimiter);

	if (platform !== 'win32') {
		process.env.PATH = nextPath;
		return;
	}

	const hasPath = typeof process.env.Path === 'string';
	const hasPATH = typeof process.env.PATH === 'string';
	if (hasPath) process.env.Path = nextPath;
	if (hasPATH) process.env.PATH = nextPath;
	if (!hasPath && !hasPATH) process.env.PATH = nextPath;
}

/** 解析 npm global bin 并注入当前进程 PATH；失败不阻断调用方，回退到现有 PATH 检测。 */
export async function refreshNpmGlobalBinPath(
	onProgress?: ProgressCallback,
	componentId?: string,
	exec: typeof execCommand = execCommand,
	platform: NodeJS.Platform = process.platform
): Promise<string | null> {
	try {
		const result = await exec('npm', ['prefix', '-g'], {timeout: NPM_PREFIX_TIMEOUT_MS});
		if (result.code !== 0) {
			onProgress?.({level: 'warning', message: 'npm prefix -g 执行失败，将使用当前 PATH 检测命令', componentId});
			return null;
		}

		const binDir = npmGlobalBinFromPrefix(result.stdout || result.stderr, platform);
		if (!binDir) {
			onProgress?.({level: 'warning', message: 'npm global prefix 为空，将使用当前 PATH 检测命令', componentId});
			return null;
		}

		prependPathForCurrentProcess(binDir, platform);
		return binDir;
	} catch {
		onProgress?.({level: 'warning', message: '无法解析 npm global bin，将使用当前 PATH 检测命令', componentId});
		return null;
	}
}
