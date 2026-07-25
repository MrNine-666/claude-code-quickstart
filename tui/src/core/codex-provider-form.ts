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

type CodexProviderTemplate = {
	readonly label: string;
	readonly profileKey: string;
	readonly baseUrl: string;
	readonly model: string;
};

// 仅保留 Codex 原生可接入的供应商：MiniMax 提供 Responses API 兼容端点。
// GLM / Kimi / DeepSeek 仅暴露 Chat Completions，而 Codex CLI 自 v0.138 起只认 wire_api="responses"，
// 直连会 404/空流，需经 LiteLLM/OmniRoute 等网关转协议——故不在此内置为一键模板。
const CODEX_PROVIDER_ORDER = ['minimax'] as const;
const CODEX_PROVIDER_TEMPLATES: Readonly<Record<(typeof CODEX_PROVIDER_ORDER)[number], CodexProviderTemplate>> = {
	minimax: {
		label: 'MiniMax',
		profileKey: 'minimax',
		baseUrl: 'https://api.minimax.io/v1',
		model: 'MiniMax-M3'
	}
};

const AUTH_JSON_SECRET_KEYS = new Set(['access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'token', 'secret']);

function isOfficialLogin(providerType: string): boolean {
	return providerType === CODEX_OFFICIAL_LOGIN_TYPE;
}

function toCodexProviderType(providerType: string): CodexProviderType {
	return isOfficialLogin(providerType) ? 'officialLogin' : 'apiKey';
}

function buildProviderTypeOptions(): SelectOption[] {
	// official login 是结构性单例的虚拟条目（不落盘、可幂等激活），恒定展示，无需按存在性隐藏。
	return [
		{value: CODEX_OFFICIAL_LOGIN_TYPE, label: 'official login'},
		...CODEX_PROVIDER_ORDER.map((key) => ({value: key, label: CODEX_PROVIDER_TEMPLATES[key].label})),
		{value: CODEX_CUSTOM_TYPE, label: '自定义 API 供应商'}
	];
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
			helpText: '供应商独立管理；official login 使用 codex login（不落盘），自定义 API 供应商写入供应商配置 TOML。'
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
		fields.push(
			{id: 'baseUrl', type: 'text', label: 'Base URL', value: values.baseUrl},
			{id: 'model', type: 'text', label: '默认模型', value: values.model},
			{id: 'apiKey', type: 'secret', label: 'API Key', value: values.apiKey}
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
