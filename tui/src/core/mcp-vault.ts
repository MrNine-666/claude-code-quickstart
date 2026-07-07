import {existsSync, readFileSync, copyFileSync, readdirSync, unlinkSync, openSync, writeSync, closeSync, statSync} from 'node:fs';
import {dirname, basename, join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {writeJsonAtomic} from './fs-utils.js';
import {vaultPath} from './paths.js';
import type {McpServerDefinition} from './mcp-contract.js';

export const MCP_META_SCHEMA_VERSION = 1;
const MCP_MAX_CORRUPT_BACKUPS = 5;
const MCP_LOCK_TIMEOUT_MS = 30000;
const MCP_LOCK_EXPIRE_MS = 300000;
const LOCK_FILE = join(tmpdir(), '.ccq-mcp-vault.lock');

// definitionHash 排除字段（非运行时元数据）。
const EXCLUDE_KEYS = ['Description', 'Category', 'Priority', 'Recommended', 'Name', 'RuntimeDeps'];

export type McpVaultServerEntry = {
	disabled?: boolean;
	credentials?: {values?: Record<string, string>} | Record<string, string>;
	config?: Record<string, unknown>;
	permissions?: string[];
	definitionHash?: string;
	updatedAt?: string;
};

export type McpVault = {
	schemaVersion: number;
	createdAt: string;
	updatedAt: string;
	servers: Record<string, McpVaultServerEntry>;
	_readOnly?: boolean;
};

export function newEmptyVault(): McpVault {
	const now = new Date().toISOString();
	return {schemaVersion: MCP_META_SCHEMA_VERSION, createdAt: now, updatedAt: now, servers: {}};
}

/** MCP vault 文件锁（30s 超时 + 过期清理），与旧 mcp-manager.js withLock 等价。 */
export function withVaultLock<T>(action: () => T): T {
	const start = Date.now();

	while (true) {
		try {
			const fd = openSync(LOCK_FILE, 'wx');
			writeSync(fd, `${process.pid}\n${Date.now()}\n`);
			closeSync(fd);
			break;
		} catch {
			if (Date.now() - start > MCP_LOCK_TIMEOUT_MS) {
				throw new Error('无法获取 MCP 锁（30s 超时），可能有其他 CCQ 进程正在运行');
			}

			try {
				const stat = statSync(LOCK_FILE);
				if (Date.now() - stat.mtimeMs > MCP_LOCK_EXPIRE_MS) {
					unlinkSync(LOCK_FILE);
				}
			} catch {}

			const waitUntil = Date.now() + 50;
			while (Date.now() < waitUntil) {
				/* busy wait */
			}
		}
	}

	try {
		return action();
	} finally {
		try {
			unlinkSync(LOCK_FILE);
		} catch {}
	}
}

function handleCorruptVault(filePath: string): McpVault {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
	const backupPath = `${filePath}.corrupt.${timestamp}`;

	try {
		copyFileSync(filePath, backupPath);
	} catch {}

	try {
		const dir = dirname(filePath);
		const baseName = basename(filePath);
		const files = readdirSync(dir)
			.filter(f => f.startsWith(`${baseName}.corrupt.`))
			.sort()
			.reverse();
		for (let i = MCP_MAX_CORRUPT_BACKUPS; i < files.length; i++) {
			unlinkSync(join(dir, files[i]!));
		}
	} catch {}

	return newEmptyVault();
}

/** 读取 vault（lazy create + schema 校验 + 腐败恢复）。 */
export function loadVault(): McpVault {
	const filePath = vaultPath();
	if (!existsSync(filePath)) {
		return newEmptyVault();
	}

	try {
		const meta = JSON.parse(readFileSync(filePath, 'utf8')) as McpVault;
		if (!meta || typeof meta.schemaVersion !== 'number' || meta.schemaVersion < 1) {
			return handleCorruptVault(filePath);
		}

		if (!meta.servers || typeof meta.servers !== 'object') {
			return handleCorruptVault(filePath);
		}

		if (meta.schemaVersion > MCP_META_SCHEMA_VERSION) {
			meta._readOnly = true;
		}

		return meta;
	} catch {
		return handleCorruptVault(filePath);
	}
}

/** 写入 vault（高版本拒写 + 清理内部标记 + updatedAt 维护）。 */
export function saveVault(meta: McpVault): void {
	if (meta.schemaVersion > MCP_META_SCHEMA_VERSION) {
		throw new Error(`schema version too high: ${meta.schemaVersion} > ${MCP_META_SCHEMA_VERSION}`);
	}

	if (meta._readOnly) {
		throw new Error('vault is read-only (newer schema version)');
	}

	meta.updatedAt = new Date().toISOString();
	for (const serverId of Object.keys(meta.servers ?? {})) {
		const server = meta.servers[serverId];
		if (server) {
			delete server.disabled;
		}

		if (server?.updatedAt && server.updatedAt > meta.updatedAt) {
			meta.updatedAt = server.updatedAt;
		}
	}

	const cleanMeta: Record<string, unknown> = {};
	for (const key of Object.keys(meta)) {
		if (!key.startsWith('_')) {
			cleanMeta[key] = (meta as Record<string, unknown>)[key];
		}
	}

	writeJsonAtomic(vaultPath(), cleanMeta);
}

function canonicalizeObject(obj: unknown): unknown {
	if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
			sorted[key] = canonicalizeObject((obj as Record<string, unknown>)[key]);
		}

		return sorted;
	}

	if (Array.isArray(obj)) {
		return obj.map(canonicalizeObject);
	}

	return obj;
}

/** 计算 MCP Server 定义哈希（SHA-256 前 8 位，排除非运行时字段）。 */
export function definitionHash(serverDef: McpServerDefinition): string {
	const runtimeFields: Record<string, unknown> = {};
	for (const key of Object.keys(serverDef)) {
		if (!EXCLUDE_KEYS.includes(key)) {
			runtimeFields[key] = (serverDef as Record<string, unknown>)[key];
		}
	}

	const json = JSON.stringify(canonicalizeObject(runtimeFields));
	return createHash('sha256').update(json, 'utf8').digest('hex').substring(0, 8);
}
