import {existsSync, readFileSync, unlinkSync} from 'node:fs';
import {atomicWrite, readJsonFileStrict, SECRET_FILE_MODE, withProfileLock, writeJsonAtomic} from './fs-utils.js';
import {loadContract} from './contracts.js';
import {piAuthJsonPath, piModelsJsonPath, piModelsStorePath, piSettingsPath} from './paths.js';
import {maskApiKey} from './text-utils.js';
import {
	buildModelDiscoveryEndpoint as buildSharedModelDiscoveryEndpoint,
	discoverModels,
	normalizeDiscoveredModels
} from './model-discovery.js';
import {PI_APIS, isPiApi, piApiDiscoveryStrategy} from './pi-api-discovery.js';
import type {PiApi, PiFormApi} from './pi-api-discovery.js';
import {
	authHeaderApplies,
	formatHeaderJson,
	headerPresetMatchesApi,
	isControlledHeaderPresetApi,
	matchedHeaderPreset,
	normalizeHeaderEntries,
	parseHeaderJson,
	piHeaderPreset,
	piHeaderPresetOptions,
	resolveHeaderPresetSelection,
	suggestHeaderPreset,
	validateHeaderName
} from './pi-header-preset.js';
import {resolvePiModelSources, resolvePiRelatedSources, stripNonPortableModelFields} from './pi-model-catalog.js';
import type {PiCatalogIndex, PiCatalogSource} from './pi-model-catalog.js';
import type {ProviderDisplayData, ProviderDisplayProfile} from './provider.js';
import type {FormField} from '../components/form/field-types.js';

export {PI_APIS, PI_KNOWN_APIS} from './pi-api-discovery.js';
export type {PiApi, PiFormApi} from './pi-api-discovery.js';

type JsonObject = Record<string, unknown>;

/** Pi 当前 KnownApi 全集由 discovery strategy registry 拥有，此处只做兼容再导出。 */

/** Deprecated compatibility marker. Pi OAuth providers are never addable by ccq. */
export const PI_CHATGPT_KEY = 'openai-codex';
export const PI_CHATGPT_PROVIDER = 'openai-codex';

export type PiModelDefinition = JsonObject & {readonly id: string};

/** 模型来源解析状态；判定在 core，view 只消费。 */
export type PiModelResolution =
	| {readonly kind: 'idle'}
	| {readonly kind: 'matching'}
	| {readonly kind: 'automatic'; readonly source: PiCatalogSource}
	| {readonly kind: 'chosen'; readonly source: PiCatalogSource}
	| {readonly kind: 'conflict'; readonly sources: readonly PiCatalogSource[]}
	| {readonly kind: 'upstream-only'};

/**
 * 表单草稿中的单个模型候选。`sources` 仅为该 id + 当前 api 的目录来源；其它 API 的同 ID
 * 条目只进 `relatedSources` 供只读展示，绝不参与选择或合并。
 */
export type PiModelCandidate = {
	readonly id: string;
	readonly upstreamDefinition: PiModelDefinition;
	readonly existingDefinition: PiModelDefinition | null;
	readonly sources: readonly PiCatalogSource[];
	readonly relatedSources: readonly PiCatalogSource[];
	readonly resolution: PiModelResolution;
};

function isPlainObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 单层字段合并（high 优先）：嵌套对象按 key 递归，数组仅在非空时整体替换，
 * `undefined`/空字符串/空对象/空数组不覆盖低优先级已有值（只补缺，不降级）。
 */
function mergeDefinitionValue(low: unknown, high: unknown): unknown {
	if (high === undefined) return low;
	if (typeof high === 'string' && high.trim() === '') return low;
	if (isPlainObject(low) && isPlainObject(high)) {
		const result: JsonObject = {...low};
		for (const [key, value] of Object.entries(high)) {
			const merged = mergeDefinitionValue(result[key], value);
			if (merged !== undefined) result[key] = merged;
		}
		return result;
	}
	if (Array.isArray(high)) return high.length > 0 ? [...high] : low;
	return high;
}

/**
 * 按 layers 顺序（低 -> 高优先级）合并模型定义。
 * 典型顺序：`{id} < 官方目录来源 < 上游 /models < 已有 models.json < 当前显式修改`。
 */
export function mergePiModelDefinitions(layers: readonly (PiModelDefinition | null | undefined)[]): PiModelDefinition {
	const result: JsonObject = {};
	for (const layer of layers) {
		if (!layer) continue;
		for (const [key, value] of Object.entries(layer)) {
			const merged = mergeDefinitionValue(result[key], value);
			if (merged !== undefined) result[key] = merged;
		}
	}
	return result as PiModelDefinition;
}

