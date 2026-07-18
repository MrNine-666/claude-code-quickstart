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

	// ── Bun Windows detached 回归：必须经 cmd start 跳出父进程 job object，
	// 并且只有 helper 真正进入脚本体（写入 ready）才能报告已调度。
	{
		let spawnCall = null;
		let unrefCalled = false;
		const helperPath = join(tempHome, 'ready-helper.ps1');
		const fakeSpawnReady = (command, args, options) => {
			spawnCall = {command, args, options};
			const child = new EventEmitter();
			child.unref = () => {
				unrefCalled = true;
			};
			setImmediate(() => {
				child.emit('spawn');
				writeFileSync(helperPath + '.ready', '123', 'utf8');
				setImmediate(() => child.emit('exit', 0, null));
			});
			return child;
		};

		await assert.doesNotReject(
			spawnDetachedPowerShell(helperPath, ['-ParentPid', '1'], fakeSpawnReady, 120)
		);
		assert.equal(spawnCall?.command, 'cmd.exe', 'Bun Windows 必须通过 cmd start trampoline 启动 helper');
		assert.deepEqual(spawnCall?.args.slice(0, 5), ['/d', '/c', 'start', '', '/b']);
		assert.equal(spawnCall?.options.detached, undefined, 'bootstrap 不得使用 Bun 已知失效的 detached 选项');
		assert.equal(unrefCalled, false, 'bootstrap 必须等待 start 返回，不得提前 unref');
		const encodedIndex = spawnCall?.args.indexOf('-EncodedCommand') ?? -1;
		assert.ok(encodedIndex >= 0, 'PowerShell helper 参数必须编码，避免 cmd 路径元字符注入');
		const decodedCommand = Buffer.from(spawnCall.args[encodedIndex + 1], 'base64').toString('utf16le');
		assert.match(decodedCommand, /-ReadyPath/);
		assert.match(decodedCommand, /-ParentPid '1'/);
		assert.equal(existsSync(helperPath + '.ready'), false, 'ready 文件应被清理');
	}
	{
		const fakeSpawnNoReady = () => {
			const child = new EventEmitter();
			child.unref = () => {};
			setImmediate(() => {
				child.emit('spawn');
				setImmediate(() => child.emit('exit', 0, null));
			});
			return child;
		};
		await assert.rejects(
			spawnDetachedPowerShell(join(tempHome, 'ready-timeout-helper.ps1'), [], fakeSpawnNoReady, 120),
			/ready/i,
			'bootstrap 返回但 helper 未进入脚本体时不得误报 scheduled'
		);
	}
	{
		const fakeSpawnFailure = () => {
			const child = new EventEmitter();
			setImmediate(() => child.emit('exit', 7, null));
			return child;
		};
		await assert.rejects(
			spawnDetachedPowerShell(join(tempHome, 'bootstrap-fail-helper.ps1'), [], fakeSpawnFailure, 120),
			/bootstrap failed: 7/,
			'cmd start bootstrap 非零退出必须向上报告'
		);
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
	console.log('[PASS] spawnDetachedPowerShell：cmd start 跳出 Bun job、ready 与 spawn 失败均致命');

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
