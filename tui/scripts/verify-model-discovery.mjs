import assert from 'node:assert/strict';

import {buildModelDiscoveryEndpoint, discoverModels, normalizeDiscoveredModels} from '../src/core/model-discovery.ts';
import {loadProviderContract, resolveModelDiscoveryConfig} from '../src/core/provider-contract.ts';
import {discoverCodexProviderModels} from '../src/services/codex-service.ts';
import {discoverProviderModels} from '../src/services/provider-service.ts';

function resultError(result, kind) {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error('expected a failed model discovery result');
	assert.equal(result.kind, kind);
	return result.error;
}

assert.equal(buildModelDiscoveryEndpoint('https://models.example/v1'), 'https://models.example/v1/models');
assert.equal(buildModelDiscoveryEndpoint('https://models.example/v1/'), 'https://models.example/v1/models');
assert.equal(buildModelDiscoveryEndpoint('https://models.example/models'), 'https://models.example/models');
assert.equal(buildModelDiscoveryEndpoint('https://models.example/models/'), 'https://models.example/models');
assert.equal(buildModelDiscoveryEndpoint('https://models.example'), 'https://models.example/v1/models');
assert.equal(buildModelDiscoveryEndpoint('https://models.example/'), 'https://models.example/v1/models');
assert.equal(buildModelDiscoveryEndpoint('https://models.example/anthropic', '/v1/models'), 'https://models.example/v1/models');
assert.equal(
	buildModelDiscoveryEndpoint('https://models.example/anthropic', '/v1/models', 'append'),
	'https://models.example/anthropic/v1/models'
);
assert.equal(buildModelDiscoveryEndpoint('https://models.example/v1', '/v1/models', 'append'), 'https://models.example/v1/models');
assert.equal(buildModelDiscoveryEndpoint('ftp://models.example'), null);
assert.equal(buildModelDiscoveryEndpoint('not a URL'), null);

const providerContract = loadProviderContract();
const minimaxDiscovery = resolveModelDiscoveryConfig({
	side: 'claude',
	providerType: 'minimax',
	baseUrl: providerContract.builtinProviders.minimax.baseUrl
});
assert.equal(
	buildModelDiscoveryEndpoint(providerContract.builtinProviders.minimax.baseUrl, minimaxDiscovery.path, minimaxDiscovery.pathMode),
	'https://api.minimaxi.com/anthropic/v1/models'
);
assert.equal(minimaxDiscovery.auth, 'x-api-key');

const glmDiscovery = resolveModelDiscoveryConfig({
	side: 'claude',
	providerType: 'glm',
	baseUrl: providerContract.builtinProviders.glm.baseUrl
});
assert.deepEqual(glmDiscovery, {
	protocol: 'anthropic',
	path: '/v1/models',
	pathMode: 'append',
	auth: 'bearer'
}, 'GLM 模型目录 discovery 必须使用 Authorization Bearer');

const deepseekDiscovery = resolveModelDiscoveryConfig({
	side: 'claude',
	providerType: 'deepseek',
	baseUrl: providerContract.builtinProviders.deepseek.baseUrl
});
assert.equal(
	buildModelDiscoveryEndpoint(deepseekDiscovery.baseUrl ?? providerContract.builtinProviders.deepseek.baseUrl, deepseekDiscovery.path, deepseekDiscovery.pathMode),
	'https://api.deepseek.com/models'
);
const deepseekEditedDiscovery = resolveModelDiscoveryConfig({
	side: 'claude',
	providerType: 'custom',
	profileKey: 'my-deepseek',
	baseUrl: 'https://api.deepseek.com/anthropic/'
});
assert.equal(deepseekEditedDiscovery.baseUrl, 'https://api.deepseek.com');

const codexGlmDiscovery = resolveModelDiscoveryConfig({
	side: 'codex',
	providerType: 'glm',
	baseUrl: providerContract.builtinProviders.glm.codex.baseUrl
});
assert.equal(
	buildModelDiscoveryEndpoint(
		codexGlmDiscovery.baseUrl ?? providerContract.builtinProviders.glm.codex.baseUrl,
		codexGlmDiscovery.path,
		codexGlmDiscovery.pathMode
	),
	'https://open.bigmodel.cn/api/coding/paas/v4/models'
);

