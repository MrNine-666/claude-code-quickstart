import {loadProviderContract} from './provider-contract.js';
import {getManagedModelEnv, type ProviderProfile} from './provider.js';
import {isNullOrWhiteSpace, testProviderKey} from './text-utils.js';
import type {FormField, SelectOption} from '../components/form/field-types.js';

// Provider 表单模型：生成 builtin/custom add/edit 字段、默认值、校验规则与保存 payload（design D8 + §3）。

export type ProviderFormMode = 'add-builtin' | 'add-custom' | 'edit';

export type ProviderFormInput = {
	readonly mode: ProviderFormMode;
	readonly builtinKey?: string;
	readonly profileKey?: string;
	readonly profile?: ProviderProfile | null;
};

export type ProviderFormValues = {
	profileKey: string;
	baseUrl: string;
	apiKey: string;
	modelEnv: Record<string, string>;
	// 用户经底部 JSON 直填的完整 env（5 必填字段外的任意键）。
	// textarea 为真源，modelEnv/apiKey/baseUrl 由其派生供结构化字段显示与快捷编辑。
	env: Record<string, string>;
	activateAfterSave: boolean;
	// add 模式表单内选择的供应商类型（builtin key 或 'custom'）；edit 模式不含。
	providerType?: string;
};

export type ProviderFormModel = {
	readonly mode: ProviderFormMode;
	readonly fields: readonly FormField[];
	readonly values: ProviderFormValues;
};

export type ProviderSavePayload =
	| {
			readonly action: 'add';
			readonly builtinKey?: string;
			readonly profileKey: string;
			readonly baseUrl?: string;
			readonly apiKey: string;
			readonly modelEnv?: Record<string, string>;
			readonly env?: Record<string, string>;
			readonly activate: boolean;
	  }
	| {
			readonly action: 'edit';
			readonly key: string;
			readonly profileKey?: string;
			readonly baseUrl?: string;
			readonly apiKey?: string;
			readonly modelEnv?: Record<string, string> | null;
			readonly env?: Record<string, string> | null;
	  };

const AUTH_TOKEN_KEY = 'ANTHROPIC_AUTH_TOKEN';
const BASE_URL_KEY = 'ANTHROPIC_BASE_URL';
const MODEL_KEY_ORDER = [
	'ANTHROPIC_DEFAULT_HAIKU_MODEL',
	'ANTHROPIC_DEFAULT_OPUS_MODEL',
	'ANTHROPIC_DEFAULT_SONNET_MODEL'
];

/**
 * 三个受管模型键的用途说明。第三方供应商下这些别名不存在，须逐个指向真实模型 ID；
 * 留空的档位会静默失败（Claude Code 不报错也无 UI 提示），故在表单里逐字段点明归属。
 */
const MODEL_KEY_HELP: Readonly<Record<string, string>> = {
	ANTHROPIC_DEFAULT_HAIKU_MODEL: '调用 haiku 时实际调用的模型。',
	ANTHROPIC_DEFAULT_OPUS_MODEL: '调用 opus 时实际调用的模型。',
	ANTHROPIC_DEFAULT_SONNET_MODEL: '调用 sonnet 时实际调用的模型。'
};

/** 自定义供应商类型标识（providerType radio 的非内置选项值）。 */
export const PROVIDER_CUSTOM_TYPE = 'custom';

/**
 * providerType radio 选项：全部由契约派生（label=Name），顺序即契约顺序。
 * custom 是契约内的占位条目（BaseUrl 为空、无 ModelEnv），位于契约末尾故天然排在最后，
 * 不再于代码中硬编码追加——新增供应商或改文案只动 providers.json。
 */
function buildProviderTypeOptions(): SelectOption[] {
	const config = loadProviderContract();
	return Object.entries(config.builtinProviders).map(([key, p]) => ({
		value: key,
		label: p.name || key
	}));
}

