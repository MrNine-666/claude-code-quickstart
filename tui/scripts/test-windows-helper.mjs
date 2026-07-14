// Windows 更新 helper 运行时实测（Layer 2）：真正 spawn helper 脚本，用独占文件句柄
// 模拟“旧 exe 镜像被占用”，验证 Copy-Item 重试循环与失败降级行为。
//
// 覆盖两个核心场景：
//   A. 占用短于重试窗口 → helper 重试后拷贝成功、删 tmp、目标被覆盖
//   B. 占用长于重试窗口 → helper 全部重试失败、exit 1、保留 tmp、目标不变
//
// 非 Windows 平台跳过（helper 是 Windows 专属分支）。
// 与运行时共用 buildWindowsUpdateHelperScript（DRY，单一真理源）。

import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync} from 'node:fs';
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

const RETRY_WINDOW_MS = WINDOWS_HELPER_COPY_MAX_ATTEMPTS * WINDOWS_HELPER_COPY_INTERVAL_MS; // ~5s
const LOG_PATH = join(process.env.TEMP ?? tmpdir(), 'ccq-update.log');
const WHOAMI = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// best-effort 清理：helper 成功路径会 Start-Process 目标 exe（cwd=workdir），
// 该瞬退子进程可能短暂锁住 workdir，导致 rm 撞文件占用。重试几次后仍失败仅告警，
// 不让脚手架清理问题污染被测逻辑的断言结果。
async function safeRemove(pathToRemove) {
	for (let attempt = 1; attempt <= 10; attempt++) {
		try {
			rmSync(pathToRemove, {recursive: true, force: true});
			return;
		} catch {
			// eslint-disable-next-line no-await-in-loop -- 串行等待占用释放
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

// 已退出进程的 pid：helper 的 Wait-Process 对不存在的 pid 走 SilentlyContinue 立即返回。
function deadPid() {
	const result = spawnSync('cmd', ['/c', 'exit'], {windowsHide: true});
	return result.pid;
}

// 独占持锁进程：以 FileShare.None 打开目标文件 holdMs 毫秒，期间任何覆盖写入都会失败。
function startExclusiveLock(targetPath, holdMs) {
	const script = [
		`$fs = [System.IO.File]::Open('${targetPath.replace(/'/g, "''")}', 'Open', 'Read', 'None')`,
		`Start-Sleep -Milliseconds ${holdMs}`,
		'$fs.Close()',
		'$fs.Dispose()'
	].join('\r\n');
	const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
		windowsHide: true,
		stdio: 'ignore'
	});
	return child;
}

// 写 helper 脚本并 spawn（复用运行时同一模板），返回 helper 进程与其 .ps1 路径。
function spawnHelper(workdir, tempPath, targetPath, parentPid) {
	const helperPath = join(workdir, 'helper.ps1');
	writeFileSync(helperPath, buildWindowsUpdateHelperScript(), 'utf8');
	const child = spawn('powershell.exe', [
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
		'-ParentPid', String(parentPid),
		'-TempPath', tempPath,
		'-TargetPath', targetPath,
		'-WorkingDirectory', workdir
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
	});
}

async function runScenarioA() {
	// 占用短于重试窗口 → 释放后拷贝成功。
	const workdir = mkdtempSync(join(tmpdir(), 'ccq-helper-a-'));
	const targetPath = join(workdir, 'ccq-fake.exe');
	const tempPath = join(workdir, '.ccq-update.tmp');
	// tmp 用真实 whoami.exe 副本，保证覆盖后 Start-Process 目标是无害可执行文件（瞬退）。
	copyFileSync(WHOAMI, tempPath);
	writeFileSync(targetPath, 'OLD-CONTENT-PLACEHOLDER'); // 旧内容，会被覆盖
	const tempSize = statSync(tempPath).size;

	clearLog();
	const lock = startExclusiveLock(targetPath, Math.floor(RETRY_WINDOW_MS / 3)); // 锁 ~1.6s，短于 5s 窗口
	await sleep(300); // 确保独占句柄已生效

	const {child, helperPath} = spawnHelper(workdir, tempPath, targetPath, deadPid());
	const code = await waitExit(child, RETRY_WINDOW_MS + 15000);

	try {
		const log = readLog();
		assert.match(log, /copy attempt \d+ failed/, 'A: 占用期应至少一次 Copy 失败并记录重试');
		assert.match(log, /copy succeeded on attempt \d+/, 'A: 锁释放后应拷贝成功');
		assert.equal(existsSync(tempPath), false, 'A: 成功后应删除 tmp');
		assert.equal(statSync(targetPath).size, tempSize, 'A: 目标应被 tmp 完整覆盖（大小一致）');
		assert.equal(code, 0, 'A: helper 成功路径应以 0 退出');
		console.log(`[PASS] 场景 A：占用短于重试窗口 → 重试后拷贝成功（exit ${code}）`);
	} finally {
		try {lock.kill();} catch {}
		await sleep(500); // 等 Start-Process 启动的 fake exe 瞬退、释放 workdir 句柄
		await safeRemove(helperPath);
		await safeRemove(workdir);
	}
}

async function runScenarioB() {
	// 占用长于重试窗口 → 全部重试失败，保留 tmp，目标不变。
	const workdir = mkdtempSync(join(tmpdir(), 'ccq-helper-b-'));
	const targetPath = join(workdir, 'ccq-fake.exe');
	const tempPath = join(workdir, '.ccq-update.tmp');
	writeFileSync(tempPath, 'NEW-CONTENT-SHOULD-REMAIN');
	writeFileSync(targetPath, 'OLD-CONTENT-MUST-NOT-CHANGE');

	clearLog();
	const lockMs = RETRY_WINDOW_MS + 3000; // 锁 ~8s，长于 5s 窗口，全程占用
	const lock = startExclusiveLock(targetPath, lockMs);
	await sleep(300);

	const {child, helperPath} = spawnHelper(workdir, tempPath, targetPath, deadPid());
	const code = await waitExit(child, lockMs + 15000);

	try {
		const log = readLog();
		assert.match(log, /copy failed after all attempts/, 'B: 全部重试失败应记录');
		assert.equal(code, 1, 'B: helper 失败路径应以 1 退出');
		assert.equal(existsSync(tempPath), true, 'B: 失败应保留 tmp 供后续重试');
		assert.equal(readFileSync(targetPath, 'utf8'), 'OLD-CONTENT-MUST-NOT-CHANGE', 'B: 目标不得被改动');
		console.log(`[PASS] 场景 B：占用长于重试窗口 → 重试全败、保留 tmp、目标不变（exit ${code}）`);
	} finally {
		try {lock.kill();} catch {}
		await sleep(500); // 等锁进程释放 workdir 句柄
		await safeRemove(helperPath);
		await safeRemove(workdir);
	}
}

try {
	await runScenarioA();
	await runScenarioB();
	clearLog();
	console.log('[PASS] Windows 更新 helper 运行时实测全部通过');
} catch (error) {
	console.error('[FAIL] Windows 更新 helper 运行时实测失败：', error?.message ?? error);
	process.exit(1);
}
