import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const root = join(import.meta.dirname, '..');
const repoRoot = join(root, '..');
const windowsFfiFixRevision = 'f64cade36214f2a5b724da8d7557ca4dad069d81';

function read(path) {
	return readFileSync(path, 'utf8');
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

function verifyRepositoryContract() {
	const pkg = JSON.parse(read(join(root, 'package.json')));
	const lock = read(join(root, 'bun.lock'));
	const workflow = read(join(repoRoot, '.github', 'workflows', 'build-and-release.yml'));

	for (const name of ['@opentui/core', '@opentui/keymap', '@opentui/react']) {
		assert.equal(pkg.dependencies[name], '0.4.5', `${name} 必须与 OpenTUI runtime 一起锁定`);
		assert.match(lock, new RegExp(`"${name.replace('/', '\\/')}@0\\.4\\.5"`));
	}
	assert.match(lock, /"bun-ffi-structs@0\.2\.4"/);
	assert.match(pkg.scripts.verify, /bun scripts\/verify-build-runtime\.mjs/);

	assert.match(
		workflow,
		/id: setup-bun-build[\s\S]{0,160}uses: oven-sh\/setup-bun@v2[\s\S]{0,160}bun-version: 'canary'[\s\S]{0,80}no-cache: true/
	);
	assert.match(
		workflow,
		/run: bun tui\/scripts\/verify-build-runtime\.mjs --installed-revision '\$\{\{ steps\.setup-bun-build\.outputs\.bun-revision \}\}'/
	);
	assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);

	console.log('[PASS] OpenTUI/FFI 构建运行时合同：0.4.5 + Bun canary revision gate');
}

const revisionFlag = process.argv.indexOf('--installed-revision');
if (revisionFlag === -1) {
	verifyRepositoryContract();
} else {
	const revision = process.argv[revisionFlag + 1];
	assert.ok(revision, '--installed-revision 需要 Bun --revision 输出');
	await verifyInstalledRevision(revision);
}
