import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = join(import.meta.dirname, '..');
const repoRoot = join(root, '..');
const windowsFfiFixRevision = 'f64cade36214f2a5b724da8d7557ca4dad069d81';

function read(path) {
	return readFileSync(path, 'utf8');
}

function workflowJob(workflow, name) {
	const marker = `\n  ${name}:\n`;
	const start = workflow.indexOf(marker);
	assert.notEqual(start, -1, `workflow 缺少 job: ${name}`);
	const bodyStart = start + marker.length;
	const nextJob = workflow.slice(bodyStart).match(/\n  [a-z0-9-]+:\n/);
	return workflow.slice(bodyStart, nextJob ? bodyStart + nextJob.index : undefined);
}

function selectedBuildTargets(job) {
	return [...job.matchAll(/bun scripts\/build\.ts --target=([a-z0-9-]+)/g)].map(match => match[1]);
}

function assertArtifactPaths(job, expected, forbidden = []) {
	for (const path of expected) {
		assert.match(job, new RegExp(`^\\s+${path.replaceAll('.', '\\.')}\\s*$`, 'm'), `producer 必须上传 ${path}`);
	}
	for (const path of forbidden) {
		assert.doesNotMatch(job, new RegExp(`^\\s+${path.replaceAll('.', '\\.')}\\s*$`, 'm'), `producer 不得上传 ${path}`);
	}
}

function parseRevision(value) {
	const match = value.trim().match(/\+([0-9a-f]{7,40})$/i);
	assert.ok(match, `无法从 Bun revision 解析 commit: ${value}`);
	return match[1].toLowerCase();
}

async function verifyInstalledRevision(value) {
	const installedRevision = parseRevision(value);
	const headers = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'ccq-build-runtime-verifier'
	};
	if (process.env.GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	}

	const compareUrl = `https://api.github.com/repos/oven-sh/bun/compare/` + `${windowsFfiFixRevision}...${installedRevision}`;
	const response = await fetch(compareUrl, {headers});
	if (!response.ok) {
		throw new Error(`Bun revision 比较失败: HTTP ${response.status} ${await response.text()}`);
	}

	const comparison = await response.json();
	assert.ok(
		comparison.status === 'ahead' || comparison.status === 'identical',
		`Bun ${installedRevision} 不包含 Windows FFI 修复 ${windowsFfiFixRevision}（status=${comparison.status}）`
	);
	console.log(`[PASS] Bun ${installedRevision} 包含 Windows FFI 修复 ${windowsFfiFixRevision}`);
}

