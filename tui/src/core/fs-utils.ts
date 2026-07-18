import {chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, statSync, openSync, writeSync, closeSync} from 'node:fs';
import {dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const PROFILE_LOCK_FILE = join(tmpdir(), '.ccq-profile.lock');
const PROFILE_LOCK_TIMEOUT_MS = 30000;
const PROFILE_LOCK_EXPIRE_MS = 300000;

export const SECRET_FILE_MODE = 0o600;

export type AtomicWriteOptions = {
	readonly mode?: number;
};

export type JsonFileReadResult<T> =
	| {readonly status: 'missing'}
	| {readonly status: 'valid'; readonly value: T}
	| {readonly status: 'invalid'; readonly error: string};

/**
 * 原子写入文件（临时文件 + rename）。
 * 用 writeFileSync 写临时文件——它会同步关闭文件句柄，避免 Windows 下
 * 未关闭句柄导致 renameSync 报 EPERM（对齐旧 manage.js atomicWrite 行为）。
 */
export function atomicWrite(filePath: string, content: string, options: AtomicWriteOptions = {}): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, {recursive: true});
	}
	let effectiveMode = options.mode;
	if (effectiveMode === undefined && process.platform !== 'win32' && existsSync(filePath)) {
		try {
			effectiveMode = statSync(filePath).mode & 0o777;
		} catch {
			/* mode 读取失败时保持历史默认权限语义 */
		}
	}

	const tempPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;
	try {
		writeFileSync(tempPath, content, {encoding: 'utf8', mode: effectiveMode});
		renameSync(tempPath, filePath);
		if (effectiveMode !== undefined && process.platform !== 'win32') {
			chmodSync(filePath, effectiveMode);
		}
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {}

		throw error;
	}
}

/**
 * Profile 级别文件锁（防止并发修改）
 */
export function withProfileLock<T>(action: () => T): T {
	const start = Date.now();

	// 自旋等待锁
	while (true) {
		try {
			const fd = openSync(PROFILE_LOCK_FILE, 'wx');
			writeSync(fd, `${process.pid}\n${Date.now()}\n`);
			closeSync(fd);
			break;
		} catch {
			if (Date.now() - start > PROFILE_LOCK_TIMEOUT_MS) {
				throw new Error('无法获取 Profile 锁（30s 超时），可能有其他 CCQ 进程正在修改 Profile');
			}

			// 检查锁是否过期（超过 5 分钟）
			try {
				const stat = statSync(PROFILE_LOCK_FILE);
				if (Date.now() - stat.mtimeMs > PROFILE_LOCK_EXPIRE_MS) {
					unlinkSync(PROFILE_LOCK_FILE);
				}
			} catch {}

			// 自旋等待 100ms
			const sleepEnd = Date.now() + 100;
			while (Date.now() < sleepEnd) {
				/* busy wait */
			}
		}
	}

	// 执行操作并释放锁
	try {
		return action();
	} finally {
		try {
			unlinkSync(PROFILE_LOCK_FILE);
		} catch {}
	}
}

/**
 * 安全读取 JSON 文件
 */
export function readJsonFile<T = unknown>(filePath: string, fallback: T): T {
	try {
		if (!existsSync(filePath)) {
			return fallback;
		}

		const raw = readFileSync(filePath, 'utf8');
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/**
 * 严格读取 JSON：区分文件不存在与已存在但无法读取/解析。
 * 仅供“读取后会写回同一文件”的变更路径使用；错误不包含原始文件内容。
 */
export function readJsonFileStrict<T = unknown>(filePath: string): JsonFileReadResult<T> {
	if (!existsSync(filePath)) {
		return {status: 'missing'};
	}

	let raw: string;
	try {
		raw = readFileSync(filePath, 'utf8');
	} catch {
		return {status: 'invalid', error: '文件无法读取'};
	}

	try {
		return {status: 'valid', value: JSON.parse(raw) as T};
	} catch {
		return {status: 'invalid', error: 'JSON 无法解析'};
	}
}

/**
 * 原子写入 JSON 文件（2 空格缩进）
 */
export function writeJsonAtomic(filePath: string, obj: unknown, options: AtomicWriteOptions = {}): void {
	atomicWrite(filePath, JSON.stringify(obj, null, 2), options);
}