/** 默认供应商类型：首个内置供应商，无内置时回退自定义。 */
function firstBuiltinKey(): string | undefined {
	const keys = Object.keys(loadProviderContract().builtinProviders).filter((key) => key !== PROVIDER_CUSTOM_TYPE);
	return keys.length > 0 ? keys[0] : undefined;
}

/**
 * 取供应商类型对应的预填模板（供 add 表单初始化与切换覆盖复用）。
 * 内置类型返回契约模板，'custom'/未知返回空白。env 含模板的全部非必填字段（模板 ExtraEnv）。
 */
export function getProviderTemplate(providerType: string): {
	profileKey: string;
	baseUrl: string;
	modelEnv: Record<string, string>;
	env: Record<string, string>;
} {
	if (!providerType || providerType === PROVIDER_CUSTOM_TYPE) {
		return {profileKey: '', baseUrl: '', modelEnv: {}, env: {}};
	}

	const builtin = loadProviderContract().builtinProviders[providerType];
	if (!builtin) {
		return {profileKey: providerType, baseUrl: '', modelEnv: {}, env: {}};
	}

	return {
		profileKey: providerType,
		baseUrl: builtin.baseUrl,
		modelEnv: pickManagedModelDefaults(builtin.modelEnv as Record<string, string> | undefined),
		env: {...(builtin.extraEnv ?? {})}
	};
}

function pickManagedModelDefaults(source: Record<string, string> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	if (!source) {
		return result;
	}

	for (const key of MODEL_KEY_ORDER) {
		if (!isNullOrWhiteSpace(source[key])) {
			result[key] = String(source[key]);
		}
	}

	return result;
}

// 清洗 env：丢弃空 key/value 条目（textarea 真源清洗）。
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (!isNullOrWhiteSpace(k) && !isNullOrWhiteSpace(v)) {
			result[k.trim()] = String(v);
		}
	}

	return result;
}

