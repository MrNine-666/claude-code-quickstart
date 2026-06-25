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
	extraEnv: Record<string, string>;
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
			readonly extraEnv?: Record<string, string>;
			readonly activate: boolean;
	  }
	| {
			readonly action: 'edit';
			readonly key: string;
			readonly profileKey?: string;
			readonly baseUrl?: string;
			readonly apiKey?: string;
			readonly modelEnv?: Record<string, string> | null;
			readonly extraEnv?: Record<string, string> | null;
	  };

const MODEL_KEY_ORDER = [
	'ANTHROPIC_DEFAULT_HAIKU_MODEL',
	'ANTHROPIC_DEFAULT_OPUS_MODEL',
	'ANTHROPIC_DEFAULT_SONNET_MODEL'
];

/** 自定义供应商类型标识（providerType select 的非内置选项值）。 */
export const PROVIDER_CUSTOM_TYPE = 'custom';

/** providerType select 选项：内置供应商（label=name）+ 自定义。 */
function buildProviderTypeOptions(): SelectOption[] {
	const config = loadProviderContract();
	const options: SelectOption[] = Object.entries(config.builtinProviders).map(([key, p]) => ({
		value: key,
		label: p.name || key
	}));
	options.push({value: PROVIDER_CUSTOM_TYPE, label: '自定义供应商'});
	return options;
}

/** 默认供应商类型：首个内置供应商，无内置时回退自定义。 */
function firstBuiltinKey(): string | undefined {
	const keys = Object.keys(loadProviderContract().builtinProviders);
	return keys.length > 0 ? keys[0] : undefined;
}

/**
 * 取供应商类型对应的预填模板（供 add 表单初始化与切换覆盖复用）。
 * 内置类型返回契约模板，'custom'/未知返回空白。
 */
export function getProviderTemplate(providerType: string): {
	profileKey: string;
	baseUrl: string;
	modelEnv: Record<string, string>;
	extraEnv: Record<string, string>;
} {
	if (!providerType || providerType === PROVIDER_CUSTOM_TYPE) {
		return {profileKey: '', baseUrl: '', modelEnv: {}, extraEnv: {}};
	}

	const builtin = loadProviderContract().builtinProviders[providerType];
	if (!builtin) {
		return {profileKey: providerType, baseUrl: '', modelEnv: {}, extraEnv: {}};
	}

	return {
		profileKey: providerType,
		baseUrl: builtin.baseUrl,
		modelEnv: pickManagedModelDefaults(builtin.modelEnv as Record<string, string> | undefined),
		extraEnv: {...(builtin.extraEnv ?? {})}
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

// 从 profile.env 提取 extra env（排除 token/baseUrl/受管模型键），供 edit 回填 key-value 区。
function pickExtraEnv(env: Record<string, string> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	if (!env) {
		return result;
	}

	const reserved = new Set<string>(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', ...MODEL_KEY_ORDER]);
	for (const [k, v] of Object.entries(env)) {
		if (!reserved.has(k) && !isNullOrWhiteSpace(v)) {
			result[k] = String(v);
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
		extraEnv: {},
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
		values.extraEnv = template.extraEnv;
	} else if (input.profile) {
		values.profileKey = input.profileKey ?? '';
		values.baseUrl = input.profile.env?.ANTHROPIC_BASE_URL ?? '';
		values.apiKey = input.profile.env?.ANTHROPIC_AUTH_TOKEN ?? '';
		values.modelEnv = getManagedModelEnv(input.profile);
		values.extraEnv = pickExtraEnv(input.profile.env);
	}

	const fields: FormField[] = [];

	// add 模式首字段：供应商类型选择（←/→ 切换，切换后覆盖其余字段为该类型模板）。
	if (input.mode !== 'edit') {
		fields.push({
			id: 'providerType',
			type: 'select',
			label: '供应商类型',
			value: providerType,
			options: buildProviderTypeOptions(),
			helpText: '←/→ 切换；切换后自动覆盖 Base URL / 模型 / 额外环境变量为该供应商模板'
		});
	}

	// 字段顺序：[providerType] → 文件名 → baseUrl → apiKey → 3 模型键 → extra env → activate
	fields.push(
		input.mode === 'edit'
			? {id: 'profileKey', type: 'readonly', label: '文件名', value: values.profileKey}
			: {
					id: 'profileKey',
					type: 'text',
					label: '文件名',
					value: values.profileKey,
					helpText: '英文文件名（字母/数字/. _ -），即 ~/.claude/providers/<文件名>.json'
			  },
		{
			id: 'baseUrl',
			type: 'text',
			label: 'Base URL',
			value: values.baseUrl,
			helpText: '必须以 http:// 或 https:// 开头'
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

	fields.push({
		id: 'extraEnv',
		type: 'key-value',
		label: '额外环境变量',
		entries: Object.entries(values.extraEnv).map(([key, value]) => ({key, value})),
		helpText: '自由增删任意 env 键值对（写入 ~/.claude/providers/<文件名>.json 的 env）'
	});

	if (input.mode !== 'edit') {
		fields.push({
			id: 'activateAfterSave',
			type: 'select',
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

	// 自定义供应商（mode=add-custom 或表单内选了 custom 类型）必须填合法 Base URL；
	// 内置供应商的 Base URL 来自契约模板，不强制校验。
	const isCustom = mode === 'add-custom' || values.providerType === PROVIDER_CUSTOM_TYPE;
	if (mode !== 'edit' && isCustom) {
		if (isNullOrWhiteSpace(values.baseUrl)) {
			errors.push('Base URL 不能为空');
		} else if (!/^https?:\/\//.test(values.baseUrl)) {
			errors.push('Base URL 必须以 http:// 或 https:// 开头');
		}
	}

	return errors;
}

/** 将表单值转换为 addProvider / editProvider 可消费的 payload（仅写非空受管字段）。 */
export function toProviderSavePayload(input: ProviderFormInput, values: ProviderFormValues): ProviderSavePayload {
	const modelEnv = pickManagedModelDefaults(values.modelEnv);
	const extraEnv = sanitizeExtraEnv(values.extraEnv);

	if (input.mode === 'edit') {
		return {
			action: 'edit',
			key: input.profileKey ?? '',
			baseUrl: values.baseUrl || undefined,
			apiKey: values.apiKey || undefined,
			modelEnv: Object.keys(modelEnv).length > 0 ? modelEnv : null,
			extraEnv
		};
	}

	// 最终供应商类型：表单内选择（values.providerType）优先，回退到初始 input。
	const effectiveType = values.providerType ?? (input.mode === 'add-custom' ? PROVIDER_CUSTOM_TYPE : input.builtinKey);
	const isCustom = !effectiveType || effectiveType === PROVIDER_CUSTOM_TYPE;

	return {
		action: 'add',
		builtinKey: isCustom ? undefined : effectiveType,
		profileKey: values.profileKey.trim(),
		baseUrl: isCustom ? values.baseUrl : undefined,
		apiKey: values.apiKey,
		modelEnv: Object.keys(modelEnv).length > 0 ? modelEnv : undefined,
		extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
		activate: values.activateAfterSave
	};
}

// 清洗 extra env：丢弃空 key/value 条目（§3.4）。
function sanitizeExtraEnv(extraEnv: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [k, v] of Object.entries(extraEnv)) {
		if (!isNullOrWhiteSpace(k) && !isNullOrWhiteSpace(v)) {
			result[k.trim()] = String(v);
		}
	}

	return result;
}
