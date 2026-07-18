// `ccq uninstall [--yes|-y]` — 卸载 ccq 可执行文件本体。

import {existsSync} from 'node:fs';
import {getCcqExecutablePath} from '../../core/update.js';
import {uninstallSelfExecutable, type SelfUninstallResult} from '../../core/self-uninstall.js';
import {confirmDangerousAction} from '../confirm.js';

type RunUninstallDeps = {
	readonly targetPath?: string;
	readonly uninstall?: (targetPath: string) => Promise<SelfUninstallResult>;
};

export async function runUninstall(assumedYes: boolean, deps: RunUninstallDeps = {}): Promise<number> {
	const execPath = deps.targetPath ?? getCcqExecutablePath();
	if (!existsSync(execPath)) {
		console.log(`未找到 ccq 可执行文件: ${execPath}`);
		return 0;
	}

	const confirmed = await confirmDangerousAction({
		prompt: `确认卸载 ccq 并删除 ${execPath} 吗？`,
		assumedYes
	});
	if (!confirmed) {
		console.log('已取消卸载。');
		return 1;
	}

	const result = await (deps.uninstall ?? uninstallSelfExecutable)(execPath);
	if (result.ok) {
		if (result.state === 'absent') {
			console.log(`未找到 ccq 可执行文件: ${result.targetPath}`);
			return 0;
		}
		if (result.state === 'scheduled') {
			console.log(`已安排卸载 ccq；当前命令退出后将删除: ${result.targetPath}`);
			return 0;
		}
		console.log(`已删除 ccq 可执行文件: ${execPath}`);
		return 0;
	}

	const detail = result.error.cause ? `：${result.error.cause}` : '';
	console.error(`卸载 ccq 失败: ${result.error.message}${detail}`);
	return 1;
}
