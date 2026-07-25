import {existsSync, readFileSync, readdirSync, unlinkSync} from 'node:fs';
import {normalizeBaseUrl, testProviderKey} from './text-utils.js';
import {codexAuthJsonPath, codexConfigPath, codexDir, codexProfilePath} from './paths.js';
import {atomicWrite as atomicWriteText, SECRET_FILE_MODE} from './fs-utils.js';
import {
	atomicWrite,
	deletePath,
	getPath,
	parse,
	redactTomlSecrets,
	setPath,
	stringify,
	type TomlDocument
} from './toml-edit.js';

// Codex provider/profile core：官方 profile-file 机制 + key 唯一身份（design D6/D7/D8）。

export type CodexProviderType = 'officialLogin' | 'apiKey' | 'custom';

export type CodexProfile = {
	readonly key: string;
	readonly providerType: CodexProviderType;
	readonly baseUrl: string;
	readonly model: string;
	readonly hasApiKey: boolean;
	readonly profilePath: string;
};

export type CodexProfileListItem = {
	readonly key: string;
	readonly providerType: CodexProviderType;
	readonly baseUrl: string;
	readonly hasApiKey: boolean;
	readonly isDefault: boolean;
	readonly profilePath: string;
};

export type CodexProfileInput = {
	readonly key: string;
	readonly providerType: CodexProviderType;
	readonly baseUrl?: string;
	readonly model?: string;
	readonly apiKey?: string;
};

export type CodexProfileLoadFailure = {
	readonly key: string;
	readonly reason: string;
};

export type CodexProfileScanResult = {
	readonly profiles: readonly CodexProfileListItem[];
	readonly failures: readonly CodexProfileLoadFailure[];
};

const PROFILE_SUFFIX = '.config.toml';
const API_KEY_FIELD = 'experimental_bearer_token';
const FORBIDDEN_AUTH_FIELDS = ['env_key', 'auth', 'requires_openai_auth'] as const;
// 供应商在 config.toml 的全部痕迹：设为默认时先删旧值，再导入新 profile 的对应键。
// 含官方键（model/model_provider/model_providers）与 legacy selector（profile/[profiles.*]）——
// 后者 ccq 从不写入，但必须清理用户遗留值，否则残留 `profile = "<key>"` 会让 Codex
// 仍读旧 profile、与新默认冲突。其余顶层键（mcp_servers/hooks/approval_policy/
// sandbox_mode 等）原样保留，绝不整体覆盖。
const CODEX_PROVIDER_CLEAR_KEYS = ['model', 'model_provider', 'model_providers', 'profile', 'profiles'] as const;
const CODEX_PROVIDER_IMPORT_KEYS = ['model', 'model_provider', 'model_providers'] as const;

/**
 * official login 虚拟条目 sentinel key。
 * 它**不对应磁盘文件**：ccq 从不为它落盘 `<key>.config.toml`，其默认态由
 * `~/.codex/config.toml` 无供应商键（model_provider 空）+ `~/.codex/auth.json` 存在共同定义。
 * 同时作为保留字：`testCodexProfileKey` 拒绝真实 profile 使用该名，避免与虚拟条目撞名。
 */
export const CODEX_OFFICIAL_LOGIN_KEY = 'official';

/** 是否为 official login 虚拟条目 key（sentinel，不落盘）。 */
export function isOfficialLoginKey(key: string | undefined | null): boolean {
	return key === CODEX_OFFICIAL_LOGIN_KEY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function trimOptional(value: string | undefined | null): string {
	return String(value ?? '').trim();
}

function assertHttpUrl(baseUrl: string): void {
	if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
		throw new Error(`Codex base URL 必须以 http:// 或 https:// 开头: ${baseUrl}`);
	}
}

/**
 * Codex profile key 复用 Claude provider key 安全规则，并额外拒绝 `.`/`..`、`-` 开头
 * 与保留字 `official`（后者是 official login 虚拟条目专用，不允许真实 profile 落盘撞名）。
 */
export function testCodexProfileKey(key: string | undefined | null): boolean {
	if (!testProviderKey(key)) {
		return false;
	}

	const value = String(key);
	if (value === '.' || value === '..' || value.startsWith('-')) {
		return false;
	}

	if (value === CODEX_OFFICIAL_LOGIN_KEY) {
		return false;
	}

	return true;
}