/** 创建未匹配的 Pi 模型候选；初始 resolution 为 idle，不提前查询官方目录。 */
export function createPiModelCandidate(input: {
	readonly id: string;
	readonly upstreamDefinition?: PiModelDefinition | null;
	readonly existingDefinition?: PiModelDefinition | null;
}): PiModelCandidate {
	return {
		id: input.id,
		upstreamDefinition: input.upstreamDefinition ?? {id: input.id},
		existingDefinition: input.existingDefinition ?? null,
		sources: [],
		relatedSources: [],
		resolution: {kind: 'idle'}
	};
}

/** 当前 API 下无来源 => upstream-only；唯一来源自动采用；多个同 API 来源 => conflict。 */
export function classifyPiModelResolution(sources: readonly PiCatalogSource[]): PiModelResolution {
	if (sources.length === 0) return {kind: 'upstream-only'};
	const [first] = sources;
	if (sources.length === 1 && first) return {kind: 'automatic', source: first};
	return {kind: 'conflict', sources};
}

/**
 * 精确 resolve 模型候选：只做 ID 完全相等 + api 严格相等；catalog 未加载时降级为空来源，
 * 不抛异常、不模糊匹配。
 */
export function resolvePiModelCandidate(input: {
	readonly id: string;
	readonly api: string;
	readonly upstreamDefinition?: PiModelDefinition | null;
	readonly existingDefinition?: PiModelDefinition | null;
	readonly catalog?: PiCatalogIndex | null;
}): PiModelCandidate {
	const sources = input.catalog ? resolvePiModelSources(input.catalog, input.id, input.api) : [];
	const relatedSources = input.catalog ? resolvePiRelatedSources(input.catalog, input.id, input.api) : [];
	return {
		...createPiModelCandidate({
			id: input.id,
			upstreamDefinition: input.upstreamDefinition,
			existingDefinition: input.existingDefinition
		}),
		sources,
		relatedSources,
		resolution: classifyPiModelResolution(sources)
	};
}

/** 候选当前采用的目录来源（automatic/chosen）；其余 resolution 返回 null。 */
export function piModelCatalogSource(candidate: PiModelCandidate): PiCatalogSource | null {
	if (candidate.resolution.kind === 'automatic' || candidate.resolution.kind === 'chosen') return candidate.resolution.source;
	return null;
}

/** 采用目录来源时整体替换的嵌套对象：价格、思考等级与兼容配置必须来自同一条来源，
 * 不能与旧值按键混合，否则会拼出跨来源配置（本任务的核心约束）。 */
const SOURCE_WHOLE_REPLACE_KEYS = ['cost', 'thinkingLevelMap', 'compat'] as const;

/**
 * 计算最终将写入 models.json 的模型定义：
 * `{id} < 上游 < 已有用户配置 < 已解析的目录来源`。
 * 只要该模型解析出目录来源（自动匹配或用户显式选择），来源就覆盖已有配置与上游；来源未
 * 提到的字段与未知扩展字段保留。未解析出来源（idle / conflict / upstream-only）时只补缺。
 * `source === undefined` 时采用 resolution 已确定的来源；显式传 null 表示不采用目录来源。
 */
export function piModelDefinitionFor(candidate: PiModelCandidate, source?: PiCatalogSource | null): PiModelDefinition {
	const catalogSource = source === undefined ? piModelCatalogSource(candidate) : source;
	const definition = catalogSource?.definition ?? null;
	const merged = mergePiModelDefinitions([{id: candidate.id}, candidate.upstreamDefinition, candidate.existingDefinition, definition]);
	if (definition) {
		for (const key of SOURCE_WHOLE_REPLACE_KEYS) {
			if (definition[key] !== undefined) merged[key] = definition[key];
		}
	}
	return merged;
}

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
	/** 是否可编辑传输层覆盖（仅 headers / authHeader），与凭据侧 `canEdit` 正交。 */
	readonly canEditTransport: boolean;
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
	/** models.json 中的 provider 级请求头（仅字符串值）。 */
	readonly headers: Readonly<Record<string, string>>;
	/** models.json 中的 `authHeader: true`。 */
	readonly authHeader: boolean;
};

export type PiProviderFormMode = 'add' | 'edit';

/**
 * 表单变体：`full` 是完整的 API Key 自定义 Provider；`transport-only` 只允许为
 * 内置 / `/login` Provider 写「仅 headers / authHeader」的 models.json 覆盖条目。
 */
export type PiProviderFormVariant = 'full' | 'transport-only';

