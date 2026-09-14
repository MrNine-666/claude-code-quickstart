import {
	buildCodexProfileToml,
	extractCodexApiKeyFromToml,
	parseCodexProfileToml,
	testCodexProfileKey,
	type CodexProviderType,
	type CodexProfile
} from './codex.js';
import {loadProviderContract, type CodexProviderTemplate} from './provider-contract.js';
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

export const CODEX_CUSTOM_TYPE = 'custom';

const LEGACY_OFFICIAL_LOGIN_TYPE = 'officialLogin';
const OFFICIAL_LOGIN_FORM_ERROR = '官方账号由 Codex 原生管理，请运行 codex login 或 codex logout，不能通过表单编辑。';

/**
 * Codex 内置一键模板：唯一事实源为 contracts/providers.json 各供应商的 `Codex` 段，
 * 与 Claude 侧同一份契约统一管理（新增供应商/改端点/改文案只动契约）。
 *
 * 声明 `Codex` 段即代表该供应商可被 Codex 原生接入——Codex CLI 当前仅支持 Responses，
 * 故仅自身提供 Responses 兼容端点者才有该段（当前智谱 GLM、MiniMax、DeepSeek）；Kimi 仅暴露
 * Chat Completions，直连会 404/空流，需经 LiteLLM/OmniRoute 等网关转协议，故契约中无 Codex 段。
	 * Codex 侧 baseUrl/model 与 Claude 侧不同源：Responses 端点与模型 ID 常与 Anthropic 兼容端点不一致；
	 * 内置模板只预填 baseUrl，模型由用户手动填写或从上游模型列表选择。
 *
 * custom 是表单中的结构性条目：它不是「某家供应商是否支持 Responses」的判断对象，
 * 故不靠 Codex 段声明可用性，由 buildProviderTypeOptions 直接补齐。官方登录是列表中的
 * 虚拟只读身份，不属于 Codex 表单类型。
 */
function codexBuiltinTemplates(): {key: string; label: string; template: CodexProviderTemplate}[] {
	const {builtinProviders} = loadProviderContract();
	const templates: {key: string; label: string; template: CodexProviderTemplate}[] = [];
	for (const [key, provider] of Object.entries(builtinProviders)) {
		if (!provider.codex) {
			continue;
		}

		templates.push({key, label: provider.name || key, template: provider.codex});
	}

	return templates;
}

/** 自定义供应商显示名：取契约 custom 条目的 Name，与 Claude 侧同源，保证两侧文案一致。 */
function customProviderLabel(): string {
	return loadProviderContract().builtinProviders[CODEX_CUSTOM_TYPE]?.name || CODEX_CUSTOM_TYPE;
}

function toCodexProviderType(providerType: string): CodexProviderType {
	if (providerType === LEGACY_OFFICIAL_LOGIN_TYPE) {
		throw new Error(OFFICIAL_LOGIN_FORM_ERROR);
	}

	return 'apiKey';
}

function buildProviderTypeOptions(): SelectOption[] {
	// 一键模板随契约顺序；custom 的显示名取自契约，与 Claude 侧同文案。
	// official login 是 Codex 列表中的虚拟身份，由 codex login 管理，不进入表单。
	return [
		...codexBuiltinTemplates().map(({key, label}) => ({value: key, label})),
		{value: CODEX_CUSTOM_TYPE, label: customProviderLabel()}
	];
}

function templateFor(providerType: string): Pick<CodexProviderFormValues, 'profileKey' | 'baseUrl' | 'model' | 'apiKey'> {
	if (providerType === LEGACY_OFFICIAL_LOGIN_TYPE) {
		throw new Error(OFFICIAL_LOGIN_FORM_ERROR);
	}

	const builtin = codexBuiltinTemplates().find(({key}) => key === providerType);
	if (builtin) {
		// profileKey 默认取契约 key：与 Claude 侧 profile 命名同源，且天然满足 safeCodexProfileKey。
		return {profileKey: builtin.key, baseUrl: builtin.template.baseUrl, model: builtin.template.model, apiKey: ''};
	}

	// custom / 未知类型：全空，profileKey 留空强制用户命名，避免多个自定义供应商落到同一文件名。
	return {profileKey: '', baseUrl: '', model: '', apiKey: ''};
}

/** 契约 PlatformUrl：该供应商的 API Key 申请页，两侧共用同一字段。 */
function platformUrlFor(providerType: string): string | undefined {
	const url = loadProviderContract().builtinProviders[providerType]?.platformUrl;
	return isNullOrWhiteSpace(url) ? undefined : url;
}

/**
 * 供应商类型字段提示：随所选类型变化（与 Claude 侧同构）。
 * 取值优先级 Codex.Note → Description。
 * 刻意不回退顶层 Note——那是 Claude 侧的接入限制（套餐档位等），与 Codex 侧无关。
 */
