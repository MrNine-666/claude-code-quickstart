import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyUpdates, checkCliToolUpdates} from '../src/core/update.ts';
import {detectTool, installTool, TOOL_DEFINITIONS} from '../src/core/tools-install.ts';
import {COMPONENT_META, TOOL_GROUP_META, uninstallComponent} from '../src/core/tools-manage.ts';
import {createInitialToolsViewState, resolveToolsPrimaryAction, updatableComponents} from '../src/state/tools-view-state.ts';

const node = 'node';
const home = mkdtempSync(join(tmpdir(), 'ccq-pi-tools-'));
process.env.CCQ_HOME = home;

const installedExec = async (command, args) => {
	if (command === node) return {code: 0, stdout: 'v22.19.0\n', stderr: ''};
	if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: '/tmp/ccq-pi-prefix\n', stderr: ''};
	if (command === 'npm' && args[0] === 'install') return {code: 0, stdout: 'installed\n', stderr: ''};
	if (command === 'pi' && args[0] === '--version') return {code: 0, stdout: '0.1.0\n', stderr: ''};
	if (command === 'pi-web' && args[0] === '--help') {
		return {code: 0, stdout: 'Usage: pi-web [options]\n  -H, --hostname <host> (default: 127.0.0.1)\n', stderr: ''};
	}
	if (command === 'pi-web' && args[0] === '--version') return {code: 1, stdout: '', stderr: 'Unknown option --version'};
	return {code: 1, stdout: '', stderr: 'not found'};
};

const piInstall = await installTool('PiCli', undefined, 'pi', {exec: installedExec});
assert.equal(piInstall.success, true);
const piWebInstall = await installTool('PiWeb', undefined, 'pi', {exec: installedExec});
assert.equal(piWebInstall.success, true);

const piWebDefinition = TOOL_DEFINITIONS.find(item => item.id === 'PiWeb');
assert.ok(piWebDefinition, 'PiWeb registry 定义存在');
assert.deepEqual(piWebDefinition.versionArgs, ['--help'], 'Pi Web 使用 --help 作为无副作用检测探针');
assert.equal(piWebDefinition.reportsVersion, false, 'Pi Web help 输出不得被当作版本来源');
const piWebDetected = await detectTool(piWebDefinition, installedExec);
assert.equal(piWebDetected.installed, true, 'Pi Web 支持 --help 时必须判定为已安装');

const detectedCliComponents = await checkCliToolUpdates(
	{},
	false,
	{exec: installedExec, latestByPackage: {'@agegr/pi-web': '0.9.0'}}
);
const piWebComponent = detectedCliComponents.find(component => component.id === 'PiWeb');
assert.equal(piWebComponent?.installed, true, '工具管理检测链路必须把可执行的 Pi Web 显示为已安装');
assert.equal(piWebComponent?.currentVersion, '', 'Pi Web help 输出不得被误当作版本号');
assert.equal(piWebComponent?.hasUpdate, true, 'Pi Web 无法比较版本时应按待更新组件投影');
assert.equal(resolveToolsPrimaryAction(piWebComponent), 'update', 'Pi Web Enter 应复用普通更新主操作');
assert.deepEqual(
	updatableComponents({...createInitialToolsViewState(), components: [piWebComponent]}).map(component => component.id),
	['PiWeb'],
	'Pi Web A 更新全部应复用普通可更新组件筛选'
);

const lowNodeCalls = [];
const lowNodeExec = async (command, args) => {
	lowNodeCalls.push({command, args: [...args]});
	if (command === node) return {code: 0, stdout: 'v22.18.9\n', stderr: ''};
	return {code: 0, stdout: '', stderr: ''};
};
const lowNode = await installTool('PiCli', undefined, 'pi', {exec: lowNodeExec});
assert.equal(lowNode.success, false);
assert.match(lowNode.error, /要求 Node\.js >= 22\.19\.0/);
assert.equal(lowNodeCalls.some(call => call.command === 'npm' && call.args[0] === 'install'), false, 'Node 版本不足时不得执行 npm install');

