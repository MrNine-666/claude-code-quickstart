import {existsSync, readFileSync, readdirSync, unlinkSync} from 'node:fs';
import {normalizeBaseUrl, testProviderKey} from './text-utils.js';
import {codexAuthJsonPath, codexConfigPath, codexDir, codexProfilePath} from './paths.js';
import {atomicWrite as atomicWriteText} from './fs-utils.js';
import {
	atomicWrite,
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

const PROFILE_SUFFIX = '.config.toml';
const API_KEY_FIELD = 'experimental_bearer_token';
const FORBIDDEN_AUTH_FIELDS = ['env_key', 'auth', 'requires_openai_auth'] as const;

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

/** Codex profile key 复用 Claude provider key 安全规则，并额外拒绝 `.`/`..` 与 `-` 开头。 */
export function testCodexProfileKey(key: string | undefined | null): boolean {
	if (!testProviderKey(key)) {
		return false;
	}

	const value = String(key);
	if (value === '.' || value === '..' || value.startsWith('-')) {
		return false;
	}

	return true;
}

/** 校验 key 并返回安全 profile 文件名 stem；非法 key 抛错（写盘前调用）。 */
export function safeCodexProfileKey(key: string): string {
	if (!testCodexProfileKey(key)) {
		throw new Error(`非法 Codex profile key: ${key}`);
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

/** 解析 profile 文件路径为 key（仅识别 `$CODEX_HOME/<key>.config.toml`）。 */
export function codexProfileKeyFromPath(profilePath: string): string | null {
	const fileName = profilePath.split(/[/\\]/).pop() ?? '';
	if (!fileName.endsWith(PROFILE_SUFFIX)) {
		return null;
	}

	const stem = fileName.slice(0, -PROFILE_SUFFIX.length);
	return testCodexProfileKey(stem) ? stem : null;
}

/** 扫描 `$CODEX_HOME` 下所有 `<key>.config.toml`，返回合法 key 列表（不解析文件内容）。 */
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

export function readCodexProfile(key: string): CodexProfile {
	const safe = safeCodexProfileKey(key);
	const profilePath = codexProfilePath(safe);
	if (!existsSync(profilePath)) {
		throw new Error(`Codex profile 不存在: ${safe}`);
	}

	return parseCodexProfileToml(safe, readFileSync(profilePath, 'utf8'), profilePath);
}

export function saveCodexProfile(input: CodexProfileInput): CodexProfile {
	const key = safeCodexProfileKey(input.key);
	const document = buildCodexProfileDocument({...input, key});
	const profilePath = codexProfilePath(key);
	atomicWrite(profilePath, document);
	return parseCodexProfileToml(key, stringify(document), profilePath);
}

export function saveCodexProfileToml(key: string, rawToml: string): CodexProfile {
	const safe = safeCodexProfileKey(key);
	const document = parse(rawToml);
	const modelProvider = getPath(document, ['model_provider']);
	if (typeof modelProvider === 'string' && modelProvider !== safe) {
		throw new Error(`Codex profile key 与 model_provider 不一致: ${safe} != ${modelProvider}`);
	}

	if (modelProvider === safe && !isRecord(getPath(document, ['model_providers', safe]))) {
		throw new Error(`Codex profile 缺少 [model_providers.${safe}]`);
	}

	const profilePath = codexProfilePath(safe);
	atomicWriteText(profilePath, rawToml);
	return parseCodexProfileToml(safe, rawToml, profilePath);
}

export function readCodexProfileToml(key: string): string {
	const safe = safeCodexProfileKey(key);
	const profilePath = codexProfilePath(safe);
	if (!existsSync(profilePath)) {
		throw new Error(`Codex profile 不存在: ${safe}`);
	}
	return readFileSync(profilePath, 'utf8');
}

export function deleteCodexProfile(key: string): void {
	const safe = safeCodexProfileKey(key);
	if (isDefaultCodexProfile(safe)) {
		throw new Error(`不能删除当前默认 Codex profile: ${safe}`);
	}

	const profile = codexProfileExists(safe) ? readCodexProfile(safe) : null;
	const profilePath = codexProfilePath(safe);
	if (existsSync(profilePath)) {
		unlinkSync(profilePath);
	}

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

export function isDefaultCodexProfile(key: string): boolean {
	return currentDefaultProviderKey() === safeCodexProfileKey(key);
}

export function listCodexProfiles(): readonly CodexProfileListItem[] {
	const defaultKey = currentDefaultProviderKey();
	return listCodexProfileKeys().map(key => {
		const profile = readCodexProfile(key);
		return {...profile, isDefault: key === defaultKey};
	});
}

/**
 * 将选中 profile 的真实 TOML 覆盖到 `$CODEX_HOME/config.toml`。
 * 不写 legacy `profile = "<key>"` 或 `[profiles.<key>]` selector。
 */
export function setDefaultCodexProfile(key: string): void {
	const rawToml = readCodexProfileToml(key);
	parse(rawToml);
	atomicWriteText(codexConfigPath(), rawToml);
}

/** 输出前统一脱敏，供调用层展示解析/保存失败信息时复用。 */
export function redactCodexTomlForOutput(content: string): string {
	return redactTomlSecrets(content);
}
