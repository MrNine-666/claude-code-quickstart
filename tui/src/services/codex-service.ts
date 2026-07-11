import {existsSync, readFileSync} from 'node:fs';
import {
	deleteCodexProfile,
	isDefaultCodexProfile,
	isOfficialLoginActive,
	isOfficialLoginKey,
	listCodexProfiles,
	migrateLegacyOfficialLoginFile,
	readCodexProfile,
	readCodexProfileToml as readCodexProfileTomlByKey,
	redactCodexTomlForOutput,
	saveCodexProfileToml,
	setDefaultCodexProfile,
	writeCodexAuthJson,
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
import {CODEX_OFFICIAL_LOGIN_KEY} from '../core/codex.js';
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

let officialMigrationDone = false;

/** 存量迁移 preflight：进入 Codex 供应商页时清理历史遗留的 official.config.toml 空壳（一次性，幂等）。 */
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
	return isOfficialLoginActive() || existsSync(codexAuthJsonPath());
}

export function loadCodexProviderDisplay(): ProviderDisplayData {
	runCodexOfficialMigrationOnce();
	const officialLoggedIn = isCodexOfficialLoggedIn();
	const profiles = listCodexProfiles().map(profile => {
		const official = profile.providerType === 'officialLogin';
		return {
			key: profile.key,
			baseUrl: profile.baseUrl || (official ? 'official login' : ''),
			authToken: profile.hasApiKey ? '<managed-by-codex-profile>' : '',
			profilePath: profile.profilePath,
			isActive: profile.isDefault,
			maskedApiKey: profile.hasApiKey
				? 'sk-****'
				: (official ? (officialLoggedIn ? 'codex login' : '未登录') : '未配置')
		};
	});
	const active = profiles.find(profile => profile.isActive);
	return {
		profiles,
		activeKey: active?.key ?? '',
		hasProviders: profiles.length > 0
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
		// official login 是不落盘的虚拟条目：不写 profile 文件。
		// - add 态：仅按需激活（清空 config.toml 供应商键，回到 auth.json 登录态）。
		// - edit 态（authEditable）：直接写入 ~/.codex/auth.json 明文；空内容即登出（删除文件）。
		if (values.providerType === 'officialLogin') {
			if (input.mode === 'edit' && values.authEditable) {
				writeCodexAuthJson(values.authJson);
			} else if (input.mode !== 'edit' && values.activateAfterSave) {
				setDefaultCodexProfile(CODEX_OFFICIAL_LOGIN_KEY);
			}

			return {
				ok: true,
				data: {
					key: CODEX_OFFICIAL_LOGIN_KEY,
					providerType: 'officialLogin',
					baseUrl: '',
					model: '',
					hasApiKey: false,
					profilePath: ''
				}
			};
		}

		const key = input.mode === 'edit' ? (input.profileKey ?? values.profileKey) : values.profileKey.trim();
		const rawToml = values.toml || codexProviderValuesToToml(values);
		// 编辑活跃 profile 前先记录其活跃态：saveCodexProfileToml 只写子文件，
		// 不会同步 config.toml 的供应商键，故活跃 profile 的改动需在写盘后重新同步默认。
		const wasActive = input.mode === 'edit' && isDefaultCodexProfile(key);
		const profile = saveCodexProfileToml(key, rawToml);
		if (input.mode === 'edit') {
			// 编辑当前活跃 profile：重新导入新值到 config.toml，避免 model/base_url/token 停留在旧值。
			if (wasActive) {
				setDefaultCodexProfile(profile.key);
			}
		} else if (values.activateAfterSave) {
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
		authJson: values.authJson,
		authEditable: values.authEditable ? 'yes' : 'no',
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
		// authJson/authEditable 随 record 透传，保住 official 编辑态的明文 auth.json 与可编辑标志。
		authJson: record.authJson ?? fallback.authJson,
		authEditable: (record.authEditable ?? (fallback.authEditable ? 'yes' : 'no')) === 'yes',
		activateAfterSave: (record.activateAfterSave ?? 'yes') === 'yes'
	};
	return {...values, toml: updateCodexTomlFromFields(values)};
}

export const codexProviderFormAdapter: ProviderFormAdapter<CodexProviderFormInput, CodexProviderFormValues, CodexProviderFormModel> = {
	textLabel: (values) => values.providerType === 'officialLogin'
		? (values.authEditable ? 'auth.json（明文·可编辑）' : 'auth.json（只读脱敏预览）')
		: '最终 TOML（真实 profile 文件）',
	title: (model) => model.mode === 'edit' ? '编辑 Codex profile' : '添加 Codex profile',
	savedMessage: (model, values) =>
		model.mode === 'edit'
			? `Codex profile ${values.profileKey} 已更新`
			: `Codex profile ${values.profileKey} 已添加${values.activateAfterSave ? '并激活' : ''}`,
	valuesToRecord: codexValuesToRecord,
	recordToValues: recordToCodexValues,
	buildText: (values) => values.providerType === 'officialLogin' ? values.authJson : (values.toml || codexProviderValuesToToml(values)),
	// official 编辑态：textarea 即 auth.json 编辑区，回写 authJson；只读预览态与其他 provider 维持原语义。
	parseText: (baseValues, raw) => {
		if (baseValues.providerType === 'officialLogin') {
			return baseValues.authEditable
				? {ok: true, values: {...baseValues, authJson: raw}}
				: {ok: true, values: baseValues};
		}

		return codexProviderValuesFromToml(baseValues, raw);
	},
	makeProviderTypeInput: (providerType) => ({mode: 'add', providerType}),
	makeSubmitInput: (model, record) => ({
		mode: model.mode,
		profileKey: model.mode === 'edit' ? record.profileKey : undefined,
		profile: null,
		providerType: record.providerType
	}),
	// official 只读预览态 textarea 禁编辑；编辑态（authEditable）放开明文编辑。
	isTextReadOnly: (values) => values.providerType === 'officialLogin' && !values.authEditable
};

export function readCodexProfileToml(profilePath: string): string {
	try {
		const key = profilePath.split(/[/\\]/).pop()?.replace(/\.config\.toml$/, '') ?? '';
		return key ? readCodexProfileTomlByKey(key) : '';
	} catch {
		return readFileSync(profilePath, 'utf8');
	}
}
