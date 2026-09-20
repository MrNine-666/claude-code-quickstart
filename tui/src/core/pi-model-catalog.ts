import {readResponseText, ResponseTooLargeError} from './model-discovery.js';
import type {PiModelDefinition} from './pi-provider.js';

/** Pi 官方聚合模型目录：`provider -> model id -> Pi model`，无需鉴权。 */
export const PI_MODEL_CATALOG_URL = 'https://pi.dev/api/models';
export const PI_CATALOG_TIMEOUT_MS = 15_000;
export const PI_CATALOG_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type PiCatalogErrorKind = 'cancelled' | 'timeout' | 'network' | 'http' | 'invalid';

/**
 * 一条目录来源记录。`definition` 已剥离 provider/baseUrl/headers/api 等不可迁移字段，
 * `provider`/`api` 只作为来源身份用于展示与冲突消解。
 */
export type PiCatalogSource = {
	readonly key: string;
	readonly provider: string;
	readonly api: string;
	readonly definition: PiModelDefinition;
};

export type PiCatalogIndex = {
	/** 两级索引：model id -> api -> 同 API 的来源记录；查询为近似 O(1)，禁止嵌套全量扫描。 */
	readonly byModelId: ReadonlyMap<string, ReadonlyMap<string, readonly PiCatalogSource[]>>;
	readonly modelCount: number;
	readonly sourceCount: number;
};

export type PiCatalogResult =
	| {readonly ok: true; readonly index: PiCatalogIndex}
	| {readonly ok: false; readonly kind: PiCatalogErrorKind; readonly error: string};

export type PiCatalogFetchOptions = {
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
	readonly fetchImpl?: typeof fetch;
};

export type PiCatalogLoader = {
	readonly load: (signal?: AbortSignal) => Promise<PiCatalogResult>;
	readonly reset: () => void;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * 删除目录来源的传输字段：provider 由 Pi 按自定义 Provider 注入，baseUrl/headers 属于来源
 * Provider 而非用户端点，api 以用户表单选择为准。函数返回新对象，不修改入参。
 */
export function stripNonPortableModelFields(definition: PiModelDefinition): PiModelDefinition {
	const next: Record<string, unknown> = {...definition};
	delete next.provider;
	delete next.baseUrl;
	delete next.headers;
	delete next.api;
	return next as PiModelDefinition;
}

function emptyIndex(): PiCatalogIndex {
	return {byModelId: new Map(), modelCount: 0, sourceCount: 0};
}

/**
 * 严格 schema guard：顶层必须是对象；非法 Provider/模型条目跳过而不是臆测。
 * 只做 ID 与 api 的精确索引，不做任何模糊归一化。
 */
export function buildPiCatalogIndex(payload: unknown): PiCatalogResult {
	if (!isObject(payload)) return {ok: false, kind: 'invalid', error: 'Pi 官方模型目录响应不是对象'};

	const byModelId = new Map<string, Map<string, PiCatalogSource[]>>();
	let sourceCount = 0;
	for (const [providerKey, providerValue] of Object.entries(payload)) {
		if (!isObject(providerValue)) continue;
		for (const [modelKey, modelValue] of Object.entries(providerValue)) {
			if (!isObject(modelValue)) continue;
			const id = textValue(modelValue.id) || modelKey.trim();
			const api = textValue(modelValue.api);
			const provider = textValue(modelValue.provider) || providerKey.trim();
			if (!id || !api || !provider) continue;
			const source: PiCatalogSource = {
				key: `${provider}\u0000${api}`,
				provider,
				api,
				definition: stripNonPortableModelFields({...modelValue, id} as PiModelDefinition)
			};
			let byApi = byModelId.get(id);
			if (!byApi) {
				byApi = new Map();
				byModelId.set(id, byApi);
			}
			const sources = byApi.get(api);
			if (sources) sources.push(source);
			else byApi.set(api, [source]);
			sourceCount += 1;
		}
	}
	return {ok: true, index: {byModelId, modelCount: byModelId.size, sourceCount}};
}

/** 精确 ID + 精确 API 查询；无匹配返回空数组，不抛异常、不模糊匹配。 */
export function resolvePiModelSources(index: PiCatalogIndex, id: string, api: string): readonly PiCatalogSource[] {
	return index.byModelId.get(id)?.get(api) ?? [];
}

/** 其它 API 的同 ID 条目：仅用于只读展示，不可选、不得混入当前 API 的 sources。 */
export function resolvePiRelatedSources(index: PiCatalogIndex, id: string, api: string): readonly PiCatalogSource[] {
	const byApi = index.byModelId.get(id);
	if (!byApi) return [];
	const related: PiCatalogSource[] = [];
	for (const [candidateApi, sources] of byApi) {
		if (candidateApi === api) continue;
		related.push(...sources);
	}
	return related;
}

async function fetchPiModelCatalogUncached(options: PiCatalogFetchOptions): Promise<PiCatalogResult> {
	const timeoutMs = Math.max(1, options.timeoutMs ?? PI_CATALOG_TIMEOUT_MS);
	const maxResponseBytes = Math.min(
		PI_CATALOG_MAX_RESPONSE_BYTES,
		Math.max(1, options.maxResponseBytes ?? PI_CATALOG_MAX_RESPONSE_BYTES)
	);

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		const response = await (options.fetchImpl ?? fetch)(PI_MODEL_CATALOG_URL, {
			headers: {Accept: 'application/json'},
			signal: controller.signal
		});
		let raw: string;
		try {
			raw = await readResponseText(response, maxResponseBytes);
		} catch (error) {
			if (error instanceof ResponseTooLargeError) {
				return {ok: false, kind: 'invalid', error: 'Pi 官方模型目录响应过大，已停止解析'};
			}
			throw error;
		}
		if (!response.ok) return {ok: false, kind: 'http', error: `Pi 官方模型目录暂不可用（HTTP ${response.status}）`};

		let payload: unknown;
		try {
			payload = JSON.parse(raw) as unknown;
		} catch {
			return {ok: false, kind: 'invalid', error: 'Pi 官方模型目录响应不是合法 JSON'};
		}
		return buildPiCatalogIndex(payload);
	} catch {
		if (timedOut) return {ok: false, kind: 'timeout', error: 'Pi 官方模型目录请求超时'};
		return {ok: false, kind: 'network', error: 'Pi 官方模型目录请求失败，请检查网络'};
	} finally {
		clearTimeout(timer);
	}
}

