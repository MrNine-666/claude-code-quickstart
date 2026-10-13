import {spawn, type ChildProcess} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import type {DownloadedSelfUpdate} from './self-update.js';
import {parseSemver} from './semver.js';
import {WINDOWS_HELPER_INTERVAL_MS, WINDOWS_HELPER_MAX_ATTEMPTS, type SpawnProcess} from './windows-deferred-operation.js';

type Fact = {size: number; sha256: string};
type Record = {
	schema: 1;
	version: string;
	id: string;
	owner: number;
	target: string;
	temp: string;
	backup: string;
	helper: string;
	done: string;
	old: Fact | null;
	next: Fact;
};

function fact(path: string): Fact | null {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('更新文件不是普通文件');
		const hash = createHash('sha256');
		const fd = openSync(path, 'r');
		try {
			const bytes = Buffer.allocUnsafe(1024 * 1024);
			for (;;) {
				const count = readSync(fd, bytes, 0, bytes.length, null);
				if (!count) break;
				hash.update(bytes.subarray(0, count));
			}
			return {size: stat.size, sha256: hash.digest('hex')};
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}
function matches(path: string, expected: Fact | null): boolean {
	const actual = fact(path);
	return actual?.size === expected?.size && actual?.sha256 === expected?.sha256;
}
function canonicalPath(path: string): string {
	return join(realpathSync(dirname(resolve(path))), basename(path));
}
function recordPath(target: string): string {
	return join(dirname(target), '.' + basename(target) + '.update.json');
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}
function literal(value: string): string {
	return "'" + value.replaceAll("'", "''") + "'";
}
function validFact(value: Fact | null): boolean {
	return (
		value !== null &&
		typeof value === 'object' &&
		Number.isSafeInteger(value.size) &&
		value.size > 0 &&
		/^[a-f0-9]{64}$/.test(value.sha256)
	);
}
function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}
function validateGuard(path: string): void {
	if (!present(path)) return;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) throw new Error('Windows 更新锁异常，已保留');
}
function readRecord(target: string): {record: Record; content: string} | null {
	const path = recordPath(target);
	if (!present(path)) return null;
	if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Windows 更新记录异常，已保留，请检查');
	validateGuard(path + '.lock');
	const content = readFileSync(path, 'utf8');
	let record: Record;
	try {
		record = JSON.parse(content) as Record;
	} catch {
		throw new Error('Windows 更新记录损坏，已保留，请检查');
	}
	validateRecord(target, record);
	return {record, content};
}
function validateRecord(target: string, record: Record): void {
	if (!record || typeof record !== 'object' || typeof record.temp !== 'string' || typeof record.id !== 'string')
		throw new Error('Windows 更新记录损坏，已保留，请检查');
	const prefix = join(dirname(target), '.' + basename(target) + '.update-' + record.id);
	if (
		record.schema !== 1 ||
		typeof record.version !== 'string' ||
		!parseSemver(record.version) ||
		!/^[a-f0-9]{24}$/.test(record.id) ||
		!Number.isSafeInteger(record.owner) ||
		record.owner <= 0 ||
		record.target !== target ||
		dirname(record.temp) !== dirname(target) ||
		resolve(record.temp) !== record.temp ||
		!new RegExp('^\\.' + basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.update-[0-9]+-[a-f0-9]+\\.tmp$').test(
			basename(record.temp)
		) ||
		record.backup !== prefix + '.backup' ||
		record.helper !== prefix + '.ps1' ||
		record.done !== prefix + '.done' ||
		!validFact(record.next) ||
		(record.old !== null && !validFact(record.old))
	) {
		throw new Error('Windows 更新记录损坏，已保留，请检查');
	}
	for (const artifact of [record.temp, record.backup, record.helper, record.done]) {
		if (present(artifact) && (!lstatSync(artifact).isFile() || lstatSync(artifact).isSymbolicLink()))
			throw new Error('Windows 更新 artifacts 异常，已保留');
	}
}

