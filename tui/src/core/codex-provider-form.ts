import {existsSync, readFileSync} from 'node:fs';
import {
	buildCodexProfileToml,
	parseCodexProfileToml,
	testCodexProfileKey,
	type CodexProviderType,
	type CodexProfile
} from './codex.js';
import {codexAuthJsonPath} from './paths.js';
import {isNullOrWhiteSpace, normalizeBaseUrl} from './text-utils.js';
import type {FormField, SelectOption} from '../components/form/field-types.js';

// Codex provider 表单模型：生成 Codex profile 字段，并输出官方 profile TOML。

export type CodexProviderFormMode = 'add' | 'edit';

export type CodexProviderFormValues = {
	profileKey: string;
	providerType: string;
	baseUrl: string;
	model: string;
	apiKey: string;
	toml: string;
	authJson: string;
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

type CodexProviderTemplate = {
	readonly label: string;
	readonly profileKey: string;
	readonly baseUrl: string;
	readonly model: string;
};

const CODEX_PROVIDER_ORDER = ['zhipu', 'minimax', 'moonshot', 'deepseek', 'bailian'] as const;
const CODEX_PROVIDER_TEMPLATES: Readonly<Record<(typeof CODEX_PROVIDER_ORDER)[number], CodexProviderTemplate>> = {
	zhipu: {
		label: '智谱 GLM',
		profileKey: 'zhipu',
		baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
		model: 'glm-5.2'
	},
	minimax: {
		label: 'MiniMax',
		profileKey: 'minimax',
		baseUrl: 'https://api.minimax.io/v1',
		model: 'MiniMax-M3'
	},
	moonshot: {
		label: 'Kimi Code',
		profileKey: 'moonshot',
		baseUrl: 'https://api.moonshot.ai/v1',
		model: 'kimi-k2.6'
	},
	deepseek: {
		label: 'DeepSeek',
		profileKey: 'deepseek',
		baseUrl: 'https://api.deepseek.com',
		model: 'deepseek-v4-pro'
	},
	bailian: {
		label: '阿里云百炼',
		profileKey: 'bailian',
		baseUrl: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
		model: 'qwen-plus'
	}
};

const AUTH_JSON_SECRET_KEYS = new Set(['access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'token', 'secret']);

function hasOfficialLoginProfile(profiles: readonly Pick<CodexProfile, 'providerType'>[] | undefined): boolean {
	return profiles?.some(profile => profile.providerType === 'officialLogin') ?? false;
}

function isOfficialLogin(providerType: string): boolean {
	return providerType === CODEX_OFFICIAL_LOGIN_TYPE;
}

function toCodexProviderType(providerType: string): CodexProviderType {
	return isOfficialLogin(providerType) ? 'officialLogin' : 'apiKey';
}

function buildProviderTypeOptions(existingProfiles?: readonly Pick<CodexProfile, 'providerType'>[]): SelectOption[] {
	const options: SelectOption[] = [
		...CODEX_PROVIDER_ORDER.map((key) => ({value: key, label: CODEX_PROVIDER_TEMPLATES[key].label})),
		{value: CODEX_CUSTOM_TYPE, label: '自定义 API 供应商'}
	];
	if (!hasOfficialLoginProfile(existingProfiles)) {
		options.unshift({value: CODEX_OFFICIAL_LOGIN_TYPE, label: 'official login'});
	}
	return options;
}

function templateFor(providerType: string): Pick<CodexProviderFormValues, 'profileKey' | 'baseUrl' | 'model' | 'apiKey'> {
	if (providerType in CODEX_PROVIDER_TEMPLATES) {
		const template = CODEX_PROVIDER_TEMPLATES[providerType as keyof typeof CODEX_PROVIDER_TEMPLATES];
		return {profileKey: template.profileKey, baseUrl: template.baseUrl, model: template.model, apiKey: ''};
	}

	return {profileKey: '', baseUrl: '', model: '', apiKey: ''};
}

function redactAuthJsonValue(value: unknown, key = ''): unknown {
	if (AUTH_JSON_SECRET_KEYS.has(key.toLowerCase())) {
		return '***';
	}

	if (Array.isArray(value)) {
		return value.map((item) => redactAuthJsonValue(item));
	}

	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value)) {
			result[childKey] = redactAuthJsonValue(childValue, childKey);
		}
		return result;
	}

	return value;
}

