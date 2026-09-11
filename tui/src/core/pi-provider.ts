import {existsSync, readFileSync, unlinkSync} from 'node:fs';
import {atomicWrite, readJsonFileStrict, SECRET_FILE_MODE, withProfileLock, writeJsonAtomic} from './fs-utils.js';
import {loadContract} from './contracts.js';
import {piAuthJsonPath, piModelsJsonPath, piSettingsPath} from './paths.js';
import {maskApiKey} from './text-utils.js';
import type {ProviderDisplayData, ProviderDisplayProfile} from './provider.js';
import type {FormField} from '../components/form/field-types.js';

type JsonObject = Record<string, unknown>;

export const PI_APIS = ['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'] as const;
export type PiApi = (typeof PI_APIS)[number];

/** Deprecated compatibility marker. Pi OAuth providers are never addable by ccq. */
export const PI_CHATGPT_KEY = 'openai-codex';
export const PI_CHATGPT_PROVIDER = 'openai-codex';

export type PiModelDefinition = JsonObject & {readonly id: string};

export type PiProviderMetadata = {
	readonly providerId: string;
	readonly displayName: string;
	readonly api: PiApi | string;
	readonly baseUrl?: string;
	readonly oauth: boolean;
	readonly models: readonly PiModelDefinition[];
};

export type PiProviderSource = 'builtin' | 'custom' | 'builtin-override' | 'unknown';
export type PiAuthKind = 'api_key' | 'oauth' | 'none' | 'unknown';

export type PiProviderRecord = {
	readonly providerId: string;
	readonly displayName: string;
	readonly source: PiProviderSource;
	readonly authKind: PiAuthKind;
	readonly authStatus: 'configured' | 'missing' | 'invalid' | 'unknown';
	readonly baseUrl: string;
	readonly api: string;
	readonly models: readonly PiModelDefinition[];
	readonly isActive: boolean;
	readonly isMissing: boolean;
	readonly canEdit: boolean;
	readonly canDelete: boolean;
	readonly canSwitch: boolean;
};

export type PiProviderProfile = {
	/** Provider ID is the sole logical identity; this is not provider/model profile data. */
	readonly key: string;
	readonly provider: string;
	/** First model retained only for generic form compatibility. */
	readonly model: string;
	readonly models: readonly PiModelDefinition[];
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly profilePath: string;
	readonly api?: string;
};

export type PiProviderFormMode = 'add' | 'edit';

export type PiProviderFormInput = {
	readonly mode: PiProviderFormMode;
	readonly providerId?: string;
	/** Compatibility alias used by the shared ProviderForm adapter. */
	readonly profileKey?: string;
	readonly profile?: PiProviderProfile | null;
};

export type PiProviderFormValues = {
	/** Deprecated compatibility value; Pi now exposes only the API Key custom form. */
	readonly providerType?: string;
	readonly api?: string;
	readonly provider: string;
	/** First model retained for old generic callers. */
	readonly model: string;
	/** One or more models, separated by commas or newlines. */
	readonly models: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly activateAfterSave: boolean;
};

export type PiProviderFormModel = {
	readonly mode: PiProviderFormMode;
	readonly fields: readonly FormField[];
	readonly values: PiProviderFormValues;
};

export type PiProviderSaveResult = PiProviderProfile;

type PiProviderRegistryDocument = {
	readonly Providers?: Record<
		string,
		{
			readonly Name?: unknown;
			readonly Api?: unknown;
			readonly BaseUrl?: unknown;
			readonly OAuth?: unknown;
			readonly Models?: unknown;
		}
	>;
};

type PiDocuments = {
	readonly models: JsonObject;
	readonly auth: JsonObject;
	readonly settings: JsonObject;
};

type PiDocumentDisplay = {
	readonly documents: PiDocuments;
	readonly failures: readonly {readonly key: string; readonly reason: string}[];
};

type AuthInfo = {
	readonly kind: PiAuthKind;
	readonly status: 'configured' | 'missing' | 'invalid' | 'unknown';
	readonly apiKey: string;
};

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function hasText(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}

function modelId(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	if (!isObject(value)) return '';
	return stringValue(value.id).trim() || stringValue(value.name).trim() || stringValue(value.model).trim();
}

function modelObject(value: unknown): PiModelDefinition | null {
	const id = modelId(value);
	if (!id) return null;
	return isObject(value) ? ({...value, id} as PiModelDefinition) : ({id} as PiModelDefinition);
}