/** 校验 key 并返回安全 profile 文件名 stem；非法 key 抛错（写盘前调用）。 */
export function safeCodexProfileKey(key: string): string {
	if (!testCodexProfileKey(key)) {
		throw new Error(`非法供应商名称: ${key}`);
	}

	return String(key);
}

/** key 唯一身份派生：文件名 stem / profile name / model_provider id / table id / 默认显示名。 */
export function codexIdentityFromKey(key: string): {
	filenameStem: string;
	profileName: string;
	providerId: string;
	modelProvidersTableId: string;
	defaultDisplayName: string;
} {
	const safe = safeCodexProfileKey(key);
	return {
		filenameStem: safe,
		profileName: safe,
		providerId: safe,
		modelProvidersTableId: safe,
		defaultDisplayName: safe
	};
}

/** 解析 profile 文件路径为 key（仅识别 `~/.codex/<key>.config.toml`）。 */
export function codexProfileKeyFromPath(profilePath: string): string | null {
	const fileName = profilePath.split(/[/\\]/).pop() ?? '';
	if (!fileName.endsWith(PROFILE_SUFFIX)) {
		return null;
	}

	const stem = fileName.slice(0, -PROFILE_SUFFIX.length);
	return testCodexProfileKey(stem) ? stem : null;
}

/** 扫描 `~/.codex` 下所有 `<key>.config.toml`，返回合法 key 列表（不解析文件内容）。 */
export function listCodexProfileKeys(): readonly string[] {
	const dir = codexDir();
	if (!existsSync(dir)) {
		return [];
	}

	const keys: string[] = [];
	for (const entry of readdirSync(dir)) {
		const key = codexProfileKeyFromPath(entry);
		if (key) {
			keys.push(key);
		}
	}

	return keys.sort((a, b) => a.localeCompare(b));
}

/** profile 文件是否存在（供 setDefault 删除前校验等场景复用）。 */
export function codexProfileExists(key: string): boolean {
	if (!testCodexProfileKey(key)) {
		return false;
	}

	return existsSync(codexProfilePath(key));
}

/** 将 Codex profile 表单字段组装为官方 `<key>.config.toml` 文档。 */
export function buildCodexProfileDocument(input: CodexProfileInput): TomlDocument {
	const key = safeCodexProfileKey(input.key);
	const model = trimOptional(input.model);
	const baseUrl = normalizeBaseUrl(input.baseUrl);
	const apiKey = trimOptional(input.apiKey);

	assertHttpUrl(baseUrl);

	let document: TomlDocument = {};
	if (model) {
		document = setPath(document, ['model'], model);
	}

	if (input.providerType === 'officialLogin') {
		return document;
	}

	document = setPath(document, ['model_provider'], key);
	const provider: Record<string, unknown> = {name: key};
	if (baseUrl) {
		provider.base_url = baseUrl;
	}

	if (apiKey) {
		provider[API_KEY_FIELD] = apiKey;
	}

	for (const field of FORBIDDEN_AUTH_FIELDS) {
		delete provider[field];
	}

	return setPath(document, ['model_providers', key], provider);
}

export function buildCodexProfileToml(input: CodexProfileInput): string {
	return stringify(buildCodexProfileDocument(input));
}

/** 从真实 TOML 回填 Codex profile 支持的字段，供 textarea → form 同步复用。 */
export function parseCodexProfileToml(key: string, content: string, profilePath = codexProfilePath(safeCodexProfileKey(key))): CodexProfile {
	const safe = safeCodexProfileKey(key);
	const document = parse(content);
	const modelProvider = getPath(document, ['model_provider']);
	const provider = getPath(document, ['model_providers', safe]);
	const baseUrl = isRecord(provider) && typeof provider.base_url === 'string' ? provider.base_url : '';
	const hasApiKey = isRecord(provider) && typeof provider[API_KEY_FIELD] === 'string' && provider[API_KEY_FIELD] !== '';
	const model = getPath(document, ['model']);
	return {
		key: safe,
		providerType: typeof modelProvider === 'string' && modelProvider === safe ? (hasApiKey ? 'apiKey' : 'custom') : 'officialLogin',
		baseUrl,
		model: typeof model === 'string' ? model : '',
		hasApiKey,
		profilePath
	};
}

