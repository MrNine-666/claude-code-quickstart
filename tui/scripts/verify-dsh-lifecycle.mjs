import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, posix, win32} from 'node:path';
import {tmpdir} from 'node:os';

const {
	DSH_COMMAND,
	DSH_INSTALL_ARGS,
	DSH_PACKAGE_NAME,
	DSH_TOOL_ID,
	DSH_UNINSTALL_ARGS,
	DSH_VERSION_ARGS,
	detectDshLifecycle,
	installDsh,
	uninstallDsh,
	updateDsh
} = await import('../src/core/dsh-lifecycle.ts');
const {environmentPath, prependPathForCurrentProcess, withEnvironmentPath} = await import('../src/core/npm-path.ts');
const {createSnapshot, getSnapshotFiles} = await import('../src/core/update.ts');
const {applyUpdates} = await import('../src/core/update.ts');
const {uninstallComponent} = await import('../src/core/tools-manage.ts');
const updateSource = readFileSync(new URL('../src/core/update.ts', import.meta.url), 'utf8');

const TEST_PLATFORM = process.platform;
const pathApi = TEST_PLATFORM === 'win32' ? win32 : posix;
const testDelimiter = TEST_PLATFORM === 'win32' ? ';' : ':';
const originalPath = process.env.PATH;
const originalPathCase = process.env.Path;
const originalCcqHome = process.env.CCQ_HOME;
const root = mkdtempSync(join(tmpdir(), 'ccq-dsh-lifecycle-'));

assert.match(
	updateSource,
	/const dshLifecycle = await detectDshLifecycle\(\{env: \{\.\.\.process\.env\}\}\);[\s\S]{0,180}await refreshNpmGlobalBinPath\(\);/,
	'DSH 检测必须先于 npm global bin PATH 刷新，保留外部 PATH 冲突事实'
);
console.log('[PASS] DSH detection preserves original PATH precedence before generic refresh');

function makePrefix(name) {
	const prefix = pathApi.join(root, name);
	const binDir = TEST_PLATFORM === 'win32' ? prefix : pathApi.join(prefix, 'bin');
	const packageRoot =
		TEST_PLATFORM === 'win32'
			? pathApi.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
			: pathApi.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh');
	mkdirSync(binDir, {recursive: true});
	mkdirSync(packageRoot, {recursive: true});
	const commandName = TEST_PLATFORM === 'win32' ? `${DSH_COMMAND}.cmd` : DSH_COMMAND;
	return {prefix, binDir, packageRoot, commandPath: pathApi.join(binDir, commandName)};
}

function writePackage(fixture, version = '1.2.3', bin = {dsh: 'bin/dsh.js'}) {
	writeFileSync(pathApi.join(fixture.packageRoot, 'package.json'), JSON.stringify({name: DSH_PACKAGE_NAME, version, bin}), 'utf8');
	const binTarget = typeof bin === 'string' ? bin : bin.dsh;
	const shim =
		TEST_PLATFORM === 'win32'
			? `@ECHO off\r\n"%~dp0node.exe" "%~dp0node_modules\\@deepseek-ai\\dsh\\${binTarget.replaceAll('/', '\\')}" %*\r\n`
			: `#!/bin/sh\n# ${fixture.packageRoot}/${binTarget}\n`;
	writeFileSync(fixture.commandPath, shim, 'utf8');
}

function writeExternalCommand(directory) {
	mkdirSync(directory, {recursive: true});
	const commandName = TEST_PLATFORM === 'win32' ? `${DSH_COMMAND}.cmd` : DSH_COMMAND;
	const commandPath = pathApi.join(directory, commandName);
	writeFileSync(commandPath, '#!/bin/sh\n# external dsh\n', 'utf8');
	return commandPath;
}

function detectionExec({prefix, commandCode = 0, commandVersion = '1.2.3', calls = []}) {
	return async (command, args) => {
		calls.push({command, args: [...args]});
		if (command === 'npm' && args[0] === 'prefix' && args[1] === '-g') {
			return {code: 0, stdout: `${prefix}\n`, stderr: ''};
		}
		if (command === DSH_COMMAND && args.length === 1 && args[0] === '--version') {
			return {code: commandCode, stdout: commandCode === 0 ? `dsh ${commandVersion}\n` : '', stderr: ''};
		}
		return {code: 127, stdout: '', stderr: 'unexpected command'};
	};
}

