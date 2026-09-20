import {EventEmitter} from 'node:events';
import {expect, test} from 'bun:test';
import {openExternalFile, type OpenExternalFileDeps} from '../../src/core/open-file.js';

// P5a 迁移自 scripts/verify-open-file.mjs（11 条静态断言，整体迁移后该脚本删除）。
// 平台 opener 的 argv / options 构造与事件→结果映射全部经注入的 spawnProcess 缝复现，
// 不依赖真实子进程；迁入后原脚本无残留断言，已从 verify 链移除。

type SpawnProcess = NonNullable<OpenExternalFileDeps['spawnProcess']>;
type SpawnCall = {command: string; args: readonly string[]; options: {readonly detached?: boolean}};

function fakeSpawn({
	code = 0,
	error,
	emitSpawn = false,
	emitClose = true
}: {
	code?: number;
	error?: Error;
	emitSpawn?: boolean;
	emitClose?: boolean;
} = {}) {
	const calls: SpawnCall[] = [];
	const spawnProcess = ((command: string, args: readonly string[] | undefined, options: {readonly detached?: boolean} | undefined) => {
		calls.push({command, args: args ?? [], options: options ?? {}});
		const child = Object.assign(new EventEmitter(), {unref: () => child});
		queueMicrotask(() => {
			if (error) child.emit('error', error);
			else {
				if (emitSpawn) child.emit('spawn');
				if (emitClose) child.emit('close', code);
			}
		});
		return child as unknown as ReturnType<SpawnProcess>;
	}) as unknown as SpawnProcess;
	return {calls, spawnProcess};
}

test('Windows 外部文件打开使用无控制台 ShellExecute bridge', async () => {
	const windows = fakeSpawn({emitSpawn: true, emitClose: false});
	const windowsPath = "C:\\Users\\Ada\\Rules & O'Reilly\\AGENTS.md";
	const windowsResultPromise = openExternalFile(windowsPath, {platform: 'win32', spawnProcess: windows.spawnProcess});
	expect(windows.calls.length, 'Windows 应只启动一次外部打开命令').toBe(1);
	expect(windows.calls[0]!.command, 'Windows 应通过无控制台的 ShellExecute bridge 打开关联编辑器').toBe('rundll32.exe');
	expect(windows.calls[0]!.options.detached, '外部编辑器进程必须脱离 TUI 生命周期').toBe(true);
	expect(windows.calls[0]!.args, 'Windows 应把目标路径作为 ShellExecute 参数传入').toEqual(['url.dll,FileProtocolHandler', windowsPath]);
	const windowsResult = await Promise.race([
		windowsResultPromise,
		new Promise(resolve => setTimeout(() => resolve({ok: false, error: '外部打开未在进程创建后返回'}), 250))
	]);
	expect(windowsResult, 'Windows 外部打开成功应在 launcher 创建后返回 ok:true').toEqual({ok: true});
});

test('macOS 外部文件打开使用系统默认应用', async () => {
	const mac = fakeSpawn();
	const macResult = await openExternalFile('/tmp/AGENTS.md', {platform: 'darwin', spawnProcess: mac.spawnProcess});
	expect(macResult, 'macOS 外部打开成功应返回 ok:true').toEqual({ok: true});
	expect(mac.calls[0]!.args, 'macOS open 应接收目标文件路径').toEqual(['/tmp/AGENTS.md']);
});

test('外部文件打开错误与边界结果', async () => {
	const linux = fakeSpawn({code: 2});
	const linuxResult = await openExternalFile('/tmp/config.toml', {platform: 'linux', spawnProcess: linux.spawnProcess});
	expect(linuxResult, '非零退出应返回结构化错误').toEqual({ok: false, error: '外部打开失败 (exit 2)'});

	const spawnFailure = fakeSpawn({error: new Error('spawn xdg-open ENOENT')});
	const failureResult = await openExternalFile('/tmp/missing.md', {platform: 'linux', spawnProcess: spawnFailure.spawnProcess});
	expect(failureResult, 'spawn failure 应保留技术错误').toEqual({ok: false, error: 'spawn xdg-open ENOENT'});

	const empty = fakeSpawn();
	const emptyResult = await openExternalFile('', {platform: 'linux', spawnProcess: empty.spawnProcess});
	expect(emptyResult, '空路径应在 spawn 前失败').toEqual({ok: false, error: '文件路径为空'});
	expect(empty.calls.length, '空路径不得启动外部命令').toBe(0);
});