// No descendants, no detached job escape. On timeout wait for actual exit, not kill request.
async function run(command: string, spawnProcess: SpawnProcess = spawn, timeoutMs = 30000): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		let child: ChildProcess;
		let timedOut = false;
		let spawnError: Error | undefined;
		try {
			child = spawnProcess(
				join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
				['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
				{shell: false, detached: false, windowsHide: true, stdio: 'ignore'}
			);
		} catch {
			reject(new Error('PowerShell 启动失败，请检查安全软件拦截记录'));
			return;
		}
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill('SIGKILL');
			} catch {
				// Do not return mutation authority to caller until OS confirms this child exited.
				spawnError = new Error('Windows 拒绝终止更新 helper');
			}
		}, timeoutMs);
		child.on('error', error => {
			spawnError = error;
			if (!child.pid) {
				clearTimeout(timer);
				reject(new Error('PowerShell 启动失败，请检查安全软件拦截记录'));
			}
		});
		child.once('exit', code => {
			clearTimeout(timer);
			if (timedOut || spawnError || code !== 0)
				reject(
					new Error(timedOut ? 'Windows 更新 helper 超时；已确认进程退出' : 'Windows 更新 helper 失败，请检查安全软件或文件占用')
				);
			else resolvePromise();
		});
	});
}

const PS_FILE_FUNCTIONS = `function Regular($path) {
  try { return (([IO.File]::GetAttributes($path) -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)) -eq 0) } catch [IO.FileNotFoundException] { return $true } catch [IO.DirectoryNotFoundException] { return $true }
}
function Hash($path) {
  $stream = [IO.File]::OpenRead($path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}
function Match($path, $size, $hash) {
  try { return [IO.File]::Exists($path) -and (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and ([IO.FileInfo]$path).Length -eq $size -and (Hash $path) -eq $hash } catch { return $false }
}
`;

export function buildWindowsUpdateHelperScript(): string {
	return `param([string]$TempPath, [string]$TargetPath, [string]$BackupPath, [long]$ExpectedSize, [string]$ExpectedSha256, [long]$OldSize, [string]$OldSha256, [string]$GuardPath, [string]$RecordPath, [string]$RecordContent)
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
${PS_FILE_FUNCTIONS}
function Restore {
  if (-not (Regular $TargetPath) -or -not (Match $BackupPath $OldSize $OldSha256)) { return }
  if ([IO.File]::Exists($TargetPath)) { [IO.File]::Replace($BackupPath, $TargetPath, [System.Management.Automation.Language.NullString]::Value, $true) }
  else { [IO.File]::Move($BackupPath, $TargetPath) }
}
$guard = $null
$authorized = $false
try {
  if (-not (Regular $GuardPath)) { exit 1 }
  $guard = [IO.File]::Open($GuardPath, 'OpenOrCreate', 'ReadWrite', 'None')
  if ($guard.Length -ne 0) { exit 1 }
  if (-not (Regular $RecordPath) -or -not [IO.File]::Exists($RecordPath) -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($RecordPath)) -cne [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($RecordContent))) { exit 1 }
  if (-not (Regular $TargetPath) -or -not (Regular $BackupPath) -or [IO.File]::Exists($BackupPath)) { exit 1 }
  if (-not (Match $TempPath $ExpectedSize $ExpectedSha256)) { exit 1 }
  if ($OldSha256) {
    if (-not (Match $TargetPath $OldSize $OldSha256)) { exit 1 }
  } elseif ([IO.File]::Exists($TargetPath)) { exit 1 }
  $authorized = $true
  for ($i = 0; $i -lt ${WINDOWS_HELPER_MAX_ATTEMPTS}; $i++) {
    try {
      if ([IO.File]::Exists($TargetPath)) { [IO.File]::Replace($TempPath, $TargetPath, $BackupPath, $true) }
      else { [IO.File]::Move($TempPath, $TargetPath) }
      break
    } catch {
      if (Match $TargetPath $ExpectedSize $ExpectedSha256) { break }
      if ([IO.File]::Exists($BackupPath)) { Restore; exit 1 }
      [Threading.Thread]::Sleep(${WINDOWS_HELPER_INTERVAL_MS})
    }
  }
  if (-not (Match $TargetPath $ExpectedSize $ExpectedSha256)) { Restore; exit 1 }
  exit 0
} catch {
  if ($authorized) { try { if (-not (Match $TargetPath $ExpectedSize $ExpectedSha256)) { Restore } } catch {} }
  exit 1
} finally { if ($guard) { $guard.Dispose() } }
`;
}

