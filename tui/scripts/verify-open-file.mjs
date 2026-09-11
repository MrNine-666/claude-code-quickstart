import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {openExternalFile} from '../src/core/open-file.ts';

function fakeSpawn({code = 0, error, emitSpawn = false, emitClose = true} = {}) {
	const calls = [];
	const spawnProcess = (command, args, options) => {
		calls.push({command, args, options});
		const child = new EventEmitter();
		child.unref = () => child;
		queueMicrotask(() => {
			if (error) child.emit('error', error);
			else {
				if (emitSpawn) child.emit('spawn');
				if (emitClose) child.emit('close', code);
			}
		});
		return child;
	};
	return {calls, spawnProcess};
}

const windows = fakeSpawn({emitSpawn: true, emitClose: false});
const windowsPath = "C:\\Users\\Ada\\Rules & O'Reilly\\AGENTS.md";
const windowsResultPromise = openExternalFile(windowsPath, {platform: 'win32', spawnProcess: windows.spawnProcess});
assert.equal(windows.calls.length, 1, 'Windows 应只启动一次外部打开命令');
assert.equal(windows.calls[0].command, 'rundll32.exe', 'Windows 应通过无控制台的 ShellExecute bridge 打开关联编辑器');
assert.equal(windows.calls[0].options.detached, true, '外部编辑器进程必须脱离 TUI 生命周期');
assert.deepEqual(windows.calls[0].args, ['url.dll,FileProtocolHandler', windowsPath], 'Windows 应把目标路径作为 ShellExecute 参数传入');
const windowsResult = await Promise.race([
	windowsResultPromise,
	new Promise(resolve => setTimeout(() => resolve({ok: false, error: '外部打开未在进程创建后返回'}), 250))
]);
assert.deepEqual(windowsResult, {ok: true}, 'Windows 外部打开成功应在 launcher 创建后返回 ok:true');
console.log('[PASS] Windows 外部文件打开使用无控制台 ShellExecute bridge');

const mac = fakeSpawn();
const macResult = await openExternalFile('/tmp/AGENTS.md', {platform: 'darwin', spawnProcess: mac.spawnProcess});
assert.deepEqual(macResult, {ok: true}, 'macOS 外部打开成功应返回 ok:true');
assert.deepEqual(mac.calls[0].args, ['/tmp/AGENTS.md'], 'macOS open 应接收目标文件路径');
console.log('[PASS] macOS 外部文件打开使用系统默认应用');

const linux = fakeSpawn({code: 2});
const linuxResult = await openExternalFile('/tmp/config.toml', {platform: 'linux', spawnProcess: linux.spawnProcess});
assert.deepEqual(linuxResult, {ok: false, error: '外部打开失败 (exit 2)'}, '非零退出应返回结构化错误');

const spawnFailure = fakeSpawn({error: new Error('spawn xdg-open ENOENT')});
const failureResult = await openExternalFile('/tmp/missing.md', {platform: 'linux', spawnProcess: spawnFailure.spawnProcess});
assert.deepEqual(failureResult, {ok: false, error: 'spawn xdg-open ENOENT'}, 'spawn failure 应保留技术错误');

const empty = fakeSpawn();
const emptyResult = await openExternalFile('', {platform: 'linux', spawnProcess: empty.spawnProcess});
assert.deepEqual(emptyResult, {ok: false, error: '文件路径为空'}, '空路径应在 spawn 前失败');
assert.equal(empty.calls.length, 0, '空路径不得启动外部命令');
console.log('[PASS] 外部文件打开错误与边界结果');