/** 认证头形态字段的取值；非 anthropic 协议不落盘。 */
export type PiAuthHeaderMode = 'default' | 'bearer';

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
	/**
	 * 已解析的完整模型定义快照（Pi 表单草稿）：与 `models` 的 ID 集合同步，
	 * 不是第二个持久配置源，只用于确保 Ctrl+S 写入与用户预览一致。
	 */
	readonly modelDefinitions?: readonly PiModelDefinition[];
	readonly baseUrl: string;
	readonly apiKey: string;
	/** 请求头编辑区原始文本；它是 `providers.<id>.headers` 的唯一真相源。 */
	readonly headers: string;
	/** 认证头形态（仅 anthropic-messages 可见与落盘）。 */
	readonly authHeader: PiAuthHeaderMode;
	/** 请求头预设动作行的高亮项 key；只是光标，不落盘。 */
	readonly headerPreset: string;
	readonly variant: PiProviderFormVariant;
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

/** 只读取字符串值的 provider 级请求头；非字符串值不得进入表单或落盘。 */
function headerRecord(value: unknown): Record<string, string> {
	if (!isObject(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === 'string') result[key] = item;
	}
	return result;
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

type PiRuntimeCatalogEntry = {
	readonly api: string;
	readonly baseUrl: string;
	/** 已剥离 provider/baseUrl/headers/api：目录传输字段绝不进入模型定义。 */
	readonly models: readonly PiModelDefinition[];
};

/**
 * 读取 Pi runtime 的 Provider 目录缓存 `~/.pi/agent/models-store.json`，作为**最低优先级**的
 * 展示元数据来源：它由 Pi 按远端目录刷新，能补全 ccq 快照未收录的内置 Provider（如 deepseek）。
 *
 * 只读且不写回（该文件归 Pi runtime 所有）。缓存缺失、损坏或结构不符时静默降级为空：它是可重建的
 * 运行时缓存，不是 ccq 拥有的配置文件，不得阻断或污染 Provider 列表展示与 Provider 写入。
 */
function readPiRuntimeCatalog(): ReadonlyMap<string, PiRuntimeCatalogEntry> {
	const result = readJsonFileStrict<unknown>(piModelsStorePath());
	if (result.status !== 'valid' || !isObject(result.value)) return new Map();

	const catalog = new Map<string, PiRuntimeCatalogEntry>();
	for (const [providerId, value] of Object.entries(result.value)) {
		if (!providerId || !isObject(value) || !Array.isArray(value.models)) continue;
		const models = modelList(value.models);
		if (models.length === 0) continue;
		catalog.set(providerId, {
			api: models.map(model => stringValue(model.api)).find(hasText) ?? '',
			baseUrl: models.map(model => stringValue(model.baseUrl)).find(hasText) ?? '',
			models: models.map(model => stripNonPortableModelFields({...model}))
		});
	}
	return catalog;
}

function mergeModels(
	catalogModels: readonly PiModelDefinition[],
	metadata: readonly PiModelDefinition[],
	configured: readonly PiModelDefinition[]
): readonly PiModelDefinition[] {
	const result = new Map<string, PiModelDefinition>();
	for (const model of catalogModels) result.set(model.id, {...model});
	for (const model of metadata) result.set(model.id, {...result.get(model.id), ...model, id: model.id});
	for (const model of configured) result.set(model.id, {...result.get(model.id), ...model, id: model.id});
	return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function normalizePiProviderRecords(documents: PiDocuments): readonly PiProviderRecord[] {
	const registry = registryMap();
	const runtimeCatalog = readPiRuntimeCatalog();
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
		const catalogEntry = runtimeCatalog.get(providerId);
		const entry = providerEntry(documents.models, providerId);
		const auth = authInfo(documents.auth[providerId]);
		const configuredModels = entry ? modelsArray(entry) : [];
		// 展示优先级由低到高：Pi runtime 目录缓存 < ccq 快照 < 用户 models.json。
		const models = mergeModels(catalogEntry?.models ?? [], metadata?.models ?? [], configuredModels);
		const isBuiltin = metadata !== undefined || catalogEntry !== undefined;
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
		// 只有 models.json 中定义的 provider 可编辑：数据源在 auth.json 的（含 /login 创建）由 Pi 原生管理。
		const canEdit = hasDefinition && !isMissing && !isOAuth && auth.kind !== 'unknown';
		// 传输层覆盖有意放宽「只有 models.json 定义过的 Provider 可由 ccq 编辑」：内置 / `/login`
		// Provider 也可写仅含 headers / authHeader 的覆盖条目，凭据仍留在 auth.json（只读）。
		const canEditTransport =
			auth.kind !== 'unknown' && !isMissing && (hasDefinition || metadata !== undefined || catalogEntry !== undefined);
		// 与 canEdit 同样要求 models.json 定义：auth.json 数据源（含 /login 创建）由 Pi 原生管理。
		const canDelete = hasDefinition && !isActive && !isOAuth && !isMissing && (auth.kind === 'api_key' || source === 'custom');
		records.push({
			providerId,
			displayName: metadata?.displayName ?? providerId,
			source,
			authKind: auth.kind,
			authStatus: auth.status,
			baseUrl: providerBaseUrl(entry, metadata) || catalogEntry?.baseUrl || '',
			api: stringValue(entry?.api) || metadata?.api || catalogEntry?.api || '',
			models,
			isActive,
			isMissing,
			canEdit,
			canDelete,
			canEditTransport
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
		isMissing: record.isMissing,
		canEditTransport: record.canEditTransport
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
		settings: {}
	};
	const record = normalizePiProviderRecords(documents).find(item => item.providerId === parsed.provider);
	if (!record) return null;
	const auth = authInfo(documents.auth[record.providerId]);
	const entry = providerEntry(documents.models, record.providerId);
	return {
		key: record.providerId,
		provider: record.providerId,
		model: record.models[0]?.id ?? '',
		models: record.models,
		baseUrl: record.baseUrl,
		apiKey: auth.apiKey,
		profilePath: record.providerId,
		api: record.api,
		headers: headerRecord(entry?.headers),
		authHeader: entry?.authHeader === true
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

/** models.json 的 providers 容器：嵌套在 `providers` 下或平铺在根级两种历史形态。 */
function providerContainer(root: JsonObject): {readonly nested: boolean; readonly container: JsonObject} {
	const nested = isObject(root.providers) || Object.keys(root).length === 0;
	return {nested, container: nested ? {...(isObject(root.providers) ? root.providers : {})} : {...modelProviderContainer(root)}};
}

/** 把 providers 容器写回根级；空条目在调用方已删除，这里只负责形态。 */
function writeProviderContainer(root: JsonObject, nested: boolean, container: JsonObject): JsonObject {
	const next = {...root};
	if (nested) {
		next.providers = container;
		return next;
	}
	for (const key of Object.keys(next)) {
		if (key !== 'providers' && key !== 'defaultProvider' && isObject(next[key])) delete next[key];
	}
	for (const [key, value] of Object.entries(container)) next[key] = value;
	return next;
}

/** 只增删 `headers` / `authHeader`，其余字段原样保留。 */
function withHeaderFields(entry: JsonObject, headers: Readonly<Record<string, string>>, authHeader: boolean): JsonObject {
	const next = {...entry};
	const normalized = normalizeHeaderEntries(headers);
	if (Object.keys(normalized).length > 0) next.headers = normalized;
	else delete next.headers;
	if (authHeader) next.authHeader = true;
	else delete next.authHeader;
	return next;
}

/** 传输层覆盖：为内置 / `/login` Provider 写仅含 `headers` / `authHeader` 的 models.json 条目。 */
function setTransportOverlay(
	root: JsonObject,
	providerId: string,
	headers: Readonly<Record<string, string>>,
	authHeader: boolean
): JsonObject {
	const {nested, container} = providerContainer(root);
	const existing = isObject(container[providerId]) ? {...container[providerId]} : {};
	const nextEntry = withHeaderFields(existing, headers, authHeader);
	// 空对象条目会让 Pi 的 applyModelsJson 抛 `must specify "baseUrl", "headers", ...`，必须删条目而非留 `{}`。
	if (Object.keys(nextEntry).length === 0) delete container[providerId];
	else container[providerId] = nextEntry;
	return writeProviderContainer(root, nested, container);
}

function setModelsEntry(
	root: JsonObject,
	providerId: string,
	values: PiProviderFormValues,
	profile: PiProviderProfile | null
): {readonly root: JsonObject; readonly models: readonly PiModelDefinition[]} {
	const {nested, container} = providerContainer(root);
	const existing = isObject(container[providerId]) ? {...container[providerId]} : {};
	const existingById = new Map(modelsArray(existing).map(model => [model.id, model]));
	const draftById = new Map((values.modelDefinitions ?? []).map(model => [model.id, model]));
	const requestedIds = modelValuesFromProfile(profile, values);
	// Form model IDs are authoritative so checkbox deselection persists. Every retained ID keeps its
	// full definition: `{id} < 当前 models.json < 已解析草稿`，绝不用 `{id}` 或空值降级。
	const models = requestedIds.map(id => mergePiModelDefinitions([{id}, existingById.get(id) ?? null, draftById.get(id) ?? null]));
	const api = values.api ?? (hasText(existing.api) ? stringValue(existing.api) : 'openai-completions');
	const parsedHeaders = parseHeaderJson(values.headers ?? '');
	const headers = parsedHeaders.ok ? parsedHeaders.headers : {};
	const nextEntry: JsonObject = withHeaderFields(
		{...existing, baseUrl: values.baseUrl.trim(), api, models},
		headers,
		authHeaderApplies(api) && values.authHeader === 'bearer'
	);
	container[providerId] = nextEntry;
	return {root: writeProviderContainer(root, nested, container), models};
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

function validatePiProviderJsonFiles(): PiDocuments {
	return {
		models: readObject(piModelsJsonPath(), 'models.json'),
		auth: readObject(piAuthJsonPath(), 'auth.json'),
		settings: {}
	};
}

function validateExistingJsonFiles(): PiDocuments {
	return {...validatePiProviderJsonFiles(), settings: readObject(piSettingsPath(), 'settings.json')};
}

function metadataFor(providerId: string): PiProviderMetadata | undefined {
	return registryMap().get(providerId);
}

/**
 * 内置 Provider 判定：ccq 快照（pi-providers.json）或 Pi runtime 目录缓存（models-store.json）任一命中即可。
 * 这类 Provider 的端点与模型由 Pi 原生定义，ccq 只允许写传输层覆盖。
 */
function isBuiltinProvider(providerId: string): boolean {
	return metadataFor(providerId) !== undefined || readPiRuntimeCatalog().has(providerId);
}

/**
 * 表单专用 profile 加载：内置 Provider 可能既无 auth.json 凭据也未在 models.json 定义，
 * 此时 normalizePiProviderRecords 不会生成记录，需要从 registry / runtime 目录合成。
 */
function loadPiBuiltinProfile(providerId: string): PiProviderProfile | null {
	const metadata = metadataFor(providerId);
	const catalogEntry = readPiRuntimeCatalog().get(providerId);
	if (!metadata && !catalogEntry) return null;
	const modelsRoot = readObject(piModelsJsonPath(), 'models.json');
	const authRoot = readObject(piAuthJsonPath(), 'auth.json');
	const entry = providerEntry(modelsRoot, providerId);
	const auth = authInfo(authRoot[providerId]);
	const configuredModels = entry ? modelsArray(entry) : [];
	const models = mergeModels(catalogEntry?.models ?? [], metadata?.models ?? [], configuredModels);
	return {
		key: providerId,
		provider: providerId,
		model: models[0]?.id ?? '',
		models,
		baseUrl: providerBaseUrl(entry, metadata) || catalogEntry?.baseUrl || '',
		apiKey: auth.apiKey,
		profilePath: providerId,
		api: stringValue(entry?.api) || metadata?.api || catalogEntry?.api || '',
		headers: headerRecord(entry?.headers),
		authHeader: entry?.authHeader === true
	};
}

function loadPiProviderFormProfile(providerId: string): PiProviderProfile | null {
	return loadPiProviderProfile(providerId) ?? loadPiBuiltinProfile(providerId);
}

function resolveProfileInput(input: PiProviderFormInput): {readonly providerId: string; readonly profile: PiProviderProfile | null} {
	const providerId = input.providerId ?? input.profileKey ?? input.profile?.provider ?? '';
	return {providerId: providerId.trim(), profile: input.profile ?? (providerId ? loadPiProviderFormProfile(providerId) : null)};
}

export function savePiProvider(values: PiProviderFormValues, input: PiProviderFormInput): PiProviderSaveResult {
	const providerId = values.provider.trim();
	const variant: PiProviderFormVariant = values.variant ?? 'full';
	const api = values.api?.trim() || 'openai-completions';
	const profileInput = resolveProfileInput(input);
	const oldProviderId = profileInput.providerId;
	const oldProfile = profileInput.profile;
	if (!providerId) throw new Error('Pi Provider ID 不能为空');
	if (!isPiApi(api)) throw new Error('不支持的 Pi API 协议');
	if (input.mode === 'edit' && (!oldProviderId || oldProviderId !== providerId || !oldProfile)) {
		throw new Error('编辑 Pi Provider 缺少有效的 provider ID');
	}

	const parsedHeaders = parseHeaderJson(values.headers ?? '');
	if (!parsedHeaders.ok) throw new Error(parsedHeaders.error);
	for (const name of Object.keys(parsedHeaders.headers)) {
		const headerError = validateHeaderName(name);
		if (headerError) throw new Error(headerError);
	}
	const headers = parsedHeaders.headers;
	const authHeader = authHeaderApplies(api) && values.authHeader === 'bearer';

	// 传输层覆盖：只写 models.json 的 headers / authHeader，绝不触碰 auth.json 凭据。
	if (variant === 'transport-only') {
		if (input.mode !== 'edit') throw new Error('传输层覆盖只能用于编辑已存在的 Provider');
		return withProfileLock(() => {
			const current = validatePiProviderJsonFiles();
			const currentRecord = normalizePiProviderRecords(current).find(item => item.providerId === providerId);
			if (currentRecord?.authKind === 'unknown') throw new Error('Provider 认证状态未知，拒绝写入以保护配置');
			if (
				!isBuiltinProvider(providerId) &&
				providerEntry(current.models, providerId) === null &&
				current.auth[providerId] === undefined
			) {
				throw new Error(`Pi Provider 不存在: ${providerId}`);
			}
			const root = setTransportOverlay(current.models, providerId, headers, authHeader);
			writePiJsonTransaction([{path: piModelsJsonPath(), value: root}]);
			return {
				key: providerId,
				provider: providerId,
				model: currentRecord?.models[0]?.id ?? '',
				models: currentRecord?.models ?? [],
				baseUrl: currentRecord?.baseUrl ?? '',
				apiKey: '',
				profilePath: providerId,
				api,
				headers,
				authHeader
			};
		});
	}

	if (input.mode === 'add' && metadataFor(providerId)) {
		throw new Error(`Provider ${providerId} 是 Pi 内置 Provider；新增只能创建 API Key 自定义 Provider`);
	}
	const apiKey = values.apiKey.trim() || oldProfile?.apiKey || '';
	if (!apiKey) throw new Error('API Key 不能为空');

	return withProfileLock(() => {
		const current = validatePiProviderJsonFiles();
		const currentRecord = normalizePiProviderRecords(current).find(item => item.providerId === providerId);
		if (
			input.mode === 'add' &&
			(metadataFor(providerId) || providerEntry(current.models, providerId) !== null || current.auth[providerId] !== undefined)
		) {
			throw new Error(`Provider ${providerId} 已存在，新增不会覆盖现有配置，请改用编辑`);
		}
		if (currentRecord?.authKind === 'oauth') throw new Error('OAuth Provider 只读，请通过 Pi 原生登录管理');
		// 只有 models.json 中定义过的 provider 才由 ccq 编辑；auth.json 数据源（/login 创建）只读。
		if (input.mode === 'edit' && providerEntry(current.models, providerId) === null) {
			throw new Error(`Provider ${providerId} 由 Pi 原生 /login 管理，ccq 仅能编辑 models.json 中的 Provider`);
		}
		if (!values.baseUrl.trim() || !/^https?:\/\//iu.test(values.baseUrl.trim())) {
			throw new Error('API Key 自定义 Provider 必须填写 http(s) Base URL');
		}
		const modelIds = modelValuesFromProfile(oldProfile, values);
		if (modelIds.length === 0) throw new Error('至少填写一个 Pi 模型');
		const targetValues: PiProviderFormValues = {...values, api, models: modelIds.join('\n'), model: modelIds[0] ?? ''};
		const nextAuth = setAuthEntry(current.auth, providerId, apiKey);
		const modelsEntry = setModelsEntry(current.models, providerId, targetValues, oldProfile);
		const changes = [
			{path: piModelsJsonPath(), value: modelsEntry.root},
			{path: piAuthJsonPath(), value: nextAuth}
		];
		writePiJsonTransaction(changes);
		return {
			key: providerId,
			provider: providerId,
			model: modelsEntry.models[0]?.id ?? modelIds[0] ?? '',
			models: modelsEntry.models,
			baseUrl: values.baseUrl.trim() || currentRecord?.baseUrl || '',
			apiKey,
			profilePath: providerId,
			api,
			headers,
			authHeader
		};
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
		if (record.isActive) {
			throw new Error(`无法删除当前默认 Pi Provider: ${parsed.provider}，请先在 Pi 配置页修改 defaultProvider`);
		}
		if (record.authKind === 'oauth') throw new Error('OAuth Provider 只读，请通过 Pi 原生 /logout 管理');
		if (record.authKind === 'unknown') throw new Error('Provider 认证状态未知，拒绝删除以保护凭据');
		if (providerEntry(current.models, parsed.provider) === null) {
			throw new Error(`Provider ${parsed.provider} 由 Pi 原生 /login 管理，ccq 仅能删除 models.json 中的 Provider`);
		}

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
	const strategy = piApiDiscoveryStrategy(api);
	if (!strategy?.supportsDiscovery) return null;
	return buildSharedModelDiscoveryEndpoint(baseUrl, strategy.path, strategy.pathMode);
}

export const buildModelDiscoveryEndpoint = buildPiModelDiscoveryEndpoint;

export function normalizePiDiscoveredModels(payload: unknown): readonly PiModelDefinition[] {
	return normalizeDiscoveredModels(payload).map(model => ({...model}) as PiModelDefinition);
}

function dedupePiModels(models: readonly PiModelDefinition[]): readonly PiModelDefinition[] {
	const byId = new Map<string, PiModelDefinition>();
	for (const model of models) {
		if (!model.id) continue;
		byId.set(model.id, model);
	}
	return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function discoverPiModels(input: {
	readonly baseUrl: string;
	readonly api: string;
	readonly apiKey?: string;
	/** 表单请求头；在协议静态头之后合并，可覆盖 `anthropic-version` 等默认头。 */
	readonly headers?: Readonly<Record<string, string>>;
	/** 为 true 时用 `Authorization: Bearer` 作为发现认证头（Pi `authHeader` 语义）。 */
	readonly authHeader?: boolean;
	readonly options?: PiModelDiscoveryOptions;
}): Promise<PiModelDiscoveryResult> {
	const options = input.options ?? {};
	const strategy = piApiDiscoveryStrategy(input.api);
	if (!strategy?.supportsDiscovery) {
		return {
			ok: false,
			kind: 'unsupported',
			error: strategy?.reason || `不支持的 Pi API 协议：${input.api}，请手工填写模型 ID`
		};
	}
	const result = await discoverModels({
		baseUrl: input.baseUrl,
		path: strategy.path,
		pathMode: strategy.pathMode,
		auth: strategy.auth,
		headers: strategy.headers,
		customHeaders: input.headers,
		authHeader: input.authHeader,
		apiKey: input.apiKey,
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		maxResponseBytes: options.maxResponseBytes,
		fetchImpl: options.fetchImpl
	});
	if (!result.ok) return result;
	const normalized = strategy.normalizeModels
		? strategy.normalizeModels(result.models)
		: result.models.map(model => ({...model}) as PiModelDefinition);
	return {ok: true, endpoint: result.endpoint, models: dedupePiModels(normalized)};
}

/**
 * 按 ID 非破坏合并：已有模型配置字段优先，additions 只补缺（重新发现不降级）。
 * 旧 `string[]` / `{id}` 调用仍可工作。
 */
export function mergePiModels(existing: readonly unknown[] | string, additions: readonly unknown[]): readonly PiModelDefinition[] {
	const result = new Map<string, PiModelDefinition>();
	for (const model of modelList(typeof existing === 'string' ? existing.split(/[\n,]/u) : existing)) result.set(model.id, model);
	for (const model of modelList(additions)) {
		const current = result.get(model.id) ?? null;
		// additions（上游/目录）优先级低于已有用户配置，只补缺。
		result.set(model.id, mergePiModelDefinitions([{id: model.id}, model, current]));
	}
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

/**
 * 表单 API 选项：只提供 Pi 文档支持、可用 Base URL + API Key 配置的协议。
 * 已有 models.json 使用其它已知协议时把当前值补进选项，保证编辑时正确显示并原样保存。
 */
function piApiFormOptions(current: string | undefined): readonly {readonly value: string; readonly label: string}[] {
	const options: {value: string; label: string}[] = PI_APIS.map(api => ({value: api, label: api}));
	const trimmed = current?.trim() ?? '';
	if (trimmed && !options.some(option => option.value === trimmed)) options.push({value: trimmed, label: trimmed});
	return options;
}

/** 预设的编辑区文本：未配置时留空，已配置时是多行 JSON。 */
function piHeaderText(headers: Readonly<Record<string, string>>): string {
	return Object.keys(normalizeHeaderEntries(headers)).length > 0 ? `${formatHeaderJson(headers)}\n` : '';
}

/** 动作行初值：命中预设用命中项，否则用首个可用预设；高亮只是光标，不落盘。 */
function initialHeaderPreset(headers: Readonly<Record<string, string>>, api: string): string {
	return matchedHeaderPreset(headers) ?? piHeaderPresetOptions(api)[0]?.preset.key ?? '';
}

/** §10.2 优先级表：自由模式 > 跨协议提示 > 协议层建议 > 默认说明。 */
function piHeaderPresetHelpText(api: string, headersText: string): string {
	if (!isControlledHeaderPresetApi(api)) {
		return '当前 API 协议没有对应预设；下列预设均非本协议客户端，仅在确认中转确实按该客户端判定时使用。左右键选择预设，Enter 应用到下方请求头（会覆盖现有内容）。';
	}
	const parsed = parseHeaderJson(headersText);
	const matched = parsed.ok ? matchedHeaderPreset(parsed.headers) : null;
	if (matched && !headerPresetMatchesApi(matched, api)) {
		const label = piHeaderPreset(matched)?.label ?? matched;
		return `当前请求头与「${label}」一致，但该预设不适用于当前 API 协议。左右键选择预设，Enter 应用到下方请求头（会覆盖现有内容）。`;
	}
	const suggestion = suggestHeaderPreset(api);
	// 受控协议必然存在建议预设（两个判定同源），因此建议文案只是基础说明的后缀，不另立分支。
	const hint = suggestion ? `当前协议通常需要配置为 ${piHeaderPreset(suggestion.key)?.label ?? suggestion.key} 客户端身份。` : '';
	return `左右键选择预设，Enter 应用到下方请求头（会覆盖现有内容）。${hint}`;
}

export function buildPiProviderFormFields(values: PiProviderFormValues, mode: PiProviderFormMode): readonly FormField[] {
	const variant: PiProviderFormVariant = values.variant ?? 'full';
	const api = values.api ?? 'openai-completions';
	const headerPresetField: FormField = {
		id: 'headerPreset',
		type: 'radio',
		label: '请求头预设',
		value: resolveHeaderPresetSelection(api, values.headerPreset),
		options: piHeaderPresetOptions(api).map(option => ({value: option.preset.key, label: option.preset.label})),
		helpText: piHeaderPresetHelpText(api, values.headers)
	};
	const authHeaderField: FormField | null = authHeaderApplies(api)
		? {
				id: 'authHeader',
				type: 'radio',
				label: '认证头形态',
				value: values.authHeader,
				options: [
					{value: 'default', label: 'Pi 默认（x-api-key）'},
					{value: 'bearer', label: 'Authorization: Bearer'}
				],
				helpText: 'Bearer 会额外追加 Authorization 头，不会移除 Pi 默认发送的 x-api-key。'
			}
		: null;

	if (variant === 'transport-only') {
		return [
			{
				id: 'provider',
				type: 'readonly',
				label: 'Provider ID',
				value: values.provider,
				helpText: '内置 Provider 的端点与模型由 Pi 原生定义；此处只写请求头覆盖，凭据仍由 Pi 管理。'
			},
			headerPresetField,
			...(authHeaderField ? [authHeaderField] : [])
		];
	}

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
			options: piApiFormOptions(values.api),
			helpText:
				'只列出 Pi models.json 文档支持、可用 Base URL + API Key 配置的协议；其它已知协议仅在编辑已有 models.json 定义时保留。'
		},
		{
			id: 'apiKey',
			type: 'secret',
			label: 'API Key',
			value: values.apiKey,
			helpText: '只写入 auth.json；展示与错误均脱敏。留空编辑时保留已有凭据。'
		},
		headerPresetField,
		...(authHeaderField ? [authHeaderField] : [])
	];
}

export function buildPiProviderFormModel(input: PiProviderFormInput): PiProviderFormModel {
	const identity = input.providerId ?? input.profileKey ?? '';
	const profile = input.profile ?? (identity ? loadPiProviderFormProfile(identity) : null);
	const providerId = profile?.provider ?? identity.trim();
	// 内置 Provider（含 /login 创建）只允许传输层覆盖，避免 ccq 抢走 Pi 原生端点与模型定义。
	const variant: PiProviderFormVariant =
		input.mode === 'edit' && providerId !== '' && isBuiltinProvider(providerId) ? 'transport-only' : 'full';
	const models = profile?.models.map(model => model.id) ?? [];
	const api = profile?.api ?? 'openai-completions';
	const headers = profile?.headers ?? {};
	const values: PiProviderFormValues = {
		providerType: 'custom-api-key',
		api,
		provider: profile?.provider ?? '',
		model: profile?.model ?? '',
		models: models.join('\n'),
		// 编辑模式从当前 models.json 初始化完整定义，保证未重新解析的模型也不会被降级。
		modelDefinitions: profile?.models ?? [],
		baseUrl: profile?.baseUrl ?? '',
		apiKey: profile?.apiKey ?? '',
		headers: piHeaderText(headers),
		authHeader: profile?.authHeader ? 'bearer' : 'default',
		headerPreset: initialHeaderPreset(headers, api),
		variant
	};
	const fields = buildPiProviderFormFields(values, input.mode);
	return {mode: input.mode, fields, values};
}

export function validatePiProviderForm(mode: PiProviderFormMode, values: PiProviderFormValues): string[] {
	const errors: string[] = [];
	const variant: PiProviderFormVariant = values.variant ?? 'full';
	if (!values.provider.trim()) errors.push('Provider ID 不能为空');
	if (values.api && !isPiApi(values.api)) errors.push('不支持的 API 协议');
	const parsedHeaders = parseHeaderJson(values.headers ?? '');
	if (!parsedHeaders.ok) {
		errors.push(parsedHeaders.error);
	} else {
		for (const name of Object.keys(parsedHeaders.headers)) {
			const headerError = validateHeaderName(name);
			if (headerError) errors.push(headerError);
		}
	}
	// transport-only 不写 baseUrl / api / models / apiKey，也不要求这些字段。
	if (variant === 'full') {
		if (values.baseUrl.trim() && !/^https?:\/\//iu.test(values.baseUrl.trim())) errors.push('Base URL 必须是 http(s) 地址');
		if (mode === 'add' && !values.baseUrl.trim()) errors.push('Base URL 必须是 http(s) 地址');
		if (normalizeModelIds(values.models).length === 0) errors.push('至少添加一个模型');
		if (mode === 'add' && !values.apiKey.trim()) errors.push('API Key 不能为空');
	}
	return errors;
}
