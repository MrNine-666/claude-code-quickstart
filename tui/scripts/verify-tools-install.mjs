import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {npmGlobalBinFromPrefix, prependPathForCurrentProcess} from '../src/core/npm-path.ts';

// CodexCli 等 npm 工具安装后应立即刷新当前 ccq 进程 PATH，避免 npm shim 已生成但检测命令不可达。
assert.equal(npmGlobalBinFromPrefix('/opt/node', 'darwin'), '/opt/node/bin', 'macOS/Linux npm global bin = <prefix>/bin');
assert.equal(npmGlobalBinFromPrefix('/opt/node', 'linux'), '/opt/node/bin', 'Linux npm global bin = <prefix>/bin');
assert.equal(npmGlobalBinFromPrefix('C:\\Users\\me\\AppData\\Roaming\\npm', 'win32'), 'C:\\Users\\me\\AppData\\Roaming\\npm', 'Windows npm shim 在 prefix 根目录');
assert.equal(npmGlobalBinFromPrefix('   ', 'darwin'), null, '空 prefix 不注入 PATH');

const originalPath = process.env.PATH;
try {
	process.env.PATH = ['second', 'third'].join(delimiter);
	prependPathForCurrentProcess('first');
	assert.equal(process.env.PATH, ['first', 'second', 'third'].join(delimiter), '新 npm bin 应前置到 PATH');

	prependPathForCurrentProcess('first');
	assert.equal(process.env.PATH, ['first', 'second', 'third'].join(delimiter), '重复 npm bin 不应重复注入');
} finally {
	process.env.PATH = originalPath;
}

console.log('[PASS] tools-install npm global bin PATH 即时注入');

const home = mkdtempSync(join(tmpdir(), 'ccq-tools-install-path-'));
const binDir = join(home, 'bin');
mkdirSync(binDir, {recursive: true});
try {
	const npmPath = join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
	const codexPath = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
	writeFileSync(
		npmPath,
		process.platform === 'win32' ? `@echo off\r\necho ${home}\r\n` : `#!/bin/sh\necho ${home}\n`,
		'utf8'
	);
	writeFileSync(
		codexPath,
		process.platform === 'win32' ? '@echo off\r\necho codex-cli 0.142.5\r\n' : '#!/bin/sh\necho codex-cli 0.142.5\n',
		'utf8'
	);
	if (process.platform !== 'win32') {
		chmodSync(npmPath, 0o755);
		chmodSync(codexPath, 0o755);
	}

	process.env.PATH = binDir;
	const {checkCliToolUpdates} = await import('../src/core/update.ts');
	const components = await checkCliToolUpdates({'@openai/codex': {latest: '0.142.5'}}, true);
	const codex = components.find(component => component.id === 'CodexCli');
	assert.equal(codex?.installed, true, 'CodexCli 应在刷新 npm global bin 后被检测为已安装');
	assert.equal(codex?.currentVersion, '0.142.5', 'CodexCli 应从 codex --version 获取当前版本');
	console.log('[PASS] tools update 检测复用 npm global bin PATH 获取 Codex 版本');
} finally {
	process.env.PATH = originalPath;
	rmSync(home, {recursive: true, force: true});
}
