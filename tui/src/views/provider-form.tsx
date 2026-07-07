import React, { useEffect, useRef, useState } from 'react';
import { TextAttributes, type KeyEvent, type ScrollBoxRenderable, type TextareaRenderable } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/react';
import { FormPanel, firstEditableIndex, nextEditableIndex } from '../components/form/FormPanel.js';
import { handleTextareaEditKeys, handleTextareaIndentKey } from '../components/editor/textarea-edit-keys.js';
import type { FormField } from '../components/form/field-types.js';
import {
	buildProviderProfileJson,
	valuesFromProviderProfileJson,
	type ProviderFormInput,
	type ProviderFormModel,
	type ProviderFormValues
} from '../core/provider-form.js';
import type { ProviderServiceResult } from '../services/provider-service.js';
import { borderColors, colors } from '../theme/index.js';

/** 从字段列表派生初始实时值。 */
function deriveValues(fields: readonly FormField[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const field of fields) {
		if (field.type === 'key-value') {
			result[field.id] = field.entries.map((entry) => `${entry.key}=${entry.value}`).join(',');
		} else {
			result[field.id] = field.value;
		}
	}

	return result;
}

type FormModelBase<TValues> = {
	readonly mode: string;
	readonly fields: readonly FormField[];
	readonly values: TValues;
};

export type ProviderFormTextResult<TValues> =
	| {readonly ok: true; readonly values: TValues}
	| {readonly ok: false; readonly error: string};

export type ProviderFormAdapter<TInput, TValues, TModel extends FormModelBase<TValues>> = {
	readonly textLabel: string;
	readonly title: (model: TModel) => string;
	readonly savedMessage: (model: TModel, values: TValues) => string;
	readonly valuesToRecord: (values: TValues) => Record<string, string>;
	readonly recordToValues: (record: Record<string, string>, fallback: TValues) => TValues;
	readonly buildText: (values: TValues) => string;
	readonly parseText: (baseValues: TValues, raw: string) => ProviderFormTextResult<TValues>;
	readonly makeProviderTypeInput: (providerType: string) => TInput;
	readonly makeSubmitInput: (model: TModel, record: Record<string, string>) => TInput;
};

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
		extraEnv: fallback.extraEnv,
		activateAfterSave: (record.activateAfterSave ?? 'yes') === 'yes',
		providerType: record.providerType || fallback.providerType
	};
}

const JSON_FIELD_ID = 'provider-form-textarea';

