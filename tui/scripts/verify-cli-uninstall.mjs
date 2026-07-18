import assert from 'node:assert/strict';
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
	const {runUninstall} = await import('../src/cli/commands/uninstall.ts');

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
