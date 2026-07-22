import {
	buildProviderProfileJson,
	valuesFromProviderProfileJson,
	type ProviderFormInput,
	type ProviderFormModel,
	type ProviderFormValues
} from '../../core/provider-form.js';
import type {ProviderFormAdapter, ProviderFormModelBase} from '../../types/provider-form-adapter.js';

function valuesToRecord(values: ProviderFormValues): Record<string, string> {
	return {
		profileKey: values.profileKey,
		baseUrl: values.baseUrl,
		apiKey: values.apiKey,
		ANTHROPIC_DEFAULT_HAIKU_MODEL: values.modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
		ANTHROPIC_DEFAULT_OPUS_MODEL: values.modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
		ANTHROPIC_DEFAULT_SONNET_MODEL: values.modelEnv.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '',
		activateAfterSave: values.activateAfterSave ? 'yes' : 'no',
		providerType: values.providerType ?? ''
	};
}

function recordToValues(record: Record<string, string>, fallback: ProviderFormValues): ProviderFormValues {
	return {
		...fallback,
		profileKey: record.profileKey ?? '',
		baseUrl: record.baseUrl ?? '',
		apiKey: record.apiKey ?? '',
		modelEnv: {
			ANTHROPIC_DEFAULT_HAIKU_MODEL: record.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
			ANTHROPIC_DEFAULT_OPUS_MODEL: record.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
			ANTHROPIC_DEFAULT_SONNET_MODEL: record.ANTHROPIC_DEFAULT_SONNET_MODEL ?? ''
		},
		env: fallback.env,
		activateAfterSave: (record.activateAfterSave ?? 'yes') === 'yes',
		providerType: record.providerType || fallback.providerType
	};
}

export const claudeProviderFormAdapter: ProviderFormAdapter<
	ProviderFormInput,
	ProviderFormValues,
	ProviderFormModelBase<ProviderFormValues> & ProviderFormModel
> = {
	textLabel: '最终 JSON（可编辑 env）',
	title: model => (model.mode === 'edit' ? '编辑供应商' : '添加供应商'),
	savedMessage: (model, values) =>
		model.mode === 'edit'
			? `供应商 ${values.profileKey} 已更新`
			: `供应商 ${values.profileKey} 已添加${values.activateAfterSave ? '并激活' : ''}`,
	valuesToRecord,
	recordToValues,
	buildText: buildProviderProfileJson,
	parseText: valuesFromProviderProfileJson,
	makeProviderTypeInput: providerType => ({
		mode: providerType === 'custom' ? 'add-custom' : 'add-builtin',
		builtinKey: providerType === 'custom' ? undefined : providerType,
		profileKey: undefined,
		profile: null
	}),
	makeSubmitInput: (model, record) => ({
		mode: model.mode,
		builtinKey: model.mode === 'add-builtin' ? record.providerType : undefined,
		profileKey: model.mode === 'edit' ? record.profileKey : undefined,
		profile: null
	})
};
