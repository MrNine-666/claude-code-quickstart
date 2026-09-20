import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, posix, win32} from 'node:path';
import {tmpdir} from 'node:os';

// [P4b 切分] 纯段（npm PATH 平台语义 / install-update-uninstall 精确 argv、
// ownership gate、mutation/postflight 失败收敛）已迁：
//   - tests/core/tools-npm-path.test.ts（Windows Path/PATH 大小写与分隔符）
//   - tests/core/tools-lifecycle-dsh.test.ts（注入 exec/detect 的操作矩阵）
// 本脚本保留需要真实落盘 / 真实 shim 的段：detectDshLifecycle 的 npm package/PATH shim/
// version parity 矩阵，`~/.dsh` snapshot allowlist 与卸载用户数据保留。
// update.ts 源码文本断言属本批范围外（P4 PRD 声明 0 源码文本断言，此处按原样保留并在对账登记）。

const {
	DSH_COMMAND,
	DSH_PACKAGE_NAME,
	DSH_TOOL_ID,
	DSH_UNINSTALL_ARGS,
	DSH_VERSION_ARGS,
	detectDshLifecycle
} = await import('../src/core/dsh-lifecycle.ts');
const {createSnapshot, getSnapshotFiles} = await import('../src/core/update.ts');
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
	/const dshLifecycle = await detectDshLifecycle\(\{env: \{\.\.\.process\.env\}(?:, exec)?\}\);[\s\S]{0,180}await refreshNpmGlobalBinPath\([^;]*\);/,
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