/** 从真实 TOML 提取明文 apiKey（experimental_bearer_token），供 edit 态回填 secret 字段。无则返回空串。 */
export function extractCodexApiKeyFromToml(key: string, content: string): string {
	const safe = safeCodexProfileKey(key);
	try {
		const provider = getPath(parse(content), ['model_providers', safe]);
		return isRecord(provider) && typeof provider[API_KEY_FIELD] === 'string' ? provider[API_KEY_FIELD] : '';
	} catch {
		return '';
	}
}

export function readCodexProfile(key: string): CodexProfile {
	const safe = safeCodexProfileKey(key);
	const profilePath = codexProfilePath(safe);
	if (!existsSync(profilePath)) {
		throw new Error(`供应商不存在: ${safe}`);
	}

	const rawToml = readFileSync(profilePath, 'utf8');
	validateCodexProfileDocument(safe, parse(rawToml));
	return parseCodexProfileToml(safe, rawToml, profilePath);
}

export function saveCodexProfile(input: CodexProfileInput): CodexProfile {
	const key = safeCodexProfileKey(input.key);
	const document = buildCodexProfileDocument({...input, key});
	const profilePath = codexProfilePath(key);
	atomicWrite(profilePath, document, {mode: SECRET_FILE_MODE});
	return parseCodexProfileToml(key, stringify(document), profilePath);
}

function validateCodexProfileDocument(key: string, document: TomlDocument): void {
	if (Object.prototype.hasOwnProperty.call(document, 'profile') || Object.prototype.hasOwnProperty.call(document, 'profiles')) {
		throw new Error('供应商配置不得包含 legacy profile/profiles selector');
	}

	const modelProvider = getPath(document, ['model_provider']);
	if (modelProvider !== key) {
		throw new Error(`供应商名称与 model_provider 不一致: 预期 ${key}`);
	}

	const providers = getPath(document, ['model_providers']);
	if (!isRecord(providers) || !isRecord(providers[key])) {
		throw new Error(`供应商配置缺少 [model_providers.${key}]`);
	}

	const providerKeys = Object.keys(providers);
	if (providerKeys.length !== 1 || providerKeys[0] !== key) {
		throw new Error(`供应商配置的 model_providers 只能包含唯一身份 ${key}`);
	}

	const provider = providers[key] as Record<string, unknown>;
	if (provider.name !== key) {
		throw new Error(`供应商名称必须与 key 一致: ${key}`);
	}

	for (const field of FORBIDDEN_AUTH_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(provider, field)) {
			throw new Error(`供应商不得包含认证字段 ${field}`);
		}
	}
}

export function saveCodexProfileToml(key: string, rawToml: string): CodexProfile {
	const safe = safeCodexProfileKey(key);
	const document = parse(rawToml);
	validateCodexProfileDocument(safe, document);

	const profilePath = codexProfilePath(safe);
	atomicWriteText(profilePath, rawToml, {mode: SECRET_FILE_MODE});
	return parseCodexProfileToml(safe, rawToml, profilePath);
}

export function readCodexProfileToml(key: string): string {
	const safe = safeCodexProfileKey(key);
	const profilePath = codexProfilePath(safe);
	if (!existsSync(profilePath)) {
		throw new Error(`供应商不存在: ${safe}`);
	}
	return readFileSync(profilePath, 'utf8');
}

export function deleteCodexProfile(key: string): void {
	// official login 虚拟条目：无磁盘文件，删除语义 = 登出（清空 auth.json）。
	// 不走「当前默认拒绝删除」保护——登出即其本意；破坏性确认由视图层危险 Modal 承担。
	if (isOfficialLoginKey(key)) {
		const authPath = codexAuthJsonPath();
		if (existsSync(authPath)) {
			unlinkSync(authPath);
		}

		return;
	}

	const safe = safeCodexProfileKey(key);
	if (isDefaultCodexProfile(safe)) {
		throw new Error(`不能删除当前默认供应商: ${safe}`);
	}

	const profile = codexProfileExists(safe) ? readCodexProfile(safe) : null;
	const profilePath = codexProfilePath(safe);
	if (existsSync(profilePath)) {
		unlinkSync(profilePath);
	}

	// 历史遗留：真实文件型 officialLogin profile 删除时同步清 auth.json（存量迁移后不再产生）。
	if (profile?.providerType === 'officialLogin') {
		const authPath = codexAuthJsonPath();
		if (existsSync(authPath)) {
			unlinkSync(authPath);
		}
	}
}

