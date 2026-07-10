import {readFileSync} from 'node:fs';
import {
	deleteCodexProfile,
	listCodexProfiles,
	readCodexProfile,
	readCodexProfileToml as readCodexProfileTomlByKey,
	redactCodexTomlForOutput,
	saveCodexProfileToml,
	setDefaultCodexProfile,
	type CodexProfile
} from '../core/codex.js';
import {deletePath, getPath, parse, setPath, stringify} from '../core/toml-edit.js';
import {
	buildCodexProviderFormModel,
	codexProviderValuesToToml,
	codexProviderValuesFromToml,
	validateCodexProviderForm,
	type CodexProviderFormMode,
	type CodexProviderFormModel,
	type CodexProviderFormValues
} from '../core/codex-provider-form.js';
import type {ProviderDisplayData} from '../core/provider.js';
import type {ProviderServiceResult} from './provider-service.js';
import type {ProviderFormAdapter} from '../views/provider-form.js';

// Codex service：把 Codex profile core 包装为 ProviderView 可消费的 service，视图不直接读写 ~/.codex。

const CODEX_API_KEY_FIELD = 'experimental_bearer_token';

export type CodexProviderFormInput = {
	readonly mode: CodexProviderFormMode;
	readonly profileKey?: string;
	readonly profile?: CodexProfile | null;
	readonly providerType?: string;
	readonly rawToml?: string;
	readonly existingProfiles?: readonly Pick<CodexProfile, 'providerType'>[];
};

export function loadCodexProviderDisplay(): ProviderDisplayData {
	const profiles = listCodexProfiles().map(profile => ({
		key: profile.key,
		baseUrl: profile.baseUrl || (profile.providerType === 'officialLogin' ? 'official login' : ''),
		authToken: profile.hasApiKey ? '<managed-by-codex-profile>' : '',
		profilePath: profile.profilePath,
		isActive: profile.isDefault,
		maskedApiKey: profile.hasApiKey ? 'sk-****' : (profile.providerType === 'officialLogin' ? 'codex login' : '未配置')
	}));
	const active = profiles.find(profile => profile.isActive);
	return {
		profiles,
		activeKey: active?.key ?? '',
		hasProviders: profiles.length > 0
	};
}

export function loadCodexProviderProfile(profilePath: string): CodexProfile | null {
	try {
		const key = profilePath.split(/[/\\]/).pop()?.replace(/\.config\.toml$/, '') ?? '';
		return key ? readCodexProfile(key) : null;
	} catch {
		return null;
	}
}

export function codexModelSummary(profile: CodexProfile | null): string {
	if (!profile) {
		return 'Codex profile';
	}

	const parts: string[] = [profile.providerType];
	if (profile.model) {
		parts.push(profile.model);
	}
	return parts.join(' · ');
}

export function buildCodexForm(input: CodexProviderFormInput): CodexProviderFormModel {
	return buildCodexProviderFormModel(input);
}

export function saveCodexProviderForm(input: CodexProviderFormInput, values: CodexProviderFormValues): ProviderServiceResult<CodexProfile> {
	const errors = validateCodexProviderForm(input.mode, values);
	if (errors.length > 0) {
		return {ok: false, error: errors.join('；')};
	}

	try {
		if (input.mode !== 'edit' && values.providerType === 'officialLogin' && listCodexProfiles().some(profile => profile.providerType === 'officialLogin')) {
			return {ok: false, error: '已存在 official login Codex profile；如需重建请先删除旧 profile，删除时会同步清空 auth.json。'};
		}

		const key = input.mode === 'edit' ? (input.profileKey ?? values.profileKey) : values.profileKey.trim();
		const rawToml = values.toml || codexProviderValuesToToml(values);
		const profile = saveCodexProfileToml(key, rawToml);
		if (input.mode !== 'edit' && values.activateAfterSave) {
			setDefaultCodexProfile(profile.key);
		}
		return {ok: true, data: profile};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {ok: false, error: redactCodexTomlForOutput(message)};
	}
}

