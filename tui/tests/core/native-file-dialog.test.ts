import {EventEmitter} from 'node:events';
import {expect, test} from 'bun:test';

import {type NativeFileDialogDeps, pickExportBundle, pickImportBundle} from '../../src/core/native-file-dialog.js';

// P1 迁移自任务 design §6.1：系统文件选择器的 argv 构造与事件→结果映射全部经注入 spawn 缝复现，
// 不启动真实对话框；取消与不可用都必须映射为结构化结果而非错误。

type SpawnProcess = NonNullable<NativeFileDialogDeps['spawnProcess']>;
type SpawnCall = {command: string; args: readonly string[]; options: {readonly shell?: boolean; readonly windowsHide?: boolean}};
type FakeOptions = {
	code?: number;
	stdout?: string;
	stderr?: string;
	error?: Error;
	neverClose?: boolean;
};

function fakeSpawn(options: FakeOptions = {}) {
	const calls: SpawnCall[] = [];
	let killCount = 0;
	const spawnProcess = ((command: string, args: readonly string[] | undefined, spawnOptions: {readonly shell?: boolean} | undefined) => {
		calls.push({command, args: args ?? [], options: spawnOptions ?? {}});
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill: () => {
				killCount += 1;
				return true;
			}
		});
		queueMicrotask(() => {
			if (options.error) {
				child.emit('error', options.error);
				return;
			}

			if (options.stdout) child.stdout.emit('data', options.stdout);
			if (options.stderr) child.stderr.emit('data', options.stderr);
			if (!options.neverClose) child.emit('close', options.code ?? 0);
		});
		return child as unknown as ReturnType<SpawnProcess>;
	}) as unknown as SpawnProcess;
	return {
		calls,
		get killCount() {
			return killCount;
		},
		spawnProcess
	};
}

function decodeWindowsScript(call: SpawnCall | undefined): string {
	const encoded = call?.args[4] ?? '';
	expect(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded), '编码参数必须是纯 base64').toBe(true);
	return Buffer.from(encoded, 'base64').toString('utf16le');
}

test('Windows 导入选择器使用编码 PowerShell 脚本且不插值用户路径', async () => {
	const fake = fakeSpawn({stdout: 'C:\\Users\\Ada\\my bundle.ccq-backup\r\n'});
	const outcome = await pickImportBundle({platform: 'win32', spawnProcess: fake.spawnProcess});
	expect(outcome).toEqual({kind: 'selected', path: 'C:\\Users\\Ada\\my bundle.ccq-backup'});
	expect(fake.calls.length).toBe(1);
	const call = fake.calls[0];
	expect(call?.command).toBe('powershell.exe');
	expect(call?.args.slice(0, 4)).toEqual(['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand']);
	expect(call?.options.shell).toBe(false);
	expect(call?.options.windowsHide).toBe(true);
	const script = decodeWindowsScript(call);
	expect(script).toContain('System.Windows.Forms.OpenFileDialog');
	expect(script).not.toContain('Ada');
});

test('Windows 另存为使用 SaveFileDialog 与默认包名', async () => {
	const fake = fakeSpawn({stdout: 'D:\\backup\\ccq-config-20260101-120000.ccq-backup\n'});
	const outcome = await pickExportBundle({platform: 'win32', spawnProcess: fake.spawnProcess});
	expect(outcome).toEqual({kind: 'selected', path: 'D:\\backup\\ccq-config-20260101-120000.ccq-backup'});
	const script = decodeWindowsScript(fake.calls[0]);
	expect(script).toContain('System.Windows.Forms.SaveFileDialog');
	expect(script).toContain('ccq-config-');
	expect(script).toContain('.ccq-backup');
});

test('macOS 导入与另存为使用 osascript choose file / choose file name', async () => {
	const imported = fakeSpawn({stdout: '/Users/ada/bundle.ccq-backup\n'});
	expect(await pickImportBundle({platform: 'darwin', spawnProcess: imported.spawnProcess})).toEqual({
		kind: 'selected',
		path: '/Users/ada/bundle.ccq-backup'
	});
	const importedCall = imported.calls[0];
	expect(importedCall?.command).toBe('osascript');
	expect(importedCall?.args[0]).toBe('-e');
	expect(importedCall?.args[1]).toContain('choose file');
	expect(importedCall?.options.shell).toBe(false);

	const exported = fakeSpawn({stdout: '/Users/ada/ccq-config-20260101-120000.ccq-backup\n'});
	expect(await pickExportBundle({platform: 'darwin', spawnProcess: exported.spawnProcess})).toEqual({
		kind: 'selected',
		path: '/Users/ada/ccq-config-20260101-120000.ccq-backup'
	});
	expect(exported.calls[0]?.args[1]).toContain('choose file name');
});

test('取消映射为 cancelled 而不是错误', async () => {
	const windows = fakeSpawn({code: 0, stdout: ''});
	expect(await pickImportBundle({platform: 'win32', spawnProcess: windows.spawnProcess})).toEqual({kind: 'cancelled'});

	const mac = fakeSpawn({code: 1, stderr: 'execution error: User canceled. (-128)\n'});
	expect(await pickImportBundle({platform: 'darwin', spawnProcess: mac.spawnProcess})).toEqual({kind: 'cancelled'});

	const preAborted = fakeSpawn();
	expect(await pickImportBundle({platform: 'win32', spawnProcess: preAborted.spawnProcess, signal: AbortSignal.abort()})).toEqual({
		kind: 'cancelled'
	});
	expect(preAborted.calls.length, '已取消时不得启动对话框进程').toBe(0);
});

test('不支持平台、spawn 失败、非零退出与超时映射为 unavailable', async () => {
	const unsupported = fakeSpawn();
	expect(await pickImportBundle({platform: 'linux', spawnProcess: unsupported.spawnProcess})).toEqual({
		kind: 'unavailable',
		reason: '当前平台不支持系统文件对话框'
	});
	expect(unsupported.calls.length).toBe(0);

	const spawnFailure = fakeSpawn({error: new Error('spawn powershell.exe ENOENT')});
	expect(await pickImportBundle({platform: 'win32', spawnProcess: spawnFailure.spawnProcess})).toEqual({
		kind: 'unavailable',
		reason: '系统文件对话框进程启动失败'
	});

	const failed = fakeSpawn({code: 1, stderr: 'Add-Type failed'});
	expect(await pickImportBundle({platform: 'win32', spawnProcess: failed.spawnProcess})).toEqual({
		kind: 'unavailable',
		reason: '系统文件对话框不可用'
	});

	const hanging = fakeSpawn({neverClose: true});
	expect(await pickImportBundle({platform: 'win32', spawnProcess: hanging.spawnProcess, timeoutMs: 20})).toEqual({
		kind: 'unavailable',
		reason: '系统文件对话框超时'
	});
	expect(hanging.killCount).toBe(1);
});

test('运行中 abort 返回 cancelled 并终止对话框进程', async () => {
	const controller = new AbortController();
	const hanging = fakeSpawn({neverClose: true});
	const pending = pickImportBundle({platform: 'darwin', spawnProcess: hanging.spawnProcess, signal: controller.signal});
	controller.abort();
	expect(await pending).toEqual({kind: 'cancelled'});
	expect(hanging.killCount).toBe(1);
});
