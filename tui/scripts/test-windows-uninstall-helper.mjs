// Windows 自卸载 helper 运行时实测：当前 exe 锁释放后删除，长锁时准确失败且永不重启。
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildWindowsUninstallHelperScript} from '../src/core/self-uninstall.ts';
import {
	WINDOWS_HELPER_INTERVAL_MS,
	WINDOWS_HELPER_MAX_ATTEMPTS
} from '../src/core/windows-deferred-operation.ts';

if (process.platform !== 'win32') {
	console.log('[SKIP] Windows uninstall helper 运行时实测：非 Windows 平台');
	process.exit(0);
}

const RETRY_WINDOW_MS = WINDOWS_HELPER_MAX_ATTEMPTS * WINDOWS_HELPER_INTERVAL_MS;

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

function readLog(workdir) {
	const logPath = join(workdir, 'ccq-uninstall.log');
	return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
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

function spawnHelper(workdir, targetPath) {
	const helperPath = join(workdir, 'uninstall-helper.ps1');
	writeFileSync(helperPath, buildWindowsUninstallHelperScript(), 'utf8');
	const child = spawn('powershell.exe', [
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
		'-ParentPid', String(deadPid()),
		'-TargetPath', targetPath
	], {windowsHide: true, stdio: 'ignore'});
	return {child, helperPath};
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

async function runShortLockDelete() {
	const workdir = mkdtempSync(join(tmpdir(), 'ccq-uninstall-short-'));
	const targetPath = join(workdir, 'ccq.exe');
	writeFileSync(targetPath, 'RUNNING-CCQ', 'utf8');
	const lock = startExclusiveLock(targetPath, Math.floor(RETRY_WINDOW_MS / 3));
	await sleep(300);
	const {child, helperPath} = spawnHelper(workdir, targetPath);
	const code = await waitExit(child, RETRY_WINDOW_MS + 15000);

	try {
		assert.equal(code, 0);
		assert.equal(existsSync(targetPath), false);
		assert.equal(existsSync(helperPath), false);
		assert.match(readLog(workdir), /delete attempt \d+ failed/);
		assert.match(readLog(workdir), /delete succeeded on attempt \d+/);
		console.log('[PASS] Windows uninstall helper：短锁释放后删除目标并自清理');
	} finally {
		try { lock.kill(); } catch {}
		await safeRemove(workdir);
	}
}

async function runLongLockFailure() {
	const workdir = mkdtempSync(join(tmpdir(), 'ccq-uninstall-long-'));
	const targetPath = join(workdir, 'ccq.exe');
	writeFileSync(targetPath, 'RUNNING-CCQ', 'utf8');
	const lockMs = RETRY_WINDOW_MS + 3000;
	const lock = startExclusiveLock(targetPath, lockMs);
	await sleep(300);
	const {child, helperPath} = spawnHelper(workdir, targetPath);
	const code = await waitExit(child, lockMs + 15000);

	try {
		assert.equal(code, 1);
		assert.equal(existsSync(targetPath), true);
		assert.equal(existsSync(helperPath), false);
		assert.match(readLog(workdir), /delete failed after all attempts/);
		console.log('[PASS] Windows uninstall helper：长锁失败保留目标并自清理');
	} finally {
		try { lock.kill(); } catch {}
		await sleep(500);
		await safeRemove(workdir);
	}
}

try {
	const helper = buildWindowsUninstallHelperScript();
	assert.equal(/Start-Process/.test(helper), false, '卸载 helper 禁止启动任何目标');
	await runShortLockDelete();
	await runLongLockFailure();
	console.log('[PASS] Windows 卸载 helper 运行时实测全部通过');
} catch (error) {
	console.error('[FAIL] Windows 卸载 helper 运行时实测失败：', error?.message ?? error);
	process.exit(1);
}
