import {spawn} from 'node:child_process';

// 跨平台在系统默认浏览器打开 URL（对齐 clipboard.ts 的 spawn + 平台判断范式）。
// Windows=start（shell 内建，首个引号参数被当窗口标题，故用 start "" <url>）；
// macOS=open；Linux=xdg-open。命令缺失或失败返回 ok:false，视图据此提示。

export type OpenUrlResult = {readonly ok: true} | {readonly ok: false; readonly error: string};

// 仅允许 http/https，防止 spawn 注入或本地协议（file:// / javascript: 等）被外部内容利用。
export function isSafeHttpUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function openCommand(url: string): {readonly command: string; readonly args: readonly string[]; readonly shell: boolean} | null {
	if (process.platform === 'win32') {
		// start 是 cmd 内建，需 shell:true；空字符串占位窗口标题，避免 url 被当标题吞掉。
		return {command: 'start', args: ['""', url], shell: true};
	}

	if (process.platform === 'darwin') {
		return {command: 'open', args: [url], shell: false};
	}

	// Linux / 其他：freedesktop 标准入口。
	return {command: 'xdg-open', args: [url], shell: false};
}

/** 在系统默认浏览器打开 http/https URL。 */
export function openUrl(url: string): Promise<OpenUrlResult> {
	if (!isSafeHttpUrl(url)) {
		return Promise.resolve({ok: false, error: '仅支持打开 http/https 链接'});
	}

	const spec = openCommand(url);
	if (!spec) {
		return Promise.resolve({ok: false, error: '当前平台不支持打开链接'});
	}

	return new Promise(resolve => {
		let settled = false;
		const finish = (result: OpenUrlResult): void => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};

		const proc = spawn(spec.command, [...spec.args], {
			shell: spec.shell,
			stdio: ['ignore', 'ignore', 'pipe']
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
				finish({ok: false, error: stderr.trim() || `打开链接失败 (exit ${code})`});
			}
		});
	});
}
