import {existsSync, readFileSync, readdirSync, unlinkSync} from 'node:fs';
import {normalizeBaseUrl, testProviderKey} from './text-utils.js';
import {codexAuthJsonPath, codexConfigPath, codexDir, codexProfilePath} from './paths.js';
import {atomicWrite as atomicWriteText, SECRET_FILE_MODE} from './fs-utils.js';
import {atomicWrite, deletePath, getPath, parse, redactTomlSecrets, setPath, stringify, type TomlDocument} from './toml-edit.js';
import {portableCodexConfig, readCodexConfigDocumentStrict} from './codex-config.js';
import {type SectionMergeReport, type TransferResult, transferFail, transferOk} from './config-transfer.js';

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
export function parseCodexProfileToml(
	key: string,
	content: string,
	profilePath = codexProfilePath(safeCodexProfileKey(key))
): CodexProfile {
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
	if (isOfficialLoginKey(key)) {
		throw new Error('Codex 官方账号为只读身份，请通过 Codex 原生命令 codex logout 管理。');
	}

	const safe = safeCodexProfileKey(key);
	if (isDefaultCodexProfile(safe)) {
		throw new Error(`不能删除当前默认供应商: ${safe}`);
	}

	const profile = codexProfileExists(safe) ? readCodexProfile(safe) : null;
	if (profile?.providerType === 'officialLogin') {
		throw new Error('Codex 官方账号为只读身份，请通过 Codex 原生命令 codex logout 管理。');
	}

	const profilePath = codexProfilePath(safe);
	if (existsSync(profilePath)) {
		unlinkSync(profilePath);
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

/** 合并写入 config.toml 的供应商投影：先删旧供应商键，再导入投影中存在的键；其余顶层键原样保留。 */
export function mergeCodexProviderProjection(projection: TomlDocument): void {
	let merged = readCodexConfigDocumentOrEmpty();
	for (const providerKey of CODEX_PROVIDER_CLEAR_KEYS) {
		merged = deletePath(merged, [providerKey]);
	}

	for (const providerKey of CODEX_PROVIDER_IMPORT_KEYS) {
		const value = getPath(projection, [providerKey]);
		if (value !== undefined) {
			merged = setPath(merged, [providerKey], value);
		}
	}

	atomicWrite(codexConfigPath(), merged, {mode: SECRET_FILE_MODE});
}

/** 从 config document 提取供应商投影（model / model_provider / model_providers）。 */
export function codexProviderProjection(document: TomlDocument): TomlDocument {
	let projection: TomlDocument = {};
	for (const key of CODEX_PROVIDER_IMPORT_KEYS) {
		const value = getPath(document, [key]);
		if (value !== undefined) {
			projection = setPath(projection, [key], value);
		}
	}

	return projection;
}

/**
 * 合并导入 config.toml 供应商投影（区别于 activation 的整表替换）：
 * `model`/`model_provider` 使用包值，`model_providers` 按 id 合并，本机独有条目与字段保留。
 */
export function importCodexProviderProjection(projection: TomlDocument, options: {readonly preserveCredentials?: boolean} = {}): void {
	const merged = mergeImportedCodexProviderProjection(readCodexConfigDocumentOrEmpty(), projection, options);
	atomicWrite(codexConfigPath(), merged, {mode: SECRET_FILE_MODE});
}

/** Import preview and write must compare the same merged owner projection. */
function mergeImportedCodexProviderProjection(
	local: TomlDocument,
	projection: TomlDocument,
	options: {readonly preserveCredentials?: boolean}
): TomlDocument {
	let merged = local;
	merged = deletePath(merged, ['profile']);
	merged = deletePath(merged, ['profiles']);
	if (options.preserveCredentials) projection = stripCodexProjectionCredentials(projection);

	for (const key of ['model', 'model_provider'] as const) {
		const value = getPath(projection, [key]);
		if (value !== undefined) {
			merged = setPath(merged, [key], value);
		}
	}

	const incomingProviders = getPath(projection, ['model_providers']);
	if (isRecord(incomingProviders)) {
		const localProviders = getPath(merged, ['model_providers']);
		const nextProviders: Record<string, unknown> = isRecord(localProviders) ? {...localProviders} : {};
		for (const [id, entry] of Object.entries(incomingProviders)) {
			const localEntry = nextProviders[id];
			nextProviders[id] = mergeCodexProviderFields(localEntry, entry);
		}

		merged = setPath(merged, ['model_providers'], nextProviders);
	}

	return merged;
}

function mergeCodexProviderFields(local: unknown, incoming: unknown): unknown {
	if (!isRecord(local) || !isRecord(incoming)) return incoming;
	const merged = {...local};
	for (const [key, value] of Object.entries(incoming)) {
		merged[key] = mergeCodexProviderFields(merged[key], value);
	}
	return merged;
}

const CODEX_PROVIDER_CREDENTIAL_FIELDS = [API_KEY_FIELD, 'http_headers'] as const;

function stripCodexProjectionCredentials(document: TomlDocument): TomlDocument {
	const providers = getPath(document, ['model_providers']);
	let next = document;
	if (isRecord(providers)) {
		for (const id of Object.keys(providers)) {
			for (const field of CODEX_PROVIDER_CREDENTIAL_FIELDS) next = deletePath(next, ['model_providers', id, field]);
		}
	}
	return next;
}

/** Provider owner owns credential facts for both profile TOML and runtime projection. */
export function codexProvidersContainCredentials(section: CodexProvidersSection): boolean {
	const contains = (document: TomlDocument): boolean => {
		const providers = getPath(document, ['model_providers']);
		return (
			isRecord(providers) &&
			Object.values(providers).some(
				entry =>
					isRecord(entry) &&
					CODEX_PROVIDER_CREDENTIAL_FIELDS.some(field => {
						const value = entry[field];
						return typeof value === 'string' ? value.length > 0 : isRecord(value) && Object.keys(value).length > 0;
					})
			)
		);
	};
	return section.profiles.some(entry => contains(parse(entry.toml))) || contains(section.configProjection);
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
		mergeCodexProviderProjection({});
		return;
	}

	const rawToml = readCodexProfileToml(key);
	const profileDoc = parse(rawToml);
	validateCodexProfileDocument(safeCodexProfileKey(key), profileDoc);
	mergeCodexProviderProjection(codexProviderProjection(profileDoc));
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

// ── 导入导出 seam（Phase 2）：供应商 profiles 与 config.toml 供应商投影 ─────────

/** profile TOML 中的明文凭据字段；未选择敏感凭据时必须从包中移除。 */
export const CODEX_PROFILE_CREDENTIAL_FIELD = API_KEY_FIELD;

export type CodexProviderProfileEntry = {readonly key: string; readonly toml: string};

export type CodexProvidersSection = {
	readonly profiles: readonly CodexProviderProfileEntry[];
	/** config.toml 中可迁移的供应商投影：model / model_provider / model_providers。 */
	readonly configProjection: TomlDocument;
};

/** 校验 `<key>.config.toml` 文本（导入边界；不写盘）。 */
export function validateCodexProfileToml(key: string, rawToml: string): {readonly ok: true} | {readonly ok: false; readonly error: string} {
	try {
		validateCodexProfileDocument(safeCodexProfileKey(key), parse(rawToml));
		return {ok: true};
	} catch (error) {
		return {ok: false, error: safeCodexLoadFailureReason(error)};
	}
}

/** 移除 profile TOML 中的明文凭据字段（未选择敏感凭据时导出）。 */
function stripCodexProfileCredentials(key: string, toml: string): string {
	let document: TomlDocument;
	try {
		document = parse(toml);
	} catch {
		return toml;
	}

	if (CODEX_PROVIDER_CREDENTIAL_FIELDS.every(field => getPath(document, ['model_providers', key, field]) === undefined)) {
		return toml;
	}

	return stringify(stripCodexProjectionCredentials(document));
}

/** 用本机已有 token 回填未包含凭据的包内容，避免同 key 覆盖时丢失本机凭据。 */
function preserveCodexProfileCredentials(key: string, incomingToml: string, localToml: string): string {
	let incoming: TomlDocument;
	let local: TomlDocument;
	try {
		incoming = parse(incomingToml);
		local = parse(localToml);
	} catch {
		return incomingToml;
	}

	let changed = false;
	for (const field of CODEX_PROVIDER_CREDENTIAL_FIELDS) {
		const path = ['model_providers', key, field];
		const localValue = getPath(local, path);
		if (localValue !== undefined && getPath(incoming, path) === undefined) {
			incoming = setPath(incoming, path, localValue);
			changed = true;
		}
	}
	return changed ? stringify(incoming) : incomingToml;
}

/** 快照 `~/.codex/<key>.config.toml` 与 config.toml 供应商投影。 */
export function snapshotCodexProvidersSection(options: {readonly includeCredentials: boolean}): TransferResult<CodexProvidersSection> {
	const warnings: string[] = [];
	const profiles: CodexProviderProfileEntry[] = [];

	for (const key of listCodexProfileKeys()) {
		let toml: string;
		try {
			toml = readCodexProfileToml(key);
		} catch {
			warnings.push(`已跳过无法读取的供应商配置：${key}`);
			continue;
		}

		const validated = validateCodexProfileToml(key, toml);
		if (!validated.ok) {
			warnings.push(`已跳过损坏的供应商配置：${key}`);
			continue;
		}

		profiles.push({key, toml: options.includeCredentials ? toml : stripCodexProfileCredentials(key, toml)});
	}

	let configProjection: TomlDocument = {};
	const config = readCodexConfigDocumentStrict();
	if (config.status === 'invalid') {
		warnings.push('Codex config.toml 损坏，未包含供应商投影');
	} else if (config.status === 'valid') {
		const portable = portableCodexConfig(config.value);
		configProjection = codexProviderProjection(portable.config);
		if (!options.includeCredentials) configProjection = stripCodexProjectionCredentials(configProjection);
		for (const exclusion of portable.excluded) {
			warnings.push(`已排除本机绑定配置：${exclusion.key}`);
		}
	}

	return transferOk({profiles, configProjection}, warnings);
}

/** 校验包中的 Codex 供应商分类（导入边界；不信任包内容）。 */
export function parseCodexProvidersSection(value: unknown): TransferResult<CodexProvidersSection> {
	if (!isRecord(value)) {
		return transferFail('validation', '供应商分类内容无效');
	}

	if (!Array.isArray(value.profiles)) {
		return transferFail('validation', '供应商分类缺少配置列表');
	}

	const profiles: CodexProviderProfileEntry[] = [];
	const seen = new Set<string>();
	for (const raw of value.profiles) {
		if (
			!isRecord(raw) ||
			typeof raw.key !== 'string' ||
			!testCodexProfileKey(raw.key) ||
			typeof raw.toml !== 'string' ||
			raw.toml.trim() === ''
		) {
			return transferFail('validation', '供应商分类包含无效条目');
		}

		if (seen.has(raw.key)) {
			return transferFail('validation', '供应商分类包含重复条目');
		}

		seen.add(raw.key);
		const validated = validateCodexProfileToml(raw.key, raw.toml);
		if (!validated.ok) {
			return transferFail('validation', `供应商配置无效：${validated.error}`);
		}

		profiles.push({key: raw.key, toml: raw.toml});
	}

	if (!isRecord(value.configProjection)) {
		return transferFail('validation', '供应商分类缺少投影配置');
	}

	// 再次过滤，防止外部包把本机绑定条目带进 config.toml。
	const portable = portableCodexConfig(value.configProjection as TomlDocument);
	const warnings = portable.excluded.map(exclusion => `已排除本机绑定配置：${exclusion.key}`);
	return transferOk({profiles, configProjection: codexProviderProjection(portable.config)}, warnings);
}

/** 合并导入 Codex 供应商分类：同 key 覆盖，其他本机 profile 与 config 键保留。 */
export function importCodexProvidersSection(
	data: unknown,
	options: {readonly containsCredentials: boolean; readonly dryRun?: boolean}
): TransferResult<SectionMergeReport> {
	const parsed = parseCodexProvidersSection(data);
	if (!parsed.ok) {
		return parsed;
	}

	const localConfig = readCodexConfigDocumentStrict();
	if (localConfig.status === 'invalid') {
		return transferFail('conflict', '本机 Codex config.toml 损坏，已停止导入供应商分类');
	}

	const added: string[] = [];
	const replaced: string[] = [];
	const unchanged: string[] = [];
	const warnings = [...parsed.warnings];

	for (const entry of parsed.data.profiles) {
		const profilePath = codexProfilePath(entry.key);
		let toml = options.containsCredentials ? entry.toml : stripCodexProfileCredentials(entry.key, entry.toml);
		let existing: string | null = null;
		if (existsSync(profilePath)) {
			try {
				existing = readFileSync(profilePath, 'utf8');
			} catch {
				return transferFail('conflict', `本机供应商配置无法读取：${entry.key}`);
			}

			const validated = validateCodexProfileToml(entry.key, existing);
			if (!validated.ok) {
				return transferFail('conflict', `本机供应商配置损坏，已停止导入：${entry.key}`);
			}

			if (!options.containsCredentials) {
				toml = preserveCodexProfileCredentials(entry.key, toml, existing);
			}
		}

		if (existing === toml) {
			unchanged.push(entry.key);
			continue;
		}

		if (existing === null) {
			added.push(entry.key);
		} else {
			replaced.push(entry.key);
		}

		if (!options.dryRun) {
			try {
				saveCodexProfileToml(entry.key, toml);
			} catch {
				return transferFail('io', `供应商配置写入失败：${entry.key}`);
			}
		}
	}

	const localProjection = localConfig.status === 'valid' ? codexProviderProjection(localConfig.value) : {};
	const incomingProjection = parsed.data.configProjection;
	const mergedProjection = codexProviderProjection(
		mergeImportedCodexProviderProjection(localProjection, incomingProjection, {
			preserveCredentials: !options.containsCredentials
		})
	);
	if (Object.keys(incomingProjection).length === 0) {
		// 包中没有默认供应商投影时不清理本机默认项（合并语义不删除包外内容）。
		unchanged.push('config');
	} else if (JSON.stringify(localProjection) === JSON.stringify(mergedProjection)) {
		unchanged.push('config');
	} else {
		(Object.keys(localProjection).length === 0 ? added : replaced).push('config');
		if (!options.dryRun) {
			try {
				importCodexProviderProjection(incomingProjection, {preserveCredentials: !options.containsCredentials});
			} catch {
				return transferFail('io', 'Codex config.toml 写入失败');
			}
		}
	}

	return transferOk({added, replaced, unchanged, skipped: [], warnings});
}
