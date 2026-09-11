import {spawn as nodeSpawn, type ChildProcess, type SpawnOptions} from 'node:child_process';

export type OpenExternalFileResult = {readonly ok: true} | {readonly ok: false; readonly error: string};

export type OpenExternalFileDeps = {
	readonly platform?: NodeJS.Platform;
	readonly spawnProcess?: typeof nodeSpawn;
};

type OpenExternalFileCommand = {
	readonly command: string;
	readonly args: readonly string[];
	readonly options: SpawnOptions;
	readonly settleOnSpawn?: boolean;
};

function openExternalFileCommand(filePath: string, platform: NodeJS.Platform): OpenExternalFileCommand {
	if (platform === 'win32') {
		// rundll32 调用 ShellExecute 的文件协议入口，使用 Windows 用户的文件关联，
		// 同时不创建 cmd/PowerShell 控制台窗口。路径作为独立 argv 传入，不经过 shell。
		return {
			command: 'rundll32.exe',
			args: ['url.dll,FileProtocolHandler', filePath],
			options: {detached: true, stdio: 'ignore', windowsHide: true},
			settleOnSpawn: true
		};
	}

	if (platform === 'darwin') {
		return {command: 'open', args: [filePath], options: {detached: true, stdio: 'ignore'}};
	}

	return {command: 'xdg-open', args: [filePath], options: {detached: true, stdio: 'ignore'}};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 通过系统默认关联应用打开本地文件或网址，不等待外部应用退出。 */
export function openExternalFile(filePath: string, deps: OpenExternalFileDeps = {}): Promise<OpenExternalFileResult> {
	if (filePath.length === 0) {
		return Promise.resolve({ok: false, error: '文件路径为空'});
	}

	const spec = openExternalFileCommand(filePath, deps.platform ?? process.platform);
	const spawnProcess = deps.spawnProcess ?? nodeSpawn;

	return new Promise(resolve => {
		let settled = false;
		const finish = (result: OpenExternalFileResult): void => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};

		let proc: ChildProcess;
		try {
			proc = spawnProcess(spec.command, [...spec.args], spec.options);
		} catch (error) {
			finish({ok: false, error: errorMessage(error)});
			return;
		}

		proc.once('error', error => finish({ok: false, error: error.message}));
		if (spec.settleOnSpawn) {
			proc.once('spawn', () => finish({ok: true}));
			proc.once('close', code => {
				if (code !== 0) finish({ok: false, error: `外部打开失败 (exit ${code ?? 'unknown'})`});
			});
		} else {
			proc.once('close', code => {
				finish(code === 0 ? {ok: true} : {ok: false, error: `外部打开失败 (exit ${code ?? 'unknown'})`});
			});
		}
		proc.unref();
	});
}