export function readCodexAuthJsonPreview(): string {
	const authPath = codexAuthJsonPath();
	if (!existsSync(authPath)) {
		return `未检测到 CODEX_HOME/auth.json\n\n请运行 codex login 完成 official login。\nccq 仅只读展示 auth.json 状态，不写入该文件。`;
	}

	try {
		const raw = readFileSync(authPath, 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		return `${JSON.stringify(redactAuthJsonValue(parsed), null, 2)}\n`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `已检测到 CODEX_HOME/auth.json，但无法解析为 JSON。\n\n${message}`;
	}
}

function valuesToToml(values: Omit<CodexProviderFormValues, 'toml' | 'authJson'>): string {
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
	readonly existingProfiles?: readonly Pick<CodexProfile, 'providerType'>[];
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
			authJson: readCodexAuthJsonPreview(),
			activateAfterSave: false
		};
	}

	const officialLoginExists = hasOfficialLoginProfile(input.existingProfiles);
	const requestedProviderType = input.providerType ?? (officialLoginExists ? CODEX_PROVIDER_ORDER[0] : CODEX_OFFICIAL_LOGIN_TYPE);
	const providerType = officialLoginExists && requestedProviderType === CODEX_OFFICIAL_LOGIN_TYPE ? CODEX_PROVIDER_ORDER[0] : requestedProviderType;
	const template = templateFor(providerType);
	const values: Omit<CodexProviderFormValues, 'toml'> = {
		profileKey: template.profileKey,
		providerType,
		baseUrl: template.baseUrl,
		model: template.model,
		apiKey: template.apiKey,
			authJson: readCodexAuthJsonPreview(),
		activateAfterSave: true
	};
	return {...values, toml: values.profileKey ? valuesToToml(values) : ''};
}

export function buildCodexProviderFormModel(input: {
	readonly mode: CodexProviderFormMode;
	readonly profile?: CodexProfile | null;
	readonly providerType?: string;
	readonly rawToml?: string;
	readonly existingProfiles?: readonly Pick<CodexProfile, 'providerType'>[];
}): CodexProviderFormModel {
	const values = makeValues(input);
	const fields: FormField[] = [];

	if (input.mode !== 'edit') {
		fields.push({
			id: 'providerType',
			type: 'radio',
			label: '供应商类型',
			value: values.providerType,
			options: buildProviderTypeOptions(input.existingProfiles),
			helpText: hasOfficialLoginProfile(input.existingProfiles)
					? '已存在 official login profile；如需重建请先删除旧 profile，删除时会同步清空 auth.json。'
					: 'Codex profile 独立管理；official login 使用 codex login，自定义 API 供应商写入 profile TOML。'
		});
	}

	fields.push(
		input.mode === 'edit'
			? {
					id: 'profileKey',
					type: 'readonly',
					label: '文件名',
					value: values.profileKey,
					helpText: '对应 CODEX_HOME/<文件名>.config.toml，并作为 codex --profile 名称。'
				}
			: {
					id: 'profileKey',
					type: 'text',
					label: '文件名',
					value: values.profileKey,
					helpText: '填写文件名主体；保存为 CODEX_HOME/<文件名>.config.toml，并作为 codex --profile 名称。'
				}
	);

	if (isOfficialLogin(values.providerType)) {
		fields.push({id: 'model', type: 'text', label: '默认模型', value: values.model});
	} else {
		fields.push(
			{id: 'baseUrl', type: 'text', label: 'Base URL', value: values.baseUrl},
			{id: 'model', type: 'text', label: '默认模型', value: values.model},
			{id: 'apiKey', type: 'secret', label: 'API Key', value: values.apiKey}
		);
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
			errors.push('文件名不能为空');
		} else if (!testCodexProfileKey(values.profileKey.trim())) {
			errors.push('请填写安全文件名（字母/数字/. _ -，不能为 . / .. 或以 - 开头）');
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