function raceSignal(promise: Promise<PiCatalogResult>, signal?: AbortSignal): Promise<PiCatalogResult> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.resolve({ok: false, kind: 'cancelled', error: '模型目录请求已取消'});
	return new Promise(resolve => {
		const onAbort = () => resolve({ok: false, kind: 'cancelled', error: '模型目录请求已取消'});
		signal.addEventListener('abort', onAbort, {once: true});
		void promise.then(result => {
			signal.removeEventListener('abort', onAbort);
			resolve(result);
		});
	});
}

/**
 * 独立 loader：成功结果缓存在 loader 内，只请求一次；失败后允许下一次选择重试。
 * 传入 signal 只取消当前等待，不打断共享下载。
 */
export function createPiCatalogLoader(options: PiCatalogFetchOptions = {}): PiCatalogLoader {
	let pending: Promise<PiCatalogResult> | null = null;
	return {
		load(signal) {
			if (!pending) {
				pending = fetchPiModelCatalogUncached(options).then(result => {
					if (!result.ok) pending = null;
					return result;
				});
			}
			return raceSignal(pending, signal);
		},
		reset() {
			pending = null;
		}
	};
}

/** 进程内共享 loader：同一 TUI 进程只下载一次成功目录，且绝不携带自定义 Provider API Key。 */
export const sharedPiModelCatalog: PiCatalogLoader = createPiCatalogLoader();

/** 共享 loader 的命名入口；首次选择 intent 触发下载，成功结果进程内缓存。 */
export function fetchPiModelCatalog(signal?: AbortSignal): Promise<PiCatalogResult> {
	return sharedPiModelCatalog.load(signal);
}

export function resetPiModelCatalogCache(): void {
	sharedPiModelCatalog.reset();
}

export const emptyPiCatalogIndex: PiCatalogIndex = emptyIndex();
