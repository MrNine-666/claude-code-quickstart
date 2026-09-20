const MAX_MODEL_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

type ModelPayloadObject = {
	readonly [key: string]: unknown;
};

export type DiscoveredModel = {
	readonly id: string;
} & Readonly<Record<string, unknown>>;

export type ModelDiscoveryErrorKind = 'unsupported' | 'cancelled' | 'timeout' | 'network' | 'http' | 'invalid';

export type ModelDiscoveryAuth = 'bearer' | 'x-api-key' | 'x-goog-api-key';

export type ModelDiscoveryPathMode = 'absolute' | 'append';

export type ModelDiscoveryOptions = {
	readonly baseUrl: string;
	/** Optional contract override; when omitted, derive /models or /v1/models from baseUrl. */
	readonly path?: string;
	/** `absolute` preserves the legacy root-path override; `append` preserves baseUrl's path. */
	readonly pathMode?: ModelDiscoveryPathMode;
	readonly auth?: ModelDiscoveryAuth;
	readonly apiKey?: string;
	/** Extra static request headers (for example Anthropic's `anthropic-version`). */
	readonly headers?: Readonly<Record<string, string>>;
	/** 用户配置的请求头；在 `headers` 之后合并，因而可覆盖协议静态头与派生的认证头。 */
	readonly customHeaders?: Readonly<Record<string, string>>;
	/** 为 true 时强制使用 `Authorization: Bearer`（Pi `authHeader` 语义）。 */
	readonly authHeader?: boolean;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
	readonly fetchImpl?: typeof fetch;
};

export type ModelDiscoveryResult =
	| {readonly ok: true; readonly endpoint: string; readonly models: readonly DiscoveredModel[]}
	| {readonly ok: false; readonly kind: ModelDiscoveryErrorKind; readonly error: string};

function isObject(value: unknown): value is ModelPayloadObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelId(value: unknown): string | null {
	if (typeof value === 'string') return value.trim() || null;
	if (!isObject(value)) return null;
	for (const key of ['id', 'name', 'model']) {
		const candidate = value[key];
		if (typeof candidate !== 'string') continue;
		const id = candidate.trim();
		if (id) return id;
	}
	return null;
}

function payloadModels(payload: unknown): readonly unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isObject(payload)) return [];
	if (Array.isArray(payload.data)) return payload.data;
	if (Array.isArray(payload.models)) return payload.models;
	return [];
}

function nonEmptyText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	return text || null;
}

function nestedErrorText(value: unknown): string | null {
	const direct = nonEmptyText(value);
	if (direct) return direct;
	if (!isObject(value)) return null;
	for (const key of ['message', 'msg', 'detail', 'description', 'error_description']) {
		const message = nonEmptyText(value[key]);
		if (message) return message;
	}
	return nestedErrorText(value.error);
}

function upstreamErrorMessage(payload: unknown): string | null {
	if (!isObject(payload)) return null;
	for (const key of ['error', 'message', 'msg', 'detail', 'description', 'error_description']) {
		const message = nestedErrorText(payload[key]);
		if (message) return message;
	}
	return null;
}

function isBusinessErrorPayload(payload: unknown): boolean {
	if (!isObject(payload)) return false;
	if (payload.error !== undefined || payload.success === false || payload.ok === false) return true;

	const code = payload.code;
	if (typeof code === 'number') return code !== 0 && code !== 200;
	if (typeof code === 'string') {
		const normalized = code.trim().toLowerCase();
		if (!normalized) return false;
		if (/^\d+$/u.test(normalized)) return Number(normalized) !== 0 && Number(normalized) !== 200;
		return ['error', 'failed', 'failure'].includes(normalized);
	}

	const status = nonEmptyText(payload.status)?.toLowerCase();
	return status === 'error' || status === 'failed' || status === 'failure';
}

function redactErrorMessage(message: string, apiKey?: string): string {
	const trimmed = message.trim();
	const key = apiKey?.trim();
	return key ? trimmed.split(key).join('[REDACTED]') : trimmed;
}

function responseErrorMessage(raw: string, payload: unknown, status: number, apiKey?: string): string {
	const message = upstreamErrorMessage(payload) ?? nonEmptyText(raw);
	return message ? redactErrorMessage(message, apiKey) : `模型发现请求失败（HTTP ${status}）`;
}

