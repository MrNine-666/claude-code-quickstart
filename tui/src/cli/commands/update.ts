// `ccq update` — 检查并更新 ccq 可执行文件本体。

import {applyUpdate, checkLatestVersion, downloadUpdate, formatSelfUpdateError} from '../../core/update.js';
import {CCQ_VERSION} from '../../version.js';

export async function runUpdate(checkOnly: boolean): Promise<number> {
	console.log(`当前 ccq 版本: ${CCQ_VERSION}`);
	console.log('正在检查最新版本...');

	const info = await checkLatestVersion();
	if (!info.ok) {
		console.error(formatSelfUpdateError(info.error));
		return 1;
	}

	if (!info.hasUpdate) {
		console.log(`已是最新版本: ${info.latestVersion}`);
		return 0;
	}

	console.log(`发现新版本: ${info.version}`);
	if (checkOnly) {
		return 0;
	}

	console.log('正在下载更新...');
	const downloaded = await downloadUpdate(info.downloadUrl);
	if (!downloaded.ok) {
		console.error(formatSelfUpdateError(downloaded.error));
		return 1;
	}

	console.log(`更新已下载: ${downloaded.tempPath}`);
	console.log('正在应用更新...');
	const applied = await applyUpdate();
	if (!applied.ok) {
		console.error(formatSelfUpdateError(applied.error));
		return 1;
	}

	if (applied.restartStarted) {
		console.log('更新 helper 已启动，ccq 将在当前进程退出后替换并重启。');
	} else {
		console.log(`ccq 更新完成: ${applied.targetPath}`);
		console.log('请重新启动 ccq 使用新版本。');
	}

	return 0;
}