function currentDefaultProviderKey(): string {
	const configPath = codexConfigPath();
	if (!existsSync(configPath)) {
		return '';
	}

	const document = parse(readFileSync(configPath, 'utf8'));
	const value = getPath(document, ['model_provider']);
	return typeof value === 'string' ? value : '';
}

/** official login 当前是否为激活默认态：config.toml 无供应商键 + auth.json 存在。 */
export function isOfficialLoginActive(): boolean {
	return currentDefaultProviderKey() === '' && existsSync(codexAuthJsonPath());
}

/**
 * 读取 ~/.codex/auth.json 明文原文（供编辑态回填）。
 * 与 readCodexAuthJsonPreview 的脱敏预览不同：此处返回真实 token，仅用于表单可编辑场景。
 * 文件不存在返回空串（编辑态视为「新建登录」，保存即写入）。
 */
export function readCodexAuthJsonRaw(): string {
	const authPath = codexAuthJsonPath();
	if (!existsSync(authPath)) {
		return '';
	}

	return readFileSync(authPath, 'utf8');
}

/**
 * 写入 ~/.codex/auth.json（明文 JSON）。空内容语义 = 登出（删除文件）。
 * 非空内容必须是合法 JSON 对象，否则抛错（不写入半成品）。auth.json 由 codex login 生成，
 * ccq 此前只读；本函数是「official 可编辑」特性的唯一写入口，写入前做 JSON 合法性校验。
 */
export function writeCodexAuthJson(rawJson: string): {loggedOut: boolean} {
	const authPath = codexAuthJsonPath();
	const trimmed = rawJson.trim();

	// 空内容即登出：删除 auth.json（不存在则幂等无操作）。
	if (trimmed === '') {
		if (existsSync(authPath)) {
			unlinkSync(authPath);
		}

		return {loggedOut: true};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`auth.json 不是合法 JSON：${message}`);
	}

	if (!isRecord(parsed)) {
		throw new Error('auth.json 顶层必须是 JSON 对象');
	}

	// 规范化为 2 空格缩进后原子写入，保持与 codex login 产物一致的可读格式。
	atomicWriteText(authPath, `${JSON.stringify(parsed, null, 2)}\n`, {mode: SECRET_FILE_MODE});
	return {loggedOut: false};
}

/**
 * 解析当前默认 Codex profile key（含 official 虚拟条目）：
 * config.toml 的 model_provider 有值 → 该真实 key；为空且 auth.json 存在 → official sentinel；否则空。
 */
export function resolveDefaultCodexProfileKey(): string {
	const providerKey = currentDefaultProviderKey();
	if (providerKey) {
		return providerKey;
	}

	return existsSync(codexAuthJsonPath()) ? CODEX_OFFICIAL_LOGIN_KEY : '';
}

export function isDefaultCodexProfile(key: string): boolean {
	const resolved = resolveDefaultCodexProfileKey();
	if (isOfficialLoginKey(key)) {
		return resolved === CODEX_OFFICIAL_LOGIN_KEY;
	}

	return resolved === safeCodexProfileKey(key);
}

/** 构造 official login 虚拟条目（不落盘，profilePath 为空串标识虚拟）。 */
function officialLoginListItem(defaultKey = resolveDefaultCodexProfileKey()): CodexProfileListItem {
	return {
		key: CODEX_OFFICIAL_LOGIN_KEY,
		providerType: 'officialLogin',
		baseUrl: '',
		hasApiKey: false,
		isDefault: defaultKey === CODEX_OFFICIAL_LOGIN_KEY,
		profilePath: ''
	};
}

function safeCodexLoadFailureReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactCodexTomlForOutput(message).split(/\r?\n/, 1)[0] || '供应商配置无法解析';
}

/**
 * 列出 Codex profile：真实 `<key>.config.toml` + 始终追加一个 official login 虚拟条目。
 * 虚拟条目排在末尾，profilePath 为空串（无磁盘文件）；其 isDefault 随 auth.json/config.toml 计算。
 */