// Immutable ownership record excludes URLs. Persistent guard serializes stale recovery with loaded child.
export async function recoverWindowsSelfUpdate(targetPath: string, runningVersion?: string): Promise<void> {
	const target = canonicalPath(targetPath);
	const loaded = readRecord(target);
	if (!loaded) return;
	const {record, content} = loaded;
	const completed = existsSync(record.done) && readFileSync(record.done, 'utf8') === record.id;
	if (existsSync(record.done) && !completed) throw new Error('Windows 更新完成记录损坏，已保留');
	if (runningVersion !== undefined && runningVersion !== record.version && matches(target, record.next)) {
		throw new Error('更新已完成，请重新运行 ccq 使用新版本');
	}
	if (completed && existsSync(record.backup) && !matches(record.backup, record.old))
		throw new Error('Windows 更新备份与记录不符，已保留');
	if (alive(record.owner)) {
		if (completed && matches(target, record.next)) return;
		throw new Error('Windows 更新仍在处理，请等待当前 ccq 退出后重试');
	}
	// Unknown target bytes may be a legitimate later install. Never overwrite them.
	if (!matches(target, record.next) && !matches(target, record.old) && existsSync(target))
		throw new Error('Windows 更新目标与记录不符，已保留诊断文件');
	await reconcileRecord(target, record, false, content);
}

async function reconcileRecord(target: string, record: Record, restoreInvalid = false, snapshot = JSON.stringify(record)): Promise<void> {
	const path = recordPath(target);
	validateGuard(path + '.lock');
	if (existsSync(record.backup) && !matches(record.backup, record.old)) throw new Error('Windows 更新备份与记录不符，已保留');
	const command = `$ErrorActionPreference = 'Stop'; $PSModuleAutoLoadingPreference = 'None';
${PS_FILE_FUNCTIONS}
if (-not (Regular ${literal(path + '.lock')})) { exit 1 }
$guard = [IO.File]::Open(${literal(path + '.lock')}, 'OpenOrCreate', 'ReadWrite', 'None'); try {
if ($guard.Length -ne 0) { exit 1 }
if (-not (Regular ${literal(path)}) -or -not [IO.File]::Exists(${literal(path)}) -or [Convert]::ToBase64String([IO.File]::ReadAllBytes(${literal(path)})) -cne [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${literal(snapshot)}))) { exit 1 }
${[target, record.temp, record.backup, record.helper, record.done].map(artifact => `if (-not (Regular ${literal(artifact)})) { exit 1 }`).join('\n')}
if ([IO.File]::Exists(${literal(record.done)}) -and [IO.File]::ReadAllText(${literal(record.done)}) -cne ${literal(record.id)}) { exit 1 }
${
	restoreInvalid && record.old
		? `if ([IO.File]::Exists(${literal(target)}) -and -not (Match ${literal(target)} ${record.next.size} ${literal(record.next.sha256)}) -and -not (Match ${literal(target)} ${record.old.size} ${literal(record.old.sha256)})) {
if (-not (Match ${literal(record.backup)} ${record.old.size} ${literal(record.old.sha256)})) { exit 1 }
[IO.File]::Replace(${literal(record.backup)}, ${literal(target)}, [System.Management.Automation.Language.NullString]::Value, $true)
}`
		: ''
}
if (-not [IO.File]::Exists(${literal(target)})) {
${record.old ? `if (-not (Match ${literal(record.backup)} ${record.old.size} ${literal(record.old.sha256)})) { exit 1 }; [IO.File]::Move(${literal(record.backup)}, ${literal(target)})` : ''}
}
if (-not (Match ${literal(target)} ${record.next.size} ${literal(record.next.sha256)}) ${record.old ? `-and -not (Match ${literal(target)} ${record.old.size} ${literal(record.old.sha256)})` : `-and [IO.File]::Exists(${literal(target)})`}) { exit 1 }
${record.old ? `if ([IO.File]::Exists(${literal(record.backup)}) -and -not (Match ${literal(record.backup)} ${record.old.size} ${literal(record.old.sha256)})) { exit 1 }` : `if ([IO.File]::Exists(${literal(record.backup)})) { exit 1 }`}
try {
${[record.backup, record.helper, record.done, path].map(artifact => `[IO.File]::Delete(${literal(artifact)})`).join('\n')}
} catch { if (-not (Match ${literal(target)} ${record.next.size} ${literal(record.next.sha256)})) { exit 1 } }
} finally { $guard.Dispose() }`;
	if (!existsSync(target) && record.old && !matches(record.backup, record.old)) throw new Error('Windows 更新备份无法校验，恢复已停止');
	await run(command);
	if (!matches(target, record.next) && !matches(target, record.old)) throw new Error('Windows 更新恢复校验失败，已保留诊断文件');
}