export function switchActiveCodexProvider(key: string): ProviderServiceResult<{providerName: string}> {
	try {
		setDefaultCodexProfile(key);
		return {ok: true, data: {providerName: key}};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export function removeCodexProvider(key: string): ProviderServiceResult<{clearedSettings: boolean}> {
	try {
		deleteCodexProfile(key);
		return {ok: true, data: {clearedSettings: false}};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

function codexValuesToRecord(values: CodexProviderFormValues): Record<string, string> {
	return {
		profileKey: values.profileKey,
		providerType: values.providerType,
		baseUrl: values.baseUrl,
		model: values.model,
		apiKey: values.apiKey,
		activateAfterSave: values.activateAfterSave ? 'yes' : 'no'
	};
}

function updateCodexTomlFromFields(values: CodexProviderFormValues): string {
	const key = values.profileKey || 'profile';
	let document;
	try {
		document = values.toml ? parse(values.toml) : parse(codexProviderValuesToToml(values));
	} catch {
		return values.toml;
	}

	const model = values.model.trim();
	const baseUrl = values.baseUrl.trim();
	const apiKey = values.apiKey.trim();

	document = model ? setPath(document, ['model'], model) : deletePath(document, ['model']);

	// Codex key = 唯一身份（HC-CLI-MULTITOOL）：model_providers 下只应保留当前 key 的 table。
	// 文件名字段逐字符编辑时（如 1→12→123），旧 key 的 table 必须清除，否则会累加残留。
	const existingProviders = getPath(document, ['model_providers']);
	if (existingProviders && typeof existingProviders === 'object' && !Array.isArray(existingProviders)) {
		for (const staleKey of Object.keys(existingProviders as Record<string, unknown>)) {
			if (staleKey !== key) {
				document = deletePath(document, ['model_providers', staleKey]);
			}
		}
	}

	if (values.providerType === 'officialLogin') {
		document = deletePath(document, ['model_provider']);
		document = deletePath(document, ['model_providers', key]);
		return stringify(document);
	}

	document = setPath(document, ['model_provider'], key);
	const provider = getPath(document, ['model_providers', key]);
	const nextProvider: Record<string, unknown> = provider && typeof provider === 'object' && !Array.isArray(provider)
		? {...(provider as Record<string, unknown>)}
		: {name: key};
	nextProvider.name = key;
	if (baseUrl) {
		nextProvider.base_url = baseUrl;
	} else {
		delete nextProvider.base_url;
	}

	if (apiKey) {
		nextProvider[CODEX_API_KEY_FIELD] = apiKey;
	}

	delete nextProvider.env_key;
	delete nextProvider.auth;
	delete nextProvider.requires_openai_auth;
	document = setPath(document, ['model_providers', key], nextProvider);
	return stringify(document);
}

function recordToCodexValues(record: Record<string, string>, fallback: CodexProviderFormValues): CodexProviderFormValues {
	const values = {
		...fallback,
		profileKey: record.profileKey ?? '',
		providerType: record.providerType || fallback.providerType,
		baseUrl: record.baseUrl ?? '',
		model: record.model ?? '',
		apiKey: record.apiKey ?? '',
		activateAfterSave: (record.activateAfterSave ?? 'yes') === 'yes'
	};
	return {...values, toml: updateCodexTomlFromFields(values)};
}

export const codexProviderFormAdapter: ProviderFormAdapter<CodexProviderFormInput, CodexProviderFormValues, CodexProviderFormModel> = {
	textLabel: (values) => values.providerType === 'officialLogin' ? 'auth.json（只读脱敏预览）' : '最终 TOML（真实 profile 文件）',
	title: (model) => model.mode === 'edit' ? '编辑 Codex profile' : '添加 Codex profile',
	savedMessage: (model, values) =>
		model.mode === 'edit'
			? `Codex profile ${values.profileKey} 已更新`
			: `Codex profile ${values.profileKey} 已添加${values.activateAfterSave ? '并激活' : ''}`,
	valuesToRecord: codexValuesToRecord,
	recordToValues: recordToCodexValues,
	buildText: (values) => values.providerType === 'officialLogin' ? values.authJson : (values.toml || codexProviderValuesToToml(values)),
	parseText: (baseValues, raw) => baseValues.providerType === 'officialLogin'
		? {ok: true, values: baseValues}
		: codexProviderValuesFromToml(baseValues, raw),
	makeProviderTypeInput: (providerType) => ({mode: 'add', providerType, existingProfiles: listCodexProfiles()}),
	makeSubmitInput: (model, record) => ({
		mode: model.mode,
		profileKey: model.mode === 'edit' ? record.profileKey : undefined,
		profile: null,
		providerType: record.providerType
	}),
	isTextReadOnly: (values) => values.providerType === 'officialLogin'
};

export function readCodexProfileToml(profilePath: string): string {
	try {
		const key = profilePath.split(/[/\\]/).pop()?.replace(/\.config\.toml$/, '') ?? '';
		return key ? readCodexProfileTomlByKey(key) : '';
	} catch {
		return readFileSync(profilePath, 'utf8');
	}
}
