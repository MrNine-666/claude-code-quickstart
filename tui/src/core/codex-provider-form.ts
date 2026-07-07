import {loadProviderContract} from './provider-contract.js';
import {
	buildCodexProfileToml,
	parseCodexProfileToml,
	testCodexProfileKey,
	type CodexProviderType,
	type CodexProfile
} from './codex.js';
import {isNullOrWhiteSpace, normalizeBaseUrl} from './text-utils.js';
import type {FormField, SelectOption} from '../components/form/field-types.js';

// Codex provider 表单模型：复用 Claude provider 的供应商类型语义，但输出官方 Codex TOML profile。

export type CodexProviderFormMode = 'add' | 'edit';

export type CodexProviderFormValues = {
	profileKey: string;
	providerType: string;
	baseUrl: string;
	model: string;
	apiKey: string;
	toml: string;
	activateAfterSave: boolean;
};

export type CodexProviderFormModel = {
	readonly mode: CodexProviderFormMode;
	readonly fields: readonly FormField[];
	readonly values: CodexProviderFormValues;
};

export type CodexTomlValuesResult =
	| {readonly ok: true; readonly values: CodexProviderFormValues}
	| {readonly ok: false; readonly error: string};

export const CODEX_OFFICIAL_LOGIN_TYPE = 'officialLogin';
export const CODEX_CUSTOM_TYPE = 'custom';

const TOML_FIELD_ID = 'codexProfileToml';

function isOfficialLogin(providerType: string): boolean {
	return providerType === CODEX_OFFICIAL_LOGIN_TYPE;
}

function toCodexProviderType(providerType: string): CodexProviderType {
	return isOfficialLogin(providerType) ? 'officialLogin' : 'apiKey';
}

function buildProviderTypeOptions(): SelectOption[] {
	const options: SelectOption[] = [
		{value: CODEX_OFFICIAL_LOGIN_TYPE, label: 'official login'}
	];

	const contract = loadProviderContract();
	for (const [key, provider] of Object.entries(contract.builtinProviders)) {
		if (key === CODEX_CUSTOM_TYPE) {
			continue;
		}

		options.push({value: key, label: provider.name || key});
	}

	options.push({value: CODEX_CUSTOM_TYPE, label: '自定义供应商'});
	return options;
}

function templateFor(providerType: string): Pick<CodexProviderFormValues, 'profileKey' | 'baseUrl' | 'model' | 'apiKey'> {
	if (isOfficialLogin(providerType) || providerType === CODEX_CUSTOM_TYPE) {
		return {profileKey: '', baseUrl: '', model: '', apiKey: ''};
	}

	const builtin = loadProviderContract().builtinProviders[providerType];
	const model = Object.values(builtin?.modelEnv ?? {}).find(value => !isNullOrWhiteSpace(value)) ?? '';
	return {
		profileKey: providerType,
		baseUrl: builtin?.baseUrl ?? '',
		model,
		apiKey: ''
	};
}

function valuesToToml(values: Omit<CodexProviderFormValues, 'toml'>): string {
	return buildCodexProfileToml({
		key: values.profileKey || 'profile',
		providerType: toCodexProviderType(values.providerType),
		baseUrl: values.baseUrl,
		model: values.model,
		apiKey: values.apiKey
	});
}

function makeValues(input: {
	readonly mode: CodexProviderFormMode;
	readonly profile?: CodexProfile | null;
	readonly providerType?: string;
	readonly rawToml?: string;
}): CodexProviderFormValues {
	if (input.mode === 'edit' && input.profile) {
		const providerType = input.profile.providerType === 'officialLogin' ? CODEX_OFFICIAL_LOGIN_TYPE : (input.providerType ?? CODEX_CUSTOM_TYPE);
		return {
			profileKey: input.profile.key,
			providerType,
			baseUrl: input.profile.baseUrl,
			model: input.profile.model,
			apiKey: '',
			toml: input.rawToml ?? valuesToToml({
				profileKey: input.profile.key,
				providerType,
				baseUrl: input.profile.baseUrl,
				model: input.profile.model,
				apiKey: '',
				activateAfterSave: false
			}),
			activateAfterSave: false
		};
	}

	const providerType = input.providerType ?? CODEX_OFFICIAL_LOGIN_TYPE;
	const template = templateFor(providerType);
	const values: Omit<CodexProviderFormValues, 'toml'> = {
		profileKey: template.profileKey,
		providerType,
		baseUrl: template.baseUrl,
		model: template.model,
		apiKey: template.apiKey,
		activateAfterSave: true
	};
	return {...values, toml: values.profileKey ? valuesToToml(values) : ''};
}

