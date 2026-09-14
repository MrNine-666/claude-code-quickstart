import {existsSync, readFileSync} from 'node:fs';
import {
	deleteCodexProfile,
	codexProfileExists,
	isDefaultCodexProfile,
	isOfficialLoginActive,
	isOfficialLoginKey,
	scanCodexProfiles,
	migrateLegacyOfficialLoginFile,
	readCodexProfile,
	readCodexProfileToml as readCodexProfileTomlByKey,
	redactCodexTomlForOutput,
	saveCodexProfileToml,
	setDefaultCodexProfile,
	type CodexProfile
} from '../core/codex.js';
import {codexAuthJsonPath} from '../core/paths.js';
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
import type {ProviderFormAdapter} from '../types/provider-form-adapter.js';
import {discoverModels} from '../core/model-discovery.js';
import {resolveModelDiscoveryConfig} from '../core/provider-contract.js';

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

let officialMigrationDone = false;

/** 存量迁移 preflight：进入 Codex 上下文的供应商页时清理历史遗留的 official.config.toml 空壳（一次性，幂等）。 */
function runCodexOfficialMigrationOnce(): void {
	if (officialMigrationDone) {
		return;
	}

	officialMigrationDone = true;
	try {
		migrateLegacyOfficialLoginFile();
	} catch {
		/* 迁移失败不阻塞列表渲染 */
	}
}

/** official login 是否已登录：已激活默认态，或 auth.json 存在（凭据由 codex login 生成，ccq 只读）。 */
export function isCodexOfficialLoggedIn(): boolean {
	try {
		return isOfficialLoginActive() || existsSync(codexAuthJsonPath());
	} catch {
		return existsSync(codexAuthJsonPath());
	}
}

export function loadCodexProviderDisplay(): ProviderDisplayData {
	runCodexOfficialMigrationOnce();
	const officialLoggedIn = isCodexOfficialLoggedIn();
	const scan = scanCodexProfiles();
	const profiles = scan.profiles.map(profile => {
		const official = profile.providerType === 'officialLogin';
		return {
			key: profile.key,
			baseUrl: profile.baseUrl || (official ? 'official login' : ''),
			authToken: profile.hasApiKey ? '<managed-by-codex-profile>' : '',
			profilePath: profile.profilePath,
			isActive: profile.isDefault,
			maskedApiKey: profile.hasApiKey ? 'sk-****' : official ? (officialLoggedIn ? 'codex login' : '未登录') : '未配置',
			...(official ? {canEdit: false, canDelete: false, canSwitch: true} : {})
		};
	});
	const active = profiles.find(profile => profile.isActive);
	return {
		profiles,
		activeKey: active?.key ?? '',
		hasProviders: profiles.length > 0,
		loadFailures: scan.failures
	};
}

export function loadCodexProviderProfile(profilePath: string): CodexProfile | null {
	// official login 虚拟条目无磁盘文件，返回其静态形态供视图展示。
	if (isOfficialLoginKey(profilePath)) {
		return {
			key: profilePath,
			providerType: 'officialLogin',
			baseUrl: '',
			model: '',
			hasApiKey: false,
			profilePath: ''
		};
	}

	try {
		const key =
			profilePath
				.split(/[/\\]/)
				.pop()
				?.replace(/\.config\.toml$/, '') ?? '';
		return key ? readCodexProfile(key) : null;
	} catch {
		return null;
	}
}

