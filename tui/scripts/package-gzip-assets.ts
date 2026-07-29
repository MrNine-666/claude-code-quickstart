#!/usr/bin/env bun
/**
 * 从最终 raw Release 可执行文件生成确定性 `.gz` 更新传输资产。
 *
 * - 仅在 raw 文件存在后调用（图标/版本注入之后）
 * - gzip level 9 + 固定 mtime/OS 头，重复压缩字节一致
 * - 成功前必须 gunzip roundtrip 等于 raw
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';

export type RawToGzipMapping = {readonly raw: string; readonly gzip: string};

function loadRawToGzipMappings(): readonly RawToGzipMapping[] {
	const contractPath = join(import.meta.dir, '../../installer/contracts/build.json');
	const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
		readonly UpdateTransports?: {readonly GzipAssets?: readonly {readonly Raw?: unknown; readonly Gzip?: unknown}[]};
	};
	const mappings = contract.UpdateTransports?.GzipAssets;
	if (!Array.isArray(mappings) || mappings.length === 0) {
		throw new Error('build.json 缺少 UpdateTransports.GzipAssets');
	}
	return Object.freeze(
		mappings.map((item, index) => {
			if (typeof item.Raw !== 'string' || !item.Raw || typeof item.Gzip !== 'string' || item.Gzip !== `${item.Raw}.gz`) {
				throw new Error(`build.json gzip 映射无效: UpdateTransports.GzipAssets[${index}]`);
			}
			return Object.freeze({raw: item.Raw, gzip: item.Gzip});
		})
	);
}

/** raw→gzip 文件名唯一来源：installer/contracts/build.json。 */
export const RAW_TO_GZIP = loadRawToGzipMappings();

export function gzipAssetNameForRaw(rawName: string): string {
	const mapping = RAW_TO_GZIP.find(item => item.raw === rawName);
	if (!mapping) throw new Error(`build.json 未声明 raw artifact 的 gzip 映射: ${rawName}`);
	return mapping.gzip;
}

/** 生成跨平台可重复的 gzip 字节（mtime=0, OS=255）。 */
export function gzipDeterministic(raw: Uint8Array | Buffer): Buffer {
	const compressed = gzipSync(raw, {level: 9});
	const out = Buffer.from(compressed);
	// RFC 1952：bytes 4-7 为 mtime；byte 9 为 OS。固定后可重复。
	out[4] = 0;
	out[5] = 0;
	out[6] = 0;
	out[7] = 0;
	out[9] = 255;
	return out;
}

export function sha256Hex(bytes: Uint8Array | Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export type PackageGzipResult = {
	readonly raw: string;
	readonly gzip: string;
	readonly rawSize: number;
	readonly gzipSize: number;
	readonly rawSha256: string;
	readonly gzipSha256: string;
};

export function packageGzipAsset(rawPath: string, gzipPath: string): PackageGzipResult {
	const raw = readFileSync(rawPath);
	const first = gzipDeterministic(raw);
	const second = gzipDeterministic(raw);
	if (!first.equals(second)) {
		throw new Error(`gzip 输出不稳定: ${rawPath}`);
	}
	const roundtrip = gunzipSync(first);
	if (!Buffer.from(roundtrip).equals(raw)) {
		throw new Error(`gzip roundtrip 与 raw 不一致: ${rawPath}`);
	}
	writeFileSync(gzipPath, first);
	return {
		raw: rawPath,
		gzip: gzipPath,
		rawSize: raw.byteLength,
		gzipSize: first.byteLength,
		rawSha256: sha256Hex(raw),
		gzipSha256: sha256Hex(first)
	};
}

export function packageGzipAssetsInDir(
	directory: string,
	mappings: ReadonlyArray<{readonly raw: string; readonly gzip: string}> = RAW_TO_GZIP
): PackageGzipResult[] {
	const results: PackageGzipResult[] = [];
	for (const mapping of mappings) {
		const rawPath = join(directory, mapping.raw);
		const gzipPath = join(directory, mapping.gzip);
		if (!existsSync(rawPath)) {
			throw new Error(`缺少 raw artifact，无法生成 gzip: ${rawPath}`);
		}
		results.push(packageGzipAsset(rawPath, gzipPath));
	}
	return results;
}

async function main(): Promise<void> {
	const directory = process.argv[2] ?? join(import.meta.dir, '../../dist');
	const results = packageGzipAssetsInDir(directory);
	for (const result of results) {
		const ratio = ((1 - result.gzipSize / result.rawSize) * 100).toFixed(2);
		console.log(`✓ ${result.gzip.split(/[\\/]/).pop()} ${result.gzipSize} B (−${ratio}%) sha256=${result.gzipSha256.slice(0, 12)}…`);
	}
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