export function buildCodexProviderFormModel(input: {
	readonly mode: CodexProviderFormMode;
	readonly profile?: CodexProfile | null;
	readonly providerType?: string;
	readonly rawToml?: string;
}): CodexProviderFormModel {
	const values = makeValues(input);
	const fields: FormField[] = [];

	if (input.mode !== 'edit') {
		fields.push({
			id: 'providerType',
			type: 'radio',
			label: '供应商类型',
			value: values.providerType,
			options: buildProviderTypeOptions(),
			helpText: 'Codex 复用 Claude 内置供应商语义，并额外支持 official login。'
		});
	}

	fields.push(
		input.mode === 'edit'
			? {id: 'profileKey', type: 'readonly', label: 'Profile key', value: values.profileKey}
			: {id: 'profileKey', type: 'text', label: 'Profile key', value: values.profileKey},
		{
			id: 'baseUrl',
			type: 'text',
			label: 'Base URL',
			value: values.baseUrl,
			disabled: isOfficialLogin(values.providerType)
		},
		{id: 'model', type: 'text', label: '默认模型', value: values.model},
		{
			id: 'apiKey',
			type: 'secret',
			label: 'API Key',
			value: values.apiKey,
			disabled: isOfficialLogin(values.providerType),
			helpText: isOfficialLogin(values.providerType) ? 'official login 使用 codex login，不需要 API key。' : undefined
		},
		{
			id: TOML_FIELD_ID,
			type: 'readonly',
			label: 'TOML',
			value: values.toml,
			helpText: '真实保存内容为 CODEX_HOME/<key>.config.toml；编辑器视图在 Phase 6 接入。'
		}
	);

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

export function codexProviderValuesToToml(values: CodexProviderFormValues): string {
	return valuesToToml(values);
}

export function codexProviderValuesFromToml(baseValues: CodexProviderFormValues, raw: string): CodexTomlValuesResult {
	try {
		const key = baseValues.profileKey || 'profile';
		const parsed = parseCodexProfileToml(key, raw);
		return {
			ok: true,
			values: {
				...baseValues,
				providerType: parsed.providerType === 'officialLogin' ? CODEX_OFFICIAL_LOGIN_TYPE : baseValues.providerType,
				baseUrl: parsed.baseUrl,
				model: parsed.model,
				apiKey: parsed.hasApiKey ? baseValues.apiKey : '',
				toml: raw
			}
		};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export function validateCodexProviderForm(mode: CodexProviderFormMode, values: CodexProviderFormValues): string[] {
	const errors: string[] = [];
	if (mode !== 'edit') {
		if (isNullOrWhiteSpace(values.profileKey)) {
			errors.push('Profile key 不能为空');
		} else if (!testCodexProfileKey(values.profileKey.trim())) {
			errors.push('请填写安全 Profile key（字母/数字/. _ -，不能为 . / .. 或以 - 开头）');
		}
	}

	if (!isOfficialLogin(values.providerType)) {
		let parsed: CodexProfile | null = null;
		try {
			parsed = parseCodexProfileToml(values.profileKey || 'profile', values.toml || codexProviderValuesToToml(values));
		} catch {}

		if (!parsed?.hasApiKey && isNullOrWhiteSpace(values.apiKey)) {
			errors.push('API Key 不能为空');
		}

		const baseUrl = normalizeBaseUrl(values.baseUrl);
		if (isNullOrWhiteSpace(baseUrl)) {
			errors.push('Base URL 不能为空');
		} else if (!/^https?:\/\//.test(baseUrl)) {
			errors.push('Base URL 必须以 http:// 或 https:// 开头');
		}
	}

	return errors;
}
