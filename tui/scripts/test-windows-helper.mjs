// Windows 更新 helper 运行时实测：覆盖文件占用重试、完整性校验与可选重启。
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	buildWindowsUpdateHelperScript,
	WINDOWS_HELPER_COPY_MAX_ATTEMPTS,
	WINDOWS_HELPER_COPY_INTERVAL_MS
} from '../src/core/update.ts';

if (process.platform !== 'win32') {
	console.log('[SKIP] Windows helper 运行时实测：非 Windows 平台');
	process.exit(0);
}

const RETRY_WINDOW_MS = WINDOWS_HELPER_COPY_MAX_ATTEMPTS * WINDOWS_HELPER_COPY_INTERVAL_MS;
const LOG_PATH = join(process.env.TEMP ?? tmpdir(), 'ccq-update.log');

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function safeRemove(pathToRemove) {
	for (let attempt = 1; attempt <= 10; attempt++) {
		try {
			rmSync(pathToRemove, {recursive: true, force: true});
			return;
		} catch {
			await sleep(300);
		}
	}
	console.warn(`[WARN] 清理残留失败（可手动删除）: ${pathToRemove}`);
}

function clearLog() {
	rmSync(LOG_PATH, {force: true});
}

function readLog() {
	return existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : '';
}

function sha256File(filePath) {
	return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function deadPid() {
	return spawnSync('cmd', ['/c', 'exit'], {windowsHide: true}).pid;
}

function startExclusiveLock(targetPath, holdMs) {
	const script = [
		`$fs = [System.IO.File]::Open('${targetPath.replace(/'/g, "''")}', 'Open', 'Read', 'None')`,
		`Start-Sleep -Milliseconds ${holdMs}`,
		'$fs.Close()',
		'$fs.Dispose()'
	].join('\r\n');
	return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
		windowsHide: true,
		stdio: 'ignore'
	});
}

function spawnHelper(workdir, tempPath, targetPath, {restartAfterApply = false} = {}) {
	const helperPath = join(workdir, 'helper.ps1');
	const expectedSha256 = sha256File(tempPath);
	writeFileSync(helperPath, buildWindowsUpdateHelperScript(), 'utf8');
	const args = [
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
		'-ParentPid', String(deadPid()),
		'-TempPath', tempPath,
		'-TargetPath', targetPath,
		'-WorkingDirectory', workdir,
		'-ExpectedSize', String(statSync(tempPath).size),
		'-ExpectedSha256', expectedSha256
	];
	if (restartAfterApply) args.push('-RestartAfterApply');
	const child = spawn('powershell.exe', args, {
		windowsHide: true,
		stdio: ['ignore', 'ignore', 'pipe']
	});
	let stderr = '';
	child.stderr?.on('data', chunk => {
		stderr += chunk.toString();
	});
	return {child, helperPath, expectedSha256, readStderr: () => stderr};
}

function waitExit(child, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`helper 未在 ${timeoutMs}ms 内退出`)), timeoutMs);
		child.on('exit', code => {
			clearTimeout(timer);
			resolve(code);
		});
		child.on('error', error => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function waitForFile(filePath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(filePath)) return;
		await sleep(100);
	}
	throw new Error(`等待文件超时: ${filePath}`);
}

