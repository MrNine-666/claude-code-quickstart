// Pi models.json/auth.json 导入边界：原生 schema 的受限镜像（不在运行时依赖 Pi 包）。
// 只验证已知字段形态，未知字段交还 Pi owner 保存；绝不输出字段值。
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const strings = (value: unknown): boolean => object(value) && Object.values(value).every(item => typeof item === 'string');
const optional = (doc: JsonObject, key: string, valid: (value: unknown) => boolean): boolean => doc[key] === undefined || valid(doc[key]);
const numericFields = (doc: JsonObject, fields: readonly string[]): boolean => fields.every(key => optional(doc, key, number));
const stringFields = (doc: JsonObject, fields: readonly string[]): boolean => fields.every(key => optional(doc, key, text));
const booleanFields = (doc: JsonObject, fields: readonly string[]): boolean =>
	fields.every(key => optional(doc, key, value => typeof value === 'boolean'));

function validCost(value: unknown, override = false): boolean {
	if (!object(value)) return false;
	const rates = ['input', 'output', 'cacheRead', 'cacheWrite'];
	if (!numericFields(value, rates) || (!override && rates.some(key => !number(value[key])))) return false;
	return optional(
		value,
		'tiers',
		tiers => Array.isArray(tiers) && tiers.every(tier => object(tier) && number(tier.inputTokensAbove) && validCost(tier))
	);
}

function validLimits(value: unknown): boolean {
	if (!object(value)) return false;
	if (!optional(value, 'maxRequestBytes', v => Number.isInteger(v) && (v as number) >= 1)) return false;
	if (value.images === undefined) return true;
	const images = value.images;
	if (
		!object(images) ||
		!['maxPerMessage', 'maxPerRequest'].every(key => optional(images, key, v => Number.isInteger(v) && (v as number) >= 1))
	)
		return false;
	const resize = images.resize;
	return (
		resize === undefined ||
		(object(resize) &&
			['maxWidth', 'maxHeight', 'maxBytes', 'jpegQuality'].every(key =>
				optional(resize, key, v => Number.isInteger(v) && (v as number) >= 1 && (key !== 'jpegQuality' || (v as number) <= 100))
			))
	);
}

function validCompat(value: unknown): boolean {
	if (!object(value)) return false;
	if (
		!booleanFields(value, [
			'supportsStore',
			'supportsDeveloperRole',
			'supportsReasoningEffort',
			'supportsUsageInStreaming',
			'supportsFinishReason',
			'requiresToolResultName',
			'requiresAssistantAfterToolResult',
			'requiresThinkingAsText',
			'requiresReasoningContentOnAssistantMessages',
			'supportsStrictMode',
			'supportsStrictTools',
			'supportsMidConvoEffort',
			'supportsEagerToolInputStreaming',
			'supportsLongCacheRetention',
			'sendSessionAffinityHeaders',
			'supportsCacheControlOnTools',
			'supportsTemperature',
			'forceAdaptiveThinking',
			'allowEmptySignature',
			'supportsOpenAIGrammarTools',
			'supportsMaxOutputTokens'
		]) ||
		!numericFields(value, ['vllmPriority'])
	)
		return false;
	const choice = (key: string, values: readonly string[]): boolean => optional(value, key, v => values.includes(v as string));
	if (
		!choice('maxTokensField', ['max_completion_tokens', 'max_tokens']) ||
		!choice('cacheControlFormat', ['anthropic']) ||
		!choice('sessionAffinityFormat', ['openai', 'openai-nosession', 'openrouter']) ||
		!choice('thinkingFormat', [
			'openai',
			'openrouter',
			'together',
			'baseten',
			'deepseek',
			'zai',
			'qwen',
			'chat-template',
			'qwen-chat-template',
			'string-thinking',
			'ant-ling'
		])
	)
		return false;
	const templateValue = (v: unknown): boolean =>
		v === null ||
		['string', 'number', 'boolean'].includes(typeof v) ||
		(object(v) &&
			['thinking.enabled', 'thinking.effort'].includes(v.$var as string) &&
			optional(v, 'omitWhenOff', x => typeof x === 'boolean'));
	if (
		!['chatTemplateKwargs', 'chatTemplateArgs'].every(key =>
			optional(value, key, v => object(v) && Object.values(v).every(templateValue))
		)
	)
		return false;
	if (
		!optional(
			value,
			'allowedFallbackModels',
			v =>
				Array.isArray(v) &&
				v.length <= 3 &&
				v.every(item => object(item) && text(item.provider) && text(item.model) && validCost(item.cost))
		)
	)
		return false;
	return (
		optional(
			value,
			'vercelGatewayRouting',
			v => object(v) && ['only', 'order'].every(key => optional(v, key, x => Array.isArray(x) && x.every(y => typeof y === 'string')))
		) &&
		optional(
			value,
			'openRouterRouting',
			v =>
				object(v) &&
				booleanFields(v, ['allow_fallbacks', 'require_parameters', 'zdr', 'enforce_distillable_text']) &&
				optional(v, 'data_collection', x => x === 'deny' || x === 'allow') &&
				['order', 'only', 'ignore', 'quantizations'].every(key =>
					optional(v, key, x => Array.isArray(x) && x.every(y => typeof y === 'string'))
				) &&
				optional(
					v,
					'sort',
					x =>
						typeof x === 'string' ||
						(object(x) &&
							optional(x, 'by', y => typeof y === 'string') &&
							optional(x, 'partition', y => y === null || typeof y === 'string'))
				) &&
				optional(
					v,
					'max_price',
					x =>
						object(x) &&
						['prompt', 'completion', 'image', 'audio', 'request'].every(key =>
							optional(x, key, y => number(y) || typeof y === 'string')
						)
				) &&
				['preferred_min_throughput', 'preferred_max_latency'].every(key =>
					optional(v, key, x => number(x) || (object(x) && numericFields(x, ['p50', 'p75', 'p90', 'p99'])))
				)
		)
	);
}