function lifecycle(state, overrides = {}) {
	const repairRequired = state === 'broken' || state === 'version-mismatch';
	return {
		owner: DSH_TOOL_ID,
		state,
		packageName: DSH_PACKAGE_NAME,
		packageVersion: '',
		commandVersion: '',
		packagePresent: false,
		commandPresent: false,
		canInstall: state === 'not-installed',
		canUpdate: state === 'managed' || repairRequired,
		canUninstall: state === 'managed' || repairRequired,
		repairRequired,
		diagnostic: `fixture: ${state}`,
		...overrides
	};
}

function sequenceDetector(values) {
	let index = 0;
	return async () => values[Math.min(index++, values.length - 1)];
}

function operationExec(prefix, calls, mutationCode = 0) {
	return async (command, args) => {
		calls.push({command, args: [...args]});
		if (command === 'npm' && args[0] === 'prefix' && args[1] === '-g') {
			return {code: 0, stdout: `${prefix}\n`, stderr: ''};
		}
		if (command === 'npm' && (args[0] === 'install' || args[0] === 'uninstall')) {
			return {code: mutationCode, stdout: '', stderr: mutationCode === 0 ? '' : 'fixture mutation failure'};
		}
		return {code: 0, stdout: '', stderr: ''};
	};
}

function mutationCalls(calls, verb) {
	return calls.filter(call => call.command === 'npm' && call.args[0] === verb);
}

function withFixtureProcessEnv(env, run) {
	const descriptor = Object.getOwnPropertyDescriptor(process, 'env');
	assert.ok(descriptor, 'process.env descriptor exists');
	Object.defineProperty(process, 'env', {...descriptor, value: env});
	try {
		run();
	} finally {
		Object.defineProperty(process, 'env', descriptor);
	}
}

async function withFixtureProcessEnvAsync(env, run) {
	const descriptor = Object.getOwnPropertyDescriptor(process, 'env');
	assert.ok(descriptor, 'process.env descriptor exists');
	Object.defineProperty(process, 'env', {...descriptor, value: env});
	try {
		return await run();
	} finally {
		Object.defineProperty(process, 'env', descriptor);
	}
}

// ── PATH injection: explicit platform delimiter and Windows casing ───────────

withFixtureProcessEnv({Path: 'C:\\existing'}, () => {
	prependPathForCurrentProcess('C:\\npm-global', 'win32');
	assert.equal(process.env.Path, 'C:\\npm-global;C:\\existing', 'Windows 仅 Path 时使用分号并保留 Path 形式');
	assert.equal(Object.hasOwn(process.env, 'PATH'), false, 'Windows 仅 Path 时不凭空创建 PATH');
});

withFixtureProcessEnv({PATH: 'C:\\existing'}, () => {
	prependPathForCurrentProcess('C:\\npm-global', 'win32');
	assert.equal(process.env.PATH, 'C:\\npm-global;C:\\existing', 'Windows 仅 PATH 时使用分号并保留 PATH 形式');
	assert.equal(Object.hasOwn(process.env, 'Path'), false, 'Windows 仅 PATH 时不凭空创建 Path');
});

withFixtureProcessEnv({Path: 'C:\\existing', PATH: 'C:\\legacy'}, () => {
	prependPathForCurrentProcess('C:\\npm-global', 'win32');
	assert.equal(process.env.Path, 'C:\\npm-global;C:\\existing;C:\\legacy', 'Windows Path 更新保留另一种变量内容');
	assert.equal(process.env.PATH, process.env.Path, 'Windows 同时存在两种变量形式时同步更新');
});
assert.equal(environmentPath({Path: 'C:\\existing'}, 'win32'), 'C:\\existing', 'Windows Path 可作为子进程 PATH 来源');
assert.deepEqual(
	withEnvironmentPath({Path: 'C:\\existing'}, 'C:\\npm-global;C:\\existing', 'win32'),
	{Path: 'C:\\npm-global;C:\\existing'},
	'Windows Path-only 子进程环境不得额外创建 PATH'
);
console.log('[PASS] npm PATH injection handles explicit platform delimiters and Windows Path/PATH casing');

