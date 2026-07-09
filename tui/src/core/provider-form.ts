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

/** 自定义供应商类型标识（providerType radio 的非内置选项值）。 */
export const PROVIDER_CUSTOM_TYPE = 'custom';

/** providerType radio 选项：内置供应商（label=name）+ 自定义。 */
function buildProviderTypeOptions(): SelectOption[] {
	const config = loadProviderContract();
	const options: SelectOption[] = Object.entries(config.builtinProviders)
		.filter(([key]) => key !== PROVIDER_CUSTOM_TYPE)
		.map(([key, p]) => ({
			value: key,
			label: p.name || key
		}));
	options.push({value: PROVIDER_CUSTOM_TYPE, label: '自定义供应商'});
	return options;
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

	// add 模式首字段：供应商类型 radio（方向键切换，切换后覆盖其余字段为该类型模板）。
	if (input.mode !== 'edit') {
		fields.push({
			id: 'providerType',
			type: 'radio',
			label: '供应商类型',
			value: providerType,
			options: buildProviderTypeOptions()
		});
	}

	// 字段顺序：[providerType] → 文件名 → baseUrl → apiKey → 3 模型键 → activate
	fields.push(
		input.mode === 'edit'
			? {id: 'profileKey', type: 'readonly', label: '文件名', value: values.profileKey}
			: {
					id: 'profileKey',
					type: 'text',
					label: '文件名',
					value: values.profileKey
			  },
		{
			id: 'baseUrl',
			type: 'text',
			label: 'Base URL',
			value: values.baseUrl
		},
		{id: 'apiKey', type: 'secret', label: 'API Key', value: values.apiKey}
	);

	for (const key of MODEL_KEY_ORDER) {
		fields.push({
			id: key,
			type: 'text',
			label: labels[key] ?? key,
			value: values.modelEnv[key] ?? ''
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
			]
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

	if (!isNullOrWhiteSpace(values.apiKey)) {
		env[AUTH_TOKEN_KEY] = values.apiKey;
	}

	if (!isNullOrWhiteSpace(values.baseUrl)) {
		env[BASE_URL_KEY] = values.baseUrl;
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
