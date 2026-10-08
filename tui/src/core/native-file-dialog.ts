import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';

// 系统文件选择器：Windows 使用 PowerShell STA + .NET WinForms 对话框，
// macOS 使用 osascript 的 choose file / choose file name。
// spawn 一律不经过 shell，也不把用户路径插值进脚本；取消不是错误。
// spawn 与 platform 通过 deps 注入，测试不启动真实对话框（对齐 open-file.ts 形态）。

export type FileDialogOutcome =
	| {readonly kind: 'selected'; readonly path: string}
	| {readonly kind: 'cancelled'}
	| {readonly kind: 'unavailable'; readonly reason: string};

export type NativeFileDialogDeps = {
	readonly platform?: NodeJS.Platform;
	readonly spawnProcess?: typeof nodeSpawn;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
};

const DEFAULT_DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

type DialogCommand = {
	readonly command: string;
	readonly args: readonly string[];
};

const WINDOWS_IMPORT_SCRIPT = [
	'[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
	'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
	'$dialog = New-Object System.Windows.Forms.OpenFileDialog',
	"$dialog.Title = '选择要导入的 CCQ 配置导出包'",
	"$dialog.Filter = 'CCQ 配置导出包 (*.ccq-backup)|*.ccq-backup|所有文件 (*.*)|*.*'",
	'$dialog.CheckFileExists = $true',
	'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($dialog.FileName) }'
].join('\n');

const WINDOWS_EXPORT_SCRIPT = [
	'[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
	'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
	'$dialog = New-Object System.Windows.Forms.SaveFileDialog',
	"$dialog.Title = '选择 CCQ 配置导出包保存位置'",
	"$dialog.Filter = 'CCQ 配置导出包 (*.ccq-backup)|*.ccq-backup|所有文件 (*.*)|*.*'",
	"$dialog.DefaultExt = 'ccq-backup'",
	'$dialog.AddExtension = $true',
	'$dialog.OverwritePrompt = $true',
	"$dialog.FileName = 'ccq-config-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.ccq-backup'",
	'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($dialog.FileName) }'
].join('\n');

const MACOS_IMPORT_SCRIPT = 'POSIX path of (choose file with prompt "选择要导入的 CCQ 配置导出包")';

function formatTimestamp(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function macosExportScript(): string {
	return `POSIX path of (choose file name with prompt "选择 CCQ 配置导出包保存位置" default name "ccq-config-${formatTimestamp(new Date())}.ccq-backup")`;
}

function encodePowerShellScript(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64');
}

function dialogCommand(kind: 'import' | 'export', platform: NodeJS.Platform): DialogCommand | undefined {
	if (platform === 'win32') {
		return {
			command: 'powershell.exe',
			args: [
				'-NoProfile',
				'-STA',
				'-NonInteractive',
				'-EncodedCommand',
				encodePowerShellScript(kind === 'import' ? WINDOWS_IMPORT_SCRIPT : WINDOWS_EXPORT_SCRIPT)
			]
		};
	}

	if (platform === 'darwin') {
		return {command: 'osascript', args: ['-e', kind === 'import' ? MACOS_IMPORT_SCRIPT : macosExportScript()]};
	}

	return undefined;
}

function isMacCancellation(platform: NodeJS.Platform, stderr: string): boolean {
	return platform === 'darwin' && /user canceled|\(-128\)/i.test(stderr);
}

function runFileDialog(kind: 'import' | 'export', deps: NativeFileDialogDeps): Promise<FileDialogOutcome> {
	const platform = deps.platform ?? process.platform;
	const spec = dialogCommand(kind, platform);
	if (!spec) {
		return Promise.resolve({kind: 'unavailable', reason: '当前平台不支持系统文件对话框'});
	}

	const signal = deps.signal;
	if (signal?.aborted) {
		return Promise.resolve({kind: 'cancelled'});
	}

	const spawnProcess = deps.spawnProcess ?? nodeSpawn;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS;

	return new Promise(resolve => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (outcome: FileDialogOutcome): void => {
			if (settled) {
				return;
			}

			settled = true;
			if (timer) {
				clearTimeout(timer);
			}

			signal?.removeEventListener('abort', handleAbort);
			resolve(outcome);
		};

		let proc: ChildProcess;
		try {
			proc = spawnProcess(spec.command, [...spec.args], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false});
		} catch {
			finish({kind: 'unavailable', reason: '系统文件对话框进程启动失败'});
			return;
		}

		let stdout = '';
		let stderr = '';
		proc.stdout?.on('data', data => {
			stdout += String(data);
		});
		proc.stderr?.on('data', data => {
			stderr += String(data);
		});

		function handleAbort(): void {
			try {
				proc.kill();
			} catch {}

			finish({kind: 'cancelled'});
		}

		signal?.addEventListener('abort', handleAbort, {once: true});
		if (signal?.aborted) {
			handleAbort();
			return;
		}

		timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {}

			finish({kind: 'unavailable', reason: '系统文件对话框超时'});
		}, timeoutMs);

		proc.once('error', () => finish({kind: 'unavailable', reason: '系统文件对话框进程启动失败'}));
		proc.once('close', code => {
			if (code === 0) {
				const path = stdout.trim();
				finish(path.length > 0 ? {kind: 'selected', path} : {kind: 'cancelled'});
				return;
			}

			finish(isMacCancellation(platform, stderr) ? {kind: 'cancelled'} : {kind: 'unavailable', reason: '系统文件对话框不可用'});
		});
	});
}

/** 打开系统“打开文件”对话框选择导入包；取消返回 cancelled，环境不支持返回 unavailable。 */
export function pickImportBundle(deps: NativeFileDialogDeps = {}): Promise<FileDialogOutcome> {
	return runFileDialog('import', deps);
}

/** 打开系统“另存为”对话框选择导出目标；取消返回 cancelled，环境不支持返回 unavailable。 */
export function pickExportBundle(deps: NativeFileDialogDeps = {}): Promise<FileDialogOutcome> {
	return runFileDialog('export', deps);
}