// ── Ownership and command-health matrix ─────────────────────────────────────
{
	const managedFixture = makePrefix('managed');
	writePackage(managedFixture);
	const calls = [];
	const managed = await detectDshLifecycle({
		platform: TEST_PLATFORM,
		env: {PATH: managedFixture.binDir},
		exec: detectionExec({prefix: managedFixture.prefix, calls})
	});
	assert.equal(managed.state, 'managed', 'npm 包、PATH shim、版本命令一致时为 managed');
	assert.equal(managed.canInstall, false, 'managed 不允许 install');
	assert.equal(managed.canUpdate, true, 'managed 允许 update');
	assert.equal(managed.canUninstall, true, 'managed 允许 uninstall');
	assert.notEqual(managed.state, 'verification-unknown', '普通 DSH 检测不产生 mutation 专用 verification-unknown 状态');
	assert.deepEqual(calls[0], {command: 'npm', args: ['prefix', '-g']}, '检测先解析 npm global prefix');
	assert.deepEqual(calls[1], {command: DSH_COMMAND, args: [...DSH_VERSION_ARGS]}, '检测使用 dsh --version');
	if (TEST_PLATFORM === 'win32') {
		assert.match(
			readFileSync(managedFixture.commandPath, 'utf8'),
			/node_modules\\@deepseek-ai\\dsh\\bin\\dsh\.js/i,
			'真实 .cmd npm shim 指向包内 dsh 入口'
		);
		assert.equal(pathApi.extname(managedFixture.commandPath), '.cmd', 'Windows ownership fixture 使用 .cmd shim');
	}
	console.log('[PASS] managed ownership requires npm package, PATH shim, and matching version');

	const mismatch = await detectDshLifecycle({
		platform: TEST_PLATFORM,
		env: {PATH: managedFixture.binDir},
		exec: detectionExec({prefix: managedFixture.prefix, commandVersion: '1.2.4'})
	});
	assert.equal(mismatch.state, 'version-mismatch', '包版本与命令版本不一致时为 version-mismatch');
	assert.equal(mismatch.repairRequired, true, 'version-mismatch 需要修复');
	assert.notEqual(mismatch.state, 'verification-unknown', '普通 DSH 检测不产生 mutation 专用 verification-unknown 状态');

	const broken = await detectDshLifecycle({
		platform: TEST_PLATFORM,
		env: {PATH: managedFixture.binDir},
		exec: detectionExec({prefix: managedFixture.prefix, commandCode: 1})
	});
	assert.equal(broken.state, 'broken', '受管包存在但版本命令失败时为 broken');
	assert.equal(broken.canUpdate, true, 'broken 允许修复');
	assert.notEqual(broken.state, 'verification-unknown', '普通 DSH 检测不产生 mutation 专用 verification-unknown 状态');

	writeFileSync(pathApi.join(managedFixture.packageRoot, 'package.json'), '{malformed', 'utf8');
	const malformed = await detectDshLifecycle({
		platform: TEST_PLATFORM,
		env: {PATH: managedFixture.binDir},
		exec: detectionExec({prefix: managedFixture.prefix})
	});
	assert.equal(malformed.state, 'broken', '损坏 manifest 不得伪装为正常受管安装');
	assert.notEqual(malformed.state, 'verification-unknown', '普通 DSH 检测不产生 mutation 专用 verification-unknown 状态');
}

