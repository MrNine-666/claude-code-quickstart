import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
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

const codeGraphHome = mkdtempSync(join(tmpdir(), 'ccq-codegraph-install-'));
const codeGraphBin = join(codeGraphHome, 'bin');
const codexHome = join(codeGraphHome, '.codex');
mkdirSync(codeGraphBin, {recursive: true});
mkdirSync(codexHome, {recursive: true});
try {
	const codeGraphLog = join(codeGraphHome, 'codegraph.log');
	const npmLog = join(codeGraphHome, 'npm.log');
	const codeGraphPath = join(codeGraphBin, process.platform === 'win32' ? 'codegraph.cmd' : 'codegraph');
	const npmPath = join(codeGraphBin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
	writeFileSync(
		codeGraphPath,
		process.platform === 'win32'
			? `@echo off\r\necho %*>>"${codeGraphLog}"\r\nif "%1"=="--version" (\r\n  echo codegraph 1.2.3\r\n  exit /b 0\r\n)\r\nif "%1"=="install" (\r\n  if not exist "%CODEX_HOME%" mkdir "%CODEX_HOME%"\r\n  >"%CODEX_HOME%\\config.toml" echo [mcp_servers.codegraph]\r\n  >>"%CODEX_HOME%\\config.toml" echo command = "codegraph"\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n`
			: `#!/bin/sh\nprintf '%s\\n' "$*" >> "${codeGraphLog}"\nif [ "$1" = "--version" ]; then\n  echo 'codegraph 1.2.3'\n  exit 0\nfi\nif [ "$1" = "install" ]; then\n  mkdir -p "$CODEX_HOME"\n  printf '[mcp_servers.codegraph]\\ncommand = "codegraph"\\n' > "$CODEX_HOME/config.toml"\n  exit 0\nfi\nexit 1\n`,
		'utf8'
	);
	writeFileSync(
		npmPath,
		process.platform === 'win32'
			? `@echo off\r\necho %*>>"${npmLog}"\r\nexit /b 14\r\n`
			: `#!/bin/sh\nprintf '%s\\n' "$*" >> "${npmLog}"\nexit 14\n`,
		'utf8'
	);
	if (process.platform !== 'win32') {
		chmodSync(codeGraphPath, 0o755);
		chmodSync(npmPath, 0o755);
	}

	const originalCodeHome = process.env.CODEX_HOME;
	process.env.PATH = [codeGraphBin, originalPath].filter(Boolean).join(delimiter);
	process.env.CODEX_HOME = codexHome;
	try {
		const progress = [];
		const {installTool} = await import('../src/core/tools-install.ts');
		const outcome = await installTool('CodeGraph', event => progress.push(event), 'cx');
		assert.equal(outcome.success, true, 'CodeGraph CLI 已存在时 Codex 安装路径应成功');
		assert.equal(outcome.version, '1.2.3', 'CodeGraph 返回既有 CLI 版本');
		assert.equal(existsSync(npmLog), false, 'CodeGraph CLI 已存在时不得调用 npm reinstall');
		assert.match(readFileSync(codeGraphLog, 'utf8'), /install\s+"?--target=codex"?\s+"?--location=global"?\s+--yes/, '仍应执行 Codex CodeGraph 接入命令');
		assert.match(readFileSync(join(codexHome, 'config.toml'), 'utf8'), /\[mcp_servers\.codegraph\]/, 'fake codegraph install 写入 Codex MCP table');
		assert.ok(progress.some(event => /跳过 npm install/.test(event.message)), '进度提示应明确跳过 npm install');
		console.log('[PASS] CodeGraph CLI 已存在时跳过 npm reinstall 并接入 Codex');
	} finally {
		if (originalCodeHome === undefined) {
			delete process.env.CODEX_HOME;
		} else {
			process.env.CODEX_HOME = originalCodeHome;
		}
		process.env.PATH = originalPath;
	}
} finally {
	rmSync(codeGraphHome, {recursive: true, force: true});
}
