import {createCipheriv, createDecipheriv, randomBytes, scrypt} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';

import {atomicWrite, SECRET_FILE_MODE} from './fs-utils.js';

// 配置导入导出包（`.ccq-backup`）的格式、加密、校验和原子写边界。
// 本模块只拥有包 schema、limits、crypto、portable tree 校验与 category registry；
// 各领域（Provider/Config/MCP/Skills/Extensions）仍由原 owner 解析与合并。

export const CONFIG_BUNDLE_FORMAT = 'ccq-config-bundle';
export const CONFIG_BUNDLE_VERSION = 1;
export const CONFIG_BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
export const CONFIG_BUNDLE_MAX_TREE_ENTRIES = 10_000;
export const CONFIG_BUNDLE_EXTENSION = '.ccq-backup';

/** 导出目标归一化：系统另存为对话框返回的路径缺少 `.ccq-backup` 后缀时补上，保证导入对话框能筛到。 */
export function ensureBundleExtension(filePath: string): string {
	const trimmed = filePath.trim();
	return trimmed.toLowerCase().endsWith(CONFIG_BUNDLE_EXTENSION) ? trimmed : `${trimmed}${CONFIG_BUNDLE_EXTENSION}`;
}
/** 认证失败、篡改与损坏密文共用的用户可见文案，不暴露内部差异。 */
export const CONFIG_BUNDLE_PASSWORD_ERROR = '密码错误或导出包已损坏';

const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const CATEGORY_KEY_SEPARATOR = '\u0000';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/;

export type TransferErrorKind = 'validation' | 'password' | 'conflict' | 'io' | 'rollback' | 'cancelled';

export type TransferResult<T> =
	| {readonly ok: true; readonly data: T; readonly warnings: readonly string[]}
	| {readonly ok: false; readonly kind: TransferErrorKind; readonly error: string};

function ok<T>(data: T, warnings: readonly string[] = []): TransferResult<T> {
	return {ok: true, data, warnings};
}

function fail(kind: TransferErrorKind, error: string): TransferResult<never> {
	return {ok: false, kind, error};
}

/** 供领域 owner 构造 TransferResult 的最小 seam（与内部 helper 同一形态）。 */
export function transferOk<T>(data: T, warnings: readonly string[] = []): TransferResult<T> {
	return ok(data, warnings);
}

export function transferFail(kind: TransferErrorKind, error: string): TransferResult<never> {
	return fail(kind, error);
}

/**
 * 分类级 merge 报告：只含条目 identity 与计数事实，绝不携带凭据值或绝对路径，
 * 供导入预览、结果与回滚诊断共用。
 */
export type TransferImportMode = 'merge' | 'replace';

export type SectionMergeReport = {
	/** 包外受管条目；旧 merge owner 省略时等价于零删除。 */
	readonly removed?: readonly string[];
	readonly added: readonly string[];
	readonly replaced: readonly string[];
	readonly unchanged: readonly string[];
	readonly skipped: readonly string[];
	readonly warnings: readonly string[];
};

// ---------------------------------------------------------------------------
// Category registry（Phase 1 只提供稳定 identity 与执行顺序，不含领域逻辑）
// ---------------------------------------------------------------------------

export const TRANSFER_TOOLS = ['ccq', 'cc', 'cx', 'pi'] as const;
export type TransferTool = (typeof TRANSFER_TOOLS)[number];

export type TransferCategoryPhase = 'ccq-library' | 'providers' | 'settings' | 'rules' | 'mcp' | 'skills' | 'extensions';

export type TransferCategoryDefinition = {
	readonly tool: TransferTool;
	readonly category: string;
	readonly label: string;
	readonly phase: TransferCategoryPhase;
};

export type TransferCategoryIdentity = {
	readonly tool: TransferTool;
	readonly category: string;
};

