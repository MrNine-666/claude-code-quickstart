import {
	buildPiProviderFormModel,
	deletePiProvider,
	discoverPiModels,
	loadPiProviderProfile,
	loadPiProviderDisplay,
	parsePiModelIds,
	piProviderModelSummary,
	savePiProvider,
	switchPiProvider,
	validatePiProviderForm,
	type PiProviderFormInput,
	type PiProviderFormModel,
	type PiProviderFormValues,
	type PiProviderProfile
} from '../core/pi-provider.js';
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

export async function discoverPiProviderModels(values: PiProviderFormValues, signal?: AbortSignal): Promise<readonly string[]> {
	const result = await discoverPiModels({
		baseUrl: values.baseUrl,
		api: values.api ?? 'openai-completions',
		apiKey: values.apiKey,
		options: {signal}
	});
	if (!result.ok) throw new Error(result.error);
	return result.models.map(model => model.id);
}

export function mergePiProviderModels(values: PiProviderFormValues, discovered: readonly string[]): PiProviderFormValues {
	const models = [...new Set([...parsePiModelIds(values.models), ...discovered.map(model => model.trim()).filter(Boolean)])];
	return {...values, models: models.join('\n'), model: values.model || models[0] || ''};
}

/** Form checkbox selection is authoritative: retain exactly the selected model IDs in the draft. */
export function replacePiProviderModels(values: PiProviderFormValues, selected: readonly string[]): PiProviderFormValues {
	const models = [...new Set(selected.map(model => model.trim()).filter(Boolean))];
	return {...values, models: models.join('\n'), model: models[0] ?? ''};
}

export function switchActivePiProvider(key: string): ProviderServiceResult<{providerName: string}> {
	try {
		const result = switchPiProvider(key);
		return {ok: true, data: {providerName: result.providerName}};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
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
		activateAfterSave: values.activateAfterSave ? 'yes' : 'no'
	};
}

function recordToValues(record: Record<string, string>, fallback: PiProviderFormValues): PiProviderFormValues {
	const models = record.models ?? fallback.models;
	return {
		...fallback,
		api: record.api ?? fallback.api,
		provider: record.provider ?? fallback.provider,
		model: parsePiModelIds(models)[0] ?? record.model ?? fallback.model,
		models,
		baseUrl: record.baseUrl ?? fallback.baseUrl,
		apiKey: record.apiKey === '***' ? fallback.apiKey : (record.apiKey ?? fallback.apiKey),
		activateAfterSave: (record.activateAfterSave ?? (fallback.activateAfterSave ? 'yes' : 'no')) === 'yes'
	};
}

function syncPiFields(values: PiProviderFormValues, fields: readonly FormField[]) {
	return fields.map(field => {
		if (field.type !== 'readonly' || field.id !== 'models') return field;
		return {...field, value: values.models};
	});
}

function buildPiFormText(values: PiProviderFormValues): string {
	return `${JSON.stringify(
		{
			provider: values.provider,
			api: values.api,
			model: values.model,
			models: values.models,
			baseUrl: values.baseUrl,
			apiKey: values.apiKey ? '***' : ''
		},
		null,
		2
	)}\n`;
}

function parsePiFormText(
	baseValues: PiProviderFormValues,
	raw: string
): {ok: true; values: PiProviderFormValues} | {ok: false; error: string} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {ok: false, error: `JSON 格式错误: ${error instanceof Error ? error.message : String(error)}`};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {ok: false, error: 'JSON 必须是对象'};
	const value = parsed as Record<string, unknown>;
	const apiKey = typeof value.apiKey === 'string' && value.apiKey !== '***' ? value.apiKey : baseValues.apiKey;
	return {
		ok: true,
		values: {
			...baseValues,
			api: typeof value.api === 'string' ? value.api : baseValues.api,
			provider: typeof value.provider === 'string' ? value.provider : baseValues.provider,
			model: typeof value.model === 'string' ? value.model : baseValues.model,
			models: typeof value.models === 'string' ? value.models : baseValues.models,
			baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : baseValues.baseUrl,
			apiKey
		}
	};
}

export const piProviderFormAdapter: ProviderFormAdapter<PiProviderFormInput, PiProviderFormValues, PiProviderFormModel> = {
	textLabel: 'Pi Provider 字段',
	showTextEditor: false,
	title: model => (model.mode === 'edit' ? '编辑 Pi Provider' : '添加 Pi Provider'),
	savedMessage: (model, values) =>
		`${values.provider} 已${model.mode === 'edit' ? '更新' : '添加'}（${values.models.split(/[\n,]/u).filter(Boolean).length} 个模型）${
			model.mode === 'add' && values.activateAfterSave ? '，并已激活' : ''
		}`,
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
