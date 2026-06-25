import React, { useState, useEffect, useRef } from 'react';
import { FormPanel, firstEditableIndex, nextEditableIndex } from '../components/form/FormPanel.js';
import { parseEntries, serializeEntries } from '../components/form/KeyValueField.js';
import type { FormField } from '../components/form/field-types.js';
import type { ProviderFormInput, ProviderFormModel, ProviderFormValues } from '../core/provider-form.js';
import type { ProviderServiceResult } from '../services/provider-service.js';

/** 从字段列表派生初始实时值（key-value 序列化为单行 K=V 文本）。 */
function deriveValues(fields: readonly FormField[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const field of fields) {
		result[field.id] = field.type === 'key-value' ? serializeEntries(field.entries) : field.value;
	}

	return result;
}

export type ProviderFormProps = {
	readonly model: ProviderFormModel;
	readonly active: boolean;
	readonly onCancel: () => void;
	readonly onSaved: (message: string) => void;
	readonly buildForm: (input: ProviderFormInput) => ProviderFormModel;
	readonly save: (input: ProviderFormInput, values: ProviderFormValues) => ProviderServiceResult<unknown>;
	readonly validate: (values: ProviderFormValues) => string[];
};

/**
 * ProviderForm：供应商表单屏（add/edit 统一复用）
 * - providerType select 切换时调 buildForm 重算字段（模板覆盖）
 * - Enter 保存：validate → save，成功调 onSaved，失败显示错误（不退出）
 * - Esc 取消返回列表
 */
export function ProviderForm({ model, active, onCancel, onSaved, buildForm, save, validate }: ProviderFormProps) {
	// 字段 + 实时值 + 焦点索引，初始化从 model 填充。
	const [fields, setFields] = useState(model.fields);
	const [values, setValues] = useState<Record<string, string>>(() => deriveValues(model.fields));
	const [focusedIndex, setFocusedIndex] = useState(() => firstEditableIndex(model.fields));
	const [errors, setErrors] = useState<string[]>([]);

	// 记录上次的 providerType，用于检测用户切换（add 模式特有）。
	const lastProviderType = useRef<string | undefined>(model.values.providerType);

	// providerType select 切换时，重调 buildForm 重算字段（覆盖为该类型模板）。
	useEffect(() => {
		if (model.mode === 'edit') {
			return; // edit 模式无 providerType 字段，不监听。
		}

		const providerTypeValue = values['providerType'];
		if (!providerTypeValue || providerTypeValue === lastProviderType.current) {
			return; // 未变化，避免循环。
		}

		lastProviderType.current = providerTypeValue;

		// 重建表单：用新类型模板覆盖字段。
		const nextInput: ProviderFormInput = {
			mode: providerTypeValue === 'custom' ? 'add-custom' : 'add-builtin',
			builtinKey: providerTypeValue === 'custom' ? undefined : providerTypeValue,
			profileKey: undefined,
			profile: null
		};
		const nextModel = buildForm(nextInput);
		const nextValues = deriveValues(nextModel.fields);

		// 强制把 providerType 选回用户刚选的值（buildForm 默认可能回退到首个内置）。
		nextValues['providerType'] = providerTypeValue;

		// 保留用户已填的 apiKey（不被模板覆盖清空）。
		if (values['apiKey']) {
			nextValues['apiKey'] = values['apiKey'];
		}

		setFields(nextModel.fields);
		setValues(nextValues);
		setFocusedIndex(firstEditableIndex(nextModel.fields));
		setErrors([]);
	}, [values, model, buildForm]);

	const handleMoveFocus = (direction: 1 | -1) => {
		const next = nextEditableIndex(fields, focusedIndex, direction);
		setFocusedIndex(next);
	};

	const handleFieldChange = (id: string, value: string) => {
		setValues((prev) => ({ ...prev, [id]: value }));
		setErrors([]); // 清除错误，用户正在修正。
	};

	const handleSubmit = () => {
		// 构建 ProviderFormValues：key-value 字段反序列化为 extraEnv 对象。
		const formValues: ProviderFormValues = {
			profileKey: values['profileKey'] ?? '',
			baseUrl: values['baseUrl'] ?? '',
			apiKey: values['apiKey'] ?? '',
			modelEnv: {
				ANTHROPIC_DEFAULT_HAIKU_MODEL: values['ANTHROPIC_DEFAULT_HAIKU_MODEL'] ?? '',
				ANTHROPIC_DEFAULT_OPUS_MODEL: values['ANTHROPIC_DEFAULT_OPUS_MODEL'] ?? '',
				ANTHROPIC_DEFAULT_SONNET_MODEL: values['ANTHROPIC_DEFAULT_SONNET_MODEL'] ?? ''
			},
			extraEnv: {},
			activateAfterSave: values['activateAfterSave'] === 'yes',
			providerType: values['providerType']
		};

		// extraEnv：解析 key-value 文本为对象。
		const extraEnvText = values['extraEnv'] ?? '';
		const entries = parseEntries(extraEnvText);
		for (const entry of entries) {
			formValues.extraEnv[entry.key] = entry.value;
		}

		// 校验。
		const validationErrors = validate(formValues);
		if (validationErrors.length > 0) {
			setErrors(validationErrors);
			return;
		}

		// 保存。
		const input: ProviderFormInput = {
			mode: model.mode,
			builtinKey: model.mode === 'add-builtin' ? values['providerType'] : undefined,
			profileKey: model.mode === 'edit' ? values['profileKey'] : undefined,
			profile: null
		};

		const result = save(input, formValues);
		if (!result.ok) {
			setErrors([result.error]);
			return;
		}

		// 成功。
		const message =
			model.mode === 'edit'
				? `供应商 ${formValues.profileKey} 已更新`
				: `供应商 ${formValues.profileKey} 已添加${formValues.activateAfterSave ? '并激活' : ''}`;
		onSaved(message);
	};

	const title = model.mode === 'edit' ? '编辑供应商' : '添加供应商';

	return (
		<FormPanel
			title={title}
			fields={fields}
			values={values}
			focusedIndex={focusedIndex}
			active={active}
			errors={errors}
			onMoveFocus={handleMoveFocus}
			onFieldChange={handleFieldChange}
			onSubmit={handleSubmit}
			onCancel={onCancel}
		/>
	);
}
