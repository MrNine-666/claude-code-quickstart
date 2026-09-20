import {describe, expect, test} from 'bun:test';

import {PI_APIS, PI_KNOWN_APIS, isPiApi, isPiFormApi, piApiDiscoveryStrategy} from '../../src/core/pi-api-discovery.js';
import {
	PI_MODEL_CATALOG_URL,
	buildPiCatalogIndex,
	createPiCatalogLoader,
	resolvePiModelSources,
	resolvePiRelatedSources,
	stripNonPortableModelFields,
	type PiCatalogFetchOptions,
	type PiCatalogIndex,
	type PiCatalogSource
} from '../../src/core/pi-model-catalog.js';
import {
	buildPiModelDiscoveryEndpoint,
	createPiModelCandidate,
	discoverPiModels,
	mergePiModelDefinitions,
	mergePiModels,
	piModelCatalogSource,
	piModelDefinitionFor,
	resolvePiModelCandidate,
	type PiModelDiscoveryOptions
} from '../../src/core/pi-provider.js';
import {matchPiProviderModel} from '../../src/services/pi-provider-service.js';
import {
	applyPiCandidateMatch,
	applyPiDiscovery,
	beginPiCandidateMatch,
	cancelPiSourceMode,
	confirmPiSourceMode,
	deselectPiCandidate,
	findPiSelectionBlocker,
	movePiSourceCursor,
	openPiSourceMode,
	piCandidateFor,
	piEmptySelection,
	piModelSelectionFromValues,
	piModelRowSummary,
	piResolutionLabel,
	piSelectedDefinitions,
	piSelectedModelIds,
	piSourceJsonPreview,
	piSourceModeSource,
	piSourceSummary,
	setPiSelectionCursor,
	togglePiSourceView
} from '../../src/state/pi-model-selection-state.js';
import {filterPiCandidates} from '../../src/views/provider/pi-model-selection-panel.js';

// 迁自 scripts/verify-pi-model-catalog.mjs 的 A–E / G / H 段（186 条进程内行为断言）。
// 保留在 verify 的是 F 段（真实 CCQ_HOME 落盘字节：savePiProvider / models.json / auth.json）。
// 主题对账见 .trellis/tasks/09-20-p5-platform-carrier-migration/research-reconciliation-P5c.md。

type TestFetchInit = {headers: Record<string, string>; signal: AbortSignal};
type TestFetchImpl = (url: string, init: TestFetchInit) => Promise<Response>;

function catalogLoader(options: {fetchImpl?: TestFetchImpl; timeoutMs?: number; maxResponseBytes?: number} = {}) {
	return createPiCatalogLoader(options as unknown as PiCatalogFetchOptions);
}

function discoverPi(input: {
	baseUrl: string;
	api: string;
	apiKey?: string;
	options?: {fetchImpl?: TestFetchImpl; signal?: AbortSignal; timeoutMs?: number; maxResponseBytes?: number};
}) {
	return discoverPiModels(input as unknown as Parameters<typeof discoverPiModels>[0]);
}

/** `PiModelDefinition` 是 `Record<string, unknown>`；嵌套字段读取统一经此收窄。 */
function record(value: unknown): Record<string, unknown> {
	return (value ?? {}) as Record<string, unknown>;
}

const EXPECTED_APIS = [
	'anthropic-messages',
	'openai-completions',
	'openai-responses',
	'azure-openai-responses',
	'openai-codex-responses',
	'mistral-conversations',
	'google-generative-ai',
	'google-vertex',
	'bedrock-converse-stream',
	'pi-messages'
] as const;

const SUPPORTED = ['anthropic-messages', 'openai-completions', 'openai-responses', 'mistral-conversations', 'google-generative-ai'];
const UNSUPPORTED = ['azure-openai-responses', 'openai-codex-responses', 'google-vertex', 'bedrock-converse-stream', 'pi-messages'];

