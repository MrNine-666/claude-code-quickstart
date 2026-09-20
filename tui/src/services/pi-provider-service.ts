import {
	buildPiProviderFormFields,
	buildPiProviderFormModel,
	deletePiProvider,
	discoverPiModels,
	loadPiProviderProfile,
	loadPiProviderDisplay,
	parsePiModelIds,
	piProviderModelSummary,
	resolvePiModelCandidate,
	savePiProvider,
	validatePiProviderForm,
	type PiAuthHeaderMode,
	type PiModelCandidate,
	type PiModelDefinition,
	type PiProviderFormInput,
	type PiProviderFormMode,
	type PiProviderFormModel,
	type PiProviderFormValues,
	type PiProviderProfile
} from '../core/pi-provider.js';
import {authHeaderApplies, parseHeaderJson, validateHeaderName} from '../core/pi-header-preset.js';
import {sharedPiModelCatalog} from '../core/pi-model-catalog.js';
import type {PiCatalogLoader} from '../core/pi-model-catalog.js';
import type {ProviderDisplayData} from '../core/provider.js';
import type {ProviderServiceResult} from './provider-service.js';
import type {ProviderFormAdapter} from '../types/provider-form-adapter.js';
import type {FormField} from '../components/form/field-types.js';
export function loadPiProviderDisplayData(): ProviderDisplayData {
	return loadPiProviderDisplay();
}

export function loadPiProviderProfileByRef(reference: string): PiProviderProfile | null {
	return loadPiProviderProfile(reference);
}

export function piProviderSummary(reference: string): string {
	return piProviderModelSummary(reference);
}

export function buildPiForm(input: PiProviderFormInput): PiProviderFormModel {
	return buildPiProviderFormModel(input);
}

