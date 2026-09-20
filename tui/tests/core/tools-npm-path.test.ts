import {delimiter} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {environmentPath, npmGlobalBinFromPrefix, prependPathForCurrentProcess, withEnvironmentPath} from '../../src/core/npm-path.js';

// P4b 迁移自 scripts/verify-tools-install.mjs（6 条）与 scripts/verify-dsh-lifecycle.mjs
// 的 PATH 注入段（9 条），合计 15 条静态断言，全部为纯进程内平台语义：
// npm global bin 派生、PATH 前置去重、Windows Path/PATH 大小写与分隔符。
//
// 载体说明：npm-path 是 install（verify-tools-install）与 dsh detection
// （verify-dsh-lifecycle）共用模块，故两脚本的纯段合并到本文件，避免重复载体（R9）。
// 保留在 verify 的是真实子进程 / 真实落盘段：verify-tools-install 的 fake CLI 子进程检测
// 与 CodeGraph 安装落盘；verify-dsh-lifecycle 的 detectDshLifecycle 真实 shim/manifest 矩阵。

function withFixtureProcessEnv(env: NodeJS.ProcessEnv, run: () => void): void {
	const descriptor = Object.getOwnPropertyDescriptor(process, 'env');
	expect(descriptor, 'process.env descriptor exists').toBeDefined();
	if (!descriptor) throw new Error('process.env descriptor 缺失');
	Object.defineProperty(process, 'env', {...descriptor, value: env});
	try {
		run();
	} finally {
		Object.defineProperty(process, 'env', descriptor);
	}
}

function withSavedPath<T>(run: () => T): T {
	const originalPath = process.env.PATH;
	try {
		return run();
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
}

describe('npmGlobalBinFromPrefix 平台派生', () => {
	test('macOS/Linux = <prefix>/bin，Windows shim 在 prefix 根目录，空 prefix 返回 null', () => {
		expect(npmGlobalBinFromPrefix('/opt/node', 'darwin'), 'macOS/Linux npm global bin = <prefix>/bin').toBe('/opt/node/bin');
		expect(npmGlobalBinFromPrefix('/opt/node', 'linux'), 'Linux npm global bin = <prefix>/bin').toBe('/opt/node/bin');
		expect(npmGlobalBinFromPrefix('C:\\Users\\me\\AppData\\Roaming\\npm', 'win32'), 'Windows npm shim 在 prefix 根目录').toBe(
			'C:\\Users\\me\\AppData\\Roaming\\npm'
		);
		expect(npmGlobalBinFromPrefix('   ', 'darwin'), '空 prefix 不注入 PATH').toBeNull();
	});
});

describe('prependPathForCurrentProcess 前置去重', () => {
	test('新 npm bin 前置到 PATH，重复注入不产生重复项', () => {
		withSavedPath(() => {
			process.env.PATH = ['second', 'third'].join(delimiter);
			prependPathForCurrentProcess('first');
			expect(process.env.PATH, '新 npm bin 应前置到 PATH').toBe(['first', 'second', 'third'].join(delimiter));

			prependPathForCurrentProcess('first');
			expect(process.env.PATH, '重复 npm bin 不应重复注入').toBe(['first', 'second', 'third'].join(delimiter));
		});
	});
});

describe('Windows Path/PATH 大小写与分隔符', () => {
	test('仅 Path 时使用分号并保留 Path 形式，不凭空创建 PATH', () => {
		withFixtureProcessEnv({Path: 'C:\\existing'}, () => {
			prependPathForCurrentProcess('C:\\npm-global', 'win32');
			expect(process.env.Path, 'Windows 仅 Path 时使用分号并保留 Path 形式').toBe('C:\\npm-global;C:\\existing');
			expect(Object.hasOwn(process.env, 'PATH'), 'Windows 仅 Path 时不凭空创建 PATH').toBe(false);
		});
	});

	test('仅 PATH 时使用分号并保留 PATH 形式，不凭空创建 Path', () => {
		withFixtureProcessEnv({PATH: 'C:\\existing'}, () => {
			prependPathForCurrentProcess('C:\\npm-global', 'win32');
			expect(process.env.PATH, 'Windows 仅 PATH 时使用分号并保留 PATH 形式').toBe('C:\\npm-global;C:\\existing');
			expect(Object.hasOwn(process.env, 'Path'), 'Windows 仅 PATH 时不凭空创建 Path').toBe(false);
		});
	});

	test('两种变量形式并存时同步更新并保留另一种内容', () => {
		withFixtureProcessEnv({Path: 'C:\\existing', PATH: 'C:\\legacy'}, () => {
			prependPathForCurrentProcess('C:\\npm-global', 'win32');
			expect(process.env.Path, 'Windows Path 更新保留另一种变量内容').toBe('C:\\npm-global;C:\\existing;C:\\legacy');
			expect(process.env.PATH, 'Windows 同时存在两种变量形式时同步更新').toBe(process.env.Path);
		});
	});

	test('environmentPath 把 Path 作为子进程 PATH 来源，withEnvironmentPath 不额外创建 PATH', () => {
		expect(environmentPath({Path: 'C:\\existing'}, 'win32'), 'Windows Path 可作为子进程 PATH 来源').toBe('C:\\existing');
		expect(
			withEnvironmentPath({Path: 'C:\\existing'}, 'C:\\npm-global;C:\\existing', 'win32'),
			'Windows Path-only 子进程环境不得额外创建 PATH'
		).toEqual({Path: 'C:\\npm-global;C:\\existing'});
	});
});