export function scanCodexProfiles(): CodexProfileScanResult {
	const failures: CodexProfileLoadFailure[] = [];
	let defaultKey = '';
	try {
		defaultKey = resolveDefaultCodexProfileKey();
	} catch (error) {
		failures.push({key: 'config.toml', reason: safeCodexLoadFailureReason(error)});
	}

	const profiles: CodexProfileListItem[] = [];
	for (const key of listCodexProfileKeys()) {
		try {
			profiles.push({...readCodexProfile(key), isDefault: key === defaultKey});
		} catch (error) {
			failures.push({key, reason: safeCodexLoadFailureReason(error)});
		}
	}

	profiles.push(officialLoginListItem(defaultKey));
	return {profiles, failures};
}

export function listCodexProfiles(): readonly CodexProfileListItem[] {
	return scanCodexProfiles().profiles;
}

/** 读取 config.toml document（不存在返回空文档）。 */
function readCodexConfigDocumentOrEmpty(): TomlDocument {
	const configPath = codexConfigPath();
	return existsSync(configPath) ? parse(readFileSync(configPath, 'utf8')) : {};
}

/** 清空 config.toml 的全部供应商键，保留其余顶层键（mcp_servers/hooks 等）。 */
function clearCodexProviderKeys(): void {
	let merged = readCodexConfigDocumentOrEmpty();
	for (const providerKey of CODEX_PROVIDER_CLEAR_KEYS) {
		merged = deletePath(merged, [providerKey]);
	}

	atomicWrite(codexConfigPath(), merged, {mode: SECRET_FILE_MODE});
}

/**
 * 将选中 profile 的供应商键合并写入 `~/.codex/config.toml`：先删旧供应商键
 * （model/model_provider/model_providers），再从新 profile 导入这些键；其余顶层键
 * （mcp_servers/hooks/approval_policy/sandbox_mode 等）原样保留，绝不整体覆盖。
 * 不写 legacy `profile = "<key>"` 或 `[profiles.<key>]` selector。
 *
 * official login 虚拟条目：无源文件，仅清空供应商键，让 codex 回到 auth.json 登录态。
 */
export function setDefaultCodexProfile(key: string): void {
	if (isOfficialLoginKey(key)) {
		clearCodexProviderKeys();
		return;
	}

	const rawToml = readCodexProfileToml(key);
	const profileDoc = parse(rawToml);
	validateCodexProfileDocument(safeCodexProfileKey(key), profileDoc);

	let merged = readCodexConfigDocumentOrEmpty();

	// 1. 删旧供应商：清掉现有 config 里的三个供应商键
	for (const providerKey of CODEX_PROVIDER_CLEAR_KEYS) {
		merged = deletePath(merged, [providerKey]);
	}

	// 2. 导新供应商：从新 profile 取三个键（profile 有才写，如 official login 无 provider 表）
	for (const providerKey of CODEX_PROVIDER_IMPORT_KEYS) {
		const value = getPath(profileDoc, [providerKey]);
		if (value !== undefined) {
			merged = setPath(merged, [providerKey], value);
		}
	}

	atomicWrite(codexConfigPath(), merged, {mode: SECRET_FILE_MODE});
}

/**
 * 存量迁移：清理历史遗留的 `official.config.toml` 空壳文件。
 * 仅当文件是 officialLogin 空壳（无 model_provider / model_providers）时删除；
 * 若用户曾撞名建过真实 apiKey/custom profile（含供应商 table），保留不动（不误删用户数据）。
 * 返回是否发生清理。auth.json 全程不动。
 */
export function migrateLegacyOfficialLoginFile(): {removed: boolean} {
	const legacyPath = codexProfilePath(CODEX_OFFICIAL_LOGIN_KEY);
	if (!existsSync(legacyPath)) {
		return {removed: false};
	}

	let isOfficialShell = true;
	try {
		const doc = parse(readFileSync(legacyPath, 'utf8'));
		const modelProvider = getPath(doc, ['model_provider']);
		const providers = getPath(doc, ['model_providers']);
		if ((typeof modelProvider === 'string' && modelProvider !== '') || isRecord(providers)) {
			isOfficialShell = false; // 真实供应商数据，保留
		}
	} catch {
		// 解析失败视为损坏空壳，可清理
	}

	if (!isOfficialShell) {
		return {removed: false};
	}

	try {
		unlinkSync(legacyPath);
	} catch {
		return {removed: false};
	}

	return {removed: true};
}

/** 输出前统一脱敏，供调用层展示解析/保存失败信息时复用。 */
export function redactCodexTomlForOutput(content: string): string {
	return redactTomlSecrets(content);
}
