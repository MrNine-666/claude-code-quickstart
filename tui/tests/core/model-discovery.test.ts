import {describe, expect, test} from 'bun:test';

import {
	buildModelDiscoveryEndpoint,
	discoverModels,
	type ModelDiscoveryErrorKind,
	type ModelDiscoveryOptions,
	normalizeDiscoveredModels
} from '../../src/core/model-discovery.js';
import {loadProviderContract, resolveModelDiscoveryConfig} from '../../src/core/provider-contract.js';

// 迁自 scripts/verify-model-discovery.mjs（73 断言，试点批 implement Step 2）。
// 保持注入式 fake fetch（options.fetchImpl），不 mock 全局 fetch。
// 主题对账见本任务 implement.md 附录 A。

const contract = loadProviderContract();

function builtinProvider(key: string) {
	const provider = contract.builtinProviders[key];
	if (!provider) throw new Error(`missing builtin provider in contract: ${key}`);
	return provider;
}

function codexBaseUrl(key: string): string {
	const provider = builtinProvider(key);
	if (!provider.codex) throw new Error(`missing codex template in contract: ${key}`);
	return provider.codex.baseUrl;
}

function expectResultError(result: Awaited<ReturnType<typeof discoverModels>>, kind: ModelDiscoveryErrorKind): string {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error('expected a failed model discovery result');
	expect(result.kind).toBe(kind);
	return result.error;
}

// Bun 的 `typeof fetch` 带 `preconnect` 静态方法，测试内联的 fake fetch 不需要实现它。
type TestFetchInit = {headers: Record<string, string>; signal: AbortSignal};
type TestFetchImpl = (url: string, init: TestFetchInit) => Promise<Response>;

/** 注入式 fake fetch 的统一入口；只放宽 fetch 的静态方法，不改 discoverModels 行为。 */
function discover(options: Omit<ModelDiscoveryOptions, 'fetchImpl'> & {fetchImpl?: TestFetchImpl}) {
	return discoverModels(options as unknown as ModelDiscoveryOptions);
}

/** 复刻 service adapter 的配置解析路径，再用注入的 fetchImpl 发起请求。 */
async function discoverViaResolvedConfig(input: {
	readonly side: 'claude' | 'codex';
	readonly providerType: string;
	readonly profileKey?: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly fetchImpl: TestFetchImpl;
}) {
	const config = resolveModelDiscoveryConfig({
		side: input.side,
		providerType: input.providerType,
		profileKey: input.profileKey,
		baseUrl: input.baseUrl
	});
	return discover({
		baseUrl: config.baseUrl ?? input.baseUrl,
		path: config.path,
		pathMode: config.pathMode,
		auth: config.auth,
		apiKey: input.apiKey,
		fetchImpl: input.fetchImpl
	});
}

describe('buildModelDiscoveryEndpoint', () => {
	test('derives /v1/models or /models from the base URL', () => {
		expect(buildModelDiscoveryEndpoint('https://models.example/v1')).toBe('https://models.example/v1/models');
		expect(buildModelDiscoveryEndpoint('https://models.example/v1/')).toBe('https://models.example/v1/models');
		expect(buildModelDiscoveryEndpoint('https://models.example/models')).toBe('https://models.example/models');
		expect(buildModelDiscoveryEndpoint('https://models.example/models/')).toBe('https://models.example/models');
		expect(buildModelDiscoveryEndpoint('https://models.example')).toBe('https://models.example/v1/models');
		expect(buildModelDiscoveryEndpoint('https://models.example/')).toBe('https://models.example/v1/models');
	});

	test('preserves base path in append mode and defaults to absolute mode', () => {
		expect(buildModelDiscoveryEndpoint('https://models.example/anthropic', '/v1/models')).toBe('https://models.example/v1/models');
		expect(buildModelDiscoveryEndpoint('https://models.example/anthropic', '/v1/models', 'append')).toBe(
			'https://models.example/anthropic/v1/models'
		);
		expect(buildModelDiscoveryEndpoint('https://models.example/v1', '/v1/models', 'append')).toBe('https://models.example/v1/models');
	});

	test('rejects non-http(s) and malformed base URLs', () => {
		expect(buildModelDiscoveryEndpoint('ftp://models.example')).toBeNull();
		expect(buildModelDiscoveryEndpoint('not a URL')).toBeNull();
	});
});