describe('A. 全端点 strategy registry', () => {
	test('PI_APIS / PI_KNOWN_APIS 与 KnownApi 判定', () => {
		expect([...PI_APIS], 'PI_APIS 必须等于 Pi models.json 文档支持的 API（表单可选集）').toEqual([
			'anthropic-messages',
			'openai-completions',
			'openai-responses',
			'google-generative-ai'
		]);
		expect([...PI_KNOWN_APIS], 'PI_KNOWN_APIS 必须是 Pi 当前 KnownApi 全集').toEqual([...EXPECTED_APIS]);
		expect(isPiApi('pi-messages')).toBe(true);
		expect(isPiFormApi('pi-messages'), '非文档支持 API 不得出现在表单选项').toBe(false);
		expect(isPiFormApi('openai-responses')).toBe(true);
		expect(isPiApi('not-an-api')).toBe(false);
		expect(piApiDiscoveryStrategy('not-an-api'), '未知 API 必须返回 null 而不是伪造 strategy').toBeNull();
	});

	test('支持 / 不支持发现的 API 矩阵', () => {
		for (const api of SUPPORTED) {
			const strategy = piApiDiscoveryStrategy(api);
			expect(strategy, `${api} 必须有 strategy`).toBeTruthy();
			expect(strategy?.supportsDiscovery, `${api} 必须标记为支持上游发现`).toBe(true);
			expect(buildPiModelDiscoveryEndpoint('https://api.example.com', api), `${api} 必须能派生发现端点`).toBeTruthy();
		}
		for (const api of UNSUPPORTED) {
			const strategy = piApiDiscoveryStrategy(api);
			expect(strategy, `${api} 必须有显式 strategy`).toBeTruthy();
			expect(strategy?.supportsDiscovery, `${api} 不能伪造 discovery 能力`).toBe(false);
			expect((strategy?.reason.length ?? 0) > 0, `${api} 必须给出降级原因`).toBe(true);
			expect(buildPiModelDiscoveryEndpoint('https://api.example.com', api), `${api} 不得派生发现端点`).toBeNull();
		}
	});

	test('端点派生规则', () => {
		expect(buildPiModelDiscoveryEndpoint('https://api.example.com/v1', 'openai-completions')).toBe('https://api.example.com/v1/models');
		expect(buildPiModelDiscoveryEndpoint('https://api.anthropic.com', 'anthropic-messages')).toBe(
			'https://api.anthropic.com/v1/models'
		);
		expect(buildPiModelDiscoveryEndpoint('https://api.anthropic.com/v1', 'anthropic-messages')).toBe(
			'https://api.anthropic.com/v1/models'
		);
		expect(buildPiModelDiscoveryEndpoint('https://api.mistral.ai/v1', 'mistral-conversations')).toBe(
			'https://api.mistral.ai/v1/models'
		);
		expect(buildPiModelDiscoveryEndpoint('https://generativelanguage.googleapis.com', 'google-generative-ai')).toBe(
			'https://generativelanguage.googleapis.com/v1beta/models'
		);
	});

	test('目录请求绝不携带自定义 Provider API Key', async () => {
		const noAuthLoader = await catalogLoader({
			fetchImpl: async (url, init) => {
				expect(url, 'Pi 目录必须只请求官方聚合端点').toBe(PI_MODEL_CATALOG_URL);
				expect(init.headers.Authorization, 'Pi 目录请求绝不携带自定义 Provider API Key').toBeUndefined();
				expect(init.headers['x-api-key']).toBeUndefined();
				expect(init.headers['x-goog-api-key']).toBeUndefined();
				return new Response(JSON.stringify({openai: {'gpt-5': {id: 'gpt-5', api: 'openai-responses', provider: 'openai'}}}), {
					status: 200
				});
			}
		}).load();
		expect(noAuthLoader.ok).toBe(true);
	});

	test('Anthropic discovery 使用 x-api-key + anthropic-version', async () => {
		const anthropicDiscovery = await discoverPi({
			baseUrl: 'https://api.anthropic.com',
			api: 'anthropic-messages',
			apiKey: 'anthropic-secret',
			options: {
				fetchImpl: async (url, init) => {
					expect(url).toBe('https://api.anthropic.com/v1/models');
					expect(init.headers['x-api-key']).toBe('anthropic-secret');
					expect(init.headers.Authorization).toBeUndefined();
					expect(init.headers['anthropic-version']).toBe('2023-06-01');
					return new Response(JSON.stringify({data: [{id: 'claude-fable-5'}]}), {status: 200});
				}
			}
		});
		expect(anthropicDiscovery.ok).toBe(true);
	});

	test('Google discovery 剥离 models/ 资源名前缀', async () => {
		const googleDiscovery = await discoverPi({
			baseUrl: 'https://generativelanguage.googleapis.com',
			api: 'google-generative-ai',
			apiKey: 'google-secret',
			options: {
				fetchImpl: async (url, init) => {
					expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
					expect(init.headers['x-goog-api-key']).toBe('google-secret');
					expect(init.headers.Authorization).toBeUndefined();
					return new Response(JSON.stringify({models: [{name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro'}]}), {
						status: 200
					});
				}
			}
		});
		expect(googleDiscovery.ok).toBe(true);
		if (googleDiscovery.ok) {
			expect(googleDiscovery.models[0]?.id, 'Google 资源名前缀必须剥离为 Pi 模型 ID').toBe('gemini-2.5-pro');
			expect(googleDiscovery.models[0]?.name, 'Google 的 models/<id> 资源名不得当作展示名写入').toBeUndefined();
		}
	});
});

const catalogPayload = {
	anthropic: {
		'claude-fable-5': {
			id: 'claude-fable-5',
			name: 'Fable 5',
			api: 'anthropic-messages',
			provider: 'anthropic',
			baseUrl: 'https://api.anthropic.com',
			headers: {'x-source-auth': 'leak-me'},
			reasoning: true,
			thinkingLevelMap: {off: null, xhigh: 'xhigh', max: 'max'},
			compat: {supportsStrictMode: true},
			input: ['text', 'image'],
			cost: {input: 3, output: 15},
			contextWindow: 200000,
			maxTokens: 64000
		}
	},
	opencode: {
		'claude-fable-5': {
			id: 'claude-fable-5',
			api: 'anthropic-messages',
			provider: 'opencode',
			baseUrl: 'https://opencode.ai/v1',
			thinkingLevelMap: {off: null},
			compat: {forceAdaptiveThinking: true},
			input: ['text'],
			cost: {input: 1, output: 4},
			contextWindow: 100000,
			maxTokens: 32000
		}
	},
	openai: {
		'gpt-5': {
			id: 'gpt-5',
			api: 'openai-responses',
			provider: 'openai',
			reasoning: true,
			input: ['text', 'image'],
			cost: {input: 1.25, output: 10, tiers: [{inputTokensAbove: 272000, input: 2}]},
			contextWindow: 400000,
			maxTokens: 128000
		}
	},
	'azure-openai-responses': {
		'gpt-5': {
			id: 'gpt-5',
			api: 'azure-openai-responses',
			provider: 'azure-openai-responses',
			contextWindow: 200000,
			maxTokens: 64000
		}
	},
	broken: {notAnObject: 'nope', '': {}},
	'no-api': {model: {id: 'model'}}
};

const catalogResult = buildPiCatalogIndex(catalogPayload);
if (!catalogResult.ok) throw new Error('catalog fixture must parse');
const catalog = catalogResult.index;
const fableSources = resolvePiModelSources(catalog, 'claude-fable-5', 'anthropic-messages');
const sourceA = fableSources.find(source => source.provider === 'anthropic');
const sourceB = fableSources.find(source => source.provider === 'opencode');
const uniqueCandidate = resolvePiModelCandidate({
	id: 'gpt-5',
	api: 'openai-responses',
	upstreamDefinition: {id: 'gpt-5'},
	catalog
});
const conflictCandidate = resolvePiModelCandidate({
	id: 'claude-fable-5',
	api: 'anthropic-messages',
	upstreamDefinition: {id: 'claude-fable-5'},
	catalog
});
const upstreamOnly = resolvePiModelCandidate({
	id: 'ghost-model',
	api: 'openai-completions',
	upstreamDefinition: {id: 'ghost-model', contextWindow: 4096},
	catalog
});

const matchValues = {
	providerType: 'custom-api-key',
	api: 'openai-responses',
	provider: 'custom-openai',
	model: 'gpt-5',
	models: 'gpt-5',
	baseUrl: 'https://gateway.example/v1',
	apiKey: 'gateway-secret',
	headers: '',
	authHeader: 'default' as const,
	headerPreset: '',
	variant: 'full' as const
};

describe('B. Pi 官方目录 parser / 索引 / 精确匹配', () => {
	test('聚合目录索引只收录有 id + api 的模型', () => {
		expect(catalogResult.ok, '合法聚合对象必须解析成功').toBe(true);
		expect(catalog.modelCount, '只索引有 id + api 的模型').toBe(2);
		expect(catalog.sourceCount, '每个 provider/model 记录都是一条来源').toBe(4);
	});

	test('精确 ID + 精确 API 匹配，多来源全部保留', () => {
		expect(fableSources.length, '同 ID 同 API 的多来源必须全部保留').toBe(2);
		expect(
			fableSources.map(source => source.provider),
			'来源必须保留 provider 身份'
		).toEqual(['anthropic', 'opencode']);
		expect(resolvePiModelSources(catalog, 'CLAUDE-FABLE-5', 'anthropic-messages'), '只做精确 ID 匹配，不做大小写归一').toEqual([]);
		expect(resolvePiModelSources(catalog, 'claude-fable-5', 'openai-completions'), '只做 API 严格相等匹配').toEqual([]);
		expect(resolvePiModelSources(catalog, 'missing-model', 'anthropic-messages')).toEqual([]);
	});

	test('跨 API 同 ID 条目只进入 relatedSources', () => {
		const related = resolvePiRelatedSources(catalog, 'gpt-5', 'openai-responses');
		expect(related.length).toBe(1);
		expect(related[0]?.api, '其他 API 的同 ID 条目必须单独只读暴露').toBe('azure-openai-responses');
	});

	test('目录定义剥离传输字段并保留 null 语义', () => {
		const stripped = record(sourceA?.definition);
		for (const key of ['provider', 'baseUrl', 'headers', 'api']) {
			expect(key in stripped, `目录定义不得迁移传输字段 ${key}`).toBe(false);
		}
		expect(record(stripped.thinkingLevelMap).off, 'thinkingLevelMap 的 null 语义必须保留').toBeNull();
		expect(record(stripped.cost).input).toBe(3);
		expect(stripNonPortableModelFields({id: 'x', provider: 'p', baseUrl: 'b', headers: {}, api: 'a', name: 'n'}).name).toBe('n');
	});

	test('非对象 / 数组 / 字符串目录响应必须失败', () => {
		expect(buildPiCatalogIndex(null).ok, '非对象目录响应必须失败').toBe(false);
		expect(buildPiCatalogIndex([1, 2]).ok, '数组目录响应必须失败').toBe(false);
		expect(buildPiCatalogIndex('nope').ok, '字符串目录响应必须失败').toBe(false);
		const emptyCatalog = buildPiCatalogIndex({});
		expect(emptyCatalog.ok).toBe(true);
		if (emptyCatalog.ok) expect(emptyCatalog.index.modelCount).toBe(0);
	});
});

let catalogRequests = 0;
const cachedLoader = catalogLoader({
	fetchImpl: async () => {
		catalogRequests += 1;
		return new Response(JSON.stringify({openai: {'gpt-5': {id: 'gpt-5', api: 'openai-responses', provider: 'openai'}}}), {
			status: 200
		});
	}
});
let failingRequests = 0;
const retryLoader = catalogLoader({
	fetchImpl: async () => {
		failingRequests += 1;
		throw new Error('catalog offline');
	}
});

describe('C. catalog loader：缓存 / 超时 / 取消 / 超限 / 网络失败', () => {
	test('成功目录进程内缓存，reset 后允许重新下载', async () => {
		expect((await cachedLoader.load()).ok).toBe(true);
		expect((await cachedLoader.load()).ok).toBe(true);
		expect(catalogRequests, '成功目录必须在进程内缓存，只请求一次').toBe(1);
		cachedLoader.reset();
		expect((await cachedLoader.load()).ok).toBe(true);
		expect(catalogRequests, 'reset 后允许重新下载').toBe(2);
	});

	test('失败结果不得缓存，下一次选择可重试', async () => {
		const firstFailure = await retryLoader.load();
		expect(firstFailure.ok).toBe(false);
		expect(firstFailure.ok ? undefined : firstFailure.kind).toBe('network');
		expect((await retryLoader.load()).ok).toBe(false);
		expect(failingRequests, '失败结果不得缓存，下一次选择必须能重试').toBe(2);
	});

	test('超时必须报 timeout', async () => {
		const timeoutLoader = catalogLoader({
			timeoutMs: 5,
			fetchImpl: async (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
				})
		});
		const timeoutFailure = await timeoutLoader.load();
		expect(timeoutFailure.ok).toBe(false);
		expect(timeoutFailure.ok ? undefined : timeoutFailure.kind).toBe('timeout');
	});

	test('取消当前等待必须立即返回 cancelled', async () => {
		const cancelController = new AbortController();
		const cancelLoader = catalogLoader({
			fetchImpl: async (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
				})
		});
		const cancelPromise = cancelLoader.load(cancelController.signal);
		cancelController.abort();
		const cancelFailure = await cancelPromise;
		expect(cancelFailure.ok).toBe(false);
		expect(cancelFailure.ok ? undefined : cancelFailure.kind, '取消当前等待必须立即返回 cancelled').toBe('cancelled');
	});

	test('空响应 / 超限 / 非法 JSON / HTTP 错误 / 非对象 一律 invalid 或 http', async () => {
		const emptyLoader = catalogLoader({fetchImpl: async () => new Response('', {status: 200})});
		const emptyFailure = await emptyLoader.load();
		expect(emptyFailure.ok).toBe(false);
		expect(emptyFailure.ok ? undefined : emptyFailure.kind, '空响应必须报 invalid 而不是静默成功').toBe('invalid');

		const oversizedLoader = catalogLoader({
			maxResponseBytes: 16,
			fetchImpl: async () =>
				new Response(JSON.stringify({openai: {'gpt-5': {id: 'gpt-5', api: 'openai-responses', provider: 'openai'}}}))
		});
		const oversizedFailure = await oversizedLoader.load();
		expect(oversizedFailure.ok).toBe(false);
		expect(oversizedFailure.ok ? undefined : oversizedFailure.kind).toBe('invalid');

		const invalidJsonLoader = catalogLoader({fetchImpl: async () => new Response('{broken')});
		const invalidJsonFailure = await invalidJsonLoader.load();
		expect(invalidJsonFailure.ok).toBe(false);
		expect(invalidJsonFailure.ok ? undefined : invalidJsonFailure.kind).toBe('invalid');

		const httpLoader = catalogLoader({fetchImpl: async () => new Response('nope', {status: 503})});
		const httpFailure = await httpLoader.load();
		expect(httpFailure.ok).toBe(false);
		expect(httpFailure.ok ? undefined : httpFailure.kind).toBe('http');

		const nonObjectLoader = catalogLoader({fetchImpl: async () => new Response(JSON.stringify([1, 2, 3]))});
		const nonObjectFailure = await nonObjectLoader.load();
		expect(nonObjectFailure.ok).toBe(false);
		expect(nonObjectFailure.ok ? undefined : nonObjectFailure.kind).toBe('invalid');
	});
});

describe('D. matcher：唯一 / 冲突 / 跨 API / 无匹配 / 目录失败降级', () => {
	test('唯一来源自动采用，跨 API 条目进入 relatedSources', () => {
		expect(uniqueCandidate.resolution.kind, '同 API 唯一来源必须自动采用').toBe('automatic');
		expect(uniqueCandidate.sources.length).toBe(1);
		expect(
			uniqueCandidate.relatedSources.map(source => source.api),
			'跨 API 条目只能进入 relatedSources'
		).toEqual(['azure-openai-responses']);
	});

	test('同 ID 同 API 多来源必须进入 conflict', () => {
		expect(conflictCandidate.resolution.kind, '同 ID 同 API 多来源必须进入 conflict').toBe('conflict');
		expect(conflictCandidate.resolution.kind === 'conflict' ? conflictCandidate.resolution.sources.length : -1).toBe(2);
	});

	test('无匹配与 catalog 未加载安全降级为 upstream-only', () => {
		expect(upstreamOnly.resolution.kind).toBe('upstream-only');
		expect(upstreamOnly.sources.length).toBe(0);
		const noCatalog = resolvePiModelCandidate({
			id: 'gpt-5',
			api: 'openai-responses',
			upstreamDefinition: {id: 'gpt-5'},
			catalog: null
		});
		expect(noCatalog.resolution.kind, 'catalog 未加载必须安全降级').toBe('upstream-only');
	});

	test('目录成功 / 失败时的 matchPiProviderModel 行为', async () => {
		const matched = await matchPiProviderModel(matchValues, {id: 'gpt-5'}, undefined, {catalogLoader: cachedLoader});
		expect(matched.ok).toBe(true);
		if (matched.ok) {
			expect(matched.candidate.resolution.kind).toBe('automatic');
			expect(matched.warning).toBeUndefined();
		}
		const degraded = await matchPiProviderModel(matchValues, {id: 'gpt-5'}, undefined, {catalogLoader: retryLoader});
		expect(degraded.ok, '目录失败不得阻塞模型选择').toBe(true);
		if (degraded.ok) {
			expect(degraded.candidate.resolution.kind).toBe('upstream-only');
			expect(degraded.warning, '目录失败必须给出非阻塞降级提示').toMatch(/Pi 官方模型目录不可用/);
		}
	});

	test('惰性：上游发现阶段不请求目录；首次选择 intent 才请求；后续命中缓存', async () => {
		let lazyCatalogRequests = 0;
		const lazyLoader = catalogLoader({
			fetchImpl: async () => {
				lazyCatalogRequests += 1;
				return new Response(
					JSON.stringify({
						openai: {
							'gpt-5': {id: 'gpt-5', api: 'openai-responses', provider: 'openai'},
							'gpt-5-mini': {id: 'gpt-5-mini', api: 'openai-responses', provider: 'openai'}
						}
					}),
					{status: 200}
				);
			}
		});
		let lazyState = applyPiDiscovery(piEmptySelection(), [{id: 'gpt-5'}, {id: 'gpt-5-mini'}]);
		expect(lazyCatalogRequests, '上游发现阶段不得请求 Pi 官方目录').toBe(0);
		lazyState = beginPiCandidateMatch(lazyState, 'gpt-5');
		expect(lazyCatalogRequests, '匹配开始也不得同步阻塞下载').toBe(0);
		const lazyMatch = await matchPiProviderModel(matchValues, {id: 'gpt-5'}, undefined, {catalogLoader: lazyLoader});
		expect(lazyMatch.ok).toBe(true);
		expect(lazyCatalogRequests, '首次选择 intent 才请求一次目录').toBe(1);
		if (lazyMatch.ok) lazyState = applyPiCandidateMatch(lazyState, lazyMatch.candidate);
		const secondMatch = await matchPiProviderModel(matchValues, {id: 'gpt-5-mini'}, undefined, {catalogLoader: lazyLoader});
		expect(secondMatch.ok).toBe(true);
		expect(lazyCatalogRequests, '后续选择必须命中进程内缓存').toBe(1);
	});
});

describe('E. merge 优先级 / 嵌套语义 / 传输字段剥离 / 不跨来源拼接', () => {
	test('高优先级层覆盖标量、按 key 合并嵌套、数组整体替换', () => {
		const merged = mergePiModelDefinitions([
			{id: 'm', name: '目录名', reasoning: false, cost: {input: 1, output: 2, cacheRead: 0.5}, input: ['text'], contextWindow: 100},
			{id: 'm', name: '上游名', cost: {input: 9}, input: ['text', 'image']},
			{id: 'm', name: '用户名', contextWindow: 200, userField: {keep: true}}
		]);
		expect(merged.name, '更高优先级层必须覆盖低优先级同名标量').toBe('用户名');
		expect(merged.cost, '嵌套对象必须按 key 合并').toEqual({input: 9, output: 2, cacheRead: 0.5});
		expect(merged.input, '数组由较高优先级整体替换').toEqual(['text', 'image']);
		expect(merged.contextWindow).toBe(200);
		expect(merged.reasoning, '显式 false 是有效值，不得被当作缺失').toBe(false);
		expect(merged.userField).toEqual({keep: true});
	});

	test('空字符串 / 空对象 / 空数组 / undefined 不得覆盖已有值', () => {
		const noDowngrade = mergePiModelDefinitions([
			{id: 'm', name: '目录名', cost: {input: 1}, input: ['text', 'image'], thinkingLevelMap: {off: null}, reasoning: true},
			{id: 'm', name: '', cost: {}, input: [], thinkingLevelMap: undefined, reasoning: undefined}
		]);
		expect(noDowngrade.name, '空字符串不得覆盖已有值').toBe('目录名');
		expect(noDowngrade.cost, '空对象不得覆盖已有嵌套值').toEqual({input: 1});
		expect(noDowngrade.input, '空数组不得覆盖已有数组').toEqual(['text', 'image']);
		expect(noDowngrade.thinkingLevelMap, 'undefined 不得覆盖已有值').toEqual({off: null});
		expect(noDowngrade.reasoning).toBe(true);
	});

	test('未解析来源时已有配置优先，上游只补缺', () => {
		const userExisting = {id: 'gpt-5', contextWindow: 333, customField: 'mine'};
		const unresolvedDefinition = piModelDefinitionFor(
			resolvePiModelCandidate({
				id: 'gpt-5',
				api: 'openai-responses',
				upstreamDefinition: {id: 'gpt-5', maxTokens: 128000},
				existingDefinition: userExisting
			})
		);
		expect(unresolvedDefinition.contextWindow, '未解析来源时已有配置优先').toBe(333);
		expect(unresolvedDefinition.maxTokens, '未解析来源时上游可补缺').toBe(128000);
		expect(unresolvedDefinition.customField, '未知扩展字段必须保留').toBe('mine');
	});

	test('automatic 来源覆盖已有与上游，未提到的字段保留', () => {
		const userExisting = {id: 'gpt-5', contextWindow: 333, customField: 'mine'};
		const definitionForCandidate = piModelDefinitionFor({
			...uniqueCandidate,
			upstreamDefinition: {id: 'gpt-5', maxTokens: 111},
			existingDefinition: userExisting
		});
		expect(definitionForCandidate.contextWindow, '自动匹配的来源必须覆盖已有 contextWindow').toBe(400000);
		expect(definitionForCandidate.maxTokens, '自动匹配的来源必须覆盖上游 maxTokens').toBe(128000);
		expect(definitionForCandidate.customField, '未知扩展字段必须保留').toBe('mine');
		for (const key of ['provider', 'baseUrl', 'headers', 'api']) {
			expect(key in definitionForCandidate, `最终定义不得含目录传输字段 ${key}`).toBe(false);
		}
	});

	test('chosen 来源覆盖已有值，cost 整体替换不按键混合', () => {
		const uniqueSource = uniqueCandidate.sources[0];
		if (!uniqueSource) throw new Error('unique source must exist');
		const overrideExisting = {
			id: 'gpt-5',
			name: '用户自定义名',
			contextWindow: 333,
			input: ['text'],
			cost: {input: 99, output: 99, cacheRead: 7, cacheWrite: 7},
			userOnlyField: 'mine'
		};
		const overrideChosen = piModelDefinitionFor({
			...uniqueCandidate,
			resolution: {kind: 'chosen', source: uniqueSource},
			upstreamDefinition: {id: 'gpt-5', maxTokens: 111},
			existingDefinition: overrideExisting
		});
		expect(overrideChosen.contextWindow, '显式选择的来源必须覆盖已有 contextWindow').toBe(400000);
		expect(overrideChosen.maxTokens, '显式选择的来源必须覆盖已有与上游 maxTokens').toBe(128000);
		expect(overrideChosen.input, '显式选择的来源必须覆盖已有 input').toEqual(['text', 'image']);
		expect(overrideChosen.cost, '显式选择的来源必须整体替换 cost，不得与旧价格按键混合').toEqual({
			input: 1.25,
			output: 10,
			tiers: [{inputTokensAbove: 272000, input: 2}]
		});
		expect(overrideChosen.name, '来源未定义的字段保留已有值').toBe('用户自定义名');
		expect(overrideChosen.userOnlyField, '来源未提到的未知扩展字段必须保留').toBe('mine');
		for (const key of ['provider', 'baseUrl', 'headers', 'api']) {
			expect(key in overrideChosen, `chosen 覆盖后仍不得含目录传输字段 ${key}`).toBe(false);
		}
	});

	test('chosen 必须整体替换 thinkingLevelMap / compat，不跨来源拼接', () => {
		expect(sourceB, 'opencode 来源必须存在').toBeTruthy();
		expect(sourceA && sourceB).toBeTruthy();
		if (!sourceA || !sourceB) throw new Error('fable sources must exist');
		const chosenOverride = piModelDefinitionFor({
			...conflictCandidate,
			resolution: {kind: 'chosen', source: sourceB},
			existingDefinition: {
				id: 'claude-fable-5',
				thinkingLevelMap: {max: 'legacy-max', high: 'legacy-high'},
				compat: {supportsStrictMode: true},
				keepMe: 1
			}
		});
		expect(chosenOverride.thinkingLevelMap, 'chosen 必须整体替换 thinkingLevelMap，不得残留旧等级').toEqual({off: null});
		expect(chosenOverride.compat, 'chosen 必须整体替换 compat，不得混入旧字段').toEqual({forceAdaptiveThinking: true});
		expect(chosenOverride.keepMe, '非目录字段仍必须保留').toBe(1);
		expect(piModelCatalogSource(conflictCandidate), 'conflict 状态不得默认采用任意来源').toBeNull();

		const chosenCandidate = {...conflictCandidate, resolution: {kind: 'chosen', source: sourceB} as const};
		const chosenDefinition = piModelDefinitionFor(chosenCandidate);
		expect(chosenDefinition.thinkingLevelMap, '只采用所选来源的 thinkingLevelMap').toEqual({off: null});
		expect(chosenDefinition.compat, '只采用所选来源的 compat').toEqual({forceAdaptiveThinking: true});
		expect(record(chosenDefinition.compat).supportsStrictMode, '不得混入其它来源的 compat').toBeUndefined();
		expect('headers' in chosenDefinition).toBe(false);
	});

	test('mergePiModels 重新发现只补缺，不覆盖用户已有字段', () => {
		expect(
			mergePiModels(
				[{id: 'keep', contextWindow: 999}],
				[
					{id: 'keep', contextWindow: 1, maxTokens: 2},
					{id: 'new', maxTokens: 3}
				]
			),
			'重新发现只补缺，不覆盖用户已有字段'
		).toEqual([
			{id: 'keep', contextWindow: 999, maxTokens: 2},
			{id: 'new', maxTokens: 3}
		]);
	});
});

describe('G. 选择状态机：惰性匹配 / 二级来源选择 / 复用 / Ctrl+S 门禁', () => {
	test('编辑态既有模型允许直接保存', () => {
		const initialState = piModelSelectionFromValues({
			models: 'existing-model',
			modelDefinitions: [{id: 'existing-model', contextWindow: 200000, userField: 'keep'}]
		});
		expect(piSelectedModelIds(initialState)).toEqual(['existing-model']);
		expect(piCandidateFor(initialState, 'existing-model')?.resolution.kind, '初始候选不得批量匹配').toBe('idle');
		expect(findPiSelectionBlocker(initialState), '编辑态既有模型允许直接保存').toBeNull();
		expect(piSelectedDefinitions(initialState)).toEqual([{id: 'existing-model', contextWindow: 200000, userField: 'keep'}]);
	});

	test('唯一来源直接勾选，行尾状态词与解析标签', () => {
		let selection = piModelSelectionFromValues({models: ''});
		expect(selection.status).toBe('idle');
		selection = applyPiDiscovery(selection, [{id: 'gpt-5'}, {id: 'claude-fable-5'}, {id: 'ghost-model'}]);
		expect(piSelectedModelIds(selection), '上游发现后不得自动勾选').toEqual([]);
		expect(selection.status).toBe('selecting');
		const gptIndex = selection.candidates.findIndex(candidate => candidate.id === 'gpt-5');
		selection = setPiSelectionCursor(selection, gptIndex);
		selection = beginPiCandidateMatch(selection, 'gpt-5');
		expect(piCandidateFor(selection, 'gpt-5')?.resolution.kind).toBe('matching');
		selection = applyPiCandidateMatch(selection, uniqueCandidate);
		expect(piCandidateFor(selection, 'gpt-5')?.resolution.kind).toBe('automatic');
		expect(piSelectedModelIds(selection), '唯一来源必须直接勾选').toEqual(['gpt-5']);
		expect(selection.sourceMode).toBeNull();
		const gptCandidate = piCandidateFor(selection, 'gpt-5');
		if (!gptCandidate) throw new Error('gpt-5 candidate must exist');
		expect(piResolutionLabel(gptCandidate), '已解析来源只显示 provider 名').toMatch(/openai/);
		expect(piResolutionLabel(gptCandidate), '行尾不得再拼状态后缀').not.toMatch(/自动匹配/);

		const configuredState = piModelSelectionFromValues({
			models: 'gpt-5',
			modelDefinitions: [{id: 'gpt-5', contextWindow: 400000, maxTokens: 128000}]
		});
		const configuredCandidate = configuredState.candidates[0];
		if (!configuredCandidate) throw new Error('configured candidate must exist');
		expect(piModelRowSummary(configuredCandidate), '已有 models.json 定义时行尾显示参数状态').toBe('已配置模型参数');
		expect(
			piModelRowSummary(resolvePiModelCandidate({id: 'bare-model', api: 'openai-completions'})),
			'未配置参数时行尾不得输出状态'
		).toBe('');
	});

	test('取消勾选清除来源，重新勾选重新匹配', () => {
		let selection = applyPiDiscovery(piModelSelectionFromValues({models: ''}), [{id: 'gpt-5'}]);
		selection = applyPiCandidateMatch(selection, uniqueCandidate);

		selection = deselectPiCandidate(selection, 'gpt-5');
		expect(piSelectedModelIds(selection)).toEqual([]);
		expect(piCandidateFor(selection, 'gpt-5')?.resolution.kind, '取消勾选必须清除已解析来源').toBe('idle');
		selection = beginPiCandidateMatch(selection, 'gpt-5');
		expect(piCandidateFor(selection, 'gpt-5')?.resolution.kind, '重新勾选必须重新进入匹配').toBe('matching');
		selection = applyPiCandidateMatch(selection, uniqueCandidate);
		expect(piCandidateFor(selection, 'gpt-5')?.resolution.kind, '重新匹配后必须重新解析来源').toBe('automatic');
		expect(piSelectedModelIds(selection), '重新匹配唯一来源后必须重新勾选').toEqual(['gpt-5']);
	});

	test('conflict 二级来源选择、Esc 不勾选、Enter 确认整条来源', () => {
		let selection = applyPiDiscovery(piModelSelectionFromValues({models: ''}), [
			{id: 'gpt-5'},
			{id: 'claude-fable-5'},
			{id: 'ghost-model'}
		]);
		selection = applyPiCandidateMatch(selection, uniqueCandidate);
		selection = applyPiCandidateMatch(selection, conflictCandidate);
		expect(selection.selected.has('claude-fable-5'), 'conflict 候选不得直接勾选').toBe(false);
		expect(findPiSelectionBlocker(selection), '未勾选的冲突来源不得阻塞 Ctrl+S').toBeNull();
		expect(selection.sourceMode?.modelId).toBe('claude-fable-5');
		expect(findPiSelectionBlocker({...selection, selected: new Set(['claude-fable-5'])}), 'conflict 已勾选必须被 Ctrl+S 门禁拦截').toBe(
			'claude-fable-5'
		);
		expect(
			findPiSelectionBlocker({
				...selection,
				selected: new Set(['gpt-5']),
				candidates: selection.candidates.map(candidate =>
					candidate.id === 'gpt-5' ? {...candidate, resolution: {kind: 'matching'} as const} : candidate
				)
			}),
			'matching 已勾选（防御性非法态）必须被 Ctrl+S 门禁拦截'
		).toBe('gpt-5');
		selection = movePiSourceCursor(selection, 1);
		expect(piSourceModeSource(selection)?.provider).toBe('opencode');
		selection = togglePiSourceView(selection);
		expect(selection.sourceMode?.view).toBe('json');
		const previewCandidate = piCandidateFor(selection, 'claude-fable-5');
		const previewSource = piSourceModeSource(selection);
		if (!previewCandidate || !previewSource) throw new Error('source mode must be open');
		const preview = piSourceJsonPreview(previewCandidate, previewSource);
		expect(JSON.parse(preview).contextWindow, 'JSON 预览必须使用当前焦点来源').toBe(100000);
		expect(piSourceSummary(previewSource), '来源摘要只读该来源自己的字段').toMatch(/上下文 100000/);
		selection = cancelPiSourceMode(selection);
		expect(selection.sourceMode).toBeNull();
		expect(selection.selected.has('claude-fable-5'), 'Esc 返回后模型必须保持未勾选').toBe(false);
		selection = openPiSourceMode(selection, 'claude-fable-5');
		selection = movePiSourceCursor(selection, -1);
		selection = confirmPiSourceMode(selection);
		const chosenResolution = piCandidateFor(selection, 'claude-fable-5')?.resolution;
		expect(chosenResolution?.kind).toBe('chosen');
		expect(chosenResolution?.kind === 'chosen' ? chosenResolution.source.provider : undefined).toBe('anthropic');
		expect(selection.selected.has('claude-fable-5'), '确认来源后才勾选').toBe(true);
		expect(selection.sourceMode).toBeNull();
	});

	test('无来源以仅上游/仅 ID 状态勾选并提示', () => {
		let selection = applyPiDiscovery(piModelSelectionFromValues({models: ''}), [{id: 'ghost-model'}]);
		selection = applyPiCandidateMatch(selection, upstreamOnly);
		expect(selection.selected.has('ghost-model')).toBe(true);
		const ghostCandidate = piCandidateFor(selection, 'ghost-model');
		if (!ghostCandidate) throw new Error('ghost candidate must exist');
		expect(piResolutionLabel(ghostCandidate)).toMatch(/仅上游/);
	});

	test('目录降级 warning 生命周期：新匹配结果替换而非保留上一条', () => {
		let warningSelection = applyPiCandidateMatch(
			applyPiDiscovery(piEmptySelection(), [{id: 'ghost-model'}]),
			{...createPiModelCandidate({id: 'ghost-model'}), resolution: {kind: 'upstream-only'}},
			'Pi 官方模型目录不可用（network）'
		);
		expect(warningSelection.warning, '目录失败必须保留非阻塞提示').toMatch(/目录不可用/);
		warningSelection = applyPiCandidateMatch(applyPiDiscovery(warningSelection, [{id: 'gpt-5'}]), uniqueCandidate);
		expect(warningSelection.warning, '新的成功匹配必须清除上一次目录降级提示').toBeNull();
		expect(warningSelection.selected.has('gpt-5'), '恢复后的唯一来源仍必须直接勾选').toBe(true);
	});

	test('手工输入与上游发现走同一入口', () => {
		let selection = applyPiDiscovery(piModelSelectionFromValues({models: ''}), []);
		expect(selection.status).toBe('selecting');
		selection = piModelSelectionFromValues({models: 'manual-model'});
		expect(piCandidateFor(selection, 'manual-model')?.resolution.kind).toBe('idle');
	});
});

describe('H. 压力：≥1000 条上游模型 + 索引查询不嵌套扫描 + 不预计算 JSON', () => {
	test('千级索引解析与状态构建保持线性，不预计算 JSON', () => {
		class CountingMap<K, V> extends Map<K, V> {
			getCalls = 0;
			override get(key: K): V | undefined {
				this.getCalls += 1;
				return super.get(key);
			}
		}

		const byApi = new CountingMap<string, readonly PiCatalogSource[]>();
		byApi.set('openai-completions', [
			{key: 'openai\u0000openai-completions', provider: 'openai', api: 'openai-completions', definition: {id: 'model-0'}}
		]);
		const byModelId = new CountingMap<string, ReadonlyMap<string, readonly PiCatalogSource[]>>();
		for (let index = 0; index < 1000; index++) byModelId.set(`model-${index}`, byApi);
		const bigIndex: PiCatalogIndex = {byModelId, modelCount: 1000, sourceCount: 1000};

		const startedAt = performance.now();
		for (let index = 0; index < 1000; index++) {
			const sources = resolvePiModelSources(bigIndex, `model-${index}`, 'openai-completions');
			expect(sources.length).toBe(1);
		}
		const elapsed = performance.now() - startedAt;
		expect(byModelId.getCalls, '每次解析只允许一次索引 get，禁止嵌套全量扫描').toBe(1000);
		expect(byApi.getCalls, 'API 维度同样只允许一次索引 get').toBe(1000);
		expect(elapsed < 2000, `1000 次索引解析必须保持线性可用（实际 ${Math.round(elapsed)}ms）`).toBe(true);

		const upstream1000 = Array.from({length: 1000}, (_value, index) => ({
			id: `model-${index}`,
			contextWindow: 128000 + index,
			maxTokens: 16384,
			input: ['text']
		}));

		const originalStringify = JSON.stringify;
		let stringifyCalls = 0;
		let discoveryElapsed = 0;
		JSON.stringify = ((...args: unknown[]) => {
			stringifyCalls += 1;
			return (originalStringify as (...inner: unknown[]) => string)(...args);
		}) as unknown as typeof JSON.stringify;
		try {
			let stressState = piEmptySelection();
			const discoveryStart = performance.now();
			stressState = applyPiDiscovery(stressState, upstream1000);
			discoveryElapsed = performance.now() - discoveryStart;
			expect(stressState.candidates.length).toBe(1000);
			stressState = piModelSelectionFromValues({models: upstream1000.map(model => model.id).join('\n')});
			expect(stressState.candidates.length).toBe(1000);
			expect(stringifyCalls, '列表与选择状态构建不得为每行预计算 JSON').toBe(0);
			expect(discoveryElapsed < 2000, `1000 条上游模型必须保持可用（实际 ${Math.round(discoveryElapsed)}ms）`).toBe(true);

			const filtered = filterPiCandidates(stressState.candidates, 'model-99');
			expect(filtered.length >= 10 && filtered.length <= 100, '千级列表筛选必须稳定可用').toBe(true);
			const focused = filtered[0];
			if (!focused) throw new Error('focused candidate must exist');
			const previewSource = resolvePiModelSources(bigIndex, focused.id, 'openai-completions')[0];
			if (!previewSource) throw new Error('preview source must exist');
			const previewJson = piSourceJsonPreview(focused, {
				...previewSource,
				definition: {...previewSource.definition, contextWindow: 123}
			});
			expect(stringifyCalls, 'JSON 预览只为当前焦点候选生成一次').toBe(1);
			expect(originalStringify(JSON.parse(previewJson)).length > 0).toBe(true);
		} finally {
			JSON.stringify = originalStringify;
		}
	});
});
