// Minimal raw/gzip update integrity: transport and materialized bytes are separate trust boundaries.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';

const previousHome = process.env.CCQ_HOME;
const home = mkdtempSync(join(tmpdir(), 'ccq-update-integrity-'));
process.env.CCQ_HOME = home;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
try {
	const {checkLatestVersion, downloadUpdate, applyUpdate} = await import('../src/core/self-update.ts');
	const {releaseAssets} = await import('./release-assets.mjs');
	const directory = join(home, 'bin');
	mkdirSync(directory);
	const targetPath = join(directory, 'ccq');
	const old = Buffer.from('old binary');
	const raw = Buffer.from('new binary bytes');
	const compressed = gzipSync(raw);
	writeFileSync(targetPath, old);
	const target = {assetName: 'ccq-macos-arm64', downloadUrl: 'https://example.invalid/raw', expectedSize: raw.length, expectedSha256: sha256(raw)};
	const identity = {...target, encoding: 'identity'};
	const gzip = {assetName: `${target.assetName}.gz`, downloadUrl: 'https://example.invalid/gzip', expectedSize: compressed.length, expectedSha256: sha256(compressed), encoding: 'gzip'};
	const plan = {version: '2.5.0', target, transports: [gzip, identity]};
	// Releases retain the raw capabilities expected by old clients and raw-only rollbacks.
	const nodePlatforms = {windows: 'win32', macos: 'darwin', linux: 'linux'};
	for (const mapping of releaseAssets()) {
		const platform = nodePlatforms[mapping.Raw.split('-')[1]];
		assert.ok(platform, `Unknown Release platform: ${mapping.Raw}`);
		const arch = mapping.Raw.includes('arm64') ? 'arm64' : 'x64';
		const asset = {name: mapping.Raw, size: raw.length, digest: `sha256:${sha256(raw)}`, browser_download_url: target.downloadUrl};
		for (const assets of [[asset], [asset, {...asset, name: mapping.Gzip, size: compressed.length, digest: `sha256:${sha256(compressed)}`, browser_download_url: gzip.downloadUrl}]]) {
			const checked = await checkLatestVersion({platform, arch, currentVersion: '2.4.0', fetch: async () => Response.json({tag_name: 'v2.5.0', assets})});
			assert.equal(checked.ok, true);
			assert.equal(checked.hasUpdate, true);
			assert.equal(checked.plan.target.assetName, mapping.Raw);
			assert.equal(checked.plan.transports.length, assets.length);
		}
	}
	assert.deepEqual(releaseAssets().filter(item => item.Raw.startsWith('ccq-linux-')).map(item => item.Raw).sort(), ['ccq-linux-arm64', 'ccq-linux-x64']);
	const linuxAsset = {name: 'ccq-linux-x64', size: raw.length, digest: `sha256:${sha256(raw)}`, browser_download_url: target.downloadUrl};
	const checkLinux = (arch, assets) => checkLatestVersion({platform: 'linux', arch, currentVersion: '2.4.0', fetch: async () => Response.json({tag_name: 'v2.5.0', assets})});
	const unsupported = await checkLinux('ia32', [linuxAsset]);
	assert.equal(unsupported.ok, false, 'Unknown Linux architecture must fail closed');
	assert.equal(unsupported.error.stage, 'check');
	const {digest: _digest, ...undigested} = linuxAsset;
	assert.equal((await checkLinux('x64', [undigested])).ok, false, 'Linux raw asset without digest must fail closed');
	const gzipWithoutDigest = await checkLinux('x64', [linuxAsset, {...undigested, name: 'ccq-linux-x64.gz'}]);
	assert.equal(gzipWithoutDigest.ok, true);
	assert.deepEqual(gzipWithoutDigest.plan.transports.map(item => item.encoding), ['identity'], 'gzip without digest is ignored');
	const deps = {targetPath, platform: 'darwin', fetch: async url => new Response(String(url).endsWith('gzip') ? compressed : raw)};
	const downloaded = await downloadUpdate(plan, undefined, deps);
	assert.equal(downloaded.ok, true);
	assert.deepEqual(readFileSync(downloaded.transaction.tempPath), raw);
	assert.deepEqual(readFileSync(targetPath), old);
	const fallback = await downloadUpdate(plan, undefined, {...deps, fetch: async url => new Response(String(url).endsWith('gzip') ? Buffer.from('corrupt') : raw)});
	assert.equal(fallback.ok, true);
	assert.deepEqual(readFileSync(fallback.transaction.tempPath), raw);

	for (const overrides of [{expectedSize: raw.length + 1}, {expectedSha256: '0'.repeat(64)}]) {
		const invalid = {...target, ...overrides};
		const rejected = await downloadUpdate({version: plan.version, target: invalid, transports: [{...invalid, encoding: 'identity'}]}, undefined, deps);
		assert.equal(rejected.ok, false, 'size/hash mismatch must fail closed');
		assert.deepEqual(readFileSync(targetPath), old);
	}
	// Valid compressed bytes containing wrong raw bytes must still fail target integrity.
	const wrongGzip = gzipSync(Buffer.alloc(raw.length, 120));
	const wrong = await downloadUpdate({...plan, transports: [{...gzip, expectedSize: wrongGzip.length, expectedSha256: sha256(wrongGzip)}]}, undefined, {...deps, fetch: async () => new Response(wrongGzip)});
	assert.equal(wrong.ok, false);
	writeFileSync(fallback.transaction.tempPath, Buffer.alloc(raw.length, 120));
	const tampered = await applyUpdate(fallback.transaction, {platform: 'darwin'});
	assert.equal(tampered.ok, false);
	assert.deepEqual(readFileSync(targetPath), old);
	// POSIX fsync on a read-only descriptor is not supported by Windows. Native helper owns Windows replacement.
	if (process.platform !== 'win32') {
		const applied = await applyUpdate(downloaded.transaction, {platform: process.platform});
		assert.equal(applied.ok, true, JSON.stringify(applied));
		assert.deepEqual(readFileSync(targetPath), raw);
	}
	// Linux uses the POSIX chmod/fsync/rename path; the fsync seam lets Windows hosts exercise it too.
	writeFileSync(targetPath, old);
	const linuxTarget = {...target, assetName: 'ccq-linux-x64'};
	const linuxPlan = {version: plan.version, target: linuxTarget, transports: [{...gzip, assetName: 'ccq-linux-x64.gz'}, {...linuxTarget, encoding: 'identity'}]};
	const linuxDownloaded = await downloadUpdate(linuxPlan, undefined, {...deps, platform: 'linux'});
	assert.equal(linuxDownloaded.ok, true, JSON.stringify(linuxDownloaded));
	const linuxApplied = await applyUpdate(linuxDownloaded.transaction, {platform: 'linux', ...(process.platform === 'win32' ? {fsyncFile: () => {}} : {})});
	assert.equal(linuxApplied.ok, true, JSON.stringify(linuxApplied));
	assert.deepEqual(readFileSync(targetPath), raw);
	console.log('[PASS] Update raw/gzip size/hash integrity, fallback and tamper rejection');
} finally {
	if (previousHome === undefined) delete process.env.CCQ_HOME;
	else process.env.CCQ_HOME = previousHome;
	rmSync(home, {recursive: true, force: true});
}