function providerTypeHelpText(providerType: string): string {
	const provider = loadProviderContract().builtinProviders[providerType];
	return provider?.codex?.note || provider?.description || '写入 ~/.codex/<文件名>.config.toml 供应商配置文件。';
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
	readonly existingProfiles?: readonly Pick<CodexProfile, 'providerType'>[];
}): CodexProviderFormValues {
	if (input.mode === 'edit' && input.profile) {
		if (input.profile.providerType === 'officialLogin') {
			throw new Error(OFFICIAL_LOGIN_FORM_ERROR);
		}

		const providerType = input.providerType ?? CODEX_CUSTOM_TYPE;
		// 从真实 TOML 回填明文 apiKey，让 secret 字段展示密码格式（与 Claude 侧一致）。
		const editApiKey = !input.rawToml ? '' : extractCodexApiKeyFromToml(input.profile.key, input.rawToml);
		return {
			profileKey: input.profile.key,
			providerType,
			baseUrl: input.profile.baseUrl,
			model: input.profile.model,
			apiKey: editApiKey,
			toml:
				input.rawToml ??
				valuesToToml({
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

	// 新增默认 providerType：显式请求优先，否则使用与 Pi 相同的 API-key custom 表单。
	const providerType = input.providerType ?? CODEX_CUSTOM_TYPE;
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
			options: buildProviderTypeOptions(),
			// 随所选类型变化：展示该供应商的契约 Codex.Note（接入限制），回退 Description。
			helpText: providerTypeHelpText(values.providerType)
		});
	}

	fields.push(
		input.mode === 'edit'
			? {
					id: 'profileKey',
					type: 'readonly',
					label: '文件名',
					value: values.profileKey,
					helpText: '对应 ~/.codex/<文件名>.config.toml，并作为 codex --profile 名称。'
				}
			: {
					id: 'profileKey',
					type: 'text',
					label: '文件名',
					value: values.profileKey,
					helpText: '填写文件名主体；保存为 ~/.codex/<文件名>.config.toml，并作为 codex --profile 名称。'
				}
	);
	const platformUrl = platformUrlFor(values.providerType);
	fields.push(
		{
			id: 'baseUrl',
			type: 'text',
			label: 'Base URL',
			value: values.baseUrl,
			// Codex 与 Claude 侧不同源的最常见误填点：Codex CLI 当前仅支持 Responses，
			// 填成供应商的 Anthropic 兼容端点会 404/空流。
			helpText: '须填供应商的 Responses 兼容端点，除 DeepSeek 外一般都需要拼接/v1。'
		},
		{
			id: 'apiKey',
			type: 'secret',
			label: 'API Key',
			value: values.apiKey,
			// Codex 侧与 Claude 侧的关键差异：密钥明文落在 profile TOML 的 experimental_bearer_token，
			// 不进 ccq vault、不由 ccq 注入 env，故须让用户知道它存在哪。
			helpText: platformUrl
				? `在 ${platformUrl} 创建；明文写入 TOML 的 experimental_bearer_token。`
				: '明文写入 TOML 的 experimental_bearer_token。'
		},
		// 契约 Codex.Note 记录该供应商的接入限制（如仅某模型支持 Responses），
		// 挂在模型字段上让用户在改模型前先看到。
		// 供应商级限制说明已归 providerType 字段（Codex.Note），此处只说字段自身语义，避免同段文案重复出现。
		{
			id: 'model',
			type: 'model-select',
			label: '默认模型',
			value: values.model,
			helpText: '写入 TOML 的 model 键，作为该 profile 的默认模型。'
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
			],
			helpText: '激活即把本 profile 写入 ~/.codex/config.toml 的供应商键并设为默认；选「否」仅保存文件，之后可在列表中切换。'
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
		if (parsed.providerType === 'officialLogin') {
			return {ok: false, error: OFFICIAL_LOGIN_FORM_ERROR};
		}
		return {
			ok: true,
			values: {
				...baseValues,
				providerType: baseValues.providerType,
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
	if (values.providerType === LEGACY_OFFICIAL_LOGIN_TYPE) {
		errors.push(OFFICIAL_LOGIN_FORM_ERROR);
		return errors;
	}

	if (mode !== 'edit') {
		if (isNullOrWhiteSpace(values.profileKey)) {
			errors.push('文件名不能为空');
		} else if (!testCodexProfileKey(values.profileKey.trim())) {
			errors.push('请填写安全文件名（字母/数字/. _ -，不能为 . / .. 或以 - 开头，且不能为保留字 official）');
		}
	}

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

	return errors;
}