export function codexModelSummary(profile: CodexProfile | null): string {
	if (!profile) {
		return '供应商';
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

/** 获取 Codex 供应商的上游模型；选择结果只回填表单，不直接修改 TOML 文件。 */
export async function discoverCodexProviderModels(values: CodexProviderFormValues, signal?: AbortSignal): Promise<readonly string[]> {
	const discoveryConfig = resolveModelDiscoveryConfig({
		side: 'codex',
		providerType: values.providerType,
		profileKey: values.profileKey,
		baseUrl: values.baseUrl
	});
	const result = await discoverModels({
		baseUrl: discoveryConfig.baseUrl ?? values.baseUrl,
		path: discoveryConfig.path,
		pathMode: discoveryConfig.pathMode,
		auth: discoveryConfig.auth,
		apiKey: values.apiKey,
		signal
	});
	if (!result.ok) throw new Error(result.error);
	return result.models.map(model => model.id);
}

export function saveCodexProviderForm(input: CodexProviderFormInput, values: CodexProviderFormValues): ProviderServiceResult<CodexProfile> {
	const errors = validateCodexProviderForm(input.mode, values);
	if (errors.length > 0) {
		return {ok: false, error: errors.join('；')};
	}

	try {
		const key = input.mode === 'edit' ? (input.profileKey ?? values.profileKey) : values.profileKey.trim();
		if (input.mode !== 'edit' && codexProfileExists(key)) {
			return {
				ok: false,
				error: `供应商 ${key} 已存在，请修改文件名后重试`,
				errorKind: 'conflict'
			};
		}
		const rawToml = values.toml || codexProviderValuesToToml(values);
		// 编辑活跃 profile 前先记录其活跃态：saveCodexProfileToml 只写子文件，
		// 不会同步 config.toml 的供应商键，故活跃 profile 的改动需在写盘后重新同步默认。
		const wasActive = input.mode === 'edit' && isDefaultCodexProfile(key);
		const profile = saveCodexProfileToml(key, rawToml);
		const shouldSyncDefault = input.mode === 'edit' ? wasActive : values.activateAfterSave;
		if (shouldSyncDefault) {
			try {
				setDefaultCodexProfile(profile.key);
			} catch (error) {
				const detail = redactCodexTomlForOutput(error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0];
				return {
					ok: true,
					data: profile,
					warning: `供应商 ${profile.key} 已保存，但激活失败：${detail || '请修复 config.toml 后在列表中重试'}`
				};
			}
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
		const message = error instanceof Error ? error.message : String(error);
		return {ok: false, error: redactCodexTomlForOutput(message)};
	}
}

export function removeCodexProvider(key: string): ProviderServiceResult<{clearedSettings: boolean}> {
	if (isOfficialLoginKey(key)) {
		return {ok: false, error: 'Codex 官方账号为只读身份，请通过 Codex 原生命令 codex logout 管理。'};
	}

	try {
		deleteCodexProfile(key);
		return {ok: true, data: {clearedSettings: false}};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {ok: false, error: redactCodexTomlForOutput(message)};
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

	document = setPath(document, ['model_provider'], key);
	const provider = getPath(document, ['model_providers', key]);
	const nextProvider: Record<string, unknown> =
		provider && typeof provider === 'object' && !Array.isArray(provider) ? {...(provider as Record<string, unknown>)} : {name: key};
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
	textLabel: '最终 TOML（供应商配置文件）',
	title: model => (model.mode === 'edit' ? '编辑供应商' : '添加供应商'),
	savedMessage: (model, values) =>
		model.mode === 'edit'
			? `供应商 ${values.profileKey} 已更新`
			: `供应商 ${values.profileKey} 已添加${values.activateAfterSave ? '并激活' : ''}`,
	valuesToRecord: codexValuesToRecord,
	recordToValues: recordToCodexValues,
	buildText: values => values.toml || codexProviderValuesToToml(values),
	parseText: codexProviderValuesFromToml,
	makeProviderTypeInput: providerType => ({mode: 'add', providerType}),
	makeSubmitInput: (model, record) => ({
		mode: model.mode,
		profileKey: model.mode === 'edit' ? record.profileKey : undefined,
		profile: null,
		providerType: record.providerType
	}),
	isTextReadOnly: () => false
};

export function readCodexProfileToml(profilePath: string): string {
	try {
		const key =
			profilePath
				.split(/[/\\]/)
				.pop()
				?.replace(/\.config\.toml$/, '') ?? '';
		return key ? readCodexProfileTomlByKey(key) : '';
	} catch {
		return readFileSync(profilePath, 'utf8');
	}
}
