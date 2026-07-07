import {delimiter} from 'node:path';
import {execCommand, type ProgressCallback} from './exec.js';

const NPM_PREFIX_TIMEOUT_MS = 5000;

/** npm global prefix → 可执行文件目录；Windows shim 在 prefix 根目录，POSIX 在 prefix/bin。 */
export function npmGlobalBinFromPrefix(prefix: string, platform: NodeJS.Platform = process.platform): string | null {
	const normalized = prefix.trim();
	if (!normalized) {
		return null;
	}

	return platform === 'win32' ? normalized : `${normalized.replace(/\/$/, '')}/bin`;
}

/** 把目录前置到当前进程 PATH（去重），让本次安装后的 npm shim 立即可被后续检测命令发现。 */
export function prependPathForCurrentProcess(binDir: string): void {
	const currentPath = process.env.PATH ?? '';
	const segments = currentPath.split(delimiter).filter(Boolean);
	if (segments.includes(binDir)) {
		return;
	}

	process.env.PATH = [binDir, ...segments].join(delimiter);
}

/** 解析 npm global bin 并注入当前进程 PATH；失败不阻断调用方，回退到现有 PATH 检测。 */
export async function refreshNpmGlobalBinPath(
	onProgress?: ProgressCallback,
	componentId?: string,
	exec: typeof execCommand = execCommand
): Promise<void> {
	try {
		const result = await exec('npm', ['prefix', '-g'], {timeout: NPM_PREFIX_TIMEOUT_MS});
		if (result.code !== 0) {
			onProgress?.({level: 'warning', message: 'npm prefix -g 执行失败，将使用当前 PATH 检测命令', componentId});
			return;
		}

		const binDir = npmGlobalBinFromPrefix(result.stdout || result.stderr);
		if (!binDir) {
			onProgress?.({level: 'warning', message: 'npm global prefix 为空，将使用当前 PATH 检测命令', componentId});
			return;
		}

		prependPathForCurrentProcess(binDir);
	} catch {
		onProgress?.({level: 'warning', message: '无法解析 npm global bin，将使用当前 PATH 检测命令', componentId});
	}
}
