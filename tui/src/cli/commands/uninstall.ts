// `ccq uninstall [--yes|-y]` — 卸载 ccq 可执行文件本体。

import {existsSync, rmSync} from 'node:fs';
import {getCcqExecutablePath} from '../../core/update.js';
import {confirmDangerousAction} from '../confirm.js';

export async function runUninstall(assumedYes: boolean): Promise<number> {
	const execPath = getCcqExecutablePath();
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

	try {
		rmSync(execPath, {force: true});
		console.log(`已删除 ccq 可执行文件: ${execPath}`);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`卸载 ccq 失败: ${message}`);
		if (process.platform === 'win32') {
			console.error('Windows 可能无法删除正在运行的 ccq.exe，请关闭当前进程后手动删除。');
		}
		return 1;
	}
}