const claudeProviderFormAdapter: ProviderFormAdapter<ProviderFormInput, ProviderFormValues, FormModelBase<ProviderFormValues> & ProviderFormModel> = {
	textLabel: '最终 JSON（可编辑 env）',
	title: (model) => model.mode === 'edit' ? '编辑供应商' : '添加供应商',
	savedMessage: (model, values) =>
		model.mode === 'edit'
			? `供应商 ${values.profileKey} 已更新`
			: `供应商 ${values.profileKey} 已添加${values.activateAfterSave ? '并激活' : ''}`,
	valuesToRecord,
	recordToValues,
	buildText: buildProviderProfileJson,
	parseText: valuesFromProviderProfileJson,
	makeProviderTypeInput: (providerType) => ({
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

export type ProviderFormProps<TInput = ProviderFormInput, TValues = ProviderFormValues, TModel extends FormModelBase<TValues> = FormModelBase<TValues>> = {
	readonly model: TModel;
	readonly active: boolean;
	readonly contentHeight?: number;
	readonly onCancel: () => void;
	readonly onSaved: (message: string) => void;
	readonly buildForm: (input: TInput) => TModel;
	readonly save: (input: TInput, values: TValues) => ProviderServiceResult<unknown>;
	readonly validate: (values: TValues) => string[];
	readonly adapter?: ProviderFormAdapter<TInput, TValues, TModel>;
};

/**
 * ProviderForm：供应商表单屏（add/edit 统一复用）
 * - 字段区用 ↑/↓ 移动焦点，radio/select 用 ←/→ 或 Tab 切选项
 * - textarea：中间行 ↑/↓ 换行，第一行 ↑ / 最后行 ↓ 切字段，Tab 缩进（2 空格）
 * - Claude 使用 settings-compatible JSON；Codex 通过 adapter 使用真实 profile TOML
 */
export function ProviderForm<TInput = ProviderFormInput, TValues = ProviderFormValues, TModel extends FormModelBase<TValues> = FormModelBase<TValues>>({
	model,
	active,
	contentHeight = 16,
	onCancel,
	onSaved,
	buildForm,
	save,
	validate,
	adapter
}: ProviderFormProps<TInput, TValues, TModel>) {
	const formAdapter = adapter ?? (claudeProviderFormAdapter as unknown as ProviderFormAdapter<TInput, TValues, TModel>);
	const [fields, setFields] = useState(model.fields);
	const [values, setValues] = useState<Record<string, string>>(() => deriveValues(model.fields));
	const [focusedIndex, setFocusedIndex] = useState(() => firstEditableIndex(model.fields));
	const [errors, setErrors] = useState<string[]>([]);
	const [baseValues, setBaseValues] = useState<TValues>(model.values);
	const [text, setText] = useState(() => formAdapter.buildText(model.values));
	const textareaRef = useRef<TextareaRenderable>(null);
	const renderer = useRenderer();
	const scrollRef = useRef<ScrollBoxRenderable>(null);
	const lastProviderType = useRef<string | undefined>((model.values as {providerType?: string}).providerType);
	// 记录程序化 setText 的目标文本，避免 onContentChange 回声反向同步。
	const pendingTextareaSync = useRef<string | null>(null);

	const textFocused = focusedIndex === fields.length;
	const fieldFocused = !textFocused;
	const focusedFieldId = textFocused ? JSON_FIELD_ID : `form-field-${focusedIndex}-${fields[focusedIndex]?.id ?? 'unknown'}`;

	useEffect(() => {
		if (!scrollRef.current) {
			return;
		}

		scrollRef.current.scrollChildIntoView(focusedFieldId);
	}, [focusedFieldId]);

	useEffect(() => {
		if (!textareaRef.current) {
			return;
		}

		const currentText = textareaRef.current.plainText;
		if (currentText === text) {
			pendingTextareaSync.current = null;
			return;
		}

		// 字段变化推送新文本到 textarea：setText 会重置 buffer，适合程序化覆盖。
		// OpenTUI textarea 的 initialValue 只适合首次初始化，后续赋值不会替换已有编辑内容。
		pendingTextareaSync.current = text;
		textareaRef.current.setText(text);
	}, [text]);

	useEffect(() => {
		if (model.mode === 'edit') {
			return;
		}

		const providerTypeValue = values.providerType;
		if (!providerTypeValue || providerTypeValue === lastProviderType.current) {
			return;
		}

		lastProviderType.current = providerTypeValue;

		const nextModel = buildForm(formAdapter.makeProviderTypeInput(providerTypeValue));
		const nextRecord = deriveValues(nextModel.fields);
		nextRecord.providerType = providerTypeValue;

		if (values.apiKey) {
			nextRecord.apiKey = values.apiKey;
		}

		const nextBase = formAdapter.recordToValues(nextRecord, nextModel.values);
		setFields(nextModel.fields);
		setValues(nextRecord);
		setBaseValues(nextBase);
		setText(formAdapter.buildText(nextBase));
		setFocusedIndex(firstEditableIndex(nextModel.fields));
		setErrors([]);
	}, [values.providerType, model.mode, buildForm, formAdapter]);

	const handleMoveFocus = (direction: 1 | -1) => {
		setFocusedIndex((current) => {
			if (current === fields.length) {
				// textarea（虚拟 fields.length）按 ↑ 应切到紧邻的上一真实字段（末位可编辑）。
				return direction > 0 ? firstEditableIndex(fields) : nextEditableIndex(fields, fields.length, -1);
			}

			const next = nextEditableIndex(fields, current, direction);
			if (direction > 0 && next <= current) {
				return fields.length;
			}

			if (direction < 0 && next >= current) {
				return fields.length;
			}

			return next;
		});
	};

	const handleSelectChange = (id: string, direction: 1 | -1) => {
		const field = fields.find((item) => item.id === id && (item.type === 'select' || item.type === 'radio'));
		if (!field || (field.type !== 'select' && field.type !== 'radio')) {
			return;
		}

		const currentValue = values[id] ?? field.value;
		const currentIndex = Math.max(0, field.options.findIndex((option) => option.value === currentValue));
		const nextIndex = (currentIndex + direction + field.options.length) % field.options.length;
		const nextOption = field.options[nextIndex];
		if (nextOption) {
			handleFieldChange(id, nextOption.value);
		}
	};

	const handleFieldChange = (id: string, value: string) => {
		const nextRecord = {...values, [id]: value};
		setValues(nextRecord);
		const nextFormValues = formAdapter.recordToValues(nextRecord, baseValues);
		setBaseValues(nextFormValues);
		setText(formAdapter.buildText(nextFormValues));
		setErrors([]);
	};

	const handleTextChange = (content: string) => {
		if (pendingTextareaSync.current === content) {
			pendingTextareaSync.current = null;
			return;
		}

		setText(content);
		const parsed = formAdapter.parseText(baseValues, content);
		if (!parsed.ok) {
			setErrors([parsed.error]);
			return;
		}

		setErrors([]);
		setBaseValues(parsed.values);
		setValues((prev) => ({...prev, ...formAdapter.valuesToRecord(parsed.values)}));
	};

	// textarea 键位（onKeyDown，handleKeyPress 之前）：Tab 缩进 + 边界 ↑/↓ 切字段。
	// onKeyDown 仅在 textarea focused（active && textFocused）时触发，无需再判 active/textFocused。
	const handleTextareaKey = (keyEvent: KeyEvent) => {
		if (handleTextareaIndentKey(keyEvent, textareaRef.current)) {
			return;
		}

		const ta = textareaRef.current;
		if (!ta) {
			return;
		}

		const name = keyEvent.name.toLowerCase();
		const line = ta.logicalCursor?.row ?? 0;
		const last = Math.max(0, (ta.lineCount ?? 1) - 1);
		if ((name === 'up' || name === 'arrowup') && line <= 0) {
			keyEvent.preventDefault();
			handleMoveFocus(-1);
			return;
		}
		if ((name === 'down' || name === 'arrowdown') && line >= last) {
			keyEvent.preventDefault();
			handleMoveFocus(1);
		}
	};

	useKeyboard((keyEvent) => {
		if (!active || !textFocused) {
			return;
		}

		// 保存按编辑语义触发 · Ctrl+Z 撤销 · Ctrl+Shift+Z/Y 重做 · 复制按编辑语义触发选中（OSC52）。
		// undo/redo 后主动重新解析文本刷新错误（OpenTUI undo 走 FFI 不触发 onContentChange）。
		if (handleTextareaEditKeys(
			keyEvent,
			textareaRef.current,
			renderer,
			handleSubmit,
			() => handleTextChange(textareaRef.current?.plainText ?? text)
		)) {
			return;
		}

		// textarea 的 Tab/方向键已由上方 onKeyDown 直接处置；这里只兜底 Esc 取消整个表单。
		if (keyEvent.name.toLowerCase() === 'escape') {
			onCancel();
		}
	});

	const handleSubmit = () => {
		const parsed = formAdapter.parseText(baseValues, text);
		if (!parsed.ok) {
			setErrors([parsed.error]);
			return;
		}

		const formValues = parsed.values;
		const validationErrors = validate(formValues);
		if (validationErrors.length > 0) {
			setErrors(validationErrors);
			return;
		}

		const input = formAdapter.makeSubmitInput(model, values);
		const result = save(input, formValues);
		if (!result.ok) {
			setErrors([result.error]);
			return;
		}

		onSaved(formAdapter.savedMessage(model, formValues));
	};

	const title = formAdapter.title(model);
	const scrollHeight = Math.max(8, contentHeight - (errors.length > 0 ? 2 : 0));
	const textHeight = Math.max(8, Math.floor(contentHeight * 0.45));

	return (
		<box flexDirection="column">
			<scrollbox
				ref={scrollRef}
				height={scrollHeight}
				width="100%"
				viewportCulling
				scrollY
				scrollX={false}
				verticalScrollbarOptions={{showArrows: true}}
			>
				<FormPanel
					title={title}
					fields={fields}
					values={values}
					focusedIndex={fieldFocused ? focusedIndex : -1}
					active={active && fieldFocused}
					errors={undefined}
					onMoveFocus={handleMoveFocus}
					onSelectChange={handleSelectChange}
					onFieldChange={handleFieldChange}
					onSubmit={handleSubmit}
					onCancel={onCancel}
				/>

				<box id={JSON_FIELD_ID} marginTop={1} flexDirection="column" flexShrink={0}>
					<text fg={textFocused ? colors.primary : colors.text} attributes={textFocused ? TextAttributes.BOLD : 0}>
						{textFocused ? '› ' : '  '}{formAdapter.textLabel}
					</text>
					<box height={textHeight} borderStyle="rounded" borderColor={textFocused ? borderColors.active : borderColors.inactive}>
						<textarea
							ref={textareaRef}
							initialValue={text}
							focused={active && textFocused}
							wrapMode="word"
							style={{flexGrow: 1}}
							textColor={colors.inputText}
							focusedTextColor={colors.inputFocusedText}
							cursorColor={colors.inputCursor}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
							onKeyDown={handleTextareaKey}
							onContentChange={() => handleTextChange(textareaRef.current?.plainText ?? text)}
						/>
					</box>
				</box>
			</scrollbox>

			{errors.length > 0 ? (
				<box marginTop={1}>
					<text fg={colors.danger}>{errors.join('；')}</text>
				</box>
			) : null}
		</box>
	);
}
