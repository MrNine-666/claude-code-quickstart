import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const tempHome = mkdtempSync(join(tmpdir(), 'ccq-uninstall-'));
process.env.CCQ_HOME = tempHome;

try {
	const {
		buildWindowsUninstallHelperScript,
		uninstallSelfExecutable
	} = await import('../src/core/self-uninstall.ts');
	const {spawnDetachedPowerShell} = await import('../src/core/windows-deferred-operation.ts');
	const {runUninstall} = await import('../src/cli/commands/uninstall.ts');

	// ── ready 握手回归：helper 从不写 ready 文件时，spawn 成功即视为已调度，
	// 短超时后必须正常返回而非抛错（此前 5s 超时会误杀本会完成的删除，真机 CI 暴露）。
	{
		let unrefCalled = false;
		const fakeSpawnNoReady = () => {
			const child = new EventEmitter();
			child.unref = () => {
				unrefCalled = true;
			};
			// 异步 emit 'spawn'：模拟进程成功创建，但脚本体（写 ready）尚未执行。
			setImmediate(() => child.emit('spawn'));
			return child;
		};

		const helperPath = join(tempHome, 'ready-timeout-helper.ps1');
		const started = Date.now();
		await assert.doesNotReject(
			spawnDetachedPowerShell(helperPath, ['-ParentPid', '1'], fakeSpawnNoReady, 120),
			'ready 超时不得抛错：helper 已 detached，会独立完成延迟操作'
		);
		assert.equal(unrefCalled, true, 'spawn 成功后必须 unref，避免父进程被 detached helper 挂住');
		assert.ok(Date.now() - started >= 100, 'ready 缺席时应等满注入的短超时窗口');
		assert.equal(existsSync(helperPath + '.ready'), false, 'ready 文件应被清理');
	}

	// spawn 阶段失败才是致命：进程未能创建时必须抛出，绝不静默视为已调度。
	{
		const fakeSpawnError = () => {
			const child = new EventEmitter();
			child.unref = () => {};
			setImmediate(() => child.emit('error', new Error('ENOENT: powershell.exe 不存在')));
			return child;
		};
		await assert.rejects(
			spawnDetachedPowerShell(join(tempHome, 'spawn-fail-helper.ps1'), [], fakeSpawnError, 120),
			/ENOENT/,
			'spawn error 必须向上抛出，供调用方报告调度失败'
		);
	}
	console.log('[PASS] spawnDetachedPowerShell：ready 超时非致命、spawn 失败致命');

	const directTarget = join(tempHome, 'ccq-direct');
	writeFileSync(directTarget, 'binary', 'utf8');
	const direct = await uninstallSelfExecutable(directTarget, {
		platform: 'darwin',
		execPath: '/usr/local/bin/bun'
	});
	assert.deepEqual(direct, {ok: true, state: 'deleted', targetPath: directTarget});
	assert.equal(existsSync(directTarget), false);

	const absentTarget = join(tempHome, 'ccq-absent');
	assert.deepEqual(await uninstallSelfExecutable(absentTarget), {
		ok: true,
		state: 'absent',
		targetPath: absentTarget
	});

	const windowsNonCurrentTarget = join(tempHome, 'ccq-non-current.exe');
	writeFileSync(windowsNonCurrentTarget, 'binary', 'utf8');
	const windowsDirect = await uninstallSelfExecutable(windowsNonCurrentTarget, {
		platform: 'win32',
		execPath: join(tempHome, 'another-ccq.exe')
	});
	assert.equal(windowsDirect.ok && windowsDirect.state, 'deleted');
	assert.equal(existsSync(windowsNonCurrentTarget), false);

	const windowsTarget = join(tempHome, 'ccq.exe');
	writeFileSync(windowsTarget, 'binary', 'utf8');
	let scheduledArgs = null;
	const scheduled = await uninstallSelfExecutable(windowsTarget, {
		platform: 'win32',
		execPath: windowsTarget.toUpperCase(),
		startWindowsHelper: async args => {
			scheduledArgs = args;
			return {helperPath: join(tempHome, 'helper.ps1')};
		}
	});
	assert.equal(scheduled.ok && scheduled.state, 'scheduled');
	assert.equal(existsSync(windowsTarget), true, 'scheduled 阶段不得提前删除当前 exe');
	assert.equal(scheduledArgs?.targetPath, windowsTarget);

	const failedSchedule = await uninstallSelfExecutable(windowsTarget, {
		platform: 'win32',
		execPath: windowsTarget,
		startWindowsHelper: async () => {
			throw new Error('spawn failed');
		}
	});
	assert.equal(failedSchedule.ok, false, 'helper spawn 失败不得误报 scheduled');
	assert.equal(existsSync(windowsTarget), true);

	const helper = buildWindowsUninstallHelperScript();
	assert.match(helper, /Wait-Process -Id \$ParentPid/);
	assert.match(helper, /Remove-Item -LiteralPath \$TargetPath/);
	assert.match(helper, /Set-Content -LiteralPath \$ReadyPath/, '卸载 helper 必须在等待父进程前报告 ready');
	assert.equal(/Start-Process -FilePath \$TargetPath/.test(helper), false, '卸载 helper 禁止重启 TUI');

	const output = [];
	const originalLog = console.log;
	console.log = (...args) => output.push(args.join(' '));
	try {
		const code = await runUninstall(true, {
			targetPath: windowsTarget,
			uninstall: async () => ({
				ok: true,
				state: 'scheduled',
				targetPath: windowsTarget,
				helperPath: join(tempHome, 'helper.ps1')
			})
		});
		assert.equal(code, 0);
	} finally {
		console.log = originalLog;
	}
	assert.equal(output.some(line => line.includes('已安排卸载')), true);
	assert.equal(output.some(line => line.includes('已删除')), false);
	console.log('[PASS] ccq 自卸载：跨平台直删 + Windows 延迟删除 + 准确文案');
} finally {
	rmSync(tempHome, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
}
