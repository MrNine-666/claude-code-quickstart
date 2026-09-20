import type {DiscoveredModel, ModelDiscoveryAuth, ModelDiscoveryPathMode} from './model-discovery.js';
import type {PiModelDefinition} from './pi-provider.js';

/**
 * 新增/编辑表单可选、可用 Base URL + API Key 配置的 API 集合。
 * 等于 Pi `docs/models.md` 为 `models.json` 自定义 Provider 列出的 Supported APIs。
 */
export const PI_APIS = ['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai'] as const;

/**
 * Pi 当前 KnownApi 全集。仅用于读取/展示/保存已有 `models.json` 配置与 discovery
 * strategy 查询：其中多数端点需要 OAuth、ADC 或 SigV4 等 Pi 自有认证，无法用
 * Base URL + API Key 配置，因此不在表单里提供选择。
 */
export const PI_KNOWN_APIS = [
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

export type PiApi = (typeof PI_KNOWN_APIS)[number];
export type PiFormApi = (typeof PI_APIS)[number];

/**
 * 单 API 的上游模型列表策略：是否支持发现、端点派生规则、认证头形式与响应归一化。
 * 无标准列表接口的 API 必须显式返回 unsupported 原因，不得伪造 discovery。
 */
export type PiApiDiscoveryStrategy = {
	readonly api: PiApi;
	readonly supportsDiscovery: boolean;
	/** 不支持发现时展示给用户的原因；支持发现时为空字符串。 */
	readonly reason: string;
	/** 绝对路径或 append 片段；缺省时从 baseUrl 派生 /models 或 /v1/models。 */
	readonly path?: string;
	readonly pathMode?: ModelDiscoveryPathMode;
	readonly auth?: ModelDiscoveryAuth;
	/** 额外静态请求头（不来自 API Key）。 */
	readonly headers?: Readonly<Record<string, string>>;
	/** 把上游原始条目归一化为 Pi 模型定义（例如剥离 Google 的 `models/` 前缀）。 */
	readonly normalizeModels?: (models: readonly DiscoveredModel[]) => readonly PiModelDefinition[];
};

function googleNormalizeModels(models: readonly DiscoveredModel[]): readonly PiModelDefinition[] {
	return models.map(model => {
		const rawId = model.id;
		const id = rawId.startsWith('models/') ? rawId.slice('models/'.length) : rawId;
		const next: Record<string, unknown> = {...model, id};
		// Google 的 name 是资源名（models/<id>），不是展示名；剥离后不应污染 Pi 模型定义。
		if (next.name === rawId || next.name === `models/${id}`) delete next.name;
		return next as PiModelDefinition;
	});
}

const PI_API_STRATEGIES: Record<PiApi, PiApiDiscoveryStrategy> = {
	'anthropic-messages': {
		api: 'anthropic-messages',
		supportsDiscovery: true,
		reason: '',
		path: '/v1/models',
		pathMode: 'append',
		auth: 'x-api-key',
		headers: {'anthropic-version': '2023-06-01'}
	},
	'openai-completions': {
		api: 'openai-completions',
		supportsDiscovery: true,
		reason: '',
		auth: 'bearer'
	},
	'openai-responses': {
		api: 'openai-responses',
		supportsDiscovery: true,
		reason: '',
		auth: 'bearer'
	},
	'azure-openai-responses': {
		api: 'azure-openai-responses',
		supportsDiscovery: false,
		reason: 'Azure OpenAI 模型列表需要 api-version 查询参数，请手工填写模型 ID'
	},
	'openai-codex-responses': {
		api: 'openai-codex-responses',
		supportsDiscovery: false,
		reason: 'ChatGPT Codex 端点使用 OAuth 登录，自定义 API Key 无法发现模型，请手工填写模型 ID'
	},
	'mistral-conversations': {
		api: 'mistral-conversations',
		supportsDiscovery: true,
		reason: '',
		path: '/v1/models',
		pathMode: 'append',
		auth: 'bearer'
	},
	'google-generative-ai': {
		api: 'google-generative-ai',
		supportsDiscovery: true,
		reason: '',
		path: '/v1beta/models',
		pathMode: 'absolute',
		auth: 'x-goog-api-key',
		normalizeModels: googleNormalizeModels
	},
	'google-vertex': {
		api: 'google-vertex',
		supportsDiscovery: false,
		reason: 'Google Vertex 需要服务账号 OAuth，请手工填写模型 ID'
	},
	'bedrock-converse-stream': {
		api: 'bedrock-converse-stream',
		supportsDiscovery: false,
		reason: 'Amazon Bedrock 需要 AWS SigV4 签名，请手工填写模型 ID'
	},
	'pi-messages': {
		api: 'pi-messages',
		supportsDiscovery: false,
		reason: 'Pi Messages 端点没有公开模型列表接口，请手工填写模型 ID'
	}
};

export function isPiApi(value: string): value is PiApi {
	return (PI_KNOWN_APIS as readonly string[]).includes(value);
}

/** 表单是否提供该 API 供选择；false 的已知 API 只能在编辑已有配置时保留。 */
export function isPiFormApi(value: string): value is PiFormApi {
	return (PI_APIS as readonly string[]).includes(value);
}

/** 返回 API 的 discovery strategy；未知 API 返回 null，由调用方降级为手工填写。 */
export function piApiDiscoveryStrategy(api: string): PiApiDiscoveryStrategy | null {
	return isPiApi(api) ? PI_API_STRATEGIES[api] : null;
}

export function piApiSupportsDiscovery(api: string): boolean {
	return piApiDiscoveryStrategy(api)?.supportsDiscovery === true;
}