describe('provider contract model discovery resolution', () => {
	test('MiniMax Claude resolves the anthropic path with x-api-key auth', () => {
		const minimax = builtinProvider('minimax');
		const minimaxDiscovery = resolveModelDiscoveryConfig({
			side: 'claude',
			providerType: 'minimax',
			baseUrl: minimax.baseUrl
		});
		expect(buildModelDiscoveryEndpoint(minimax.baseUrl, minimaxDiscovery.path, minimaxDiscovery.pathMode)).toBe(
			'https://api.minimaxi.com/anthropic/v1/models'
		);
		expect(minimaxDiscovery.auth).toBe('x-api-key');
	});

	test('GLM Claude uses Authorization Bearer', () => {
		const glmDiscovery = resolveModelDiscoveryConfig({
			side: 'claude',
			providerType: 'glm',
			baseUrl: builtinProvider('glm').baseUrl
		});
		expect(glmDiscovery).toEqual({
			protocol: 'anthropic',
			path: '/v1/models',
			pathMode: 'append',
			auth: 'bearer'
		});
	});

	test('DeepSeek uses the root /models endpoint, including after a Base URL edit', () => {
		const deepseek = builtinProvider('deepseek');
		const deepseekDiscovery = resolveModelDiscoveryConfig({
			side: 'claude',
			providerType: 'deepseek',
			baseUrl: deepseek.baseUrl
		});
		expect(
			buildModelDiscoveryEndpoint(deepseekDiscovery.baseUrl ?? deepseek.baseUrl, deepseekDiscovery.path, deepseekDiscovery.pathMode)
		).toBe('https://api.deepseek.com/models');

		const deepseekEditedDiscovery = resolveModelDiscoveryConfig({
			side: 'claude',
			providerType: 'custom',
			profileKey: 'my-deepseek',
			baseUrl: 'https://api.deepseek.com/anthropic/'
		});
		expect(deepseekEditedDiscovery.baseUrl).toBe('https://api.deepseek.com');
	});

	test('GLM Codex uses the independent Coding Plan endpoint', () => {
		const codexGlmDiscovery = resolveModelDiscoveryConfig({
			side: 'codex',
			providerType: 'glm',
			baseUrl: codexBaseUrl('glm')
		});
		expect(
			buildModelDiscoveryEndpoint(
				codexGlmDiscovery.baseUrl ?? codexBaseUrl('glm'),
				codexGlmDiscovery.path,
				codexGlmDiscovery.pathMode
			)
		).toBe('https://open.bigmodel.cn/api/coding/paas/v4/models');
	});

	test('custom fallback keeps the /api/v1 base path', () => {
		const customDiscovery = contract.modelDiscovery;
		expect(buildModelDiscoveryEndpoint('https://newapi.example/api/v1', customDiscovery.path, customDiscovery.pathMode)).toBe(
			'https://newapi.example/api/v1/models'
		);
	});

	test('declares the discovery transport for every builtin and the generic fallback', () => {
		expect(contract.modelDiscovery).toEqual({
			protocol: 'openai-compatible',
			path: '/v1/models',
			pathMode: 'append',
			auth: 'bearer'
		});
		expect(builtinProvider('minimax').modelDiscovery).toEqual({
			protocol: 'anthropic',
			path: '/v1/models',
			pathMode: 'append',
			auth: 'x-api-key'
		});
		expect(builtinProvider('deepseek').modelDiscovery).toEqual({
			protocol: 'openai-compatible',
			baseUrl: 'https://api.deepseek.com',
			path: '/models',
			pathMode: 'absolute',
			auth: 'bearer'
		});
		expect(builtinProvider('glm').modelDiscovery).toEqual({
			protocol: 'anthropic',
			path: '/v1/models',
			pathMode: 'append',
			auth: 'bearer'
		});
		expect(builtinProvider('glm').codexModelDiscovery).toEqual({
			protocol: 'openai-compatible',
			baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
			path: '/models',
			pathMode: 'append',
			auth: 'bearer'
		});
	});
});

