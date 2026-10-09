// gzip 更新传输资产门禁：确定性、roundtrip、raw-to-gzip 映射与 Release 清单一致。
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';

const workDir = mkdtempSync(join(tmpdir(), 'ccq-gzip-assets-'));
try {
	const {RAW_TO_GZIP, packageGzipAssetsInDir} = await import('./package-gzip-assets.ts');
	const {releaseAssets, verifyReleaseAssets} = await import('./release-assets.mjs');
	assert.deepEqual(releaseAssets('stable').concat(releaseAssets('arm64')).map(item => item.Raw).sort(), RAW_TO_GZIP.map(item => item.raw).sort());

	// ── 四个平台目录级打包：必须先有 raw，且解压等于 raw ────────────────────────
	const rawBytes = new Map();
	for (const {raw} of RAW_TO_GZIP) {
		const bytes = Buffer.from(`binary-${raw}-${'x'.repeat(4096)}`);
		rawBytes.set(raw, bytes);
		writeFileSync(join(workDir, raw), bytes);
	}
	const results = packageGzipAssetsInDir(workDir);
	assert.equal(results.length, 4, '必须为四个平台各生成一个 gzip 资产');
	for (const {raw, gzip} of RAW_TO_GZIP) {
		const produced = readFileSync(join(workDir, gzip));
		assert.equal(Buffer.from(gunzipSync(produced)).equals(rawBytes.get(raw)), true, `${gzip} 解压结果必须与最终 raw 字节完全一致`);
	}
	const repeated = packageGzipAssetsInDir(workDir);
	assert.deepEqual(
		repeated.map(item => item.gzipSha256),
		results.map(item => item.gzipSha256),
		'重复打包必须产生相同 digest，Release 才可复现'
	);

	// ── 缺少 raw 必须 fail closed，绝不生成半套传输资产 ─────────────────────────
	const emptyDir = mkdtempSync(join(tmpdir(), 'ccq-gzip-empty-'));
	try {
		assert.throws(() => packageGzipAssetsInDir(emptyDir), /缺少 raw artifact/, 'raw 缺失时必须失败，不允许发布不完整的传输资产集合');
	} finally {
		rmSync(emptyDir, {recursive: true, force: true});
	}

	verifyReleaseAssets(workDir);
	const {publishRelease} = await import('./publish-release.mjs');
	let remote = null;
	let remoteAssets = [];
	let failUpload = true;
	let corruptDigest = false;
	let mutations = 0;
	const request = async (url, options) => {
		const path = new URL(url).pathname;
		const json = value => Response.json(value);
		if (options.method !== 'GET') mutations++;
		if (path.endsWith('/tags/v2.5.0')) return remote ? json(remote) : new Response(null, {status: 404});
		if (options.method === 'DELETE') {
			remoteAssets = remoteAssets.filter(asset => asset.id !== Number(path.split('/').pop()));
			return new Response(null, {status: 204});
		}
		if (path.endsWith('/assets')) {
			if (options.method === 'GET') return json(remoteAssets);
			if (failUpload && remoteAssets.length === 1) return new Response(null, {status: 502});
			const bytes = options.body;
			const asset = {
				id: remoteAssets.length + 1, name: new URL(url).searchParams.get('name'),
				state: 'uploaded', size: bytes.length,
				digest: `sha256:${corruptDigest ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')}`
			};
			remoteAssets.push(asset);
			return json(asset);
		}
		const body = JSON.parse(options.body);
		if (options.method === 'POST') remote = {id: 1, body: 'Generated release notes', ...body};
		else {
			assert.equal(remoteAssets.length, releaseAssets().length * 2, 'Publish must wait for complete assets');
			remote = {...remote, ...body};
		}
		return json(remote);
	};
	const publish = () => publishRelease({directory: workDir, repository: 'owner/repo', tag: 'v2.5.0', token: 'fixture', fetch: request});
	await assert.rejects(publish(), /HTTP 502/);
	assert.equal(remote.draft, true, 'Upload failure must not expose partial public Release');
	failUpload = false;
	corruptDigest = true;
	await assert.rejects(publish(), /digest mismatch/);
	assert.equal(remote.draft, true, 'Integrity failure must leave Release hidden');
	corruptDigest = false;
	remoteAssets.push({id: 99, name: 'install.ps1'});
	await publish();
	assert.equal(remote.draft, false);
	assert.ok(remote.body.startsWith('Generated release notes\n\n'), 'Keep generated Release notes');
	for (const name of ['install.ps1', 'install.sh', 'download-tui.ps1', 'download-tui.zsh']) {
		assert.ok(remote.body.includes(`https://raw.githubusercontent.com/owner/repo/main/dist/${name}`));
	}
	assert.ok(!remote.body.includes('/v2.5.0/dist/'), 'Installer links have no script version');
	assert.equal(remoteAssets.length, releaseAssets().length * 2, 'Retry must remove stale extra assets');
	const publishedMutations = mutations;
	await publish();
	assert.equal(mutations, publishedMutations, 'Identical published retry must be read-only');
	remoteAssets[0].digest = `sha256:${'0'.repeat(64)}`;
	await assert.rejects(publish(), /digest mismatch/);
	assert.equal(mutations, publishedMutations, 'Mismatched published retry must fail without mutation');
	console.log('[PASS] Release draft staging, failure/retry, remote integrity and published idempotence');
	const mapping = RAW_TO_GZIP[0];
	writeFileSync(join(workDir, 'install.ps1'), 'unexpected');
	assert.throws(() => verifyReleaseAssets(workDir), /exact owned/);
	unlinkSync(join(workDir, 'install.ps1'));
	const gzipBytes = readFileSync(join(workDir, mapping.gzip));
	writeFileSync(join(workDir, mapping.gzip), 'corrupt');
	assert.throws(() => verifyReleaseAssets(workDir));
	writeFileSync(join(workDir, mapping.gzip), gzipBytes);
	unlinkSync(join(workDir, mapping.raw));
	assert.throws(() => verifyReleaseAssets(workDir), /exact owned/);
	console.log('[PASS] gzip 更新资产：确定性、roundtrip、精确 Release 集合、损坏/缺失失败');
} finally {
	rmSync(workDir, {recursive: true, force: true});
}
