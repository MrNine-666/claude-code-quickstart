import {gunzipSync} from 'node:zlib';
import {expect, test} from 'bun:test';
import buildContract from '../../../installer/contracts/build.json' with {type: 'json'};
import {RAW_TO_GZIP, gzipDeterministic} from '../../scripts/package-gzip-assets.js';

// P5a 迁移自 scripts/verify-gzip-assets.mjs 的纯段（10 条静态断言）：
//   - RAW_TO_GZIP 映射与 installer/contracts/build.json 同源（6）
//   - gzipDeterministic 字节确定性 / mtime=0 / OS=255 / roundtrip（4）
// 目录级打包（真实写盘 + gunzip 校验 + 缺 raw fail closed）仍留在 verify-gzip-assets.mjs。

const contractMappings = buildContract.UpdateTransports.GzipAssets;

test('RAW_TO_GZIP 映射与 installer 契约同源', () => {
	expect(contractMappings.length, '契约 gzip 资产数量必须与打包脚本映射一致').toBe(RAW_TO_GZIP.length);
	expect(
		RAW_TO_GZIP.map(item => [item.raw, item.gzip]),
		'打包脚本的映射必须与 installer 契约逐项一致，不得形成第二份文件名来源'
	).toEqual(contractMappings.map(item => [item.Raw, item.Gzip]));
	for (const {raw, gzip} of RAW_TO_GZIP) {
		expect(gzip, 'gzip 资产名必须是 raw 名加 .gz').toBe(`${raw}.gz`);
		expect(buildContract.BuildEntrypoints.ReleaseArtifacts.includes(raw), `Release 必须仍发布 raw: ${raw}`).toBe(true);
		expect(buildContract.BuildEntrypoints.ReleaseArtifacts.includes(gzip), `Release 必须发布 gzip: ${gzip}`).toBe(true);
	}
	const platformArtifacts = [...buildContract.BuildEntrypoints.Windows.Artifacts, ...buildContract.BuildEntrypoints.MacOS.Artifacts];
	expect(
		[...buildContract.BuildEntrypoints.ReleaseArtifacts].sort(),
		'Release 集合必须等于两个平台 Artifacts 的并集，不得维护第二份名单或数量魔数'
	).toEqual([...new Set(platformArtifacts)].sort());
});

test('gzipDeterministic 字节确定性 + roundtrip', () => {
	const payload = Buffer.alloc(64 * 1024);
	for (let index = 0; index < payload.byteLength; index++) payload[index] = (index * 37) & 0xff;
	const firstPass = gzipDeterministic(payload);
	const secondPass = gzipDeterministic(payload);
	expect(firstPass.equals(secondPass), '重复压缩必须产生完全一致的字节').toBe(true);
	expect(firstPass[4], 'gzip mtime 头必须固定为 0').toBe(0);
	expect(firstPass[9], 'gzip OS 头必须固定为 255，避免跨平台漂移').toBe(255);
	expect(Buffer.from(gunzipSync(firstPass)).equals(payload), 'gzip 必须可 roundtrip 回 raw 字节').toBe(true);
});
