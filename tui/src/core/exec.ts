import {spawn} from 'node:child_process';

// 跨平台外部命令执行 + 结构化进度事件（取代旧 *-manager.js 的 console.log 耦合）。
// 进度通过 onProgress 回调上报；Ink 视图据此更新 state，旧 CLI/fallback 可改打印 console。

export type ProgressLevel = 'info' | 'success' | 'warning' | 'danger';

export type ProgressEvent = {
	readonly level: ProgressLevel;
	readonly message: string;
	readonly componentId?: string;
};

export type ProgressCallback = (event: ProgressEvent) => void;

export type ExecResult = {readonly code: number; readonly stdout: string; readonly stderr: string};

export type ExecOptions = {
	readonly timeout?: number;
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
};

/** Windows 参数引号包裹（防御性，规避 shell 拼接注入与 DEP0190 警告）。 */
function quoteWinArg(arg: string): string {
	if (/^[a-z0-9_\-/.@]+$/i.test(arg)) {
		return arg;
	}

	return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * 执行外部命令（Promise 包装，捕获 stdout/stderr）。
 * Windows: 拼接命令字符串 + shell:true（避免 DEP0190）；非 Windows: spawn(command, args)。
 */
export function execCommand(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const timeout = options.timeout ?? 60000;

		let spawnCmd: string;
		let spawnArgs: string[];
		let useShell: boolean;
		if (process.platform === 'win32') {
			spawnCmd = `${command} ${args.map(quoteWinArg).join(' ')}`;
			spawnArgs = [];
			useShell = true;
		} else {
			spawnCmd = command;
			spawnArgs = [...args];
			useShell = false;
		}

		const proc = spawn(spawnCmd, spawnArgs, {
			cwd: options.cwd ?? process.cwd(),
			env: options.env ?? process.env,
			shell: useShell,
			stdio: 'pipe'
		});

		let stdout = '';
		let stderr = '';
		let settled = false;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

		const settleResolve = (result: ExecResult) => {
			if (settled) {
				return;
			}

			settled = true;
			resolve(result);
		};

		const settleReject = (error: Error) => {
			if (settled) {
				return;
			}

			settled = true;
			reject(error);
		};

		const timer = setTimeout(() => {
			// Windows shell:true 只终止外层 shell 时，npx 子进程树可能继续持有 stdio，
			// 因而 close 永远不返回。超时事实应在此刻直接收敛 Promise，kill 只负责清理。
			settleReject(new Error(`命令超时 (${timeout}ms): ${command} ${args.join(' ')}`));
			try {
				proc.kill('SIGTERM');
			} catch {}

			forceKillTimer = setTimeout(() => {
				try {
					proc.kill('SIGKILL');
				} catch {}
			}, 5000);
		}, timeout);

		proc.stdout?.on('data', data => {
			stdout += String(data);
		});
		proc.stderr?.on('data', data => {
			stderr += String(data);
		});

		proc.on('close', code => {
			clearTimeout(timer);
			if (forceKillTimer) {
				clearTimeout(forceKillTimer);
			}

			settleResolve({code: code ?? 0, stdout, stderr});
		});

		proc.on('error', error => {
			clearTimeout(timer);
			if (forceKillTimer) {
				clearTimeout(forceKillTimer);
			}
			settleReject(error);
		});
	});
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const CONTROL_PATTERN = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]', 'g');

/** 清除 ANSI 转义序列与控制字符。 */
export function removeAnsiSequences(text: string): string {
	if (!text) {
		return '';
	}

	return text.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '');
}

/** 创建一个把进度事件转写为 console 输出的回调（供旧 CLI/fallback 路径复用）。 */
export function createConsoleProgress(): ProgressCallback {
	return event => {
		const prefix = event.componentId ? `[${event.componentId}] ` : '';
		if (event.level === 'danger' || event.level === 'warning') {
			console.error(`${prefix}${event.message}`);
		} else {
			console.log(`${prefix}${event.message}`);
		}
	};
}
