// gzip 更新传输资产门禁：确定性、roundtrip、raw-to-gzip 映射与 Release 清单一致。
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';

const workDir = mkdtempSync(join(tmpdir(), 'ccq-gzip-assets-'));
try {
	const {RAW_TO_GZIP, packageGzipAssetsInDir} = await import('./package-gzip-assets.ts');

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

	console.log('[PASS] gzip 更新资产：四平台目录级打包 + 缺 raw fail closed');
} finally {
	rmSync(workDir, {recursive: true, force: true});
}