export function buildModelDiscoveryEndpoint(
	baseUrl: string,
	pathOverride?: string,
	pathMode: ModelDiscoveryPathMode = 'absolute'
): string | null {
	let url: URL;
	try {
		url = new URL(baseUrl.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

	const configuredPath = pathOverride?.trim();
	if (configuredPath) {
		let path = configuredPath.startsWith('/') ? configuredPath : `/${configuredPath}`;
		path = path.replace(/\/+$/u, '');
		if (/\/v1$/iu.test(path)) path = `${path}/models`;
		if (!/\/models$/iu.test(path)) path = `${path}/models`;
		if (pathMode === 'append') {
			const basePath = url.pathname.replace(/\/+$/u, '');
			// A base URL ending in /v1 already contains the version segment. This keeps
			// both /v1 + /v1/models and /api/anthropic + /v1/models well-formed.
			const suffix = /\/v1\/models$/iu.test(path) && /\/v1$/iu.test(basePath) ? '/models' : path;
			url.pathname = `${basePath}${suffix}` || '/models';
		} else {
			url.pathname = path;
		}
		return url.toString();
	}

	const path = url.pathname.replace(/\/+$/u, '');
	if (/\/models$/iu.test(path)) {
		url.pathname = path || '/models';
		return url.toString();
	}
	url.pathname = /\/v1$/iu.test(path) ? `${path}/models` : `${path}/v1/models`;
	return url.toString();
}

export function normalizeDiscoveredModels(payload: unknown): readonly DiscoveredModel[] {
	const unique = new Map<string, DiscoveredModel>();
	for (const value of payloadModels(payload)) {
		const id = modelId(value);
		if (!id) continue;
		unique.set(id, isObject(value) ? ({...value, id} as DiscoveredModel) : ({id} as DiscoveredModel));
	}
	return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export class ResponseTooLargeError extends Error {}

export async function readResponseText(response: Response, maxResponseBytes: number): Promise<string> {
	const contentLength = Number(response.headers.get('content-length') ?? '0');
	if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) throw new ResponseTooLargeError();

	if (!response.body) {
		const raw = await response.text();
		if (new TextEncoder().encode(raw).byteLength > maxResponseBytes) throw new ResponseTooLargeError();
		return raw;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				chunks.push(decoder.decode());
				return chunks.join('');
			}
			bytes += next.value.byteLength;
			if (bytes > maxResponseBytes) throw new ResponseTooLargeError();
			chunks.push(decoder.decode(next.value, {stream: true}));
		}
	} finally {
		if (bytes > maxResponseBytes) await reader.cancel().catch(() => undefined);
		else reader.releaseLock();
	}
}

export async function discoverModels(input: ModelDiscoveryOptions): Promise<ModelDiscoveryResult> {
	const endpoint = buildModelDiscoveryEndpoint(input.baseUrl, input.path, input.pathMode);
	if (!endpoint) return {ok: false, kind: 'unsupported', error: '模型发现需要有效的 HTTP(S) Base URL'};

	const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS);
	const maxResponseBytes = Math.min(
		MAX_MODEL_DISCOVERY_RESPONSE_BYTES,
		Math.max(1, input.maxResponseBytes ?? MAX_MODEL_DISCOVERY_RESPONSE_BYTES)
	);
	if (input.signal?.aborted) return {ok: false, kind: 'cancelled', error: '模型发现已取消'};

	const controller = new AbortController();
	let timedOut = false;
	let externallyCancelled = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const abort = () => {
		externallyCancelled = true;
		controller.abort();
	};
	input.signal?.addEventListener('abort', abort, {once: true});

	try {
		const headers: Record<string, string> = {Accept: 'application/json', ...input.headers, ...input.customHeaders};
		const apiKey = input.apiKey?.trim();
		if (apiKey) {
			// 认证头在自定义头之后按需补缺：用户显式写的同名头优先（与 Pi 的 defaultHeaders 合并语义一致）。
			const nativeAuthName =
				input.auth === 'x-api-key' ? 'x-api-key' : input.auth === 'x-goog-api-key' ? 'x-goog-api-key' : 'Authorization';
			const setIfAbsent = (name: string): void => {
				if (Object.keys(headers).some(existing => existing.toLowerCase() === name.toLowerCase())) return;
				headers[name] = name === 'Authorization' ? `Bearer ${apiKey}` : apiKey;
			};
			setIfAbsent(nativeAuthName);
			// `authHeader: true` 是「额外追加」而非替换（与 Pi 的 withConfiguredAuth 一致，也与字段文案一致）。
			// 真实请求会同时带 x-api-key 与 Authorization，发现请求必须同形；否则只认原生头的端点
			// 会呈现「发现失败但调用成功」的难排查错配。
			if (input.authHeader === true) setIfAbsent('Authorization');
		}
		const response = await (input.fetchImpl ?? fetch)(endpoint, {headers, signal: controller.signal});

		let raw: string;
		try {
			raw = await readResponseText(response, maxResponseBytes);
		} catch (error) {
			if (error instanceof ResponseTooLargeError) return {ok: false, kind: 'invalid', error: '模型发现响应过大，已停止解析'};
			throw error;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(raw) as unknown;
		} catch {
			const message = nonEmptyText(raw);
			return {
				ok: false,
				kind: response.ok ? 'invalid' : 'http',
				error: message
					? redactErrorMessage(message, apiKey)
					: response.ok
						? '模型发现响应不是合法 JSON'
						: responseErrorMessage('', null, response.status, apiKey)
			};
		}
		if (!response.ok) return {ok: false, kind: 'http', error: responseErrorMessage(raw, payload, response.status, apiKey)};
		const models = normalizeDiscoveredModels(payload);
		if (models.length === 0) {
			const message = upstreamErrorMessage(payload);
			if (isBusinessErrorPayload(payload) || message) {
				return {
					ok: false,
					kind: 'http',
					error: redactErrorMessage(message ?? raw, apiKey)
				};
			}
			return {ok: false, kind: 'invalid', error: '模型发现响应未包含可用模型 ID'};
		}
		return {ok: true, endpoint, models};
	} catch {
		if (externallyCancelled || input.signal?.aborted) return {ok: false, kind: 'cancelled', error: '模型发现已取消'};
		if (timedOut) return {ok: false, kind: 'timeout', error: '模型发现请求超时'};
		return {ok: false, kind: 'network', error: '模型发现请求失败，请检查 Base URL、网络或 API Key'};
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener('abort', abort);
	}
}
