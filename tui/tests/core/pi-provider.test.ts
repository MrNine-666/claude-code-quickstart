import {describe, expect, test} from 'bun:test';

import {PI_APIS, PI_KNOWN_APIS, piApiDiscoveryStrategy} from '../../src/core/pi-api-discovery.js';
import {createPiCatalogLoader, type PiCatalogFetchOptions} from '../../src/core/pi-model-catalog.js';
import {buildPiModelDiscoveryEndpoint, discoverPiModels, parsePiProviderKey} from '../../src/core/pi-provider.js';
import type {ProviderDisplayProfile} from '../../src/core/provider.js';
import {discoverPiProviderModels, matchPiProviderModel} from '../../src/services/pi-provider-service.js';
import {createProviderViewAdapter} from '../../src/views/provider/provider-view-adapter.js';

// 迁自 scripts/verify-pi-provider.mjs 的进程内行为断言（27 条）：Pi 卡片描述投影 / parsePiProviderKey /
// PI_APIS 与 KnownApi strategy / discovery endpoint 与去重 / unsupported + service discovery /
// 惰性匹配 resolution。保留在 verify 的是真实 ~/.pi 落盘字节与损坏文件拒写断言。
// 主题对账见 .trellis/tasks/09-20-p5-platform-carrier-migration/research-reconciliation-P5c.md。

type TestFetchInit = {headers: Record<string, string>; signal: AbortSignal};
type TestFetchImpl = (url: string, init: TestFetchInit) => Promise<Response>;

function piRow(overrides: Partial<ProviderDisplayProfile> = {}): ProviderDisplayProfile {
	return {
		key: 'pi-row',
		baseUrl: 'https://api.example.com',
		authToken: '',
		profilePath: 'pi-row',
		isActive: false,
		maskedApiKey: 'sk-****',
		...overrides
	};
}

const customInput = {
	providerType: 'custom-api-key',
	provider: 'custom-acme',
	api: 'openai-completions',
	model: 'acme-one',
	models: 'acme-one\nacme-two',
	baseUrl: 'https://acme.example/v1',
	apiKey: 'acme-secret',
	headers: '',
	authHeader: 'default' as const,
	headerPreset: '',
	variant: 'full' as const
};

describe('Pi 卡片描述投影', () => {
	test('title / summary 由 provider 元数据与凭据类型决定', () => {
		const pi = createProviderViewAdapter('pi');
		expect(pi.toHomeRow(piRow({key: 'openai', displayName: 'OpenAI'})).title).toBe('OpenAI · openai');

		const deepseekRow = piRow({
			key: 'deepseek',
			baseUrl: 'https://api.deepseek.com',
			maskedApiKey: 'sk-ds-****',
			authKind: 'api_key',
			source: 'builtin'
		});
		const deepseekHome = pi.toHomeRow(deepseekRow);
		expect(deepseekHome.summary, 'Pi 内置 Provider 必须展示 url + key + 官方').toBe(
			`https://api.deepseek.com · ${deepseekRow.maskedApiKey} · 官方`
		);
		expect(deepseekHome.summary, 'Pi 卡片描述不得再拼接模型数与 source 原值').not.toMatch(/个模型|builtin/);
		expect(pi.toHomeRow(piRow({key: 'keep', source: 'custom'})).summary, '仅 models.json 自定义 Provider 记为自定义').toMatch(
			/· 自定义$/
		);
		expect(
			pi.toHomeRow(piRow({key: 'auth-login', source: 'unknown'})).summary,
			'仅 auth.json 来源的非自定义 Provider 归为官方'
		).toMatch(/· 官方$/);
		expect(
			pi.toHomeRow(piRow({key: 'openai-codex', authKind: 'oauth', authStatus: 'configured'})).summary,
			'Pi OAuth 已登录时只展示已授权登录'
		).toBe('已授权登录');
		expect(
			pi.toHomeRow(piRow({key: 'openai-codex', authKind: 'oauth', authStatus: 'invalid'})).summary,
			'Pi OAuth 凭据不完整时必须告警而非展示为已登录'
		).toBe('授权凭据不完整，请通过 /login 修复');
		expect(
			pi.toHomeRow(piRow({key: 'aether-cx', displayName: 'aether-cx'})).title,
			'provider displayName 与 ID 相同时列表标题不得重复'
		).toBe('aether-cx');
	});
});

describe('parsePiProviderKey', () => {
	test('Pi identity 必须是 provider ID', () => {
		expect(parsePiProviderKey('openai/gpt-4o'), 'Pi identity 必须是 provider ID').toBeNull();
		expect(parsePiProviderKey('openai')?.provider).toBe('openai');
	});
});

