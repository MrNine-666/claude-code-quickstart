import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function currentTarget() {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === 'win32' && arch === 'x64') {
		return {target: 'bun-windows-x64', ext: '.exe'};
	}
	if (platform === 'win32' && arch === 'arm64') {
		return {target: 'bun-windows-arm64', ext: '.exe'};
	}
	if (platform === 'darwin' && arch === 'x64') {
		return {target: 'bun-darwin-x64', ext: ''};
	}
	if (platform === 'darwin' && arch === 'arm64') {
		return {target: 'bun-darwin-arm64', ext: ''};
	}

	throw new Error(`当前平台暂不支持编译产物契约验证: ${platform}/${arch}`);
}

async function run(command, args, options = {}) {
	const proc = Bun.spawn([command, ...args], {
		cwd: options.cwd,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);

	return {stdout, stderr, exitCode};
}

const root = join(import.meta.dir, '..');
const tempDir = mkdtempSync(join(tmpdir(), 'ccq-compiled-contracts-'));
const {target, ext} = currentTarget();
const outfile = join(tempDir, `compiled-contracts-probe${ext}`);

try {
	const build = await run('bun', [
		'build',
		'--compile',
		`--target=${target}`,
		`--outfile=${outfile}`,
		join(root, 'scripts', 'compiled-contracts-probe.ts')
	], {cwd: root});

	assert.equal(build.exitCode, 0, `编译契约探针失败\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`);

	const probe = await run(outfile, [], {cwd: root});
	assert.equal(probe.exitCode, 0, `运行契约探针失败\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`);
	assert.match(probe.stdout, /PROBE_PASS/, `契约探针未输出 PROBE_PASS\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`);
	assert.doesNotMatch(probe.stdout, /B:\/?~BUN|[A-Za-z]:[\\/].*contracts|\/embedded\/contracts/, '探针输出不应包含契约路径字符串');

	console.log('[PASS] 编译产物契约加载正常（text loader 内联内容）');
} finally {
	try {
		rmSync(tempDir, {recursive: true, force: true});
	} catch {
		// Windows 下临时 exe 可能短暂被占用；验证结果不依赖清理成功。
	}
}