async function runShortLockWithoutRestart() {
	const workdir = mkdtempSync(join(tmpdir(), 'ccq-helper-short-'));
	const targetPath = join(workdir, 'ccq-fake.cmd');
	const tempPath = join(workdir, '.ccq-update.tmp');
	const markerPath = join(workdir, 'unexpected-restart.txt');
	writeFileSync(tempPath, `@echo off\r\n> "${markerPath}" echo restarted\r\n`, 'utf8');
	writeFileSync(targetPath, 'OLD-CONTENT', 'utf8');

	clearLog();
	const lock = startExclusiveLock(targetPath, Math.floor(RETRY_WINDOW_MS / 3));
	await sleep(300);
	const {child, helperPath, expectedSha256, readStderr} = spawnHelper(workdir, tempPath, targetPath);
	const code = await waitExit(child, RETRY_WINDOW_MS + 15000);

	try {
		const log = readLog();
		assert.match(log, /replace attempt \d+ failed/, `helper stderr: ${readStderr()}`);
		assert.match(log, /replace succeeded on attempt \d+/);
		assert.equal(code, 0);
		assert.equal(existsSync(tempPath), false);
		assert.equal(existsSync(helperPath), false);
		assert.equal(existsSync(helperPath + '.backup'), false, '成功替换后不得残留 backup');
		assert.equal(sha256File(targetPath), expectedSha256);
		assert.equal(existsSync(markerPath), false, 'restart=false 不得启动更新后的目标');
		console.log('[PASS] Windows update helper：短锁重试成功且 restart=false 不启动目标');
	} finally {
		try { lock.kill(); } catch {}
		await safeRemove(workdir);
	}
}

async function runLongLockFailure() {
	const workdir = mkdtempSync(join(tmpdir(), 'ccq-helper-long-'));
	const targetPath = join(workdir, 'ccq-fake.exe');
	const tempPath = join(workdir, '.ccq-update.tmp');
	writeFileSync(tempPath, 'NEW-CONTENT-SHOULD-REMAIN', 'utf8');
	writeFileSync(targetPath, 'OLD-CONTENT-MUST-NOT-CHANGE', 'utf8');

	clearLog();
	const lockMs = RETRY_WINDOW_MS + 3000;
	const lock = startExclusiveLock(targetPath, lockMs);
	await sleep(300);
	const {child, helperPath} = spawnHelper(workdir, tempPath, targetPath);
	const code = await waitExit(child, lockMs + 15000);

	try {
		assert.match(readLog(), /replace failed after all attempts/);
		assert.equal(code, 1);
		assert.equal(existsSync(tempPath), true);
		assert.equal(existsSync(helperPath), false);
		assert.equal(existsSync(helperPath + '.backup'), false, '替换未开始时不得创建 backup');
		try { lock.kill(); } catch {}
		await waitExit(lock, 5000).catch(() => undefined);
		assert.equal(readFileSync(targetPath, 'utf8'), 'OLD-CONTENT-MUST-NOT-CHANGE');
		console.log('[PASS] Windows update helper：长锁失败保留旧目标与诊断 temp');
	} finally {
		try { lock.kill(); } catch {}
		await sleep(500);
		await safeRemove(workdir);
	}
}

async function runRestartAfterApply() {
	const workdir = mkdtempSync(join(tmpdir(), 'ccq-helper-restart-'));
	const targetPath = join(workdir, 'ccq-fake.cmd');
	const tempPath = join(workdir, '.ccq-update.tmp');
	const markerPath = join(workdir, 'restarted.txt');
	writeFileSync(tempPath, `@echo off\r\n> "${markerPath}" echo restarted\r\n`, 'utf8');
	writeFileSync(targetPath, 'OLD-CONTENT', 'utf8');

	clearLog();
	const {child, helperPath} = spawnHelper(workdir, tempPath, targetPath, {restartAfterApply: true});
	const code = await waitExit(child, RETRY_WINDOW_MS + 15000);

	try {
		assert.equal(code, 0);
		await waitForFile(markerPath, 5000);
		assert.match(readLog(), /starting updated executable/);
		assert.equal(existsSync(helperPath), false);
		assert.equal(existsSync(helperPath + '.backup'), false, '重启前必须清理 backup');
		console.log('[PASS] Windows update helper：restart=true 仅在验证成功后启动目标');
	} finally {
		await safeRemove(workdir);
	}
}

try {
	await runShortLockWithoutRestart();
	await runLongLockFailure();
	await runRestartAfterApply();
	clearLog();
	console.log('[PASS] Windows 更新 helper 运行时实测全部通过');
} catch (error) {
	console.error('[FAIL] Windows 更新 helper 运行时实测失败：', error?.message ?? error);
	process.exit(1);
}