{
	const notInstalledFixture = makePrefix('not-installed');
	const notInstalled = await detectDshLifecycle({
		platform: TEST_PLATFORM,
		env: {PATH: ''},
		exec: detectionExec({prefix: notInstalledFixture.prefix})
	});
	assert.equal(notInstalled.state, 'not-installed', '无包且无命令时为 not-installed');
	assert.equal(notInstalled.canInstall, true, 'not-installed 允许 install');
	assert.notEqual(notInstalled.state, 'verification-unknown', '普通 DSH 检测不产生 mutation 专用 verification-unknown 状态');

	const externalDir = pathApi.join(root, 'external-bin');
	writeExternalCommand(externalDir);
	const external = await detectDshLifecycle({
		platform: TEST_PLATFORM,
		env: {PATH: externalDir},
		exec: detectionExec({prefix: notInstalledFixture.prefix})
	});
	assert.equal(external.state, 'external', '无受管包但 PATH 有 dsh 时为 external');
	assert.equal(external.canInstall, false, 'external 不允许接管安装');
	assert.equal(external.canUpdate, false, 'external 不允许更新');
	assert.equal(external.canUninstall, false, 'external 不允许卸载');
	assert.notEqual(external.state, 'verification-unknown', '普通 DSH 检测不产生 mutation 专用 verification-unknown 状态');
	assert.match(external.diagnostic, /外部安装/, 'external 诊断明确说明不会接管');

	const conflictFixture = makePrefix('path-conflict');
	writePackage(conflictFixture);
	const conflictDir = pathApi.join(root, 'conflict-bin');
	writeExternalCommand(conflictDir);
	const conflict = await detectDshLifecycle({
		platform: TEST_PLATFORM,
		env: {PATH: [conflictDir, conflictFixture.binDir].join(testDelimiter)},
		exec: detectionExec({prefix: conflictFixture.prefix})
	});
	assert.equal(conflict.state, 'path-conflict', '外部 dsh 遮蔽受管 npm bin 时为 path-conflict');
	assert.equal(conflict.canUpdate, false, 'PATH 冲突禁止更新');
	assert.equal(conflict.canUninstall, false, 'PATH 冲突禁止卸载');
	assert.notEqual(conflict.state, 'verification-unknown', '普通 DSH 检测不产生 mutation 专用 verification-unknown 状态');
	assert.match(conflict.diagnostic, /PATH 首个 dsh/, 'PATH 冲突诊断明确');

	const unavailable = await detectDshLifecycle({
		platform: TEST_PLATFORM,
		env: {PATH: externalDir},
		exec: async () => {
			throw new Error('spawn npm ENOENT');
		}
	});
	assert.equal(unavailable.state, 'npm-unavailable', 'npm 缺失时为 npm-unavailable');
	assert.equal(unavailable.canInstall, false, 'npm 缺失禁止安装');
	assert.equal(unavailable.canUpdate, false, 'npm 缺失禁止更新');
	assert.equal(unavailable.canUninstall, false, 'npm 缺失禁止卸载');
	assert.notEqual(unavailable.state, 'verification-unknown', '普通 DSH 检测不产生 mutation 专用 verification-unknown 状态');
	console.log('[PASS] external, PATH conflict, not-installed, and npm-unavailable are read-only as required');
}