/** 构建 Provider 表单字段、默认值（一屏展示所有可编辑字段）。 */
export function buildProviderFormModel(input: ProviderFormInput): ProviderFormModel {
	const config = loadProviderContract();
	const labels = config.modelEnvLabels;

	const values: ProviderFormValues = {
		profileKey: '',
		baseUrl: '',
		apiKey: '',
		modelEnv: {},
		env: {},
		activateAfterSave: input.mode !== 'edit'
	};

	// add 模式：providerType 决定预填模板（builtin key 或 'custom'），表单内可切换覆盖。
	let providerType = '';
	if (input.mode !== 'edit') {
		providerType =
			input.mode === 'add-custom'
				? PROVIDER_CUSTOM_TYPE
				: input.builtinKey ?? firstBuiltinKey() ?? PROVIDER_CUSTOM_TYPE;
		const template = getProviderTemplate(providerType);
		values.providerType = providerType;
		values.profileKey = template.profileKey;
		values.baseUrl = template.baseUrl;
		values.modelEnv = template.modelEnv;
		values.env = template.env;
	} else if (input.profile) {
		values.profileKey = input.profileKey ?? '';
		values.baseUrl = input.profile.env?.[BASE_URL_KEY] ?? '';
		values.apiKey = input.profile.env?.[AUTH_TOKEN_KEY] ?? '';
		values.modelEnv = getManagedModelEnv(input.profile);
		values.env = pickNonManagedEnv(input.profile.env);
	}

	const fields: FormField[] = [];

	const selected = providerType ? config.builtinProviders[providerType] : undefined;

	// add 模式首字段：供应商类型 radio（方向键切换，切换后覆盖其余字段为该类型模板）。
	// helpText 展示所选供应商的契约 Note（套餐门槛、上下文档位等接入限制），无 Note 时回退 Description。
	if (input.mode !== 'edit') {
		const typeHelp = selected?.note || selected?.description;
		fields.push({
			id: 'providerType',
			type: 'radio',
			label: '供应商类型',
			value: providerType,
			options: buildProviderTypeOptions(),
			...(typeHelp ? {helpText: typeHelp} : {})
		});
	}

	// 字段顺序：[providerType] → 文件名 → baseUrl → apiKey → 3 模型键 → activate
	fields.push(
		input.mode === 'edit'
			? {
					id: 'profileKey',
					type: 'readonly',
					label: '文件名',
					value: values.profileKey,
					helpText: '对应 ~/.claude/providers/<文件名>.json，创建后不可改名。'
				}
			: {
					id: 'profileKey',
					type: 'text',
					label: '文件名',
					value: values.profileKey,
					helpText: '填写文件名主体；保存为 ~/.claude/providers/<文件名>.json。若同名文件已存在，将拒绝创建，请更换文件名后重试。'
			  },
		{
			id: 'baseUrl',
			type: 'text',
			label: 'Base URL',
			value: values.baseUrl,
			// 最常见的接入错误：填了供应商的 OpenAI 兼容端点。多数供应商两套端点路径不同（如 DeepSeek 的
			// /anthropic 与根域），填错通常表现为 404 或空响应。
			helpText: '须填供应商的 Anthropic 兼容端点，无需拼接/v1。'
		},
		{
			id: 'apiKey',
			type: 'secret',
			label: 'API Key',
			value: values.apiKey,
			helpText: selected?.platformUrl ? `在 ${selected.platformUrl} 创建；写入 profile 后以脱敏形式展示。` : '写入 profile 后以脱敏形式展示。'
		}
	);

	// 三个模型键映射 Claude Code 的 opus/sonnet/haiku 别名。第三方供应商下留空的档位会静默失败
	// （无报错、无 UI 提示），故逐个说明其归属用途，尤其 haiku 还承担后台任务。
	for (const key of MODEL_KEY_ORDER) {
		fields.push({
			id: key,
			type: 'text',
			label: labels[key] ?? key,
			value: values.modelEnv[key] ?? '',
			helpText: MODEL_KEY_HELP[key]
		});
	}

	if (input.mode !== 'edit') {
		fields.push({
			id: 'activateAfterSave',
			type: 'radio',
			label: '保存后激活',
			value: values.activateAfterSave ? 'yes' : 'no',
			options: [
				{value: 'yes', label: '是'},
				{value: 'no', label: '否'}
			],
			helpText: '激活即把本 profile 的 env 写入 ~/.claude/settings.json 并切为当前供应商；选「否」仅保存，之后可在列表中切换。'
		});
	}

	return {mode: input.mode, fields, values};
}

// 从 profile.env 提取非必填 env（排除 token/baseUrl/受管模型键），供 edit 回填 JSON 区。
function pickNonManagedEnv(env: Record<string, string> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	if (!env) {
		return result;
	}

	const reserved = new Set<string>([AUTH_TOKEN_KEY, BASE_URL_KEY, ...MODEL_KEY_ORDER]);
	for (const [k, v] of Object.entries(env)) {
		if (!reserved.has(k) && !isNullOrWhiteSpace(v)) {
			result[k] = String(v);
		}
	}

	return result;
}

export function providerValuesToProfile(values: ProviderFormValues): ProviderProfile {
	const env: Record<string, string> = {};

	// BASE_URL 与 AUTH_TOKEN 同策略：add 模式（providerType 存在）即使为空也以空串占位，
	// 引导用户在 textarea 填写（自定义供应商无模板 baseUrl 时尤为需要）；edit 模式仅非空写入。
	// BASE_URL 置于 AUTH_TOKEN 之上，符合先填地址后填密钥的输入顺序。
	if (!isNullOrWhiteSpace(values.baseUrl)) {
		env[BASE_URL_KEY] = values.baseUrl;
	} else if (values.providerType !== undefined) {
		env[BASE_URL_KEY] = '';
	}

	// add 模式（providerType 存在）AUTH_TOKEN 常显示：apiKey 未填时以空串占位，引导用户填写；
	// edit 模式仅在非空时写入，避免污染既有 profile。
	if (!isNullOrWhiteSpace(values.apiKey)) {
		env[AUTH_TOKEN_KEY] = values.apiKey;
	} else if (values.providerType !== undefined) {
		env[AUTH_TOKEN_KEY] = '';
	}

	for (const key of MODEL_KEY_ORDER) {
		const value = values.modelEnv[key];
		if (!isNullOrWhiteSpace(value)) {
			env[key] = String(value);
		}
	}

	for (const [key, value] of Object.entries(sanitizeEnv(values.env))) {
		env[key] = value;
	}

	return {env};
}

