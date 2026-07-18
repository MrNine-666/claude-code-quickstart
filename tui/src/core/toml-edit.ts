import {parse as parseToml, stringify as stringifyToml} from 'smol-toml';
import {atomicWrite as writeTextAtomic, type AtomicWriteOptions} from './fs-utils.js';

export type TomlPath = readonly string[];
export type TomlDocument = Record<string, unknown>;

const SECRET_FIELD_PATTERN = /(?:token|api[_-]?key|secret|password|bearer|credential)/i;
const SECRET_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{24,})\b/g;
const REDACTED = '[REDACTED]';

export class TomlEditError extends Error {
	constructor(message: string, readonly originalCause?: unknown) {
		super(message);
		this.name = 'TomlEditError';
	}
}

function assertPath(path: TomlPath): void {
	if (path.length === 0) {
		throw new TomlEditError('TOML path 不能为空');
	}

	for (const segment of path) {
		if (!segment || segment.includes('\0')) {
			throw new TomlEditError(`非法 TOML path segment: ${formatTomlError(segment)}`);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneTomlDocument(document: TomlDocument): TomlDocument {
	return structuredClone(document) as TomlDocument;
}

export function formatTomlError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(SECRET_VALUE_PATTERN, REDACTED).replace(/(experimental_bearer_token\s*=\s*)[^\s,}\]]+/gi, `$1${REDACTED}`);
}

export function redactTomlSecrets(value: string): string {
	return value
		.split(/\r?\n/)
		.map((line) => {
			const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1] ?? '';
			if (SECRET_FIELD_PATTERN.test(key)) {
				return line.replace(/=.*/, `= "${REDACTED}"`);
			}

			return line.replace(SECRET_VALUE_PATTERN, REDACTED);
		})
		.join('\n');
}

export function parse(content: string): TomlDocument {
	try {
		const parsed = parseToml(content);
		if (!isRecord(parsed)) {
			throw new TomlEditError('TOML 根节点必须是 table');
		}

		return parsed as TomlDocument;
	} catch (error) {
		if (error instanceof TomlEditError) {
			throw error;
		}

		throw new TomlEditError(`TOML 解析失败: ${formatTomlError(error)}`, error);
	}
}

export function stringify(document: TomlDocument): string {
	try {
		return stringifyToml(document);
	} catch (error) {
		throw new TomlEditError(`TOML 序列化失败: ${formatTomlError(error)}`, error);
	}
}

export function getPath(document: TomlDocument, path: TomlPath): unknown {
	assertPath(path);
	let current: unknown = document;
	for (const segment of path) {
		if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
			return undefined;
		}

		current = current[segment];
	}

	return current;
}

export function setPath(document: TomlDocument, path: TomlPath, value: unknown): TomlDocument {
	assertPath(path);
	const next = cloneTomlDocument(document);
	let current: Record<string, unknown> = next;

	for (const segment of path.slice(0, -1)) {
		const child = current[segment];
		if (child === undefined) {
			current[segment] = {};
		} else if (!isRecord(child)) {
			throw new TomlEditError(`无法在非 table 节点下写入 TOML path: ${path.join('.')}`);
		}

		current = current[segment] as Record<string, unknown>;
	}

	current[path[path.length - 1]!] = value;
	return next;
}

export function deletePath(document: TomlDocument, path: TomlPath): TomlDocument {
	assertPath(path);
	const next = cloneTomlDocument(document);
	let current: unknown = next;

	for (const segment of path.slice(0, -1)) {
		if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
			return next;
		}

		current = current[segment];
	}

	if (isRecord(current)) {
		delete current[path[path.length - 1]!];
	}

	return next;
}

export function atomicWrite(filePath: string, document: TomlDocument, options: AtomicWriteOptions = {}): void {
	writeTextAtomic(filePath, stringify(document), options);
}