describe('service adapter discovery requests', () => {
	test('MiniMax Claude sends x-api-key to the anthropic endpoint', async () => {
		const result = await discoverViaResolvedConfig({
			side: 'claude',
			providerType: 'minimax',
			profileKey: 'minimax',
			baseUrl: 'https://api.minimaxi.com/anthropic',
			apiKey: 'service-anthropic-key',
			fetchImpl: async (url, init) => {
				expect(url).toBe('https://api.minimaxi.com/anthropic/v1/models');
				expect(init.headers).toMatchObject({'x-api-key': 'service-anthropic-key'});
				expect(init.headers.Authorization).toBeUndefined();
				return new Response(JSON.stringify({data: [{id: 'MiniMax-M3'}]}), {status: 200});
			}
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.models.map(model => model.id)).toEqual(['MiniMax-M3']);
	});

	test('GLM Claude sends Authorization Bearer', async () => {
		const result = await discoverViaResolvedConfig({
			side: 'claude',
			providerType: 'glm',
			profileKey: 'glm',
			baseUrl: 'https://open.bigmodel.cn/api/anthropic',
			apiKey: 'service-glm-key',
			fetchImpl: async (url, init) => {
				expect(url).toBe('https://open.bigmodel.cn/api/anthropic/v1/models');
				expect(init.headers.Authorization).toBe('Bearer service-glm-key');
				expect(init.headers['x-api-key']).toBeUndefined();
				return new Response(JSON.stringify({data: [{id: 'glm-5.3'}]}), {status: 200});
			}
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.models.map(model => model.id)).toEqual(['glm-5.3']);
	});

	test('GLM Codex sends Authorization Bearer to the Coding Plan endpoint', async () => {
		const result = await discoverViaResolvedConfig({
			side: 'codex',
			providerType: 'glm',
			profileKey: 'glm',
			baseUrl: codexBaseUrl('glm'),
			apiKey: 'service-codex-key',
			fetchImpl: async (url, init) => {
				expect(url).toBe('https://open.bigmodel.cn/api/coding/paas/v4/models');
				expect(init.headers.Authorization).toBe('Bearer service-codex-key');
				expect(init.headers['x-api-key']).toBeUndefined();
				return new Response(JSON.stringify({data: [{id: 'glm-5.3'}]}), {status: 200});
			}
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.models.map(model => model.id)).toEqual(['glm-5.3']);
	});
});

describe('normalizeDiscoveredModels', () => {
	test('deduplicates, sorts and normalizes array payloads', () => {
		expect(
			normalizeDiscoveredModels([
				' zeta ',
				{id: 'alpha', owned_by: 'upstream'},
				{name: 'beta'},
				{model: 'gamma'},
				{id: 'alpha', owned_by: 'upstream'},
				{ignored: true},
				42
			])
		).toEqual([{id: 'alpha', owned_by: 'upstream'}, {name: 'beta', id: 'beta'}, {model: 'gamma', id: 'gamma'}, {id: 'zeta'}]);
	});

	test('reads data[] and models[] wrappers', () => {
		expect(normalizeDiscoveredModels({data: [{id: 'data-model'}]})).toEqual([{id: 'data-model'}]);
		expect(normalizeDiscoveredModels({models: ['models-model']})).toEqual([{id: 'models-model'}]);
	});

	test('falls back to models[] when data is not an array, and returns empty for empty data[]', () => {
		expect(normalizeDiscoveredModels({data: 'not-an-array', models: [{name: 'fallback-model'}]})).toEqual([
			{name: 'fallback-model', id: 'fallback-model'}
		]);
		expect(normalizeDiscoveredModels({data: [], models: [{id: 'ignored-model'}]})).toEqual([]);
	});
});

describe('discoverModels request payload', () => {
	test('sends one Bearer request with Accept and an abort signal, then dedupes and sorts', async () => {
		let requestCount = 0;
		const discovery = await discover({
			baseUrl: 'https://models.example/v1',
			apiKey: 'secret-discovery-key',
			fetchImpl: async (url, init) => {
				requestCount += 1;
				expect(url).toBe('https://models.example/v1/models');
				expect(init.headers.Authorization).toBe('Bearer secret-discovery-key');
				expect(init.headers.Accept).toBe('application/json');
				expect(init.signal).toBeInstanceOf(AbortSignal);
				return new Response(JSON.stringify({data: [{id: 'zeta'}, {id: 'alpha'}, {id: 'zeta'}]}), {status: 200});
			}
		});
		expect(requestCount).toBe(1);
		expect(discovery.ok).toBe(true);
		if (discovery.ok) expect(discovery.models).toEqual([{id: 'alpha'}, {id: 'zeta'}]);
	});

	test('uses x-api-key with append mode for Anthropic-compatible providers', async () => {
		const anthropicDiscovery = await discover({
			baseUrl: 'https://api.minimaxi.com/anthropic',
			path: '/v1/models',
			pathMode: 'append',
			auth: 'x-api-key',
			apiKey: 'anthropic-discovery-key',
			fetchImpl: async (url, init) => {
				expect(url).toBe('https://api.minimaxi.com/anthropic/v1/models');
				expect(init.headers['x-api-key']).toBe('anthropic-discovery-key');
				expect(init.headers.Authorization).toBeUndefined();
				return new Response(JSON.stringify({data: [{id: 'MiniMax-M3'}]}), {status: 200});
			}
		});
		expect(anthropicDiscovery.ok).toBe(true);
	});

	test('omits Authorization when no api key is provided', async () => {
		await discover({
			baseUrl: 'https://models.example',
			fetchImpl: async (_url, init) => {
				expect(init.headers.Authorization).toBeUndefined();
				expect(init.headers.Accept).toBe('application/json');
				return new Response(JSON.stringify(['manual-key-model']), {status: 200});
			}
		});
	});

	test('honors an absolute configured path', async () => {
		await discover({
			baseUrl: 'https://models.example/anthropic',
			path: '/models',
			fetchImpl: async url => {
				expect(url).toBe('https://models.example/models');
				return new Response(JSON.stringify(['configured-path-model']), {status: 200});
			}
		});
	});

	test('sends extra static headers such as anthropic-version', async () => {
		const versionedDiscovery = await discover({
			baseUrl: 'https://api.anthropic.com',
			path: '/v1/models',
			pathMode: 'append',
			auth: 'x-api-key',
			apiKey: 'anthropic-discovery-key',
			headers: {'anthropic-version': '2023-06-01'},
			fetchImpl: async (url, init) => {
				expect(url).toBe('https://api.anthropic.com/v1/models');
				expect(init.headers['x-api-key']).toBe('anthropic-discovery-key');
				expect(init.headers.Authorization).toBeUndefined();
				expect(init.headers['anthropic-version']).toBe('2023-06-01');
				expect(init.headers.Accept).toBe('application/json');
				return new Response(JSON.stringify({data: [{id: 'claude-fable-5'}]}), {status: 200});
			}
		});
		expect(versionedDiscovery.ok).toBe(true);
	});

	test('sends only x-goog-api-key for Google Generative Language', async () => {
		const googleDiscovery = await discover({
			baseUrl: 'https://generativelanguage.googleapis.com',
			path: '/v1beta/models',
			pathMode: 'absolute',
			auth: 'x-goog-api-key',
			apiKey: 'google-discovery-key',
			fetchImpl: async (url, init) => {
				expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
				expect(init.headers['x-goog-api-key']).toBe('google-discovery-key');
				expect(init.headers.Authorization).toBeUndefined();
				expect(init.headers['x-api-key']).toBeUndefined();
				return new Response(JSON.stringify({models: [{name: 'models/gemini-2.5-pro'}]}), {status: 200});
			}
		});
		expect(googleDiscovery.ok).toBe(true);
		if (googleDiscovery.ok) {
			expect(googleDiscovery.models.map(model => model.name)).toEqual(['models/gemini-2.5-pro']);
		}
	});
});

describe('discoverModels error matrix', () => {
	test('classifies HTTP errors and redacts the api key from JSON error bodies', async () => {
		const httpError = await discover({
			baseUrl: 'https://models.example',
			apiKey: 'http-secret-key',
			fetchImpl: async () =>
				new Response(JSON.stringify({error: {message: 'upstream rejected http-secret-key'}}), {
					status: 401,
					headers: {'content-type': 'application/json'}
				})
		});
		expect(expectResultError(httpError, 'http')).toBe('upstream rejected [REDACTED]');
	});

	test('treats business-error payloads on HTTP 200 as http errors with redaction', async () => {
		const glmBusinessError = await discover({
			baseUrl: 'https://open.bigmodel.cn/api/anthropic',
			path: '/v1/models',
			pathMode: 'append',
			apiKey: 'glm-secret-key',
			fetchImpl: async () =>
				new Response(JSON.stringify({code: 401, msg: '令牌无效，请检查 API Key glm-secret-key'}), {
					status: 200,
					headers: {'content-type': 'application/json'}
				})
		});
		expect(expectResultError(glmBusinessError, 'http')).toBe('令牌无效，请检查 API Key [REDACTED]');
	});

	test('passes through plain-text HTTP error bodies', async () => {
		const plainTextHttpError = await discover({
			baseUrl: 'https://models.example',
			fetchImpl: async () => new Response('上游服务暂时不可用', {status: 503})
		});
		expect(expectResultError(plainTextHttpError, 'http')).toBe('上游服务暂时不可用');
	});

	test('reports invalid JSON bodies', async () => {
		const invalidJson = await discover({
			baseUrl: 'https://models.example',
			fetchImpl: async () => new Response('{broken', {status: 200})
		});
		expect(expectResultError(invalidJson, 'invalid')).toBe('{broken');
	});

	test('reports empty model lists as invalid', async () => {
		const empty = await discover({
			baseUrl: 'https://models.example',
			fetchImpl: async () => new Response(JSON.stringify({data: []}), {status: 200})
		});
		expect(expectResultError(empty, 'invalid')).toBe('模型发现响应未包含可用模型 ID');
	});

	test('stops reading oversized responses', async () => {
		const oversized = await discover({
			baseUrl: 'https://models.example',
			maxResponseBytes: 16,
			fetchImpl: async () => new Response(JSON.stringify({data: ['a model payload larger than sixteen bytes']}), {status: 200})
		});
		expect(expectResultError(oversized, 'invalid')).toBe('模型发现响应过大，已停止解析');
	});

	test('classifies timeouts', async () => {
		const timeout = await discover({
			baseUrl: 'https://models.example',
			timeoutMs: 5,
			fetchImpl: async (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
						once: true
					});
				})
		});
		expect(expectResultError(timeout, 'timeout')).toBe('模型发现请求超时');
	});

	test('classifies external cancellation', async () => {
		const cancelController = new AbortController();
		const cancelledPromise = discover({
			baseUrl: 'https://models.example',
			signal: cancelController.signal,
			fetchImpl: async (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
						once: true
					});
				})
		});
		cancelController.abort();
		expect(expectResultError(await cancelledPromise, 'cancelled')).toBe('模型发现已取消');
	});

	test('classifies network errors without leaking the api key or upstream text', async () => {
		const networkError = await discover({
			baseUrl: 'https://models.example',
			apiKey: 'network-secret-key',
			fetchImpl: async () => {
				throw new Error('network-secret-key from upstream');
			}
		});
		const message = expectResultError(networkError, 'network');
		expect(message).not.toMatch(/network-secret-key|upstream/);
	});

	test('rejects unsupported base URLs before fetching', async () => {
		const unsupported = await discover({baseUrl: 'not a URL'});
		expect(expectResultError(unsupported, 'unsupported')).toBe('模型发现需要有效的 HTTP(S) Base URL');
	});
});
