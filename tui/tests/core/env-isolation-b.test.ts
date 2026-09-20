import {join} from 'node:path';

import {expect, test} from 'bun:test';

import {codexDir, piModelsJsonPath, providersDir, resolveHome, settingsPath} from '../../src/core/paths.js';
import {createTempHome} from '../helpers/temp-home.js';

// env 隔离回归 B（试点批 implement Step 5）：与 env-isolation-a.test.ts 并列，
// 两份文件使用不同的临时目录前缀与不同的 CCQ_HOME。
// 只要 paths.ts 保持「调用时解析」，两者互不污染（默认串行、--parallel、--concurrent 均成立）。

test('env isolation B: paths resolve against this file own CCQ_HOME', () => {
	const home = createTempHome('ccq-env-isolation-b-');
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