export function buildProviderProfileJson(values: ProviderFormValues): string {
	return `${JSON.stringify(providerValuesToProfile(values), null, 2)}\n`;
}

export type ProviderProfileJsonResult =
	| {readonly ok: true; readonly values: ProviderFormValues}
	| {readonly ok: false; readonly error: string};

export function valuesFromProviderProfileJson(baseValues: ProviderFormValues, raw: string): ProviderProfileJsonResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {ok: false, error: `JSON 格式错误: ${error instanceof Error ? error.message : String(error)}`};
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {ok: false, error: 'JSON 必须是对象'};
	}

	const env = (parsed as {env?: unknown}).env;
	if (!env || typeof env !== 'object' || Array.isArray(env)) {
		return {ok: false, error: 'JSON 必须包含 env 对象'};
	}

	const normalizedEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
		if (value === undefined || value === null) {
			continue;
		}

		normalizedEnv[key] = String(value);
	}

	return {
		ok: true,
		values: {
			...baseValues,
			apiKey: normalizedEnv[AUTH_TOKEN_KEY] ?? '',
			baseUrl: normalizedEnv[BASE_URL_KEY] ?? '',
			modelEnv: pickManagedModelDefaults(normalizedEnv),
			env: pickNonManagedEnv(normalizedEnv)
		}
	};
}

/** 校验表单值（返回错误信息数组，空数组表示通过）。 */
export function validateProviderForm(mode: ProviderFormMode, values: ProviderFormValues): string[] {
	const errors: string[] = [];
	if (isNullOrWhiteSpace(values.apiKey)) {
		errors.push('API Key 不能为空');
	}

	// 文件名校验（add 模式用户填写；edit 模式 readonly 不校验）
	if (mode !== 'edit') {
		if (isNullOrWhiteSpace(values.profileKey)) {
			errors.push('文件名不能为空');
		} else if (!testProviderKey(values.profileKey.trim())) {
			errors.push('请填写英文文件名（字母/数字/. _ -）');
		}
	}

	if (isNullOrWhiteSpace(values.baseUrl)) {
		errors.push('Base URL 不能为空');
	} else if (!/^https?:\/\//.test(values.baseUrl)) {
		errors.push('Base URL 必须以 http:// 或 https:// 开头');
	}

	return errors;
}

/** 将表单值转换为 addProvider / editProvider 可消费的 payload（仅写非空受管字段）。 */
export function toProviderSavePayload(input: ProviderFormInput, values: ProviderFormValues): ProviderSavePayload {
	const modelEnv = pickManagedModelDefaults(values.modelEnv);
	const env = sanitizeEnv(values.env);

	if (input.mode === 'edit') {
		return {
			action: 'edit',
			key: input.profileKey ?? '',
			baseUrl: values.baseUrl || undefined,
			apiKey: values.apiKey || undefined,
			modelEnv: Object.keys(modelEnv).length > 0 ? modelEnv : null,
			env
		};
	}

	// 最终供应商类型：表单内选择（values.providerType）优先，回退到初始 input。
	const effectiveType = values.providerType ?? (input.mode === 'add-custom' ? PROVIDER_CUSTOM_TYPE : input.builtinKey);
	const isCustom = !effectiveType || effectiveType === PROVIDER_CUSTOM_TYPE;

	return {
		action: 'add',
		builtinKey: isCustom ? undefined : effectiveType,
		profileKey: values.profileKey.trim(),
		baseUrl: values.baseUrl,
		apiKey: values.apiKey,
		modelEnv: Object.keys(modelEnv).length > 0 ? modelEnv : undefined,
		env,
		activate: values.activateAfterSave
	};
}