function validModel(value: unknown, override = false): boolean {
	if (!object(value) || (!override && !text(value.id))) return false;
	if (
		!stringFields(value, ['name', 'api', 'baseUrl']) ||
		!booleanFields(value, ['reasoning']) ||
		!numericFields(value, ['contextWindow', 'maxTokens'])
	)
		return false;
	if (
		!optional(value, 'headers', strings) ||
		!optional(value, 'input', v => Array.isArray(v) && v.every(item => item === 'text' || item === 'image'))
	)
		return false;
	if (!optional(value, 'inputLimits', validLimits) || !optional(value, 'cost', v => validCost(v, override))) return false;
	if (!optional(value, 'promptCache', v => object(v) && ['short', 'long'].every(key => optional(v, key, n => number(n) && n > 0))))
		return false;
	if (!optional(value, 'thinkingLevelMap', v => object(v) && Object.values(v).every(item => item === null || typeof item === 'string')))
		return false;
	if (!optional(value, 'samplingParams', object) || !optional(value, 'compat', validCompat)) return false;
	return true;
}

export function validPiProviderDefinition(value: unknown): value is JsonObject {
	if (!object(value)) return false;
	if (!stringFields(value, ['name', 'api', 'baseUrl', 'apiKey']) || !booleanFields(value, ['authHeader'])) return false;
	if (!optional(value, 'headers', strings) || !optional(value, 'compat', validCompat) || !optional(value, 'oauth', v => v === 'radius'))
		return false;
	if (!optional(value, 'models', v => Array.isArray(v) && v.every(model => validModel(model)))) return false;
	return optional(value, 'modelOverrides', v => object(v) && Object.values(v).every(model => validModel(model, true)));
}

export function validPiModelsDocument(value: unknown): value is JsonObject {
	return object(value) && object(value.providers) && Object.values(value.providers).every(validPiProviderDefinition);
}

export function validPiApiKeyEntry(value: unknown): value is JsonObject {
	return (
		object(value) &&
		value.type === 'api_key' &&
		optional(value, 'key', v => typeof v === 'string') &&
		optional(value, 'env', strings) &&
		!['access', 'refresh', 'expires', 'token', 'apiKey', 'api_key'].some(key => Object.hasOwn(value, key))
	);
}

export function validPiAuthDocument(value: unknown): value is JsonObject {
	return (
		object(value) &&
		Object.values(value).every(
			entry =>
				validPiApiKeyEntry(entry) ||
				(object(entry) &&
					entry.type === 'oauth' &&
					typeof entry.access === 'string' &&
					typeof entry.refresh === 'string' &&
					number(entry.expires))
		)
	);
}
