// gzip 更新传输资产门禁：确定性、roundtrip、raw-to-gzip 映射与 Release 清单一致。
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';

const workDir = mkdtempSync(join(tmpdir(), 'ccq-gzip-assets-'));
try {
	const {RAW_TO_GZIP, gzipDeterministic, packageGzipAssetsInDir} = await import('./package-gzip-assets.ts');

	// ── raw -> gzip 映射必须与 installer 契约同源，且覆盖四个平台 ────────────────
	const contract = JSON.parse(readFileSync(new URL('../../installer/contracts/build.json', import.meta.url), 'utf8'));
	const contractMappings = contract.UpdateTransports.GzipAssets;
	assert.equal(contractMappings.length, 4, '契约必须声明四个平台的 gzip 传输资产');
	assert.deepEqual(
		RAW_TO_GZIP.map(item => [item.raw, item.gzip]),
		contractMappings.map(item => [item.Raw, item.Gzip]),
		'打包脚本的映射必须与 installer 契约逐项一致，不得形成第二份文件名来源'
	);
	for (const {raw, gzip} of RAW_TO_GZIP) {
		assert.equal(gzip, `${raw}.gz`, 'gzip 资产名必须是 raw 名加 .gz');
		assert.ok(contract.BuildEntrypoints.ReleaseArtifacts.includes(raw), `Release 必须仍发布 raw: ${raw}`);
		assert.ok(contract.BuildEntrypoints.ReleaseArtifacts.includes(gzip), `Release 必须发布 gzip: ${gzip}`);
	}
	assert.equal(contract.BuildEntrypoints.ReleaseArtifacts.length, 10, 'Release artifact 必须精确为 10 个');

	// ── 确定性：同一输入重复压缩字节一致（mtime/OS 头被固定） ────────────────────
	const payload = Buffer.alloc(64 * 1024);
	for (let index = 0; index < payload.byteLength; index++) payload[index] = (index * 37) & 0xff;
	const firstPass = gzipDeterministic(payload);
	const secondPass = gzipDeterministic(payload);
	assert.equal(firstPass.equals(secondPass), true, '重复压缩必须产生完全一致的字节');
	assert.equal(firstPass[4], 0, 'gzip mtime 头必须固定为 0');
	assert.equal(firstPass[9], 255, 'gzip OS 头必须固定为 255，避免跨平台漂移');
	assert.equal(Buffer.from(gunzipSync(firstPass)).equals(payload), true, 'gzip 必须可 roundtrip 回 raw 字节');

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

	console.log('[PASS] gzip 更新资产：确定性 + roundtrip + 契约同源 10 artifact');
} finally {
	rmSync(workDir, {recursive: true, force: true});
}
