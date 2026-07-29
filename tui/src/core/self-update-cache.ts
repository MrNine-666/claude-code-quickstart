// 自更新 transport 持久缓存：digest 分片、排他 lease、TTL/取消/成功清理。

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeSync
} from 'node:fs';
import {join} from 'node:path';
import {createHash, type Hash} from 'node:crypto';
import {atomicWrite} from './fs-utils.js';
import {selfUpdateCacheDir} from './paths.js';

export const SELF_UPDATE_CACHE_SCHEMA = 1;
export const SELF_UPDATE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SELF_UPDATE_LEASE_STALE_MS = 60_000;

export type SelfUpdateTransportEncoding = 'gzip' | 'identity';

export type TransportCacheIdentity = {
	readonly version: string;
	readonly platform: string;
	readonly assetName: string;
	readonly encoding: SelfUpdateTransportEncoding;
	readonly expectedSize: number;
	readonly expectedSha256: string;
	readonly targetSha256: string;
};

export type TransportCacheMetadata = TransportCacheIdentity & {
	readonly schema: number;
};

export type TransportCacheLease = {
	readonly pid: number;
	readonly heartbeatAt: number;
};

export type OpenTransportCacheResult =
	| {
			readonly ok: true;
			readonly entryDir: string;
			readonly payloadPath: string;
			readonly metadataPath: string;
			readonly leasePath: string;
			readonly offset: number;
			readonly hash: Hash;
	  }
	| {readonly ok: false; readonly reason: 'busy' | 'error'; readonly message: string};

function metadataPathFor(entryDir: string): string {
	return join(entryDir, 'metadata.json');
}

function payloadPathFor(entryDir: string): string {
	return join(entryDir, 'payload.part');
}

function leasePathFor(entryDir: string): string {
	return join(entryDir, 'lease.json');
}

export function transportCacheEntryDir(expectedSha256: string): string {
	return join(selfUpdateCacheDir(), expectedSha256.toLowerCase());
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error && typeof error === 'object' && 'code' in error ? (error as {code?: string}).code : undefined;
		// Windows 上无权探测时视为可能存活，避免误抢锁；ESRCH 才是明确不存在。
		return code !== 'ESRCH';
	}
}

