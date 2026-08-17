import {existsSync, readFileSync} from 'node:fs';
import {
	buildCodexProfileToml,
	extractCodexApiKeyFromToml,
	parseCodexProfileToml,
	readCodexAuthJsonRaw,
	testCodexProfileKey,
	CODEX_OFFICIAL_LOGIN_KEY,
	type CodexProviderType,
	type CodexProfile
} from './codex.js';
import {codexAuthJsonPath} from './paths.js';
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
	authJson: string;
	// official 编辑态：authJson 为明文可编辑 JSON（edit 模式），否则为脱敏只读预览（add 模式）。
	authEditable: boolean;
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

/**
 * Codex 内置一键模板：唯一事实源为 contracts/providers.json 各供应商的 `Codex` 段，
 * 与 Claude 侧同一份契约统一管理（新增供应商/改端点/改文案只动契约）。
 *
 * 声明 `Codex` 段即代表该供应商可被 Codex 原生接入——Codex CLI 当前仅支持 Responses，
 * 故仅自身提供 Responses 兼容端点者才有该段（当前智谱 GLM、MiniMax、DeepSeek）；Kimi 仅暴露
 * Chat Completions，直连会 404/空流，需经 LiteLLM/OmniRoute 等网关转协议，故契约中无 Codex 段。
 * Codex 侧 baseUrl/model 与 Claude 侧不同源：Responses 端点与模型 ID 常与 Anthropic 兼容端点不一致。
 *
 * 不含结构性条目（official login / custom）：二者都不是「某家供应商是否支持 Responses」的判断对象，
 * 故不靠 Codex 段声明可用性，由 buildProviderTypeOptions 直接补齐。
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

const AUTH_JSON_SECRET_KEYS = new Set(['access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'token', 'secret']);

function isOfficialLogin(providerType: string): boolean {
	return providerType === CODEX_OFFICIAL_LOGIN_TYPE;
}

function toCodexProviderType(providerType: string): CodexProviderType {
	return isOfficialLogin(providerType) ? 'officialLogin' : 'apiKey';
}

function buildProviderTypeOptions(): SelectOption[] {
	// 两个结构性条目不由契约的 Codex 段声明可用性，恒定展示：
	//   - official login：认证方式而非供应商（~/.codex/auth.json 全局单例，不落盘、无端点无模型）。
	//   - custom：用户手填的逃生口，"是否支持 Responses"取决于用户填什么，非供应商属性。
	// 中间的一键模板随契约顺序；custom 的显示名取自契约，与 Claude 侧同文案。
	return [
		{value: CODEX_OFFICIAL_LOGIN_TYPE, label: 'official login'},
		...codexBuiltinTemplates().map(({key, label}) => ({value: key, label})),
		{value: CODEX_CUSTOM_TYPE, label: customProviderLabel()}
	];
}

function templateFor(providerType: string): Pick<CodexProviderFormValues, 'profileKey' | 'baseUrl' | 'model' | 'apiKey'> {
	const builtin = codexBuiltinTemplates().find(({key}) => key === providerType);
	if (builtin) {
		// profileKey 默认取契约 key：与 Claude 侧 profile 命名同源，且天然满足 safeCodexProfileKey。
		return {profileKey: builtin.key, baseUrl: builtin.template.baseUrl, model: builtin.template.model, apiKey: ''};
	}

	// custom / 未知类型：全空，profileKey 留空强制用户命名，避免多个自定义供应商落到同一文件名。
	return {profileKey: '', baseUrl: '', model: '', apiKey: ''};
}

/** 契约 Codex.Note：该供应商的接入限制说明，无则返回 undefined（自定义/无声明供应商）。 */
function templateNote(providerType: string): string | undefined {
	return codexBuiltinTemplates().find(({key}) => key === providerType)?.template.note;
}

/** 契约 PlatformUrl：该供应商的 API Key 申请页，两侧共用同一字段。 */
function platformUrlFor(providerType: string): string | undefined {
	const url = loadProviderContract().builtinProviders[providerType]?.platformUrl;
	return isNullOrWhiteSpace(url) ? undefined : url;
}

/**
 * 供应商类型字段提示：随所选类型变化（与 Claude 侧同构）。
 * 取值优先级 Codex.Note → Description；official login 不在契约内，用固定文案。
 * 刻意不回退顶层 Note——那是 Claude 侧的接入限制（套餐档位等），与 Codex 侧无关。
 */
function providerTypeHelpText(providerType: string): string {
	if (isOfficialLogin(providerType)) {
		return '使用 codex login 认证，靠 ~/.codex/auth.json（全局单例），不落 profile 文件。';
	}

	const provider = loadProviderContract().builtinProviders[providerType];
	return provider?.codex?.note || provider?.description || '写入 ~/.codex/<文件名>.config.toml 供应商配置文件。';
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
		return `未检测到 ~/.codex/auth.json\n\n请运行 codex login 完成 official login。\nccq 仅只读展示 auth.json 状态，不写入该文件。`;
	}

	try {
		const raw = readFileSync(authPath, 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		return `${JSON.stringify(redactAuthJsonValue(parsed), null, 2)}\n`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `已检测到 ~/.codex/auth.json，但无法解析为 JSON。\n\n${message}`;
	}
}

