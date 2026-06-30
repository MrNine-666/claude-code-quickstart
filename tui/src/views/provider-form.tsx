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

const JSON_FIELD_ID = 'provider-form-json';

export type ProviderFormProps = {
	readonly model: ProviderFormModel;
	readonly active: boolean;
	readonly contentHeight?: number;
	readonly onCancel: () => void;
	readonly onSaved: (message: string) => void;
	readonly buildForm: (input: ProviderFormInput) => ProviderFormModel;
	readonly save: (input: ProviderFormInput, values: ProviderFormValues) => ProviderServiceResult<unknown>;
	readonly validate: (values: ProviderFormValues) => string[];
};

/**
 * ProviderForm：供应商表单屏（add/edit 统一复用）
 * - 字段区用 ↑/↓ 移动焦点，radio/select 用 ←/→ 或 Tab 切选项
 * - JSON textarea：中间行 ↑/↓ 换行，第一行 ↑ / 最后行 ↓ 切字段，Tab 缩进（2 空格）
 * - 保存以 JSON 解析后的值为真源
 */
export function ProviderForm({ model, active, contentHeight = 16, onCancel, onSaved, buildForm, save, validate }: ProviderFormProps) {
	const [fields, setFields] = useState(model.fields);
	const [values, setValues] = useState<Record<string, string>>(() => deriveValues(model.fields));
	const [focusedIndex, setFocusedIndex] = useState(() => firstEditableIndex(model.fields));
	const [errors, setErrors] = useState<string[]>([]);
	const [baseValues, setBaseValues] = useState<ProviderFormValues>(model.values);
	const [jsonText, setJsonText] = useState(() => buildProviderProfileJson(model.values));
	const textareaRef = useRef<TextareaRenderable>(null);
	const renderer = useRenderer();
	const scrollRef = useRef<ScrollBoxRenderable>(null);
	const lastProviderType = useRef<string | undefined>(model.values.providerType);
	// 记录程序化 setText 的目标文本，避免 onContentChange 回声反向同步。
	const pendingTextareaSync = useRef<string | null>(null);

	const jsonFocused = focusedIndex === fields.length;
	const fieldFocused = !jsonFocused;
	const focusedFieldId = jsonFocused ? JSON_FIELD_ID : `form-field-${focusedIndex}-${fields[focusedIndex]?.id ?? 'unknown'}`;

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
		if (currentText === jsonText) {
			pendingTextareaSync.current = null;
			return;
		}

		// 字段变化推送新 JSON 到 textarea：setText 会重置 buffer，适合程序化覆盖。
		// OpenTUI textarea 的 initialValue 只适合首次初始化，后续赋值不会替换已有编辑内容。
		pendingTextareaSync.current = jsonText;
		textareaRef.current.setText(jsonText);
	}, [jsonText]);

	useEffect(() => {
		if (model.mode === 'edit') {
			return;
		}

		const providerTypeValue = values.providerType;
		if (!providerTypeValue || providerTypeValue === lastProviderType.current) {
			return;
		}

		lastProviderType.current = providerTypeValue;

		const nextInput: ProviderFormInput = {
			mode: providerTypeValue === 'custom' ? 'add-custom' : 'add-builtin',
			builtinKey: providerTypeValue === 'custom' ? undefined : providerTypeValue,
			profileKey: undefined,
			profile: null
		};
		const nextModel = buildForm(nextInput);
		const nextRecord = deriveValues(nextModel.fields);
		nextRecord.providerType = providerTypeValue;

		if (values.apiKey) {
			nextRecord.apiKey = values.apiKey;
		}

		const nextBase = recordToValues(nextRecord, nextModel.values);
		setFields(nextModel.fields);
		setValues(nextRecord);
		setBaseValues(nextBase);
		setJsonText(buildProviderProfileJson(nextBase));
		setFocusedIndex(firstEditableIndex(nextModel.fields));
		setErrors([]);
	}, [values.providerType, model.mode, buildForm]);

	const handleMoveFocus = (direction: 1 | -1) => {
		setFocusedIndex((current) => {
			if (current === fields.length) {
				// textarea（虚拟 fields.length）按 ↑ 应切到紧邻的上一真实字段（末位可编辑）：
				// 从 fields.length 起算（越界 → nextEditableIndex 返回末位）；用 fields.length-1 会再往回跳过末字段。
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
		const nextFormValues = recordToValues(nextRecord, baseValues);
		setBaseValues(nextFormValues);
		setJsonText(buildProviderProfileJson(nextFormValues));
		setErrors([]);
	};

	const handleJsonChange = (content: string) => {
		if (pendingTextareaSync.current === content) {
			pendingTextareaSync.current = null;
			return;
		}

		setJsonText(content);
		const parsed = valuesFromProviderProfileJson(baseValues, content);
		if (!parsed.ok) {
			setErrors([parsed.error]);
			return;
		}

		setErrors([]);
		setBaseValues(parsed.values);
		setValues((prev) => ({...prev, ...valuesToRecord(parsed.values)}));
	};

	// JSON textarea 键位（onKeyDown，handleKeyPress 之前）：Tab 缩进 + 边界 ↑/↓ 切字段。
	// onKeyDown 仅在 textarea focused（active && jsonFocused）时触发，无需再判 active/jsonFocused。
	const handleTextareaKey = (keyEvent: KeyEvent) => {
		// Tab = 2 空格缩进 / Shift+Tab = 反向缩进（preventDefault 阻止 textarea 默认）。
		if (handleTextareaIndentKey(keyEvent, textareaRef.current)) {
			return;
		}

		// 边界导航：第一行按 ↑ 切上一字段，最后行按 ↓ 切下一字段；中间行放行让 textarea 换行。
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
		if (!active || !jsonFocused) {
			return;
		}

		// Ctrl/Cmd+S 保存 · Ctrl+Z 撤销 · Ctrl+Shift+Z/Y 重做 · Ctrl/Cmd+C 复制选中（OSC52）。
		// undo/redo 后主动重新解析 JSON 刷新错误（OpenTUI undo 走 FFI 不触发 onContentChange）。
		if (handleTextareaEditKeys(
			keyEvent,
			textareaRef.current,
			renderer,
			handleSubmit,
			() => handleJsonChange(textareaRef.current?.plainText ?? jsonText)
		)) {
			return;
		}

		// textarea 的 Tab/方向键已由上方 onKeyDown 直接处置；这里只兜底 Esc 取消整个表单。
		if (keyEvent.name.toLowerCase() === 'escape') {
			onCancel();
		}
	});

	const handleSubmit = () => {
		const parsed = valuesFromProviderProfileJson(baseValues, jsonText);
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

		const input: ProviderFormInput = {
			mode: model.mode,
			builtinKey: model.mode === 'add-builtin' ? values.providerType : undefined,
			profileKey: model.mode === 'edit' ? values.profileKey : undefined,
			profile: null
		};

		const result = save(input, formValues);
		if (!result.ok) {
			setErrors([result.error]);
			return;
		}

		const message =
			model.mode === 'edit'
				? `供应商 ${formValues.profileKey} 已更新`
				: `供应商 ${formValues.profileKey} 已添加${formValues.activateAfterSave ? '并激活' : ''}`;
		onSaved(message);
	};

	const title = model.mode === 'edit' ? '编辑供应商' : '添加供应商';
	const scrollHeight = Math.max(8, contentHeight - (errors.length > 0 ? 2 : 0));
	const jsonHeight = Math.max(8, Math.floor(contentHeight * 0.45));

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
					<text fg={jsonFocused ? colors.primary : colors.text} attributes={jsonFocused ? TextAttributes.BOLD : 0}>
						{jsonFocused ? '› ' : '  '}最终 JSON（可编辑 env）
					</text>
					<box height={jsonHeight} borderStyle="rounded" borderColor={jsonFocused ? borderColors.active : borderColors.inactive}>
						<textarea
							ref={textareaRef}
							initialValue={jsonText}
							focused={active && jsonFocused}
							wrapMode="word"
							style={{flexGrow: 1}}
							textColor={colors.inputText}
							focusedTextColor={colors.inputFocusedText}
							cursorColor={colors.inputCursor}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
							onKeyDown={handleTextareaKey}
							onContentChange={() => handleJsonChange(textareaRef.current?.plainText ?? jsonText)}
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
