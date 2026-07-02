// `ccq update` — 检查并更新 ccq 可执行文件本体。

import {applyUpdate, checkLatestVersion, downloadUpdate} from '../../core/update.js';
import {CCQ_VERSION} from '../../version.js';

export async function runUpdate(checkOnly: boolean): Promise<number> {
	console.log(`当前 ccq 版本: ${CCQ_VERSION}`);
	console.log('正在检查最新版本...');

	const info = await checkLatestVersion();
	if (!info) {
		console.log('未发现可用更新（或暂时无法连接 GitHub Release）。');
		return 0;
	}

	console.log(`发现新版本: ${info.version}`);
	if (checkOnly) {
		return 0;
	}

	console.log('正在下载更新...');
	const downloaded = await downloadUpdate(info.downloadUrl);
	if (!downloaded) {
		console.error('下载更新失败，请检查网络连接后重试。');
		return 1;
	}

	console.log('正在应用更新...');
	const applied = await applyUpdate();
	if (!applied) {
		console.error('应用更新失败。');
		return 1;
	}

	if (process.platform === 'win32') {
		console.log('更新文件已下载，将在下次启动 ccq 时尝试替换当前可执行文件。');
	} else {
		console.log('ccq 更新完成，请重新启动 ccq 使用新版本。');
	}

	return 0;
}