const customDiscovery = providerContract.modelDiscovery;
assert.equal(
	buildModelDiscoveryEndpoint('https://newapi.example/api/v1', customDiscovery.path, customDiscovery.pathMode),
	'https://newapi.example/api/v1/models'
);

const originalFetch = globalThis.fetch;
try {
	globalThis.fetch = async (url, init) => {
		assert.equal(url, 'https://api.minimaxi.com/anthropic/v1/models');
		assert.equal(init.headers['x-api-key'], 'service-anthropic-key');
		assert.equal(init.headers.Authorization, undefined);
		return new Response(JSON.stringify({data: [{id: 'MiniMax-M3'}]}), {status: 200});
	};
	const claudeModels = await discoverProviderModels({
		profileKey: 'minimax',
		baseUrl: 'https://api.minimaxi.com/anthropic',
		apiKey: 'service-anthropic-key',
		modelEnv: {},
		env: {},
		activateAfterSave: false,
		providerType: 'minimax'
	});
	assert.deepEqual(claudeModels, ['MiniMax-M3']);

	globalThis.fetch = async (url, init) => {
		assert.equal(url, 'https://open.bigmodel.cn/api/anthropic/v1/models');
		assert.equal(init.headers.Authorization, 'Bearer service-glm-key');
		assert.equal(init.headers['x-api-key'], undefined);
		return new Response(JSON.stringify({data: [{id: 'glm-5.3'}]}), {status: 200});
	};
	const glmModels = await discoverProviderModels({
		profileKey: 'glm',
		baseUrl: 'https://open.bigmodel.cn/api/anthropic',
		apiKey: 'service-glm-key',
		modelEnv: {},
		env: {},
		activateAfterSave: false,
		providerType: 'glm'
	});
	assert.deepEqual(glmModels, ['glm-5.3']);

	globalThis.fetch = async (url, init) => {
		assert.equal(url, 'https://open.bigmodel.cn/api/coding/paas/v4/models');
		assert.equal(init.headers.Authorization, 'Bearer service-codex-key');
		assert.equal(init.headers['x-api-key'], undefined);
		return new Response(JSON.stringify({data: [{id: 'glm-5.3'}]}), {status: 200});
	};
	const codexModels = await discoverCodexProviderModels({
		profileKey: 'glm',
		providerType: 'glm',
		baseUrl: providerContract.builtinProviders.glm.codex.baseUrl,
		model: '',
		apiKey: 'service-codex-key',
		toml: '',
		activateAfterSave: false
	});
	assert.deepEqual(codexModels, ['glm-5.3']);
} finally {
	globalThis.fetch = originalFetch;
}

assert.deepEqual(
	normalizeDiscoveredModels([
		' zeta ',
		{id: 'alpha', owned_by: 'upstream'},
		{name: 'beta'},
		{model: 'gamma'},
		{id: 'alpha', owned_by: 'upstream'},
		{ignored: true},
		42
	]),
	[{id: 'alpha', owned_by: 'upstream'}, {name: 'beta', id: 'beta'}, {model: 'gamma', id: 'gamma'}, {id: 'zeta'}]
);
assert.deepEqual(normalizeDiscoveredModels({data: [{id: 'data-model'}]}), [{id: 'data-model'}]);
assert.deepEqual(normalizeDiscoveredModels({models: ['models-model']}), [{id: 'models-model'}]);
assert.deepEqual(normalizeDiscoveredModels({data: 'not-an-array', models: [{name: 'fallback-model'}]}), [
	{name: 'fallback-model', id: 'fallback-model'}
]);
assert.deepEqual(normalizeDiscoveredModels({data: [], models: [{id: 'ignored-model'}]}), []);

let requestCount = 0;
const discovery = await discoverModels({
	baseUrl: 'https://models.example/v1',
	apiKey: 'secret-discovery-key',
	fetchImpl: async (url, init) => {
		requestCount += 1;
		assert.equal(url, 'https://models.example/v1/models');
		assert.equal(init.headers.Authorization, 'Bearer secret-discovery-key');
		assert.equal(init.headers.Accept, 'application/json');
		assert.ok(init.signal instanceof AbortSignal);
		return new Response(JSON.stringify({data: [{id: 'zeta'}, {id: 'alpha'}, {id: 'zeta'}]}), {status: 200});
	}
});
assert.equal(requestCount, 1);
assert.equal(discovery.ok, true);
if (discovery.ok) assert.deepEqual(discovery.models, [{id: 'alpha'}, {id: 'zeta'}]);