export async function applyWindowsSelfUpdate(
	transaction: DownloadedSelfUpdate,
	spawnProcess?: SpawnProcess,
	timeoutMs?: number
): Promise<void> {
	const target = canonicalPath(transaction.targetPath);
	if (!parseSemver(transaction.plan.version)) throw new Error('更新版本记录无效');
	await recoverWindowsSelfUpdate(target);
	const id = randomBytes(12).toString('hex');
	const prefix = join(dirname(target), '.' + basename(target) + '.update-' + id);
	const record: Record = {
		schema: 1,
		version: transaction.plan.version,
		id,
		owner: process.pid,
		target,
		temp: canonicalPath(transaction.tempPath),
		backup: prefix + '.backup',
		helper: prefix + '.ps1',
		done: prefix + '.done',
		old: fact(target),
		next: {size: transaction.plan.target.expectedSize, sha256: transaction.plan.target.expectedSha256.toLowerCase()}
	};
	const path = recordPath(target);
	validateRecord(target, record);
	validateGuard(path + '.lock');
	writeFileSync(path, JSON.stringify(record), {flag: 'wx'});
	let failure: unknown;
	try {
		writeFileSync(record.helper, buildWindowsUpdateHelperScript(), {flag: 'wx', encoding: 'ascii'});
		const command = `& ${literal(record.helper)} -TempPath ${literal(record.temp)} -TargetPath ${literal(target)} -BackupPath ${literal(record.backup)} -ExpectedSize ${record.next.size} -ExpectedSha256 ${literal(record.next.sha256)} -OldSize ${record.old?.size ?? 0} -OldSha256 ${literal(record.old?.sha256 ?? '')} -GuardPath ${literal(path + '.lock')} -RecordPath ${literal(path)} -RecordContent ${literal(JSON.stringify(record))}`;
		await run(command, spawnProcess, timeoutMs);
	} catch (error) {
		failure = error;
	}
	if (matches(target, record.next)) {
		try {
			writeFileSync(record.done, id, {flag: 'wx'});
		} catch {
			// Applied fact survives a failed completion write; leave ownership for next-start reconciliation.
			return;
		}
		try {
			await reconcileRecord(target, record);
		} catch {
			// Verified apply survives cleanup failure; retained record owns next-start cleanup.
		}
		return;
	}
	// Only this still-owned, ended child may roll back damaged bytes. Stale recovery never guesses ownership of unknown targets.
	if (!matches(target, record.old) && record.old && matches(record.backup, record.old)) {
		await reconcileRecord(target, record, true);
	} else if (matches(target, record.old) && !existsSync(record.backup)) {
		await reconcileRecord(target, record);
	}
	if (matches(target, record.old) && !existsSync(record.temp))
		failure = new Error(`${failure instanceof Error ? failure.message : 'Windows 更新校验失败'}；原版本已恢复，请重新下载更新`);
	throw failure ?? new Error('Windows 更新目标校验失败，已保留恢复记录');
}
