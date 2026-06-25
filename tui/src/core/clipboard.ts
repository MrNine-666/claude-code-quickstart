import {spawn} from 'node:child_process';

// 跨平台剪贴板写入（design TDR-5）：Windows=clip，macOS=pbcopy，通过 stdin 注入文本。
// 命令缺失或写入失败返回 ok:false，视图据此禁用「复制」入口。

export type ClipboardResult = {readonly ok: true} | {readonly ok: false; readonly error: string};

function clipboardCommand(): {readonly command: string; readonly args: readonly string[]} | null {
	if (process.platform === 'win32') {
		return {command: 'clip', args: []};
	}

	if (process.platform === 'darwin') {
		return {command: 'pbcopy', args: []};
	}

	return null;
}

/** 当前平台是否支持剪贴板写入（仅 Windows / macOS）。 */
export function isClipboardSupported(): boolean {
	return clipboardCommand() !== null;
}

/** 将文本写入系统剪贴板（通过命令 stdin）。 */
export function copyToClipboard(text: string): Promise<ClipboardResult> {
	const spec = clipboardCommand();
	if (!spec) {
		return Promise.resolve({ok: false, error: '当前平台不支持剪贴板写入'});
	}

	return new Promise(resolve => {
		let settled = false;
		const finish = (result: ClipboardResult): void => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};

		const proc = spawn(spec.command, [...spec.args], {
			shell: process.platform === 'win32',
			stdio: ['pipe', 'ignore', 'pipe']
		});

		let stderr = '';
		proc.stderr?.on('data', data => {
			stderr += String(data);
		});

		proc.on('error', error => {
			finish({ok: false, error: error.message});
		});

		proc.on('close', code => {
			if (code === 0) {
				finish({ok: true});
			} else {
				finish({ok: false, error: stderr.trim() || `复制失败 (exit ${code})`});
			}
		});

		try {
			proc.stdin?.end(text, 'utf8');
		} catch (error) {
			finish({ok: false, error: error instanceof Error ? error.message : String(error)});
		}
	});
}