export const TRANSFER_CATEGORY_REGISTRY: readonly TransferCategoryDefinition[] = [
	{tool: 'ccq', category: 'mcp-library', label: 'MCP 共享库', phase: 'ccq-library'},
	{tool: 'ccq', category: 'system-settings', label: '系统设置', phase: 'settings'},
	{tool: 'cc', category: 'providers', label: '供应商', phase: 'providers'},
	{tool: 'cx', category: 'providers', label: '供应商', phase: 'providers'},
	{tool: 'pi', category: 'providers', label: '供应商与模型', phase: 'providers'},
	{tool: 'cc', category: 'settings', label: '通用设置', phase: 'settings'},
	{tool: 'cx', category: 'settings', label: '通用设置', phase: 'settings'},
	{tool: 'pi', category: 'settings', label: '通用设置', phase: 'settings'},
	{tool: 'cc', category: 'rules', label: '全局规则', phase: 'rules'},
	{tool: 'cx', category: 'rules', label: '全局规则', phase: 'rules'},
	{tool: 'pi', category: 'rules', label: '全局规则', phase: 'rules'},
	{tool: 'cc', category: 'mcp', label: 'MCP', phase: 'mcp'},
	{tool: 'cx', category: 'mcp', label: 'MCP', phase: 'mcp'},
	{tool: 'pi', category: 'mcp', label: 'MCP', phase: 'mcp'},
	{tool: 'cc', category: 'skills', label: 'Skills', phase: 'skills'},
	{tool: 'cx', category: 'skills', label: 'Skills', phase: 'skills'},
	{tool: 'pi', category: 'skills', label: 'Skills', phase: 'skills'},
	{tool: 'pi', category: 'extensions', label: 'Extensions', phase: 'extensions'}
];

/** 稳定导入执行顺序：CCQ definition -> CCQ settings -> Providers -> Settings -> Rules -> MCP -> Skills -> Pi Extensions。 */
export const TRANSFER_EXECUTION_ORDER: readonly TransferCategoryIdentity[] = TRANSFER_CATEGORY_REGISTRY.map(definition => ({
	tool: definition.tool,
	category: definition.category
}));

const CATEGORY_KEYS = new Set(TRANSFER_CATEGORY_REGISTRY.map(definition => categoryKey(definition.tool, definition.category)));

function categoryKey(tool: string, category: string): string {
	return `${tool}${CATEGORY_KEY_SEPARATOR}${category}`;
}

export function isTransferTool(value: unknown): value is TransferTool {
	return typeof value === 'string' && (TRANSFER_TOOLS as readonly string[]).includes(value);
}

export function isTransferCategory(tool: unknown, category: unknown): category is string {
	return typeof tool === 'string' && typeof category === 'string' && CATEGORY_KEYS.has(categoryKey(tool, category));
}

export function transferCategoryDefinition(tool: TransferTool, category: string): TransferCategoryDefinition | undefined {
	return TRANSFER_CATEGORY_REGISTRY.find(definition => definition.tool === tool && definition.category === category);
}

// ---------------------------------------------------------------------------
// Bundle envelope / payload
// ---------------------------------------------------------------------------

export type BundleCreator = {
	readonly name: 'ccq';
	readonly version: string;
	readonly platform: string;
};

export type BundleSection = {
	readonly tool: TransferTool;
	readonly category: string;
	readonly data: unknown;
};

export type BundlePayload = {
	readonly createdAt: string;
	readonly createdBy: BundleCreator;
	readonly containsCredentials: boolean;
	readonly sections: readonly BundleSection[];
};

export type BundleEncryption = {
	readonly algorithm: 'aes-256-gcm';
	readonly kdf: 'scrypt';
	readonly salt: string;
	readonly iv: string;
	readonly tag: string;
};

export type PlainBundleEnvelope = {
	readonly format: typeof CONFIG_BUNDLE_FORMAT;
	readonly version: typeof CONFIG_BUNDLE_VERSION;
	readonly encryption: null;
	readonly payload: BundlePayload;
};

export type EncryptedBundleEnvelope = {
	readonly format: typeof CONFIG_BUNDLE_FORMAT;
	readonly version: typeof CONFIG_BUNDLE_VERSION;
	readonly encryption: BundleEncryption;
	readonly payload: string;
};

