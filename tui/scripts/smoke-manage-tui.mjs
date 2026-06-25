import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const projectRoot = process.cwd();
const cliPath = join(projectRoot, 'dist', 'cli.js');

assert.ok(existsSync(cliPath), `manage TUI CLI 入口不存在: ${cliPath}`);

const direct = spawnSync(process.execPath, [cliPath], {
	cwd: projectRoot,
	encoding: 'utf8',
	stdio: ['pipe', 'pipe', 'pipe']
});

assert.equal(direct.status, 0, `非 TTY 直接启动失败: ${direct.stderr || direct.stdout}`);
assert.match(direct.stdout, /需要交互式 TTY/, '非 TTY 启动应输出清晰提示');

const tempRoot = mkdtempSync(join(tmpdir(), 'ccq-manage-tui-'));
for (const entry of ['package.json', 'pnpm-lock.yaml', 'dist']) {
	const source = join(projectRoot, entry);
	assert.ok(existsSync(source), `目录型包缺少必要条目: ${source}`);
	cpSync(source, join(tempRoot, entry), {recursive: true});
}

const pnpmCli = process.env.npm_execpath;
assert.ok(pnpmCli, '无法从 npm_execpath 定位 pnpm CLI');
const install = spawnSync(process.execPath, [pnpmCli, 'install', '--prod', '--frozen-lockfile'], {
	cwd: tempRoot,
	encoding: 'utf8',
	stdio: ['ignore', 'pipe', 'pipe']
});

assert.equal(install.status, 0, `临时目录 pnpm 运行时依赖恢复失败: ${install.stderr || install.stdout}`);

const copied = spawnSync(process.execPath, [join(tempRoot, 'dist', 'cli.js')], {
	cwd: tempRoot,
	encoding: 'utf8',
	stdio: ['pipe', 'pipe', 'pipe']
});

assert.equal(copied.status, 0, `临时 package-shaped 目录启动失败: ${copied.stderr || copied.stdout}`);
assert.match(copied.stdout, /需要交互式 TTY/, '临时目录 smoke 应输出非 TTY 提示');

console.log(`[PASS] manage TUI package-shaped 目录 smoke 通过: ${tempRoot}`);