describe('Pi discovery / KnownApi strategy', () => {
	test('buildPiModelDiscoveryEndpoint 派生 /models', () => {
		expect(buildPiModelDiscoveryEndpoint('https://api.example.com/v1', 'openai-completions')).toBe('https://api.example.com/v1/models');
	});

	test('discoverPiModels 携带 Bearer 并去重排序', async () => {
		const discovery = await discoverPiModels({
			baseUrl: 'https://api.example.com/v1',
			api: 'openai-completions',
			apiKey: 'discovery-secret',
			options: {
				fetchImpl: async (_url: string, init: TestFetchInit) => {
					expect(init.headers.Authorization).toBe('Bearer discovery-secret');
					return new Response(JSON.stringify({data: [{id: 'acme-four'}, {id: 'acme-four'}, {id: 'acme-five'}]}), {
						status: 200,
						headers: {'content-type': 'application/json'}
					});
				}
			}
		} as unknown as Parameters<typeof discoverPiModels>[0]);
		expect(discovery.ok).toBe(true);
		if (discovery.ok) {
			expect(discovery.models.map(model => model.id)).toEqual(['acme-five', 'acme-four']);
		}
	});

	test('PI_APIS 表单可选集 / PI_KNOWN_APIS 全集 / 不支持发现显式降级', () => {
		expect([...PI_APIS], 'PI_APIS 必须等于 Pi models.json 文档支持的 API（表单可选集）').toEqual([
			'anthropic-messages',
			'openai-completions',
			'openai-responses',
			'google-generative-ai'
		]);
		expect([...PI_KNOWN_APIS], 'PI_KNOWN_APIS 必须覆盖 Pi 当前 KnownApi 全集').toEqual([
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
		]);
		for (const api of ['azure-openai-responses', 'openai-codex-responses', 'google-vertex', 'bedrock-converse-stream', 'pi-messages']) {
			const strategy = piApiDiscoveryStrategy(api);
			expect(strategy?.supportsDiscovery, `${api} 必须显式降级`).toBe(false);
			expect((strategy?.reason.length ?? 0) > 0, `${api} 必须给出降级原因`).toBe(true);
		}
	});

	test('无列表接口的 API 降级为手工填写', async () => {
		const unsupportedDiscovery = await discoverPiModels({baseUrl: 'https://api.example.com', api: 'pi-messages'});
		expect(unsupportedDiscovery.ok).toBe(false);
		expect(unsupportedDiscovery.ok ? undefined : unsupportedDiscovery.kind).toBe('unsupported');
		expect(unsupportedDiscovery.ok ? undefined : unsupportedDiscovery.error).toMatch(/手工填写模型 ID/);
	});

	test('service discovery 保留上游完整对象，无列表接口 rejects', async () => {
		const serviceDiscovered = await discoverPiProviderModels(
			{...customInput, provider: 'custom-service', baseUrl: 'https://api.example.com/v1', api: 'openai-completions'},
			undefined,
			{
				fetchImpl: (async () =>
					new Response(
						JSON.stringify({data: [{id: 'acme-six', contextWindow: 200000, maxTokens: 64000, input: ['text', 'image']}]}),
						{status: 200}
					)) as unknown as typeof fetch
			}
		);
		expect(serviceDiscovered[0]?.id).toBe('acme-six');
		expect(serviceDiscovered[0]?.contextWindow, 'discovery 必须保留上游完整字段').toBe(200000);
		expect(serviceDiscovered[0]?.input).toEqual(['text', 'image']);
		await expect(discoverPiProviderModels({...customInput, api: 'pi-messages'})).rejects.toThrow(/手工填写模型 ID/);
	});
});

describe('惰性匹配与失败路径', () => {
	test('唯一来源自动采用', async () => {
		const catalogLoader = createPiCatalogLoader({
			fetchImpl: (async () =>
				new Response(
					JSON.stringify({
						anthropic: {
							'claude-fable-5': {
								id: 'claude-fable-5',
								name: 'Fable 5',
								api: 'anthropic-messages',
								provider: 'anthropic',
								baseUrl: 'https://api.anthropic.com',
								headers: {'x-source': 'leak-me'},
								reasoning: true,
								input: ['text', 'image'],
								cost: {input: 3, output: 15},
								contextWindow: 200000,
								maxTokens: 64000,
								thinkingLevelMap: {off: null, xhigh: 'xhigh'},
								compat: {supportsStrictMode: true}
							}
						}
					}),
					{status: 200}
				)) as unknown as typeof fetch
		} as unknown as PiCatalogFetchOptions);
		const catalogValues = {
			...customInput,
			provider: 'custom-catalog',
			api: 'anthropic-messages',
			model: 'claude-fable-5',
			models: 'claude-fable-5',
			baseUrl: 'https://catalog.example',
			apiKey: 'catalog-secret'
		};
		const matched = await matchPiProviderModel(catalogValues, {id: 'claude-fable-5'}, undefined, {catalogLoader});
		expect(matched.ok).toBe(true);
		if (!matched.ok) throw new Error('expected a matched candidate');
		expect(matched.candidate.resolution.kind, '唯一来源必须自动采用').toBe('automatic');
	});

	test('discovery 失败时 ok=false', async () => {
		const failedDiscovery = await discoverPiModels({
			baseUrl: 'https://api.example.com/v1',
			api: 'openai-responses',
			options: {fetchImpl: (async () => new Response('{broken', {status: 500})) as unknown as typeof fetch}
		});
		expect(failedDiscovery.ok).toBe(false);
	});
});