export type BundleEnvelope = PlainBundleEnvelope | EncryptedBundleEnvelope;

export type CreateBundlePayloadInput = {
	readonly sections: readonly BundleSection[];
	readonly containsCredentials: boolean;
	readonly version: string;
	readonly platform: string;
	readonly createdAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBase64String(value: unknown): value is string {
	return typeof value === 'string' && BASE64_PATTERN.test(value);
}

function decodeBase64Exact(value: string, expectedBytes: number | undefined): Buffer | undefined {
	if (!isBase64String(value)) {
		return undefined;
	}

	const decoded = Buffer.from(value, 'base64');
	if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
		return undefined;
	}

	return decoded;
}

export function createBundlePayload(input: CreateBundlePayloadInput): TransferResult<BundlePayload> {
	return parseBundlePayload({
		createdAt: input.createdAt ?? new Date().toISOString(),
		createdBy: {name: 'ccq', version: input.version, platform: input.platform},
		containsCredentials: input.containsCredentials,
		sections: input.sections
	});
}

export function parseBundlePayload(input: unknown): TransferResult<BundlePayload> {
	if (!isRecord(input)) {
		return fail('validation', '导出包内容无效');
	}

	if (typeof input.createdAt !== 'string' || input.createdAt === '') {
		return fail('validation', '导出包缺少创建时间');
	}

	const createdBy = input.createdBy;
	if (
		!isRecord(createdBy) ||
		createdBy.name !== 'ccq' ||
		typeof createdBy.version !== 'string' ||
		createdBy.version === '' ||
		typeof createdBy.platform !== 'string' ||
		createdBy.platform === ''
	) {
		return fail('validation', '导出包创建者信息无效');
	}

	if (typeof input.containsCredentials !== 'boolean') {
		return fail('validation', '导出包缺少凭据标记');
	}

	if (!Array.isArray(input.sections)) {
		return fail('validation', '导出包缺少配置分类');
	}

	const sections: BundleSection[] = [];
	const seen = new Set<string>();
	for (const raw of input.sections) {
		if (!isRecord(raw) || !isTransferTool(raw.tool) || !isTransferCategory(raw.tool, raw.category)) {
			return fail('validation', '导出包包含未知的工具或配置分类');
		}

		if (!Object.hasOwn(raw, 'data')) {
			return fail('validation', '导出包配置分类缺少内容');
		}

		const key = categoryKey(raw.tool, raw.category);
		if (seen.has(key)) {
			return fail('validation', '导出包包含重复的配置分类');
		}

		seen.add(key);
		sections.push({tool: raw.tool, category: raw.category, data: raw.data});
	}

	return ok({
		createdAt: input.createdAt,
		createdBy: {name: 'ccq', version: createdBy.version, platform: createdBy.platform},
		containsCredentials: input.containsCredentials,
		sections
	});
}

function parseBundleEncryption(input: unknown): TransferResult<BundleEncryption> {
	if (!isRecord(input)) {
		return fail('validation', '导出包加密参数无效');
	}

	if (input.algorithm !== 'aes-256-gcm' || input.kdf !== 'scrypt') {
		return fail('validation', '导出包使用了不支持的加密算法');
	}

	const salt = typeof input.salt === 'string' ? decodeBase64Exact(input.salt, SCRYPT_SALT_BYTES) : undefined;
	const iv = typeof input.iv === 'string' ? decodeBase64Exact(input.iv, GCM_IV_BYTES) : undefined;
	const tag = typeof input.tag === 'string' ? decodeBase64Exact(input.tag, GCM_TAG_BYTES) : undefined;
	if (!salt || !iv || !tag) {
		return fail('validation', '导出包加密参数无效');
	}

	return ok({
		algorithm: 'aes-256-gcm',
		kdf: 'scrypt',
		salt: salt.toString('base64'),
		iv: iv.toString('base64'),
		tag: tag.toString('base64')
	});
}