function modelList(value: unknown): PiModelDefinition[] {
	if (!Array.isArray(value)) return [];
	return value.map(modelObject).filter((item): item is PiModelDefinition => item !== null);
}

function modelsArray(entry: JsonObject): PiModelDefinition[] {
	if (Array.isArray(entry.models)) return modelList(entry.models);
	if (Array.isArray(entry.model)) return modelList(entry.model);
	if (typeof entry.model === 'string') return [{id: entry.model}];
	return [];
}

function modelProviderContainer(root: JsonObject): JsonObject {
	if (isObject(root.providers)) return root.providers;

	const container: JsonObject = {};
	for (const [key, value] of Object.entries(root)) {
		if (key !== 'providers' && key !== 'defaultProvider' && isObject(value)) container[key] = value;
	}
	return container;
}

function providerEntry(root: JsonObject, providerId: string): JsonObject | null {
	if (isObject(root.providers) && isObject(root.providers[providerId])) return root.providers[providerId];
	return isObject(root[providerId]) ? root[providerId] : null;
}

function providerBaseUrl(entry: JsonObject | null, metadata?: PiProviderMetadata): string {
	if (entry) {
		const value = stringValue(entry.baseUrl) || stringValue(entry.base_url) || stringValue(entry.url);
		if (value) return value;
	}
	return metadata?.baseUrl ?? '';
}

function authInfo(value: unknown): AuthInfo {
	if (value === undefined) return {kind: 'none', status: 'missing', apiKey: ''};
	if (typeof value === 'string') {
		return value ? {kind: 'api_key', status: 'configured', apiKey: value} : {kind: 'api_key', status: 'invalid', apiKey: ''};
	}
	if (!isObject(value)) return {kind: 'unknown', status: 'invalid', apiKey: ''};
	if (value.type === 'oauth') {
		const complete = hasText(value.access) && hasText(value.refresh);
		return {kind: 'oauth', status: complete ? 'configured' : 'invalid', apiKey: ''};
	}
	if (value.type === 'api_key' || 'key' in value || 'apiKey' in value || 'api_key' in value || 'token' in value) {
		const key = stringValue(value.key) || stringValue(value.apiKey) || stringValue(value.api_key) || stringValue(value.token);
		return key ? {kind: 'api_key', status: 'configured', apiKey: key} : {kind: 'api_key', status: 'invalid', apiKey: ''};
	}
	return {kind: 'unknown', status: 'unknown', apiKey: ''};
}

function readObject(path: string, label: string): JsonObject {
	const result = readJsonFileStrict<unknown>(path);
	if (result.status === 'missing') return {};
	if (result.status === 'invalid' || !isObject(result.value)) throw new Error(`${label} 损坏或无法解析，请先修复后重试`);
	return result.value;
}

function readObjectForDisplay(
	path: string,
	label: string
): {readonly value: JsonObject; readonly failure?: {readonly key: string; readonly reason: string}} {
	const result = readJsonFileStrict<unknown>(path);
	if (result.status === 'missing') return {value: {}};
	if (result.status === 'invalid' || !isObject(result.value)) {
		return {value: {}, failure: {key: label, reason: result.status === 'invalid' ? result.error : 'JSON 顶层必须是对象'}};
	}
	return {value: result.value};
}

function readPiDocumentsForDisplay(): PiDocumentDisplay {
	const models = readObjectForDisplay(piModelsJsonPath(), 'models.json');
	const auth = readObjectForDisplay(piAuthJsonPath(), 'auth.json');
	const settings = readObjectForDisplay(piSettingsPath(), 'settings.json');
	const failures = [models.failure, auth.failure, settings.failure].filter(
		(failure): failure is {readonly key: string; readonly reason: string} => failure !== undefined
	);
	return {documents: {models: models.value, auth: auth.value, settings: settings.value}, failures};
}

function loadRegistryDocument(): PiProviderRegistryDocument {
	try {
		return loadContract<PiProviderRegistryDocument>('pi-providers.json');
	} catch {
		return {Providers: {}};
	}
}

export function loadPiProviderRegistry(): readonly PiProviderMetadata[] {
	const providers = loadRegistryDocument().Providers ?? {};
	return Object.entries(providers).map(([providerId, raw]) => ({
		providerId,
		displayName: stringValue(raw.Name) || providerId,
		api: stringValue(raw.Api),
		baseUrl: stringValue(raw.BaseUrl) || undefined,
		oauth: raw.OAuth === true,
		models: modelList(raw.Models)
	}));
}

