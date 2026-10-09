import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = join(import.meta.dirname, '..');
const windowsFfiFixRevision = 'f64cade36214f2a5b724da8d7557ca4dad069d81';

async function verifyInstalledRevision(value) {
	const actual = spawnSync(process.execPath, ['--revision'], {encoding: 'utf8'});
	assert.equal(actual.status, 0, actual.stderr);
	assert.equal(actual.stdout.trim(), value.trim(), 'Setup revision must match executing Bun runtime');
	const match = actual.stdout.trim().match(/\+([0-9a-f]{7,40})$/i);
	assert.ok(match, `无法从 Bun revision 解析 commit: ${value}`);
	const revision = match[1].toLowerCase();
	const headers = {Accept: 'application/vnd.github+json', 'User-Agent': 'ccq-build-runtime-verifier'};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const response = await fetch(`https://api.github.com/repos/oven-sh/bun/compare/${windowsFfiFixRevision}...${revision}`, {headers});
	if (!response.ok) throw new Error(`Bun revision 比较失败: HTTP ${response.status}`);
	const comparison = await response.json();
	assert.ok(comparison.status === 'ahead' || comparison.status === 'identical', `Bun ${revision} 不包含 Windows FFI 修复 ${windowsFfiFixRevision}`);
	console.log(`[PASS] Bun ${revision} 包含 Windows FFI 修复 ${windowsFfiFixRevision}`);
}

async function verifyBuildBehavior() {
	const {parseReleaseTag} = await import('./release-metadata.mjs');
	assert.deepEqual(parseReleaseTag('v1.2.3'), {tag: 'v1.2.3', version: '1.2.3', prerelease: false});
	assert.equal(parseReleaseTag('v1.2.3-preview.1+build.7').prerelease, true);
	assert.equal(parseReleaseTag('v1.2.3+build.7').prerelease, false);
	for (const invalid of ['1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3-01', 'v1.2.3-']) assert.throws(() => parseReleaseTag(invalid));

	const build = await import('./build.ts');
	const targets = ['windows-x64', 'windows-arm64', 'macos-x64', 'macos-arm64'];
	assert.deepEqual(build.selectBuildTargets([]).map(target => target.id), targets);
	for (const target of targets) assert.deepEqual(build.selectBuildTargets([`--target=${target}`]).map(item => item.id), [target]);
	for (const args of [['--target'], ['--target='], ['--target=linux-x64'], ['--target=windows-x64', '--target=macos-x64']]) {
		assert.throws(() => build.selectBuildTargets(args));
	}
	const directory = mkdtempSync(join(tmpdir(), 'ccq-build-contract-'));
	try {
		const selected = build.selectBuildTargets(['--target=windows-x64'])[0];
		const preserved = build.selectBuildTargets(['--target=macos-x64'])[0];
		for (const target of [selected, preserved]) {
			for (const name of Object.values(build.targetArtifactNames(target))) writeFileSync(join(directory, name), 'stale');
		}
		const manifest = JSON.parse(readFileSync(join(root, '../installer/contracts/build.json'), 'utf8'));
		const scriptNames = [...manifest.Windows.Artifacts, ...manifest.MacOS.Artifacts].map(item => item.OutputFile);
		for (const name of scriptNames) writeFileSync(join(directory, name), `tracked-${name}`);
		build.cleanTargetArtifacts(selected, directory);
		for (const name of scriptNames) assert.equal(readFileSync(join(directory, name), 'utf8'), `tracked-${name}`, 'Binary cleanup must preserve tracked scripts');
		for (const name of Object.values(build.targetArtifactNames(selected))) assert.equal(existsSync(join(directory, name)), false);
		for (const name of Object.values(build.targetArtifactNames(preserved))) assert.equal(existsSync(join(directory, name)), true);
		const attempted = [];
		await assert.rejects(build.runBuildTargets([selected], async target => {
			attempted.push(target.id);
			throw new Error('fixture compile failure');
		}));
		assert.deepEqual(attempted, [selected.id]);
		const partialAttempted = [];
		await assert.rejects(build.runBuildTargets([selected, preserved], async target => {
			partialAttempted.push(target.id);
			if (target.id === preserved.id) throw new Error('second target failure');
		}));
		assert.deepEqual(partialAttempted, [selected.id, preserved.id], 'Partial multi-target builds must fail');

		const packagePath = join(directory, 'package.json');
		const outputPath = join(directory, 'github-output.txt');
		writeFileSync(packagePath, '{"version":"0.0.0-dev"}');
		const cli = spawnSync('node', [join(root, 'scripts/release-metadata.mjs'), '--tag=v2.5.0-preview.1', `--package=${packagePath}`, `--github-output=${outputPath}`], {encoding: 'utf8'});
		assert.equal(cli.status, 0, cli.stderr);
		assert.equal(JSON.parse(readFileSync(packagePath, 'utf8')).version, '2.5.0-preview.1');
		assert.equal(readFileSync(outputPath, 'utf8'), 'version=2.5.0-preview.1\nprerelease=true\n');
	} finally {
		rmSync(directory, {recursive: true, force: true});
	}
	console.log('[PASS] Build target selection, failure propagation, stale cleanup and tag version injection');
}

const revisionFlag = process.argv.indexOf('--installed-revision');
if (revisionFlag === -1) await verifyBuildBehavior();
else {
	const revision = process.argv[revisionFlag + 1];
	assert.ok(revision, '--installed-revision 需要 Bun --revision 输出');
	await verifyInstalledRevision(revision);
}