const anthropicDiscovery = await discoverModels({
	baseUrl: 'https://api.minimaxi.com/anthropic',
	path: '/v1/models',
	pathMode: 'append',
	auth: 'x-api-key',
	apiKey: 'anthropic-discovery-key',
	fetchImpl: async (url, init) => {
		assert.equal(url, 'https://api.minimaxi.com/anthropic/v1/models');
		assert.equal(init.headers['x-api-key'], 'anthropic-discovery-key');
		assert.equal(init.headers.Authorization, undefined);
		return new Response(JSON.stringify({data: [{id: 'MiniMax-M3'}]}), {status: 200});
	}
});
assert.equal(anthropicDiscovery.ok, true);

await discoverModels({
	baseUrl: 'https://models.example',
	fetchImpl: async (_url, init) => {
		assert.equal(init.headers.Authorization, undefined);
		assert.equal(init.headers.Accept, 'application/json');
		return new Response(JSON.stringify(['manual-key-model']), {status: 200});
	}
});

await discoverModels({
	baseUrl: 'https://models.example/anthropic',
	path: '/models',
	fetchImpl: async url => {
		assert.equal(url, 'https://models.example/models');
		return new Response(JSON.stringify(['configured-path-model']), {status: 200});
	}
});

const httpError = await discoverModels({
	baseUrl: 'https://models.example',
	apiKey: 'http-secret-key',
	fetchImpl: async () =>
		new Response(JSON.stringify({error: {message: 'upstream rejected http-secret-key'}}), {
			status: 401,
			headers: {'content-type': 'application/json'}
		})
});
assert.equal(resultError(httpError, 'http'), 'upstream rejected [REDACTED]');

const glmBusinessError = await discoverModels({
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
assert.equal(resultError(glmBusinessError, 'http'), '令牌无效，请检查 API Key [REDACTED]');

const plainTextHttpError = await discoverModels({
	baseUrl: 'https://models.example',
	fetchImpl: async () => new Response('上游服务暂时不可用', {status: 503})
});
assert.equal(resultError(plainTextHttpError, 'http'), '上游服务暂时不可用');

const invalidJson = await discoverModels({
	baseUrl: 'https://models.example',
	fetchImpl: async () => new Response('{broken', {status: 200})
});
assert.equal(resultError(invalidJson, 'invalid'), '{broken');

const empty = await discoverModels({
	baseUrl: 'https://models.example',
	fetchImpl: async () => new Response(JSON.stringify({data: []}), {status: 200})
});
assert.equal(resultError(empty, 'invalid'), '模型发现响应未包含可用模型 ID');

const oversized = await discoverModels({
	baseUrl: 'https://models.example',
	maxResponseBytes: 16,
	fetchImpl: async () => new Response(JSON.stringify({data: ['a model payload larger than sixteen bytes']}), {status: 200})
});
assert.equal(resultError(oversized, 'invalid'), '模型发现响应过大，已停止解析');

const timeout = await discoverModels({
	baseUrl: 'https://models.example',
	timeoutMs: 5,
	fetchImpl: async (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
		})
});
assert.equal(resultError(timeout, 'timeout'), '模型发现请求超时');

const cancelController = new AbortController();
const cancelledPromise = discoverModels({
	baseUrl: 'https://models.example',
	signal: cancelController.signal,
	fetchImpl: async (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
		})
});
cancelController.abort();
assert.equal(resultError(await cancelledPromise, 'cancelled'), '模型发现已取消');

const networkError = await discoverModels({
	baseUrl: 'https://models.example',
	apiKey: 'network-secret-key',
	fetchImpl: async () => {
		throw new Error('network-secret-key from upstream');
	}
});
assert.doesNotMatch(resultError(networkError, 'network'), /network-secret-key|upstream/);

const unsupported = await discoverModels({baseUrl: 'not a URL'});
assert.equal(resultError(unsupported, 'unsupported'), '模型发现需要有效的 HTTP(S) Base URL');

console.log('[PASS] shared model discovery: endpoint, normalization, auth, payload, HTTP/JSON/empty/oversize/timeout/cancel/network cases');