function registryMap(): Map<string, PiProviderMetadata> {
	return new Map(loadPiProviderRegistry().map(item => [item.providerId, item]));
}

function mergeModels(metadata: readonly PiModelDefinition[], configured: readonly PiModelDefinition[]): readonly PiModelDefinition[] {
	const result = new Map<string, PiModelDefinition>();
	for (const model of metadata) result.set(model.id, {...model});
	for (const model of configured) result.set(model.id, {...result.get(model.id), ...model, id: model.id});
	return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function normalizePiProviderRecords(documents: PiDocuments): readonly PiProviderRecord[] {
	const registry = registryMap();
	const configuredProviders = modelProviderContainer(documents.models);
	const ids = new Set<string>([
		...Object.keys(documents.auth),
		...Object.keys(configuredProviders),
		stringValue(documents.settings.defaultProvider)
	]);
	const records: PiProviderRecord[] = [];

	for (const providerId of ids) {
		if (!providerId) continue;
		const metadata = registry.get(providerId);
		const entry = providerEntry(documents.models, providerId);
		const auth = authInfo(documents.auth[providerId]);
		const configuredModels = entry ? modelsArray(entry) : [];
		const models = mergeModels(metadata?.models ?? [], configuredModels);
		const isBuiltin = metadata !== undefined;
		const hasDefinition = entry !== null;
		const source: PiProviderSource = isBuiltin
			? hasDefinition
				? 'builtin-override'
				: 'builtin'
			: hasDefinition
				? 'custom'
				: 'unknown';
		const isActive = stringValue(documents.settings.defaultProvider) === providerId;
		const isMissing = source === 'unknown' && auth.kind === 'none' && models.length === 0;
		const isOAuth = auth.kind === 'oauth';
		const canSwitch = !isMissing;
		const canEdit = !isMissing && !isOAuth && auth.kind !== 'unknown';
		const canDelete = !isActive && !isOAuth && !isMissing && (auth.kind === 'api_key' || source === 'custom');
		records.push({
			providerId,
			displayName: metadata?.displayName ?? providerId,
			source,
			authKind: auth.kind,
			authStatus: auth.status,
			baseUrl: providerBaseUrl(entry, metadata),
			api: stringValue(entry?.api) || metadata?.api || '',
			models,
			isActive,
			isMissing,
			canEdit,
			canDelete,
			canSwitch
		});
	}

	return records.sort((left, right) => left.providerId.localeCompare(right.providerId));
}

function toDisplayProfile(record: PiProviderRecord, authValue: unknown): ProviderDisplayProfile {
	const auth = authInfo(authValue);
	const maskedApiKey =
		auth.kind === 'oauth'
			? auth.status === 'configured'
				? 'OAuth 已登录（令牌由 Pi 管理）'
				: 'OAuth 凭据不完整，请通过 Pi 原生 /login 修复'
			: auth.apiKey
				? maskApiKey(auth.apiKey)
				: auth.kind === 'none'
					? '未配置 API Key'
					: '认证状态未知';
	return {
		key: record.providerId,
		baseUrl: record.baseUrl,
		authToken: '',
		profilePath: record.providerId,
		isActive: record.isActive,
		maskedApiKey,
		providerId: record.providerId,
		displayName: record.displayName,
		authKind: record.authKind,
		authStatus: record.authStatus,
		source: record.source,
		modelCount: record.models.length,
		modelIds: record.models.map(model => model.id),
		canEdit: record.canEdit,
		canDelete: record.canDelete,
		canSwitch: record.canSwitch,
		isMissing: record.isMissing
	};
}

export function loadPiProviderRecords(): readonly PiProviderRecord[] {
	const {documents} = readPiDocumentsForDisplay();
	return normalizePiProviderRecords(documents);
}

export function loadPiProviderDisplay(): ProviderDisplayData {
	const {documents, failures} = readPiDocumentsForDisplay();
	const records = normalizePiProviderRecords(documents);
	return {
		profiles: records.map(record => toDisplayProfile(record, documents.auth[record.providerId])),
		activeKey: stringValue(documents.settings.defaultProvider),
		hasProviders: records.length > 0,
		loadFailures: failures
	};
}

/** Provider ID is the logical identity. The optional model argument is ignored for old callers. */
export function piProviderKey(provider: string, _model?: string): string {
	return provider.trim();
}

/** Compatibility parser: new Pi identities are plain provider IDs, never provider/model pairs. */
export function parsePiProviderKey(key: string): {readonly provider: string; readonly model: ''} | null {
	const provider = key.trim();
	if (!provider || provider.includes('::') || provider.includes('/')) return null;
	return {provider, model: ''};
}

export function piProviderModelSummary(providerId: string): string {
	const record = loadPiProviderRecords().find(item => item.providerId === providerId);
	return record ? `${record.providerId} · ${record.models.length} 个模型` : providerId;
}

export function loadPiProviderProfile(providerId: string): PiProviderProfile | null {
	const parsed = parsePiProviderKey(providerId);
	if (!parsed) return null;
	const documents = {
		models: readObject(piModelsJsonPath(), 'models.json'),
		auth: readObject(piAuthJsonPath(), 'auth.json'),
		settings: readObject(piSettingsPath(), 'settings.json')
	};
	const record = normalizePiProviderRecords(documents).find(item => item.providerId === parsed.provider);
	if (!record) return null;
	const auth = authInfo(documents.auth[record.providerId]);
	return {
		key: record.providerId,
		provider: record.providerId,
		model: record.models[0]?.id ?? '',
		models: record.models,
		baseUrl: record.baseUrl,
		apiKey: auth.apiKey,
		profilePath: record.providerId,
		api: record.api
	};
}

export function piChatGptStatus(): {readonly loggedIn: boolean} {
	const auth = readObject(piAuthJsonPath(), 'auth.json');
	const info = authInfo(auth[PI_CHATGPT_PROVIDER]);
	return {loggedIn: info.kind === 'oauth' && info.status === 'configured'};
}

function normalizeModelIds(values: readonly unknown[] | string): readonly string[] {
	const raw = typeof values === 'string' ? values.split(/[\n,]/u) : values.flatMap(value => [modelId(value)]);
	return [...new Set(raw.map(value => String(value).trim()).filter(Boolean))];
}

export function parsePiModelIds(values: readonly unknown[] | string): readonly string[] {
	return normalizeModelIds(values);
}

function modelValuesFromProfile(profile: PiProviderProfile | null, values: PiProviderFormValues): readonly string[] {
	const fromModels = normalizeModelIds(values.models);
	if (fromModels.length > 0) return fromModels;
	if (values.model.trim()) return [values.model.trim()];
	return profile?.models.map(model => model.id) ?? [];
}

function setModelsEntry(root: JsonObject, providerId: string, values: PiProviderFormValues, profile: PiProviderProfile | null): JsonObject {
	const next = {...root};
	const nested = isObject(next.providers) || Object.keys(next).length === 0;
	const container = nested ? {...(isObject(next.providers) ? next.providers : {})} : {...modelProviderContainer(next)};
	const existing = isObject(container[providerId]) ? {...container[providerId]} : {};
	const existingModels = modelsArray(existing);
	const requestedIds = modelValuesFromProfile(profile, values);
	// Form model IDs are authoritative so checkbox deselection persists. Keep the existing
	// model objects for IDs that remain selected, including provider-specific metadata.
	const ids = requestedIds;
	const byId = new Map(existingModels.map(model => [model.id, model]));
	for (const id of requestedIds) byId.set(id, {...byId.get(id), id});
	const nextEntry: JsonObject = {
		...existing,
		baseUrl: values.baseUrl.trim(),
		api: values.api ?? existing.api ?? 'openai-completions',
		models: ids.map(id => byId.get(id) ?? {id})
	};
	container[providerId] = nextEntry;
	if (nested) next.providers = container;
	else {
		for (const key of Object.keys(next)) {
			if (key !== 'providers' && key !== 'defaultProvider' && isObject(next[key])) delete next[key];
		}
		for (const [key, value] of Object.entries(container)) next[key] = value;
	}
	return next;
}

function setAuthEntry(root: JsonObject, providerId: string, apiKey: string): JsonObject {
	const next = {...root};
	const old = next[providerId];
	if (authInfo(old).kind === 'oauth') throw new Error('该供应商使用 OAuth，请通过 Pi 原生登录管理');
	if (isObject(old)) {
		const entry: JsonObject = {...old, type: 'api_key', key: apiKey};
		if ('apiKey' in old && !('key' in old)) entry['apiKey'] = apiKey;
		next[providerId] = entry;
	} else {
		next[providerId] = {type: 'api_key', key: apiKey};
	}
	return next;
}

function removeProviderDefinition(root: JsonObject, providerId: string): JsonObject {
	const next = {...root};
	if (isObject(next.providers)) {
		next.providers = {...next.providers};
		delete (next.providers as JsonObject)[providerId];
		return next;
	}
	delete next[providerId];
	return next;
}

function removeAuthEntry(root: JsonObject, providerId: string): JsonObject {
	const next = {...root};
	delete next[providerId];
	return next;
}

type FileSnapshot = {readonly exists: boolean; readonly content?: string};

function snapshotFile(path: string): FileSnapshot {
	return existsSync(path) ? {exists: true, content: readFileSync(path, 'utf8')} : {exists: false};
}

function restoreFile(path: string, snapshot: FileSnapshot): void {
	if (snapshot.exists) atomicWrite(path, snapshot.content ?? '', {mode: SECRET_FILE_MODE});
	else if (existsSync(path)) unlinkSync(path);
}

function writePiJsonTransaction(changes: readonly {readonly path: string; readonly value: JsonObject}[]): void {
	const snapshots = new Map(changes.map(change => [change.path, snapshotFile(change.path)]));
	const written: string[] = [];
	try {
		for (const change of changes) {
			writeJsonAtomic(change.path, change.value, {mode: SECRET_FILE_MODE});
			written.push(change.path);
		}
	} catch (error) {
		for (const path of written.reverse()) {
			const snapshot = snapshots.get(path);
			if (snapshot) restoreFile(path, snapshot);
		}
		throw error;
	}
}

function validateExistingJsonFiles(): PiDocuments {
	return {
		models: readObject(piModelsJsonPath(), 'models.json'),
		auth: readObject(piAuthJsonPath(), 'auth.json'),
		settings: readObject(piSettingsPath(), 'settings.json')
	};
}

function metadataFor(providerId: string): PiProviderMetadata | undefined {
	return registryMap().get(providerId);
}

function resolveProfileInput(input: PiProviderFormInput): {readonly providerId: string; readonly profile: PiProviderProfile | null} {
	const providerId = input.providerId ?? input.profileKey ?? input.profile?.provider ?? '';
	return {providerId: providerId.trim(), profile: input.profile ?? (providerId ? loadPiProviderProfile(providerId) : null)};
}

export function savePiProvider(values: PiProviderFormValues, input: PiProviderFormInput): PiProviderSaveResult {
	const providerId = values.provider.trim();
	const api = values.api?.trim() || 'openai-completions';
	const profileInput = resolveProfileInput(input);
	const oldProviderId = profileInput.providerId;
	const oldProfile = profileInput.profile;
	if (!providerId) throw new Error('Pi Provider ID 不能为空');
	if (!PI_APIS.includes(api as PiApi)) throw new Error('不支持的 Pi API 协议');
	if (input.mode === 'edit' && (!oldProviderId || oldProviderId !== providerId || !oldProfile)) {
		throw new Error('编辑 Pi Provider 缺少有效的 provider ID');
	}
	if (input.mode === 'add' && metadataFor(providerId)) {
		throw new Error(`Provider ${providerId} 是 Pi 内置 Provider；新增只能创建 API Key 自定义 Provider`);
	}
	const apiKey = values.apiKey.trim() || oldProfile?.apiKey || '';
	if (!apiKey) throw new Error('API Key 不能为空');

	return withProfileLock(() => {
		const current = validateExistingJsonFiles();
		const currentRecord = normalizePiProviderRecords(current).find(item => item.providerId === providerId);
		if (
			input.mode === 'add' &&
			(metadataFor(providerId) || providerEntry(current.models, providerId) !== null || current.auth[providerId] !== undefined)
		) {
			throw new Error(`Provider ${providerId} 已存在，新增不会覆盖现有配置，请改用编辑`);
		}
		if (currentRecord?.authKind === 'oauth') throw new Error('OAuth Provider 只读，请通过 Pi 原生登录管理');
		const currentEntry = providerEntry(current.models, providerId);
		const authOnlyBuiltinEdit =
			input.mode === 'edit' && currentRecord?.source === 'builtin' && currentEntry === null && !values.baseUrl.trim();
		if (!authOnlyBuiltinEdit && (!values.baseUrl.trim() || !/^https?:\/\//iu.test(values.baseUrl.trim()))) {
			throw new Error('API Key 自定义 Provider 必须填写 http(s) Base URL');
		}
		const models = modelValuesFromProfile(oldProfile, values);
		if (!authOnlyBuiltinEdit && models.length === 0) throw new Error('至少填写一个 Pi 模型');
		const targetValues: PiProviderFormValues = {...values, api, models: models.join('\n'), model: models[0] ?? ''};
		const nextAuth = setAuthEntry(current.auth, providerId, apiKey);
		const changes = [
			...(authOnlyBuiltinEdit
				? []
				: [{path: piModelsJsonPath(), value: setModelsEntry(current.models, providerId, targetValues, oldProfile)}]),
			{path: piAuthJsonPath(), value: nextAuth},
			...(input.mode === 'add' && values.activateAfterSave
				? [{path: piSettingsPath(), value: {...current.settings, defaultProvider: providerId}}]
				: [])
		];
		writePiJsonTransaction(changes);
		return {
			key: providerId,
			provider: providerId,
			model: models[0] ?? '',
			models: models.map(id => ({id})),
			baseUrl: values.baseUrl.trim() || currentRecord?.baseUrl || '',
			apiKey,
			profilePath: providerId,
			api
		};
	});
}

export function switchPiProvider(providerId: string): {readonly success: true; readonly providerName: string} {
	const parsed = parsePiProviderKey(providerId);
	if (!parsed) throw new Error(`非法 Pi Provider ID: ${providerId}`);
	return withProfileLock(() => {
		const current = validateExistingJsonFiles();
		const record = normalizePiProviderRecords(current).find(item => item.providerId === parsed.provider);
		if (!record || !record.canSwitch) throw new Error(`Pi Provider 不存在或不可切换: ${parsed.provider}`);
		// Only defaultProvider is ccq-owned here. All other Pi settings are copied untouched.
		writeJsonAtomic(piSettingsPath(), {...current.settings, defaultProvider: parsed.provider}, {mode: SECRET_FILE_MODE});
		return {success: true, providerName: record.displayName};
	});
}

export function deletePiProvider(providerId: string): {
	readonly deleted: true;
	readonly removedModels: boolean;
	readonly removedAuth: boolean;
} {
	const parsed = parsePiProviderKey(providerId);
	if (!parsed) throw new Error(`非法 Pi Provider ID: ${providerId}`);
	return withProfileLock(() => {
		const current = validateExistingJsonFiles();
		const record = normalizePiProviderRecords(current).find(item => item.providerId === parsed.provider);
		if (!record) throw new Error(`Pi Provider 不存在: ${parsed.provider}`);
		if (record.isActive) throw new Error(`无法删除当前激活 Pi Provider: ${parsed.provider}，请先切换到其他 Provider`);
		if (record.authKind === 'oauth') throw new Error('OAuth Provider 只读，请通过 Pi 原生 /logout 管理');
		if (record.authKind === 'unknown') throw new Error('Provider 认证状态未知，拒绝删除以保护凭据');

		const changes: {readonly path: string; readonly value: JsonObject}[] = [];
		let removedModels = false;
		let removedAuth = false;
		if (record.source === 'custom') {
			changes.push({path: piModelsJsonPath(), value: removeProviderDefinition(current.models, parsed.provider)});
			removedModels = providerEntry(current.models, parsed.provider) !== null;
		}
		if (record.authKind === 'api_key') {
			changes.push({path: piAuthJsonPath(), value: removeAuthEntry(current.auth, parsed.provider)});
			removedAuth = current.auth[parsed.provider] !== undefined;
		}
		if (changes.length > 0) writePiJsonTransaction(changes);
		return {deleted: true, removedModels, removedAuth};
	});
}

export type PiModelDiscoveryOptions = {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
	readonly fetchImpl?: typeof fetch;
};

export type PiModelDiscoveryResult =
	| {readonly ok: true; readonly endpoint: string; readonly models: readonly PiModelDefinition[]}
	| {readonly ok: false; readonly kind: 'unsupported' | 'cancelled' | 'timeout' | 'network' | 'http' | 'invalid'; readonly error: string};

export function buildPiModelDiscoveryEndpoint(baseUrl: string, api: string): string | null {
	if (api !== 'openai-completions' && api !== 'openai-responses') return null;
	let url: URL;
	try {
		url = new URL(baseUrl.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	const path = url.pathname.replace(/\/+$/u, '');
	if (/\/models$/iu.test(path)) return url.toString();
	if (/\/v1$/iu.test(path)) {
		url.pathname = `${path}/models`;
		return url.toString();
	}
	url.pathname = `${path}/v1/models`;
	return url.toString();
}

export const buildModelDiscoveryEndpoint = buildPiModelDiscoveryEndpoint;

function discoveryModels(payload: unknown): readonly PiModelDefinition[] {
	const values = Array.isArray(payload)
		? payload
		: isObject(payload) && Array.isArray(payload.data)
			? payload.data
			: isObject(payload) && Array.isArray(payload.models)
				? payload.models
				: [];
	const unique = new Map<string, PiModelDefinition>();
	for (const value of values) {
		const model = modelObject(value);
		if (model) unique.set(model.id, model);
	}
	return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function normalizePiDiscoveredModels(payload: unknown): readonly PiModelDefinition[] {
	return discoveryModels(payload);
}

export async function discoverPiModels(input: {
	readonly baseUrl: string;
	readonly api: string;
	readonly apiKey?: string;
	readonly options?: PiModelDiscoveryOptions;
}): Promise<PiModelDiscoveryResult> {
	const endpoint = buildPiModelDiscoveryEndpoint(input.baseUrl, input.api);
	if (!endpoint) return {ok: false, kind: 'unsupported', error: '该 Pi API 协议没有可用的模型发现接口，请手工填写模型 ID'};
	const options = input.options ?? {};
	const timeoutMs = Math.max(1, options.timeoutMs ?? 10000);
	const maxResponseBytes = Math.max(1024, options.maxResponseBytes ?? 2 * 1024 * 1024);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const abort = () => controller.abort();
	options.signal?.addEventListener('abort', abort, {once: true});
	try {
		if (options.signal?.aborted) return {ok: false, kind: 'cancelled', error: '模型发现已取消'};
		const fetchImpl = options.fetchImpl ?? fetch;
		const response = await fetchImpl(endpoint, {
			headers: input.apiKey ? {Authorization: `Bearer ${input.apiKey}`, Accept: 'application/json'} : {Accept: 'application/json'},
			signal: controller.signal
		});
		if (!response.ok) return {ok: false, kind: 'http', error: `模型发现请求失败（HTTP ${response.status}）`};
		const contentLength = Number(response.headers.get('content-length') ?? '0');
		if (Number.isFinite(contentLength) && contentLength > maxResponseBytes)
			return {ok: false, kind: 'invalid', error: '模型发现响应过大，已停止解析'};
		const raw = await response.text();
		if (new TextEncoder().encode(raw).byteLength > maxResponseBytes)
			return {ok: false, kind: 'invalid', error: '模型发现响应过大，已停止解析'};
		let payload: unknown;
		try {
			payload = JSON.parse(raw) as unknown;
		} catch {
			return {ok: false, kind: 'invalid', error: '模型发现响应不是合法 JSON'};
		}
		const models = discoveryModels(payload);
		if (models.length === 0) return {ok: false, kind: 'invalid', error: '模型发现响应未包含可用模型 ID'};
		return {ok: true, endpoint, models};
	} catch (error) {
		if (options.signal?.aborted) return {ok: false, kind: 'cancelled', error: '模型发现已取消'};
		if (timedOut || (error instanceof Error && error.name === 'AbortError'))
			return {ok: false, kind: 'timeout', error: '模型发现请求超时'};
		return {ok: false, kind: 'network', error: '模型发现请求失败，请检查 Base URL、网络或 API Key'};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', abort);
	}
}

export function mergePiModels(existing: readonly unknown[] | string, additions: readonly unknown[]): readonly PiModelDefinition[] {
	const result = new Map<string, PiModelDefinition>();
	for (const model of modelList(typeof existing === 'string' ? existing.split(/[\n,]/u) : existing)) result.set(model.id, model);
	for (const model of modelList(additions)) result.set(model.id, {...result.get(model.id), ...model, id: model.id});
	return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Commit only after the user confirms discovery candidates; no auth/settings write is involved. */
export function commitPiDiscoveredModels(providerId: string, additions: readonly unknown[]): readonly PiModelDefinition[] {
	const parsed = parsePiProviderKey(providerId);
	if (!parsed) throw new Error(`非法 Pi Provider ID: ${providerId}`);
	const models = modelList(additions);
	if (models.length === 0) throw new Error('没有可保存的模型');
	return withProfileLock(() => {
		const currentModels = readObject(piModelsJsonPath(), 'models.json');
		const entry = providerEntry(currentModels, parsed.provider);
		if (!entry) throw new Error(`Pi Provider 不存在于 models.json: ${parsed.provider}`);
		const merged = mergePiModels(modelsArray(entry), models);
		const nextEntry = {...entry, models: merged};
		const root = {...currentModels};
		if (isObject(root.providers)) root.providers = {...root.providers, [parsed.provider]: nextEntry};
		else root[parsed.provider] = nextEntry;
		writeJsonAtomic(piModelsJsonPath(), root, {mode: SECRET_FILE_MODE});
		return merged;
	});
}

export const savePiDiscoveredModels = commitPiDiscoveredModels;

export function piBuiltinTemplates(): readonly {
	readonly key: string;
	readonly label: string;
	readonly baseUrl: string;
	readonly model: string;
	readonly api: string;
	readonly note: string;
}[] {
	return loadPiProviderRegistry().map(item => ({
		key: item.providerId,
		label: item.displayName,
		baseUrl: item.baseUrl ?? '',
		model: item.models[0]?.id ?? '',
		api: item.api,
		note: item.oauth ? 'OAuth 由 Pi 原生 /login 管理，ccq 仅只读展示。' : 'Pi 内置 Provider 元数据。'
	}));
}

export function buildPiProviderFormFields(values: PiProviderFormValues, mode: PiProviderFormMode): readonly FormField[] {
	return [
		{
			id: 'provider',
			type: mode === 'edit' ? 'readonly' : 'text',
			label: 'Provider ID',
			value: values.provider,
			helpText: '按 Pi provider ID 保存；新增时不能与 Pi 内置 provider ID 冲突。'
		},
		{
			id: 'baseUrl',
			type: 'text',
			label: 'Base URL',
			value: values.baseUrl,
			helpText: '必填 http(s) 地址；OpenAI-compatible discovery 会派生 /v1/models。'
		},
		{
			id: 'api',
			type: 'radio',
			label: 'API 协议',
			value: values.api ?? 'openai-completions',
			options: PI_APIS.map(api => ({value: api, label: api})),
			helpText: '协议决定 discovery 是否可用。'
		},
		{
			id: 'apiKey',
			type: 'secret',
			label: 'API Key',
			value: values.apiKey,
			helpText: '只写入 auth.json；展示与错误均脱敏。留空编辑时保留已有凭据。'
		},
		...(mode === 'edit'
			? []
			: [
					{
						id: 'activateAfterSave',
						type: 'radio' as const,
						label: '保存后激活',
						value: values.activateAfterSave ? 'yes' : 'no',
						options: [
							{value: 'yes', label: '是'},
							{value: 'no', label: '否'}
						],
						helpText:
							'激活即把该 Pi Provider 写入 ~/.pi/agent/settings.json 的 defaultProvider；选「否」仅保存，之后可在列表中切换。'
					}
				])
	];
}

export function buildPiProviderFormModel(input: PiProviderFormInput): PiProviderFormModel {
	const identity = input.providerId ?? input.profileKey ?? '';
	const profile = input.profile ?? (identity ? loadPiProviderProfile(identity) : null);
	const models = profile?.models.map(model => model.id) ?? [];
	const values: PiProviderFormValues = {
		providerType: 'custom-api-key',
		api: profile?.api ?? 'openai-completions',
		provider: profile?.provider ?? '',
		model: profile?.model ?? '',
		models: models.join('\n'),
		baseUrl: profile?.baseUrl ?? '',
		apiKey: profile?.apiKey ?? '',
		activateAfterSave: input.mode !== 'edit'
	};
	const fields = buildPiProviderFormFields(values, input.mode);
	return {mode: input.mode, fields, values};
}

export function validatePiProviderForm(mode: PiProviderFormMode, values: PiProviderFormValues): string[] {
	const errors: string[] = [];
	if (!values.provider.trim()) errors.push('Provider ID 不能为空');
	if (values.api && !PI_APIS.includes(values.api as PiApi)) errors.push('不支持的 API 协议');
	if (values.baseUrl.trim() && !/^https?:\/\//iu.test(values.baseUrl.trim())) errors.push('Base URL 必须是 http(s) 地址');
	if (mode === 'add' && !values.baseUrl.trim()) errors.push('Base URL 必须是 http(s) 地址');
	if (normalizeModelIds(values.models).length === 0) errors.push('至少添加一个模型');
	if (mode === 'add' && !values.apiKey.trim()) errors.push('API Key 不能为空');
	return errors;
}