function readJsonFile(filePath: string): unknown | null {
	try {
		if (!existsSync(filePath)) return null;
		return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function parseMetadata(value: unknown): TransportCacheMetadata | null {
	if (!isRecord(value)) return null;
	if (value.schema !== SELF_UPDATE_CACHE_SCHEMA) return null;
	if (typeof value.version !== 'string' || !value.version) return null;
	if (typeof value.platform !== 'string' || !value.platform) return null;
	if (typeof value.assetName !== 'string' || !value.assetName) return null;
	if (value.encoding !== 'gzip' && value.encoding !== 'identity') return null;
	if (!Number.isSafeInteger(value.expectedSize) || Number(value.expectedSize) <= 0) return null;
	if (!isSha256(value.expectedSha256) || !isSha256(value.targetSha256)) return null;
	return value as TransportCacheMetadata;
}

function parseLease(value: unknown): TransportCacheLease | null {
	if (!isRecord(value)) return null;
	if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return null;
	if (typeof value.heartbeatAt !== 'number' || !Number.isFinite(value.heartbeatAt) || value.heartbeatAt < 0) return null;
	return value as TransportCacheLease;
}

function readLease(leasePath: string): TransportCacheLease | null {
	return parseLease(readJsonFile(leasePath));
}

function writeJsonAtomic(filePath: string, value: unknown): void {
	atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function removeTransportCacheEntry(expectedSha256: string): void {
	const entryDir = transportCacheEntryDir(expectedSha256);
	try {
		rmSync(entryDir, {recursive: true, force: true});
	} catch {
		// 主操作已携带结构化错误；清理 best-effort。
	}
}

function metadataMatches(value: unknown, identity: TransportCacheIdentity): boolean {
	const meta = parseMetadata(value);
	if (!meta) return false;
	return (
		meta.schema === SELF_UPDATE_CACHE_SCHEMA &&
		meta.version === identity.version &&
		meta.platform === identity.platform &&
		meta.assetName === identity.assetName &&
		meta.encoding === identity.encoding &&
		meta.expectedSize === identity.expectedSize &&
		meta.expectedSha256.toLowerCase() === identity.expectedSha256.toLowerCase() &&
		meta.targetSha256.toLowerCase() === identity.targetSha256.toLowerCase()
	);
}

function rehashPayload(payloadPath: string, expectedSize: number): {offset: number; hash: Hash} | null {
	if (!existsSync(payloadPath)) {
		return {offset: 0, hash: createHash('sha256')};
	}
	const stat = statSync(payloadPath);
	if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > expectedSize) {
		return null;
	}
	const hash = createHash('sha256');
	const fd = openSync(payloadPath, 'r');
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		let remaining = stat.size;
		while (remaining > 0) {
			const count = Math.min(buffer.byteLength, remaining);
			const read = readSync(fd, buffer, 0, count, null);
			if (read <= 0) return null;
			hash.update(buffer.subarray(0, read));
			remaining -= read;
		}
	} finally {
		closeSync(fd);
	}
	return {offset: stat.size, hash};
}

function tryAcquireLease(leasePath: string, now: number): boolean {
	if (existsSync(leasePath)) {
		const existing = readLease(leasePath);
		if (existing) {
			const stale = now - existing.heartbeatAt >= SELF_UPDATE_LEASE_STALE_MS;
			// 只有“心跳停滞且 owner 已退出”才能回收。活进程即使长时间
			// 卡在 fetch/解压中也仍拥有 lease，避免两个 writer 交叉追加。
			if (!stale || isProcessAlive(existing.pid)) return false;
		} else {
			// 损坏 lease 也要给仍可能在创建它的进程一个停滞窗口。
			try {
				if (now - statSync(leasePath).mtimeMs < SELF_UPDATE_LEASE_STALE_MS) return false;
			} catch {
				return false;
			}
		}
		try {
			rmSync(leasePath, {force: true});
		} catch {
			return false;
		}
	}
	try {
		const fd = openSync(leasePath, 'wx');
		try {
			writeSync(fd, `${JSON.stringify({pid: process.pid, heartbeatAt: now}, null, 2)}\n`);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch {
		return false;
	}
}

export function heartbeatTransportLease(leasePath: string): void {
	const lease = readLease(leasePath);
	if (!lease || lease.pid !== process.pid) {
		throw new Error('更新缓存 lease 已丢失');
	}
	writeJsonAtomic(leasePath, {pid: process.pid, heartbeatAt: Date.now()} satisfies TransportCacheLease);
}

export function releaseTransportLease(leasePath: string): void {
	try {
		const lease = readLease(leasePath);
		if (lease && lease.pid === process.pid) {
			rmSync(leasePath, {force: true});
		}
	} catch {
		// best-effort
	}
}

/**
 * 打开（或创建）与当前 transport 身份绑定的缓存条目，并取得排他 lease。
 * 合法分片会 rehash 后返回 offset；损坏/不匹配条目会删除后从 0 开始。
 */
export function openTransportCache(identity: TransportCacheIdentity): OpenTransportCacheResult {
	let acquiredLeasePath: string | null = null;
	try {
		mkdirSync(selfUpdateCacheDir(), {recursive: true, mode: 0o700});
		const entryDir = transportCacheEntryDir(identity.expectedSha256);
		mkdirSync(entryDir, {recursive: true, mode: 0o700});
		const metadataPath = metadataPathFor(entryDir);
		const payloadPath = payloadPathFor(entryDir);
		const leasePath = leasePathFor(entryDir);
		const now = Date.now();
		if (!tryAcquireLease(leasePath, now)) {
			return {ok: false, reason: 'busy', message: '另一个 ccq 进程正在写入同一更新分片'};
		}
		acquiredLeasePath = leasePath;

		const meta = readJsonFile(metadataPath);
		if (!metadataMatches(meta, identity)) {
			try {
				rmSync(payloadPath, {force: true});
			} catch {}
			writeJsonAtomic(metadataPath, {
				schema: SELF_UPDATE_CACHE_SCHEMA,
				...identity,
				expectedSha256: identity.expectedSha256.toLowerCase(),
				targetSha256: identity.targetSha256.toLowerCase()
			} satisfies TransportCacheMetadata);
			return {
				ok: true,
				entryDir,
				payloadPath,
				metadataPath,
				leasePath,
				offset: 0,
				hash: createHash('sha256')
			};
		}

		const rehashed = rehashPayload(payloadPath, identity.expectedSize);
		if (!rehashed) {
			try {
				rmSync(payloadPath, {force: true});
			} catch {}
			return {
				ok: true,
				entryDir,
				payloadPath,
				metadataPath,
				leasePath,
				offset: 0,
				hash: createHash('sha256')
			};
		}
		// 触碰 mtime，供 TTL 清理判断“最近使用”。
		try {
			const nowSec = Date.now() / 1000;
			utimesSync(entryDir, nowSec, nowSec);
		} catch {}
		return {
			ok: true,
			entryDir,
			payloadPath,
			metadataPath,
			leasePath,
			offset: rehashed.offset,
			hash: rehashed.hash
		};
	} catch (error) {
		if (acquiredLeasePath) releaseTransportLease(acquiredLeasePath);
		return {
			ok: false,
			reason: 'error',
			message: error instanceof Error ? error.message : String(error)
		};
	}
}

/**
 * 清理非当前 digest、损坏条目与超过 7 天的闲置缓存。
 * `keepDigests` 非空时，不在集合内的条目一律删除（新 Release 清理）。
 */
export function cleanupTransportCache(options: {readonly keepDigests?: ReadonlySet<string>; readonly now?: number} = {}): void {
	const root = selfUpdateCacheDir();
	if (!existsSync(root)) return;
	const now = options.now ?? Date.now();
	const keep = options.keepDigests;
	let entries: string[] = [];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const name of entries) {
		const entryDir = join(root, name);
		try {
			const st = statSync(entryDir);
			if (!st.isDirectory()) {
				rmSync(entryDir, {force: true, recursive: true});
				continue;
			}
			const digest = name.toLowerCase();
			const meta = parseMetadata(readJsonFile(metadataPathFor(entryDir)));
			const payload = payloadPathFor(entryDir);
			const leasePath = leasePathFor(entryDir);
			const lease = readLease(leasePath);
			if (existsSync(leasePath)) {
				const leaseFresh = lease
					? now - lease.heartbeatAt < SELF_UPDATE_LEASE_STALE_MS
					: now - statSync(leasePath).mtimeMs < SELF_UPDATE_LEASE_STALE_MS;
				const ownerAlive = lease ? isProcessAlive(lease.pid) : false;
				if (leaseFresh || ownerAlive) {
					// 活跃 writer 优先于 new-release/TTL 清理；它释放后下次 cleanup 再收口。
					continue;
				}
				rmSync(leasePath, {force: true});
			}
			const malformed =
				!meta ||
				meta.expectedSha256.toLowerCase() !== digest ||
				(existsSync(payload) && statSync(payload).size > meta.expectedSize);

			const age = now - st.mtimeMs;
			const belongsToCurrentRelease = !keep || keep.has(digest);
			if (malformed || !belongsToCurrentRelease || age > SELF_UPDATE_CACHE_TTL_MS) {
				rmSync(entryDir, {recursive: true, force: true});
			}
		} catch {
			try {
				rmSync(entryDir, {recursive: true, force: true});
			} catch {}
		}
	}
}