export function parseBundleEnvelope(input: unknown): TransferResult<BundleEnvelope> {
	if (!isRecord(input) || input.format !== CONFIG_BUNDLE_FORMAT) {
		return fail('validation', '不是 CCQ 配置导出包');
	}

	if (typeof input.version !== 'number') {
		return fail('validation', '导出包版本无效');
	}

	if (input.version !== CONFIG_BUNDLE_VERSION) {
		return fail('validation', `不支持的导出包版本：${input.version}`);
	}

	if (input.encryption === null) {
		const payload = parseBundlePayload(input.payload);
		if (!payload.ok) {
			return payload;
		}

		// 明文含文件型凭据是用户的显式选择；文件权限仍为 0600。OAuth 始终由领域 owner 排除。
		return ok({format: CONFIG_BUNDLE_FORMAT, version: CONFIG_BUNDLE_VERSION, encryption: null, payload: payload.data});
	}

	const encryption = parseBundleEncryption(input.encryption);
	if (!encryption.ok) {
		return encryption;
	}

	// 密文只要求是字符串；base64 与长度校验全部留给 decrypt，使任何密文损坏都与密码错误共用同一文案。
	if (typeof input.payload !== 'string' || input.payload.length === 0) {
		return fail('validation', '加密导出包内容无效');
	}

	return ok({format: CONFIG_BUNDLE_FORMAT, version: CONFIG_BUNDLE_VERSION, encryption: encryption.data, payload: input.payload});
}

// ---------------------------------------------------------------------------
// Portable file tree
// ---------------------------------------------------------------------------

export const PORTABLE_TREE_ROOTS = ['ccq', 'claude', 'agents', 'codex', 'pi-agent'] as const;
export type PortableTreeRootId = (typeof PORTABLE_TREE_ROOTS)[number];

/** 允许出现在包中的受限权限集合，拒绝 setuid/setgid/world-writable。 */
export const PORTABLE_FILE_MODES: readonly number[] = [0o600, 0o644, 0o700, 0o755];

export type PortableTreeFileEntry = {
	readonly kind: 'file';
	readonly root: PortableTreeRootId;
	readonly path: string;
	readonly contentBase64: string;
	readonly mode: number;
};

export type PortableTreeSymlinkEntry = {
	readonly kind: 'symlink';
	readonly root: PortableTreeRootId;
	readonly path: string;
	readonly target: string;
};

export type PortableTreeEntry = PortableTreeFileEntry | PortableTreeSymlinkEntry;

/** 跨整个 bundle 共享的校验状态：累计条目数并检测重复的 root+path。 */
export type PortableTreeValidationState = {
	entryCount: number;
	readonly paths: Set<string>;
};

export function createPortableTreeValidationState(): PortableTreeValidationState {
	return {entryCount: 0, paths: new Set()};
}

function isPortableTreeRootId(value: unknown): value is PortableTreeRootId {
	return typeof value === 'string' && (PORTABLE_TREE_ROOTS as readonly string[]).includes(value);
}

/** 路径安全时返回 true；只接受规范化 POSIX 相对路径。 */
function isPortableRelativePath(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0) {
		return false;
	}

	if (value.includes('\u0000') || value.includes('\\')) {
		return false;
	}

	if (value.startsWith('/') || DRIVE_PREFIX_PATTERN.test(value)) {
		return false;
	}

	for (const segment of value.split('/')) {
		if (segment === '' || segment === '.' || segment === '..') {
			return false;
		}
	}

	return true;
}

/** 符号链接 target 必须是非空相对路径，且规范化后不逃出同一个导出 root。 */
function symlinkTargetStaysInRoot(entryPath: string, target: unknown): target is string {
	if (typeof target !== 'string' || target.length === 0 || target.includes('\u0000') || target.includes('\\')) {
		return false;
	}

	if (target.startsWith('/') || DRIVE_PREFIX_PATTERN.test(target)) {
		return false;
	}

	const resolved = entryPath.split('/').slice(0, -1);
	for (const segment of target.split('/')) {
		if (segment === '' || segment === '.') {
			return false;
		}

		if (segment === '..') {
			if (resolved.length === 0) {
				return false;
			}

			resolved.pop();
			continue;
		}

		resolved.push(segment);
	}

	return resolved.length > 0;
}

