// `ccq update` — 检查并更新 ccq 可执行文件本体。

import {applyUpdate, checkLatestVersion, downloadUpdate, formatSelfUpdateError, type DownloadUpdateProgress} from '../../core/update.js';
import {CCQ_VERSION} from '../../version.js';

type UpdateProgressOutput = {
	readonly isTTY: boolean;
	readonly write: (text: string) => void;
};

type RunUpdateDeps = {
	readonly check?: typeof checkLatestVersion;
	readonly download?: typeof downloadUpdate;
	readonly apply?: typeof applyUpdate;
	readonly progressOutput?: UpdateProgressOutput;
};

const UPDATE_PROGRESS_BAR_WIDTH = 24;

function createUpdateProgressReporter(output: UpdateProgressOutput): {
	readonly onProgress: (progress: DownloadUpdateProgress) => void;
	readonly finish: () => void;
} {
	let rendered = false;
	let lastLineLength = 0;
	let lastTransport = '';
	let lastBucket = -1;

	return {
		onProgress(progress) {
			const percentage = Math.min(100, Math.max(0, Math.round(progress.percentage)));
			const line = formatUpdateProgress(progress, percentage);
			if (output.isTTY) {
				output.write(`\r${line.padEnd(lastLineLength, ' ')}`);
				lastLineLength = line.length;
				rendered = true;
				return;
			}

			const transport = `${progress.encoding}:${progress.assetName}`;
			const bucket = Math.floor(percentage / 10);
			if (transport === lastTransport && bucket <= lastBucket) return;
			output.write(`${line}\n`);
			lastTransport = transport;
			lastBucket = bucket;
			rendered = true;
		},
		finish() {
			if (output.isTTY && rendered) output.write('\n');
		}
	};
}

function formatUpdateProgress(progress: DownloadUpdateProgress, percentage: number): string {
	const filledWidth = Math.round((percentage * UPDATE_PROGRESS_BAR_WIDTH) / 100);
	const bar = '='.repeat(filledWidth) + '-'.repeat(UPDATE_PROGRESS_BAR_WIDTH - filledWidth);
	const transport = progress.encoding === 'gzip' ? 'gzip' : 'raw';
	return `[${bar}] ${String(percentage).padStart(3, ' ')}%  ${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}  ${transport}`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function runUpdate(checkOnly: boolean, deps: RunUpdateDeps = {}): Promise<number> {
	const check = deps.check ?? checkLatestVersion;
	const download = deps.download ?? downloadUpdate;
	const apply = deps.apply ?? applyUpdate;
	const progressOutput =
		deps.progressOutput ??
		({
			isTTY: Boolean(process.stdout.isTTY),
			write: text => {
				process.stdout.write(text);
			}
		} satisfies UpdateProgressOutput);
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
	const progress = createUpdateProgressReporter(progressOutput);
	const downloaded = await download(info.plan, undefined, {onProgress: progress.onProgress});
	progress.finish();
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