// ── npm argv, preflight ownership gate, postflight, and prerelease warning ───
{
	const prefix = pathApi.join(root, 'operations');
	const managed = lifecycle('managed', {
		packageVersion: '1.2.3',
		commandVersion: '1.2.3',
		packagePresent: true,
		commandPresent: true
	});
	const notInstalled = lifecycle('not-installed');
	const external = lifecycle('external', {commandPresent: true});

	const windowsPostflightDetections = [];
	const windowsPathResult = await withFixtureProcessEnvAsync({Path: 'C:\\process-path'}, async () =>
		updateDsh(undefined, {
			platform: 'win32',
			env: {Path: 'C:\\existing'},
			exec: async (command, args) => {
				if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: 'C:\\npm-global\n', stderr: ''};
				return {code: 0, stdout: '', stderr: ''};
			},
			detect: async deps => {
				windowsPostflightDetections.push(deps);
				return managed;
			}
		})
	);
	assert.equal(windowsPathResult.success, true, 'Windows Path-only postflight remains operable');
	assert.equal(windowsPostflightDetections.length, 2, 'Windows update performs preflight and postflight detection');
	assert.deepEqual(
		windowsPostflightDetections[1]?.env,
		{Path: 'C:\\npm-global;C:\\existing'},
		'Windows postflight preserves Path casing while prefixing npm bin'
	);
	assert.equal(
		Object.hasOwn(windowsPostflightDetections[1]?.env ?? {}, 'PATH'),
		false,
		'Windows Path-only postflight does not introduce a conflicting PATH key'
	);

	const installCalls = [];
	const installResult = await installDsh(undefined, {
		exec: operationExec(prefix, installCalls),
		detect: sequenceDetector([notInstalled, managed])
	});
	assert.equal(installResult.success, true, 'not-installed 安装成功');
	assert.deepEqual(
		mutationCalls(installCalls, 'install').map(call => call.args),
		[DSH_INSTALL_ARGS],
		'安装使用精确 npm argv'
	);
	assert.equal(installResult.lifecycle.state, 'managed', '安装成功返回 postflight lifecycle');

	const updateCalls = [];
	const updateResult = await updateDsh(undefined, {
		exec: operationExec(prefix, updateCalls),
		detect: sequenceDetector([managed, managed])
	});
	assert.equal(updateResult.success, true, 'managed 更新成功');
	assert.deepEqual(
		mutationCalls(updateCalls, 'install').map(call => call.args),
		[DSH_INSTALL_ARGS],
		'更新使用精确 npm argv'
	);
	assert.equal(updateResult.lifecycle.state, 'managed', '更新成功返回 postflight lifecycle');

	const uninstallCalls = [];
	const uninstallResult = await uninstallDsh(undefined, {
		exec: operationExec(prefix, uninstallCalls),
		detect: sequenceDetector([managed, external])
	});
	assert.equal(uninstallResult.success, true, '包移除且外部命令仍存在时卸载成功');
	assert.deepEqual(
		mutationCalls(uninstallCalls, 'uninstall').map(call => call.args),
		[DSH_UNINSTALL_ARGS],
		'卸载使用精确 npm argv'
	);
	assert.equal(uninstallResult.lifecycle.state, 'external', '卸载返回外部 dsh postflight 状态');
	assert.equal(uninstallResult.warning, external.diagnostic, '卸载后外部 dsh 以 warning 暴露');

	const blockedCalls = [];
	const blocked = await installDsh(undefined, {
		exec: operationExec(prefix, blockedCalls),
		detect: async () => external
	});
	assert.equal(blocked.success, false, 'external install 被阻止');
	assert.equal(mutationCalls(blockedCalls, 'install').length, 0, 'external install 不执行 npm 写命令');

	const failedPostflight = lifecycle('broken', {
		packageVersion: '1.2.3',
		packagePresent: true,
		commandPresent: true,
		repairRequired: true
	});
	const postflightCalls = [];
	const failed = await installDsh(undefined, {
		exec: operationExec(prefix, postflightCalls),
		detect: sequenceDetector([notInstalled, failedPostflight])
	});
	assert.equal(failed.success, false, 'postflight 非 managed 必须失败');
	assert.equal(failed.lifecycle.state, 'broken', 'postflight 失败保留最终 lifecycle');
	assert.match(failed.error, /postflight/, 'postflight 失败有明确诊断');

	const thrownMutationCalls = [];
	const thrownMutation = await updateDsh(undefined, {
		exec: async (command, args) => {
			thrownMutationCalls.push({command, args: [...args]});
			if (command === 'npm' && args[0] === 'install') throw new Error('fixture mutation throw');
			if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: `${prefix}\n`, stderr: ''};
			return {code: 0, stdout: '', stderr: ''};
		},
		detect: sequenceDetector([managed, managed])
	});
	assert.equal(thrownMutation.success, false, 'mutation throw 必须返回失败');
	assert.equal(thrownMutation.lifecycle.state, 'managed', 'mutation throw 后 postflight 成功时保留最终 managed lifecycle');
	assert.match(thrownMutation.error, /fixture mutation throw/, 'mutation throw 诊断被保留');
	assert.equal(mutationCalls(thrownMutationCalls, 'install').length, 1, 'mutation throw 仍只尝试一次 npm install');

	const nonzeroMutationCalls = [];
	const nonzeroMutation = await updateDsh(undefined, {
		exec: operationExec(prefix, nonzeroMutationCalls, 23),
		detect: sequenceDetector([managed, managed])
	});
	assert.equal(nonzeroMutation.success, false, 'mutation 非零退出码必须返回失败');
	assert.equal(nonzeroMutation.lifecycle.state, 'managed', 'mutation 非零后 postflight 成功时保留最终 managed lifecycle');
	assert.match(nonzeroMutation.error, /exit 23/, 'mutation 非零退出码诊断被保留');

	let postflightDetectCount = 0;
	const verificationUnknown = await updateDsh(undefined, {
		exec: operationExec(prefix, []),
		detect: async () => {
			postflightDetectCount += 1;
			if (postflightDetectCount === 1) return managed;
			throw new Error('fixture postflight detector failure');
		}
	});
	assert.equal(verificationUnknown.success, false, 'postflight detector throw 必须返回失败');
	assert.equal(verificationUnknown.state, 'verification-unknown', 'postflight detector throw 使用不可验证最终状态');
	assert.equal(verificationUnknown.lifecycle.state, 'verification-unknown', 'postflight detector throw 不得复用 mutation 前 lifecycle');
	assert.equal(verificationUnknown.lifecycle.canInstall, false, 'verification-unknown 禁止 install');
	assert.equal(verificationUnknown.lifecycle.canUpdate, false, 'verification-unknown 禁止 update');
	assert.equal(verificationUnknown.lifecycle.canUninstall, false, 'verification-unknown 禁止 uninstall');
	assert.match(verificationUnknown.error, /postflight.*fixture postflight detector failure/, 'postflight detector 诊断被保留');

	let combinedDetectCount = 0;
	const combinedFailure = await updateDsh(undefined, {
		exec: operationExec(prefix, [], 41),
		detect: async () => {
			combinedDetectCount += 1;
			if (combinedDetectCount === 1) return managed;
			throw new Error('fixture combined postflight failure');
		}
	});
	assert.equal(combinedFailure.lifecycle.state, 'verification-unknown', 'mutation 与 postflight 双失败仍使用不可验证最终状态');
	assert.match(combinedFailure.error, /exit 41/, 'mutation 失败诊断不可被 postflight 错误覆盖');
	assert.match(combinedFailure.error, /fixture combined postflight failure/, 'postflight 检测失败诊断不可覆盖 mutation 错误');
	console.log('[PASS] mutation failures preserve postflight facts; postflight detection failure becomes verification-unknown');

	const mixedCalls = [];
	let mixedSnapshotCreated = false;
	const mixedDsh = lifecycle('path-conflict', {packagePresent: true, commandPresent: true});
	const mixedResult = await applyUpdates(
		[
			{
				id: DSH_TOOL_ID,
				name: 'DeepSeek Harness',
				type: 'npm',
				package: DSH_PACKAGE_NAME,
				installed: true,
				currentVersion: '1.2.3',
				latestVersion: '1.2.4',
				hasUpdate: true
			},
			{
				id: 'OpenSpec',
				name: 'OpenSpec CLI',
				type: 'npm',
				package: '@fission-ai/openspec',
				installed: true,
				currentVersion: '1.0.0',
				latestVersion: '1.1.0',
				hasUpdate: true
			}
		],
		undefined,
		{
			exec: operationExec(prefix, mixedCalls),
			createSnapshotFn: () => {
				mixedSnapshotCreated = true;
				return pathApi.join(root, 'mixed-snapshot');
			},
			dshDetect: async () => mixedDsh
		}
	);
	assert.equal(mixedSnapshotCreated, true, '混合批次仍为其他组件创建 snapshot');
	assert.equal(
		mixedResult.updatedItems.some(item => item.startsWith(`failed::${DSH_TOOL_ID}::`)),
		true,
		'批量 DSH 门禁失败被隔离'
	);
	assert.equal(
		mixedResult.updatedItems.some(item => item.startsWith('updated::OpenSpec::')),
		true,
		'批量 DSH 门禁失败不阻断其他组件'
	);
	assert.equal(
		mutationCalls(mixedCalls, 'install').some(call => call.args.includes(DSH_PACKAGE_NAME)),
		false,
		'批量 DSH 被阻止时不执行 npm install'
	);

	let singleSnapshotCreated = false;
	const singleBlockedCalls = [];
	const singleBlockedResult = await applyUpdates(
		[
			{
				id: DSH_TOOL_ID,
				name: 'DeepSeek Harness',
				type: 'npm',
				package: DSH_PACKAGE_NAME,
				installed: true,
				currentVersion: '1.2.3',
				latestVersion: '1.2.4',
				hasUpdate: true
			}
		],
		undefined,
		{
			exec: operationExec(prefix, singleBlockedCalls),
			createSnapshotFn: () => {
				singleSnapshotCreated = true;
				return pathApi.join(root, 'single-blocked-snapshot');
			},
			dshDetect: async () => external
		}
	);
	assert.equal(singleBlockedResult.dshLifecycle.state, 'external', '单项 DSH 门禁失败保留最终 lifecycle');
	assert.equal(
		singleBlockedResult.updatedItems.some(item => item.startsWith(`failed::${DSH_TOOL_ID}::`)),
		true,
		'单项 DSH 门禁返回失败结果'
	);
	assert.equal(singleSnapshotCreated, false, '单项 DSH 门禁失败不创建 snapshot');
	assert.equal(mutationCalls(singleBlockedCalls, 'install').length, 0, '单项 DSH 门禁失败不执行 npm install');
	console.log('[PASS] 单项更新竞态阻断返回 lifecycle 且不创建 snapshot');

	const prerelease = lifecycle('managed', {
		packageVersion: '2.0.0-beta.1',
		commandVersion: '2.0.0-beta.1',
		packagePresent: true,
		commandPresent: true,
		prereleaseWarning: '当前为预发布版本，可能存在 breaking changes。'
	});
	const prereleaseResult = await installDsh(undefined, {
		exec: operationExec(prefix, []),
		detect: sequenceDetector([notInstalled, prerelease])
	});
	assert.equal(prereleaseResult.success, true, '预发布版本仍允许安装');
	assert.match(prereleaseResult.warning, /预发布版本/, '预发布安装返回风险提示');
	console.log('[PASS] install/update/uninstall argv, ownership gate, postflight, and prerelease warning');
}

