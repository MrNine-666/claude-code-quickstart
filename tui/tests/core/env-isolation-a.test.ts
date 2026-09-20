import {join} from 'node:path';

import {expect, test} from 'bun:test';

import {codexDir, piModelsJsonPath, providersDir, resolveHome, settingsPath} from '../../src/core/paths.js';
import {createTempHome} from '../helpers/temp-home.js';

// env 隔离回归 A（试点批 implement Step 5）：与 env-isolation-b.test.ts 并列。
//
// 目的不是「测试 paths.ts 能读 env」，而是锁住一条正向约定：
// 路径必须在**调用时**解析，模块不得在顶层（或首次调用时）捕获路径。
// 两个文件各自设置不同的 CCQ_HOME，若任何模块把解析结果缓存成模块常量，
// 同进程串行执行时后一个文件就会读到前一个文件的路径而失败。

test('env isolation A: paths resolve against this file own CCQ_HOME', () => {
	const home = createTempHome('ccq-env-isolation-a-');
	try {
		expect(resolveHome()).toBe(home.path);
		expect(providersDir()).toBe(join(home.path, '.claude', 'providers'));
		expect(settingsPath()).toBe(join(home.path, '.claude', 'settings.json'));
		expect(codexDir()).toBe(join(home.path, '.codex'));
		expect(piModelsJsonPath()).toBe(join(home.path, '.pi', 'agent', 'models.json'));
	} finally {
		home.restore();
		home.cleanup();
	}
});

test('env isolation A: switching CCQ_HOME re-resolves the same module lazily', () => {
	const second = createTempHome('ccq-env-isolation-a-switch-');
	try {
		// 模块已在文件顶部 import；这里再次调用必须反映新的 CCQ_HOME，
		// 证明解析没有在 import 时或首次调用时被固化。
		expect(resolveHome()).toBe(second.path);
		expect(providersDir()).toBe(join(second.path, '.claude', 'providers'));
	} finally {
		second.restore();
		second.cleanup();
	}
});