async function verifyRepositoryContract() {
	const pkg = JSON.parse(read(join(root, 'package.json')));
	const lock = read(join(root, 'bun.lock'));
	const workflow = read(join(repoRoot, '.github', 'workflows', 'build-and-release.yml'));
	const buildContract = JSON.parse(read(join(repoRoot, 'installer', 'contracts', 'build.json')));
	const buildSource = read(join(root, 'scripts', 'build.ts'));

	for (const name of ['@opentui/core', '@opentui/keymap', '@opentui/react']) {
		assert.equal(pkg.dependencies[name], '0.4.5', `${name} 必须与 OpenTUI runtime 一起锁定`);
		assert.match(lock, new RegExp(`"${name.replace('/', '\\/')}@0\\.4\\.5"`));
	}
	assert.match(lock, /"bun-ffi-structs@0\.2\.4"/);
	assert.match(pkg.scripts.verify, /bun scripts\/verify-build-runtime\.mjs/);

	const stableJob = workflowJob(workflow, 'build-tui');
	const windowsArm64Job = workflowJob(workflow, 'build-tui-windows-arm64');
	const buildWindowsJob = workflowJob(workflow, 'build-windows');
	const buildMacosJob = workflowJob(workflow, 'build-macos');
	const smokeWindowsJob = workflowJob(workflow, 'smoke-windows');
	const smokeMacosJob = workflowJob(workflow, 'smoke-macos');
	const releaseJob = workflowJob(workflow, 'release');

	assert.match(stableJob, /runs-on: ubuntu-latest/);
	assert.match(stableJob, /bun-version: '1\.3\.14'/);
	assert.doesNotMatch(stableJob, /bun-version: 'canary'|--installed-revision|no-cache: true/);
	assert.deepEqual(selectedBuildTargets(stableJob), ['windows-x64', 'macos-x64', 'macos-arm64']);
	assert.doesNotMatch(stableJob, /package-gzip-assets\.ts dist/, 'partial producer 不得再次执行全目录 gzip');
	assertArtifactPaths(
		stableJob,
		[
			'dist/ccq-windows-x64.exe',
			'dist/ccq-windows-x64.exe.gz',
			'dist/ccq-macos-x64',
			'dist/ccq-macos-x64.gz',
			'dist/ccq-macos-arm64',
			'dist/ccq-macos-arm64.gz'
		],
		['dist/ccq-windows-arm64.exe', 'dist/ccq-windows-arm64.exe.gz']
	);

	assert.match(windowsArm64Job, /runs-on: windows-11-arm/);
	assert.match(windowsArm64Job, /id: setup-bun-windows-arm64[\s\S]{0,180}bun-version: 'canary'[\s\S]{0,100}no-cache: true/);
	assert.match(
		windowsArm64Job,
		/bun tui\/scripts\/verify-build-runtime\.mjs --installed-revision '\$\{\{ steps\.setup-bun-windows-arm64\.outputs\.bun-revision \}\}'/
	);
	assert.match(windowsArm64Job, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
	assert.deepEqual(selectedBuildTargets(windowsArm64Job), ['windows-arm64']);
	assert.match(windowsArm64Job, /ccq-windows-arm64\.exe[\s\S]{0,500}--version/);
	assert.match(windowsArm64Job, /ccq-windows-arm64\.exe[\s\S]{0,900}--help/);
	assertArtifactPaths(windowsArm64Job, ['dist/ccq-windows-arm64.exe', 'dist/ccq-windows-arm64.exe.gz'], [
		'dist/ccq-windows-x64.exe',
		'dist/ccq-macos-x64',
		'dist/ccq-macos-arm64'
	]);

	assert.match(buildWindowsJob, /needs:[\s\S]{0,120}- build-tui[\s\S]{0,120}- build-tui-windows-arm64/);
	assert.match(buildWindowsJob, /name: built-tui-windows-arm64-\$\{\{ github\.sha \}\}[\s\S]{0,80}path: dist/);
	assert.doesNotMatch(buildMacosJob, /build-tui-windows-arm64|built-tui-windows-arm64-/);
	assert.doesNotMatch(smokeWindowsJob, /build-tui-windows-arm64|built-tui-windows-arm64-/);
	assert.doesNotMatch(smokeMacosJob, /build-tui-windows-arm64|built-tui-windows-arm64-/);
	assert.match(releaseJob, /needs:[\s\S]{0,220}- build-tui-windows-arm64/);
	assert.match(releaseJob, /name: built-tui-windows-arm64-\$\{\{ github\.sha \}\}[\s\S]{0,80}path: dist/);
	assert.match(releaseJob, /BuildEntrypoints\.ReleaseArtifacts\.length/);
	assert.equal(buildContract.BuildEntrypoints.ReleaseArtifacts.length, 10, 'Release 必须保持精确十文件合同');
	for (const asset of ['ccq-windows-arm64.exe', 'ccq-windows-arm64.exe.gz']) {
		assert.ok(buildContract.BuildEntrypoints.ReleaseArtifacts.includes(asset), `Release 合同必须包含 ${asset}`);
	}

	assert.match(buildSource, /if \(import\.meta\.main\)/, 'build.ts 被 gate import 时不得自动开始编译');
	const buildModule = await import('./build.ts');
	const legalTargets = ['windows-x64', 'windows-arm64', 'macos-x64', 'macos-arm64'];
	assert.deepEqual(
		buildModule.selectBuildTargets([]).map(target => target.id),
		legalTargets,
		'默认 build 保持四目标'
	);
	for (const target of legalTargets) {
		assert.deepEqual(
			buildModule.selectBuildTargets([`--target=${target}`]).map(selected => selected.id),
			[target],
			`显式 target 必须只选择 ${target}`
		);
	}
	assert.throws(() => buildModule.selectBuildTargets(['--target']), /target.*值|用法/i);
	assert.throws(() => buildModule.selectBuildTargets(['--target=']), /target.*值|用法/i);
	assert.throws(() => buildModule.selectBuildTargets(['--target=linux-x64']), /未知.*target|不支持/i);
	assert.throws(
		() => buildModule.selectBuildTargets(['--target=windows-x64', '--target=macos-x64']),
		/重复.*target|只能选择一个/i
	);

	const cleanupRoot = mkdtempSync(join(tmpdir(), 'ccq-build-target-cleanup-'));
	try {
		const selectedTarget = buildModule.selectBuildTargets(['--target=windows-x64'])[0];
		const preservedTarget = buildModule.selectBuildTargets(['--target=macos-x64'])[0];
		const selectedArtifacts = buildModule.targetArtifactNames(selectedTarget);
		const preservedArtifacts = buildModule.targetArtifactNames(preservedTarget);
		for (const artifact of [...Object.values(selectedArtifacts), ...Object.values(preservedArtifacts)]) {
			writeFileSync(join(cleanupRoot, artifact), artifact);
		}
		buildModule.cleanTargetArtifacts(selectedTarget, cleanupRoot);
		for (const artifact of Object.values(selectedArtifacts)) {
			assert.equal(existsSync(join(cleanupRoot, artifact)), false, `构建前必须清理当前 target artifact: ${artifact}`);
		}
		for (const artifact of Object.values(preservedArtifacts)) {
			assert.equal(existsSync(join(cleanupRoot, artifact)), true, `构建前不得清理其他 target artifact: ${artifact}`);
		}
	} finally {
		rmSync(cleanupRoot, {recursive: true, force: true});
	}
	const compileStart = buildSource.indexOf('async function compileTarget');
	const cleanupCall = buildSource.indexOf('cleanTargetArtifacts(target);', compileStart);
	const spawnCall = buildSource.indexOf('Bun.spawn(', compileStart);
	assert.ok(compileStart >= 0 && cleanupCall > compileStart && spawnCall > cleanupCall, '当前 target artifact 必须在 Bun.spawn 前清理');

	const attempted = [];
	const originalLog = console.log;
	const originalError = console.error;
	try {
		console.log = () => {};
		console.error = () => {};
		await assert.rejects(
			buildModule.runBuildTargets(buildModule.selectBuildTargets(['--target=windows-x64']), async target => {
				attempted.push(target.id);
				throw new Error('fixture compile failure');
			}),
			/所有.*构建.*失败|windows-x64.*失败/
		);
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
	assert.deepEqual(attempted, ['windows-x64'], '单 target 失败不得尝试其他平台');

	console.log('[PASS] OpenTUI/FFI 构建运行时合同：三个稳定交叉目标 + Windows ARM64 canary 原生 revision gate');
}

const revisionFlag = process.argv.indexOf('--installed-revision');
if (revisionFlag === -1) {
	await verifyRepositoryContract();
} else {
	const revision = process.argv[revisionFlag + 1];
	assert.ok(revision, '--installed-revision 需要 Bun --revision 输出');
	await verifyInstalledRevision(revision);
}