export function parsePortableTreeEntry(input: unknown): TransferResult<PortableTreeEntry> {
	if (!isRecord(input) || !isPortableTreeRootId(input.root)) {
		return fail('validation', '文件树条目无效');
	}

	if (!isPortableRelativePath(input.path)) {
		return fail('validation', '文件树路径不安全');
	}

	const entryPath = input.path;

	if (input.kind === 'file') {
		if (!isBase64String(input.contentBase64)) {
			return fail('validation', '文件树条目内容不是有效 base64');
		}

		if (typeof input.mode !== 'number' || !PORTABLE_FILE_MODES.includes(input.mode)) {
			return fail('validation', '文件树条目权限不受支持');
		}

		return ok({kind: 'file', root: input.root, path: entryPath, contentBase64: input.contentBase64, mode: input.mode});
	}

	if (input.kind === 'symlink') {
		if (!symlinkTargetStaysInRoot(entryPath, input.target)) {
			return fail('validation', '文件树符号链接目标不安全');
		}

		return ok({kind: 'symlink', root: input.root, path: entryPath, target: input.target});
	}

	return fail('validation', '文件树条目类型无效');
}

export function parsePortableTreeEntries(
	input: unknown,
	state: PortableTreeValidationState = createPortableTreeValidationState()
): TransferResult<readonly PortableTreeEntry[]> {
	if (!Array.isArray(input)) {
		return fail('validation', '文件树必须是数组');
	}

	const entries: PortableTreeEntry[] = [];
	for (const raw of input) {
		const parsed = parsePortableTreeEntry(raw);
		if (!parsed.ok) {
			return parsed;
		}

		state.entryCount += 1;
		if (state.entryCount > CONFIG_BUNDLE_MAX_TREE_ENTRIES) {
			return fail('validation', `文件树条目超过 ${CONFIG_BUNDLE_MAX_TREE_ENTRIES} 上限`);
		}

		const pathKey = categoryKey(parsed.data.root, parsed.data.path);
		if (state.paths.has(pathKey)) {
			return fail('validation', '文件树存在重复路径');
		}

		state.paths.add(pathKey);
		entries.push(parsed.data);
	}

	return ok(entries);
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, SCRYPT_KEY_BYTES, (error, derivedKey) => {
			if (error) {
				reject(error);
			} else {
				resolve(derivedKey as Buffer);
			}
		});
	});
}

function passwordFailure(): TransferResult<never> {
	return fail('password', CONFIG_BUNDLE_PASSWORD_ERROR);
}

