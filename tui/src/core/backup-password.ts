import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {atomicWrite, SECRET_FILE_MODE} from './fs-utils.js';
import {ccqDir} from './paths.js';

/** The password never enters argv, shell source, CCQ settings or a backup bundle. */
export type BackupPasswordResult<T> = {readonly ok: true; readonly value: T} | {readonly ok: false; readonly error: string};
export type BackupPasswordStore = {
	readonly load: () => BackupPasswordResult<string | null>;
	readonly save: (password: string) => BackupPasswordResult<void>;
	readonly clear: () => BackupPasswordResult<void>;
};

const SERVICE = 'ccq.config-backup';
const ACCOUNT = 'backup-password';
const MAX_PASSWORD_BYTES = 4096;
const WINDOWS_SECRET_FILE = 'backup-password.dpapi';
const GENERIC_ERROR = '无法访问系统密码存储，请检查系统凭据服务';

type Run = typeof spawnSync;

function fail<T>(message = GENERIC_ERROR): BackupPasswordResult<T> {
	return {ok: false, error: message};
}

function macStore(run: Run): BackupPasswordStore {
	const command = (args: string[], input?: string) =>
		run('/usr/bin/security', args, {
			...(input === undefined ? {} : {input}),
			encoding: 'utf8',
			timeout: 10000,
			maxBuffer: MAX_PASSWORD_BYTES * 8,
			windowsHide: true
		});
	const load = (): BackupPasswordResult<string | null> => {
		const result = command(['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w']);
		if (result.status === 44) return {ok: true, value: null};
		if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return fail();
		return {ok: true, value: result.stdout.replace(/\r?\n$/u, '')};
	};
	return {
		load,
		save: password => {
			if (!password || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return fail('备份密码不能为空或超过长度限制');
			// security(1) marks -w <password> insecure (argv); -i accepts a command through stdin.
			// Fixed ASCII identifiers and hex data cannot inject a second command.
			const hex = Buffer.from(password, 'utf8').toString('hex');
			const result = command(['-i'], `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -X ${hex}\n`);
			if (result.error || result.status !== 0) return fail();
			const verified = load();
			return verified.ok && verified.value === password ? {ok: true, value: undefined} : fail();
		},
		clear: () => {
			const result = command(['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE]);
			if (result.error || (result.status !== 0 && result.status !== 44)) return fail();
			return {ok: true, value: undefined};
		}
	};
}

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $data = [Console]::In.ReadToEnd()
  if ('__MODE__' -eq 'protect') {
    $raw = [System.Text.Encoding]::UTF8.GetBytes($data)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($protected))
  } else {
    $raw = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($data), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($raw))
  }
} catch { exit 1 }
`;

function windowsStore(run: Run, filePath: string): BackupPasswordStore {
	const transform = (mode: 'protect' | 'unprotect', input: string): BackupPasswordResult<string> => {
		const encoded = Buffer.from(WINDOWS_SCRIPT.replace('__MODE__', mode), 'utf16le').toString('base64');
		const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
			input,
			encoding: 'utf8',
			timeout: 10000,
			maxBuffer: MAX_PASSWORD_BYTES * 8,
			windowsHide: true
		});
		if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return fail();
		return {ok: true, value: mode === 'protect' ? result.stdout.trim() : result.stdout};
	};
	const validFile = (): boolean => !existsSync(filePath) || (lstatSync(filePath).isFile() && !lstatSync(filePath).isSymbolicLink());
	return {
		load: () => {
			try {
				if (!validFile()) return fail();
				if (!existsSync(filePath)) return {ok: true, value: null};
				const encoded = readFileSync(filePath, 'utf8');
				if (!encoded || encoded.length > MAX_PASSWORD_BYTES * 8) return fail();
				return transform('unprotect', encoded);
			} catch {
				return fail();
			}
		},
		save: password => {
			if (!password || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return fail('备份密码不能为空或超过长度限制');
			try {
				if (!validFile()) return fail();
				const encrypted = transform('protect', password);
				if (!encrypted.ok || !encrypted.value) return fail();
				atomicWrite(filePath, encrypted.value, {mode: SECRET_FILE_MODE});
				const verified = transform('unprotect', readFileSync(filePath, 'utf8'));
				return verified.ok && verified.value === password ? {ok: true, value: undefined} : fail();
			} catch {
				return fail();
			}
		},
		clear: () => {
			try {
				if (!validFile()) return fail();
				rmSync(filePath, {force: true});
				return {ok: true, value: undefined};
			} catch {
				return fail();
			}
		}
	};
}

export function createBackupPasswordStore(
	options: {readonly platform?: NodeJS.Platform; readonly run?: Run; readonly windowsFile?: string} = {}
): BackupPasswordStore {
	const platform = options.platform ?? process.platform;
	const run = options.run ?? spawnSync;
	if (platform === 'darwin') return macStore(run);
	if (platform === 'win32') return windowsStore(run, options.windowsFile ?? join(ccqDir(), WINDOWS_SECRET_FILE));
	return {
		load: () => fail('当前平台不支持保存备份密码'),
		save: () => fail('当前平台不支持保存备份密码'),
		clear: () => fail('当前平台不支持保存备份密码')
	};
}
