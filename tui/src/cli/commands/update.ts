// `ccq update` — 检查并更新 ccq 可执行文件本体。

import {applyUpdate, checkLatestVersion, downloadUpdate, formatSelfUpdateError} from '../../core/update.js';
import {CCQ_VERSION} from '../../version.js';

type RunUpdateDeps = {
	readonly check?: typeof checkLatestVersion;
	readonly download?: typeof downloadUpdate;
	readonly apply?: typeof applyUpdate;
};

export async function runUpdate(checkOnly: boolean, deps: RunUpdateDeps = {}): Promise<number> {
	const check = deps.check ?? checkLatestVersion;
	const download = deps.download ?? downloadUpdate;
	const apply = deps.apply ?? applyUpdate;
	console.log(`当前 ccq 版本: ${CCQ_VERSION}`);
	console.log('正在检查最新版本...');

	const info = await check();
	if (!info.ok) {
		console.error(formatSelfUpdateError(info.error));
		return 1;
	}

	if (!info.hasUpdate) {
		console.log(`已是最新版本: ${info.latestVersion}`);
		return 0;
	}

	console.log(`发现新版本: ${info.plan.version}`);
	if (checkOnly) {
		return 0;
	}

	console.log('正在下载更新...');
	const downloaded = await download(info.plan);
	if (!downloaded.ok) {
		console.error(formatSelfUpdateError(downloaded.error));
		return 1;
	}

	console.log(`更新已下载: ${downloaded.transaction.tempPath}`);
	console.log('正在应用更新...');
	const applied = await apply(downloaded.transaction, {restartAfterApply: false});
	if (!applied.ok) {
		console.error(formatSelfUpdateError(applied.error));
		return 1;
	}

	if (applied.state === 'scheduled') {
		console.log('已安排更新，ccq 将在当前命令退出后完成替换。');
	} else {
		console.log(`ccq 更新完成: ${applied.targetPath}`);
	}
	console.log('请重新运行 ccq 使用新版本。');

	return 0;
}