// ── snapshot boundary and ~/.dsh preservation ────────────────────────────────
{
	const snapshotHome = pathApi.join(root, 'snapshot-home');
	const dshHome = pathApi.join(snapshotHome, '.dsh');
	mkdirSync(dshHome, {recursive: true});
	const dshStatePath = pathApi.join(dshHome, 'state.json');
	writeFileSync(dshStatePath, 'user-owned dsh state\n', 'utf8');
	mkdirSync(pathApi.join(snapshotHome, '.claude'), {recursive: true});
	writeFileSync(pathApi.join(snapshotHome, '.claude', 'settings.json'), '{}', 'utf8');
	process.env.CCQ_HOME = snapshotHome;

	const files = getSnapshotFiles();
	const isDshPath = file => file.includes(`${pathApi.sep}.dsh${pathApi.sep}`) || file.endsWith(`${pathApi.sep}.dsh`);
	assert.equal(files.some(isDshPath), false, 'snapshot allowlist 排除 ~/.dsh');
	const snapshotPath = createSnapshot();
	const manifest = JSON.parse(readFileSync(pathApi.join(snapshotPath, 'manifest.json'), 'utf8'));
	assert.equal(
		manifest.files.some(file => isDshPath(file.source) || file.relative.includes('.dsh')),
		false,
		'实际 snapshot manifest 不包含 ~/.dsh'
	);

	const uninstallCalls = [];
	const uninstallDetectorCalls = [];
	const managed = lifecycle('managed', {packagePresent: true, commandPresent: true, packageVersion: '1.2.3', commandVersion: '1.2.3'});
	const external = lifecycle('external', {commandPresent: true});
	const lifecycleEnv = {PATH: 'fixture-dsh-path'};
	const uninstallDetector = sequenceDetector([managed, managed, external]);
	const outcome = await uninstallComponent('DeepSeekHarness', undefined, {
		exec: operationExec(pathApi.join(root, 'snapshot-prefix'), uninstallCalls),
		createSnapshotFn: () => snapshotPath,
		env: lifecycleEnv,
		platform: TEST_PLATFORM,
		dshDetect: async deps => {
			uninstallDetectorCalls.push(deps);
			return uninstallDetector(deps);
		}
	});
	assert.equal(outcome.success, true, 'DSH 卸载成功');
	assert.equal(outcome.lifecycle.state, 'external', '卸载 outcome 保留外部 postflight 状态');
	assert.equal(readFileSync(dshStatePath, 'utf8'), 'user-owned dsh state\n', '卸载不删除 ~/.dsh 用户数据');
	assert.deepEqual(
		mutationCalls(uninstallCalls, 'uninstall').map(call => call.args),
		[DSH_UNINSTALL_ARGS],
		'卸载仍只调用 DSH npm 包命令'
	);
	assert.equal(uninstallDetectorCalls.length, 3, '卸载 preflight、mutation preflight 与 postflight 都重新检测');
	for (const deps of uninstallDetectorCalls) {
		assert.equal(deps.env, lifecycleEnv, 'DSH 卸载检测透传 env');
		assert.equal(deps.platform, TEST_PLATFORM, 'DSH 卸载检测透传 platform');
	}
	rmSync(snapshotPath, {recursive: true, force: true});
	console.log('[PASS] snapshot allowlist excludes ~/.dsh and uninstall preserves user data');
}

if (originalPath === undefined) delete process.env.PATH;
else process.env.PATH = originalPath;
if (originalPathCase === undefined) delete process.env.Path;
else process.env.Path = originalPathCase;
if (originalCcqHome === undefined) delete process.env.CCQ_HOME;
else process.env.CCQ_HOME = originalCcqHome;
rmSync(root, {recursive: true, force: true});
console.log('[PASS] DSH lifecycle focused gate complete');