function valuesToToml(values: Omit<CodexProviderFormValues, 'toml' | 'authJson' | 'authEditable'>): string {
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
		const editingOfficial = isOfficialLogin(providerType);
		// 从真实 TOML 回填明文 apiKey，让 secret 字段展示密码格式（与 Claude 侧一致）；official 无 TOML。
		const editApiKey = editingOfficial || !input.rawToml ? '' : extractCodexApiKeyFromToml(input.profile.key, input.rawToml);
		return {
			profileKey: input.profile.key,
			providerType,
			baseUrl: input.profile.baseUrl,
			model: input.profile.model,
			apiKey: editApiKey,
			// official 编辑态无 profile TOML（虚拟条目，靠 auth.json）；仅真实 provider 生成 TOML。
			toml: editingOfficial ? '' : (input.rawToml ?? valuesToToml({
				profileKey: input.profile.key,
				providerType,
				baseUrl: input.profile.baseUrl,
				model: input.profile.model,
				apiKey: '',
				activateAfterSave: false
			})),
			// 编辑 official：textarea 回填明文 auth.json 供直接编辑；其他 provider 无 authJson 语义。
			authJson: editingOfficial ? readCodexAuthJsonRaw() : readCodexAuthJsonPreview(),
			authEditable: editingOfficial,
			activateAfterSave: false
		};
	}

	// 新增默认 providerType：显式请求优先，否则默认 official login（虚拟条目，最常见首选）。
	const providerType = input.providerType ?? CODEX_OFFICIAL_LOGIN_TYPE;
	const template = templateFor(providerType);
	// official login 虚拟条目：profileKey 固定为 sentinel（不落盘），无 baseUrl/model/apiKey。
	const profileKey = isOfficialLogin(providerType) ? CODEX_OFFICIAL_LOGIN_KEY : template.profileKey;
	const values: Omit<CodexProviderFormValues, 'toml'> = {
		profileKey,
		providerType,
		baseUrl: template.baseUrl,
		model: template.model,
		apiKey: template.apiKey,
		// add 态 official 仅脱敏预览、只读；明文编辑仅在 edit 态放开（authEditable=false）。
		authJson: readCodexAuthJsonPreview(),
		authEditable: false,
		activateAfterSave: true
	};
	return {...values, toml: !isOfficialLogin(providerType) && values.profileKey ? valuesToToml(values) : ''};
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

	// official login 是不落盘的虚拟条目（全局单例 + 靠 auth.json），无文件名/无 model 字段：
	// 唯一可调操作是「保存后激活」（=清空 config.toml 供应商键，让 codex 回到登录态）。
	if (!isOfficialLogin(values.providerType)) {
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
			// 契约 Codex.Note 记录该供应商的接入限制（如仅某模型支持 Responses），
			// 挂在模型字段上让用户在改模型前先看到。
			// 供应商级限制说明已归 providerType 字段（Codex.Note），此处只说字段自身语义，避免同段文案重复出现。
			{id: 'model', type: 'text', label: '默认模型', value: values.model, helpText: '写入 TOML 的 model 键，作为该 profile 的默认模型。'},
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
			}
		);
	} else if (values.authEditable) {
		// 编辑 official：JSON 由底部 textarea 明文可编辑，此处仅留一行说明，避免与 textarea 内容重复。
		fields.push({
			id: 'authStatus',
			type: 'readonly',
			label: '官方登录状态',
			value: values.authJson.trim() === '' ? '未登录（保存非空 JSON 即写入 auth.json）' : '已登录（可直接编辑下方 auth.json）',
			helpText: '下方 auth.json 为 ~/.codex/auth.json 明文；直接编辑并 Ctrl+S 保存，清空内容保存即登出（删除 auth.json）。'
		});
	} else {
		fields.push({
			id: 'authJson',
			type: 'readonly',
			label: '官方登录状态',
			value: values.authJson,
			helpText: 'official login 靠 ~/.codex/auth.json（全局单例）。请先运行 `codex login` 完成登录，或进入编辑（E）直接修改 auth.json。'
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
			// 两种类型的激活语义不同：official login 是「清空供应商键回到登录态」，真实 provider 是「写入供应商键」。
			helpText: isOfficialLogin(values.providerType)
				? '激活即清空 ~/.codex/config.toml 的供应商键，让 codex 回到 auth.json 登录态；选「否」则不改动当前默认。'
				: '激活即把本 profile 写入 ~/.codex/config.toml 的供应商键并设为默认；选「否」仅保存文件，之后可在列表中切换。'
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
	// official login 虚拟条目 profileKey 固定为 sentinel（保留字），不走文件名校验。
	if (mode !== 'edit' && !isOfficialLogin(values.providerType)) {
		if (isNullOrWhiteSpace(values.profileKey)) {
			errors.push('文件名不能为空');
		} else if (!testCodexProfileKey(values.profileKey.trim())) {
			errors.push('请填写安全文件名（字母/数字/. _ -，不能为 . / .. 或以 - 开头，且不能为保留字 official）');
		}
	}

	// 编辑 official：auth.json 明文可编辑。非空内容须为合法 JSON 对象；空内容合法（保存即登出）。
	if (isOfficialLogin(values.providerType) && values.authEditable) {
		const trimmed = values.authJson.trim();
		if (trimmed !== '') {
			let parsedAuth: unknown;
			try {
				parsedAuth = JSON.parse(trimmed);
			} catch (error) {
				errors.push(`auth.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
			}

			if (parsedAuth !== undefined && (typeof parsedAuth !== 'object' || parsedAuth === null || Array.isArray(parsedAuth))) {
				errors.push('auth.json 顶层必须是 JSON 对象');
			}
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