export function savePiProviderForm(input: PiProviderFormInput, values: PiProviderFormValues): ProviderServiceResult<PiProviderProfile> {
	const errors = validatePiProviderForm(input.mode, values);
	if (errors.length > 0) return {ok: false, error: errors.join('；')};
	try {
		return {ok: true, data: savePiProvider(values, input)};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export async function discoverPiProviderModels(
	values: PiProviderFormValues,
	signal?: AbortSignal,
	options: {readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number} = {}
): Promise<readonly PiModelDefinition[]> {
	if (values.variant === 'transport-only') {
		throw new Error('内置 Provider 使用 Pi 原生端点，不支持自定义模型发现');
	}
	const parsedHeaders = parseHeaderJson(values.headers ?? '');
	const result = await discoverPiModels({
		baseUrl: values.baseUrl,
		api: values.api ?? 'openai-completions',
		apiKey: values.apiKey,
		headers: parsedHeaders.ok ? parsedHeaders.headers : undefined,
		authHeader: authHeaderApplies(values.api ?? '') && values.authHeader === 'bearer',
		options: {signal, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs}
	});
	if (!result.ok) throw new Error(result.error);
	return result.models;
}

export type PiModelMatchResult =
	| {readonly ok: true; readonly candidate: PiModelCandidate; readonly warning?: string}
	| {readonly ok: false; readonly error: string};

/**
 * 首次选择 intent 时才调用：加载（进程内缓存的）Pi 官方目录并精确匹配当前 ID + API。
 * 目录不可用时降级为仅上游/仅 ID，返回非阻塞 warning，不阻断保存。
 */
export async function matchPiProviderModel(
	values: PiProviderFormValues,
	candidate: PiModelDefinition,
	signal?: AbortSignal,
	options: {readonly catalogLoader?: PiCatalogLoader} = {}
): Promise<PiModelMatchResult> {
	const loader = options.catalogLoader ?? sharedPiModelCatalog;
	const api = values.api?.trim() || 'openai-completions';
	const id = candidate.id.trim();
	const result = await loader.load(signal);
	if (!result.ok) {
		if (result.kind === 'cancelled') return {ok: false, error: result.error};
		return {
			ok: true,
			candidate: resolvePiModelCandidate({id, api, upstreamDefinition: candidate, catalog: null}),
			warning: `Pi 官方模型目录不可用（${result.error}），已降级为仅上游/仅 ID。`
		};
	}
	return {ok: true, candidate: resolvePiModelCandidate({id, api, upstreamDefinition: candidate, catalog: result.index})};
}

export type PiSelectedModelDefinition = {
	readonly id: string;
	readonly definition: PiModelDefinition;
};

export function mergePiProviderModels(values: PiProviderFormValues, discovered: readonly string[]): PiProviderFormValues {
	const models = [...new Set([...parsePiModelIds(values.models), ...discovered.map(model => model.trim()).filter(Boolean)])];
	return {...values, models: models.join('\n'), model: values.model || models[0] || ''};
}

/**
 * Form checkbox selection is authoritative: retain exactly the selected model IDs in the draft。
 * 传字符串（旧式仅 ID 调用）时按 `{id}` 定义处理，传对象时保留完整已解析定义。
 */
export function replacePiProviderModels(
	values: PiProviderFormValues,
	models: readonly (PiSelectedModelDefinition | string)[]
): PiProviderFormValues {
	const normalized: readonly PiSelectedModelDefinition[] = models.map(model => {
		if (typeof model === 'string') {
			const id = model.trim();
			return {id, definition: {id} as PiModelDefinition};
		}
		return model;
	});
	const definitions = new Map(normalized.map(model => [model.id, model.definition]));
	const modelIds = [...new Set(normalized.map(model => model.id.trim()).filter(Boolean))];
	return {
		...values,
		models: modelIds.join('\n'),
		model: modelIds[0] ?? '',
		modelDefinitions: modelIds.map(id => definitions.get(id) ?? {id})
	};
}

export function removePiProvider(
	key: string
): ProviderServiceResult<{readonly deleted: true; readonly removedModels: boolean; readonly removedAuth: boolean}> {
	try {
		return {ok: true, data: deletePiProvider(key)};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

function valuesToRecord(values: PiProviderFormValues): Record<string, string> {
	const models = parsePiModelIds(values.models);
	return {
		api: values.api ?? 'openai-completions',
		provider: values.provider,
		model: models[0] ?? values.model,
		models: models.join('\n'),
		baseUrl: values.baseUrl,
		apiKey: values.apiKey,
		headers: values.headers,
		authHeader: values.authHeader,
		headerPreset: values.headerPreset
	};
}

function recordToValues(record: Record<string, string>, fallback: PiProviderFormValues): PiProviderFormValues {
	const models = record.models ?? fallback.models;
	const authHeader: PiAuthHeaderMode =
		record.authHeader === 'bearer' || record.authHeader === 'default' ? record.authHeader : fallback.authHeader;
	return {
		...fallback,
		api: record.api ?? fallback.api,
		provider: record.provider ?? fallback.provider,
		model: parsePiModelIds(models)[0] ?? record.model ?? fallback.model,
		models,
		baseUrl: record.baseUrl ?? fallback.baseUrl,
		apiKey: record.apiKey === '***' ? fallback.apiKey : (record.apiKey ?? fallback.apiKey),
		headers: record.headers ?? fallback.headers,
		authHeader,
		headerPreset: record.headerPreset ?? fallback.headerPreset
	};
}

/** 字段形状键：id / 类型 / 选项集 / helpText。形状未变时保留原数组，避免无谓重建导致焦点跳动。 */
function fieldShapeKey(field: FormField): string {
	const options = field.type === 'radio' || field.type === 'select' ? field.options.map(option => option.value).join('|') : '';
	return `${field.id}:${field.type}:${options}:${field.helpText ?? ''}`;
}

function syncPiFields(values: PiProviderFormValues, fields: readonly FormField[]): readonly FormField[] {
	const mode: PiProviderFormMode = fields.find(field => field.id === 'provider')?.type === 'readonly' ? 'edit' : 'add';
	const next = buildPiProviderFormFields(values, mode);
	if (fields.length === next.length && fields.every((field, index) => fieldShapeKey(field) === fieldShapeKey(next[index]!))) {
		return fields;
	}
	return next;
}

/** 请求头编辑区是唯一真相源：buildText 原样返回其文本，parseText 只解析这一块。 */
function buildPiFormText(values: PiProviderFormValues): string {
	return values.headers;
}

function parsePiFormText(
	baseValues: PiProviderFormValues,
	raw: string
): {ok: true; values: PiProviderFormValues} | {ok: false; error: string} {
	const parsed = parseHeaderJson(raw);
	if (!parsed.ok) return {ok: false, error: parsed.error};
	for (const name of Object.keys(parsed.headers)) {
		const error = validateHeaderName(name);
		if (error) return {ok: false, error};
	}
	return {ok: true, values: {...baseValues, headers: raw}};
}

export const piProviderFormAdapter: ProviderFormAdapter<PiProviderFormInput, PiProviderFormValues, PiProviderFormModel> = {
	textLabel: '请求头',
	textHelpText:
		'JSON 对象，留空即不配置请求头。值为 Pi 配置语法：$ENV 插值、!command 执行、$$ 表示字面 $。可用 $VAR 引用 auth.json 凭据 env 中的值，避免把密钥写进本文件。',
	showTextEditor: true,
	// 「请求头」是普通字段：编辑区按 `label │ 编辑区` 一行渲染，与其它字段对齐。
	// CC/Codex 的 textarea 是整份文档编辑器（label 超出 FormLabel 固定宽度），保持全宽方块。
	textFieldRow: true,
	title: model => (model.mode === 'edit' ? '编辑 Pi Provider' : '添加 Pi Provider'),
	savedMessage: (model, values) =>
		values.variant === 'transport-only'
			? `${values.provider} 的请求头已${model.mode === 'edit' ? '更新' : '添加'}`
			: `${values.provider} 已${model.mode === 'edit' ? '更新' : '添加'}（${values.models.split(/[\n,]/u).filter(Boolean).length} 个模型）`,
	valuesToRecord,
	recordToValues,
	buildText: buildPiFormText,
	parseText: parsePiFormText,
	syncFields: syncPiFields,
	makeProviderTypeInput: builtinKey => ({mode: 'add', builtinKey}),
	makeSubmitInput: (model, record) => ({
		mode: model.mode,
		builtinKey: model.mode === 'add' ? record.providerType : undefined,
		profileKey: model.mode === 'edit' ? record.provider : undefined,
		profile: null
	}),
	isTextReadOnly: () => false
};