const piInstallCall = await (async () => {
	const calls = [];
	const exec = async (command, args) => {
		calls.push({command, args: [...args]});
		return installedExec(command, args);
	};
	const result = await installTool('PiCli', undefined, 'pi', {exec});
	assert.equal(result.success, true);
	return calls.find(call => call.command === 'npm' && call.args[0] === 'install');
})();
assert.deepEqual(piInstallCall.args, ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent']);

const piWebInstallCall = await (async () => {
	const calls = [];
	const exec = async (command, args) => {
		calls.push({command, args: [...args]});
		return installedExec(command, args);
	};
	const result = await installTool('PiWeb', undefined, 'pi', {exec});
	assert.equal(result.success, true);
	return calls.find(call => call.command === 'npm' && call.args[0] === 'install');
})();
assert.deepEqual(piWebInstallCall.args, ['install', '-g', '@agegr/pi-web']);

const updateCalls = [];
const updateExec = async (command, args) => {
	updateCalls.push({command, args: [...args]});
	if (command === node) return {code: 0, stdout: 'v22.19.0\n', stderr: ''};
	if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: '/tmp/ccq-pi-prefix\n', stderr: ''};
	if (command === 'npm' && args[0] === 'install') return {code: 0, stdout: '', stderr: ''};
	if (command === 'pi' && args[0] === '--version') return {code: 0, stdout: '0.2.0\n', stderr: ''};
	if (command === 'pi-web' && args[0] === '--version') return {code: 0, stdout: '0.2.0\n', stderr: ''};
	return {code: 1, stdout: '', stderr: 'not found'};
};
await applyUpdates(
	[
		{
			id: 'PiCli',
			name: 'Pi Agent CLI',
			type: 'npm',
			package: '@earendil-works/pi-coding-agent',
			installed: true,
			currentVersion: '0.1.0',
			latestVersion: '0.2.0',
			hasUpdate: true
		}
	],
	undefined,
	{exec: updateExec, createSnapshotFn: () => join(home, 'update-snapshot')}
);
const updateInstall = updateCalls.find(call => call.command === 'npm' && call.args[0] === 'install');
assert.deepEqual(updateInstall.args, ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent@0.2.0']);
assert.ok(updateCalls.findIndex(call => call.command === node) < updateCalls.indexOf(updateInstall), 'Pi 更新先做 Node preflight');
assert.ok(updateCalls.some(call => call.command === 'pi' && call.args[0] === '--version'), 'Pi 更新完成后做命令对账');

const removeCalls = [];
const removeExec = async (command, args) => {
	removeCalls.push({command, args: [...args]});
	if (command === 'npm' && args[0] === 'uninstall') return {code: 0, stdout: '', stderr: ''};
	if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: '/tmp/ccq-pi-prefix\n', stderr: ''};
	if (command === 'pi-web' && args[0] === '--help') return {code: 1, stdout: '', stderr: 'not found'};
	return {code: 1, stdout: '', stderr: 'not found'};
};

mkdirSync(join(home, '.pi', 'agent'), {recursive: true});
const sentinel = join(home, '.pi', 'agent', 'settings.json');
writeFileSync(sentinel, JSON.stringify({userSetting: true}), 'utf8');
const removed = await uninstallComponent('PiWeb', undefined, {
	exec: removeExec,
	createSnapshotFn: () => join(home, 'remove-snapshot')
});
assert.equal(removed.success, true);
assert.deepEqual(removeCalls.find(call => call.command === 'npm' && call.args[0] === 'uninstall').args, ['uninstall', '-g', '@agegr/pi-web']);
assert.deepEqual(JSON.parse(readFileSync(sentinel, 'utf8')), {userSetting: true}, '卸载 Pi Web 不得删除 Pi 用户 settings');

assert.equal(COMPONENT_META.PiCli.group, 'agent');
assert.equal(COMPONENT_META.PiWeb.group, 'companion');
assert.equal(TOOL_GROUP_META.companion.label, '全局伴随工具');
assert.equal(TOOL_GROUP_META.companion.description, '通过 npm 全局安装的 Agent 伴随工具');

console.log('[PASS] Pi Tools：Node preflight、Pi CLI ignore-scripts、Pi Web postinstall 语义、update/uninstall 对账与用户数据保护门禁全部通过');