export async function encryptBundlePayload(payload: BundlePayload, password: string): Promise<TransferResult<EncryptedBundleEnvelope>> {
	if (typeof password !== 'string' || password.length === 0) {
		return fail('validation', '加密导出必须设置密码');
	}

	const salt = randomBytes(SCRYPT_SALT_BYTES);
	const iv = randomBytes(GCM_IV_BYTES);
	let key: Buffer;
	try {
		key = await deriveKey(password, salt);
	} catch {
		return fail('io', '导出包加密失败');
	}

	let plaintext: Buffer | undefined;
	try {
		plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
		const cipher = createCipheriv('aes-256-gcm', key, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const tag = cipher.getAuthTag();
		return ok({
			format: CONFIG_BUNDLE_FORMAT,
			version: CONFIG_BUNDLE_VERSION,
			encryption: {
				algorithm: 'aes-256-gcm',
				kdf: 'scrypt',
				salt: salt.toString('base64'),
				iv: iv.toString('base64'),
				tag: tag.toString('base64')
			},
			payload: ciphertext.toString('base64')
		});
	} catch {
		return fail('io', '导出包加密失败');
	} finally {
		// 尽力清零派生密钥与明文缓冲；JS 字符串与 cipher 内部状态无法零化。
		key.fill(0);
		plaintext?.fill(0);
	}
}

export async function decryptBundlePayload(envelope: BundleEnvelope, password?: string): Promise<TransferResult<BundlePayload>> {
	if (envelope.encryption === null) {
		return parseBundlePayload(envelope.payload);
	}

	if (typeof password !== 'string' || password.length === 0) {
		return fail('password', '此导出包已加密，需要输入密码');
	}

	const salt = decodeBase64Exact(envelope.encryption.salt, SCRYPT_SALT_BYTES);
	const iv = decodeBase64Exact(envelope.encryption.iv, GCM_IV_BYTES);
	const tag = decodeBase64Exact(envelope.encryption.tag, GCM_TAG_BYTES);
	const ciphertext = decodeBase64Exact(envelope.payload, undefined);
	if (!salt || !iv || !tag || !ciphertext) {
		return passwordFailure();
	}

	let key: Buffer;
	try {
		key = await deriveKey(password, salt);
	} catch {
		return passwordFailure();
	}

	try {
		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		try {
			let parsed: unknown;
			try {
				parsed = JSON.parse(plaintext.toString('utf8'));
			} catch {
				// 认证已通过但 payload JSON 损坏：与密码错误共用同一文案，不泄漏内部状态。
				return passwordFailure();
			}

			return parseBundlePayload(parsed);
		} finally {
			plaintext.fill(0);
		}
	} catch {
		return passwordFailure();
	} finally {
		key.fill(0);
	}
}

// ---------------------------------------------------------------------------
// Serialization and atomic write
// ---------------------------------------------------------------------------

export function serializeConfigBundle(envelope: BundleEnvelope): TransferResult<string> {
	let text: string;
	try {
		text = JSON.stringify(envelope, null, 2);
	} catch {
		return fail('validation', '导出包内容无法序列化');
	}

	if (Buffer.byteLength(text, 'utf8') > CONFIG_BUNDLE_MAX_BYTES) {
		return fail('validation', '导出包超过 64 MiB 上限');
	}

	return ok(text);
}

function describeIoError(error: unknown): string {
	const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
	switch (code) {
		case 'ENOENT':
			return '导出包文件不存在';
		case 'EACCES':
		case 'EPERM':
			return '导出包文件不可读写';
		case 'EISDIR':
			return '导出包路径是目录';
		case 'ENOSPC':
			return '磁盘空间不足';
		default:
			return '导出包读写失败';
	}
}

export function writeConfigBundle(filePath: string, envelope: BundleEnvelope): TransferResult<void> {
	const validated = parseBundleEnvelope(envelope);
	if (!validated.ok) {
		return validated;
	}

	const serialized = serializeConfigBundle(validated.data);
	if (!serialized.ok) {
		return serialized;
	}

	try {
		// 明文包同样使用保守权限，避免未来内容变化导致凭据意外可读。
		atomicWrite(filePath, serialized.data, {mode: SECRET_FILE_MODE});
	} catch (error) {
		return fail('io', describeIoError(error));
	}

	return ok(undefined);
}

export function parseConfigBundleText(text: string): TransferResult<BundleEnvelope> {
	if (Buffer.byteLength(text, 'utf8') > CONFIG_BUNDLE_MAX_BYTES) {
		return fail('validation', '导出包超过 64 MiB 上限');
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return fail('validation', '导出包不是有效 JSON');
	}

	return parseBundleEnvelope(parsed);
}

export function readConfigBundle(filePath: string): TransferResult<BundleEnvelope> {
	let size: number;
	try {
		const stat = statSync(filePath);
		if (!stat.isFile()) {
			return fail('io', '导出包不是普通文件');
		}

		size = stat.size;
	} catch (error) {
		return fail('io', describeIoError(error));
	}

	if (size > CONFIG_BUNDLE_MAX_BYTES) {
		return fail('validation', '导出包超过 64 MiB 上限');
	}

	let text: string;
	try {
		text = readFileSync(filePath, 'utf8');
	} catch (error) {
		return fail('io', describeIoError(error));
	}

	return parseConfigBundleText(text);
}
