import type {ReactNode} from 'react';
import {TextAttributes, type KeyEvent} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import {colors} from '../../theme/index.js';
import {isEditingModifier} from '../../utils/keyboard.js';
import {ErrorPanel} from '../error-panel.js';
import {TextField} from './TextField.js';
import {ModelSelectField} from './ModelSelectField.js';
import {SelectField} from './SelectField.js';
import {RadioField} from './RadioField.js';
import {KeyValueField, serializeEntries} from './KeyValueField.js';
import {FormLabel, FORM_VALUE_MARGIN_LEFT} from './FormLabel.js';
import type {FormField} from './field-types.js';

// 通用表单容器（Provider / MCP 复用）：
// - ↑/↓ 切换可编辑字段（跳过 readonly/disabled，循环）
// - radio/select 字段用 ←/→ 或 Tab/Shift+Tab 切换选项（上下键已让给字段切换）
// - 保存按编辑语义：macOS Cmd+S，其他平台 Ctrl+S；Esc 取消
// - 纯展示 + 回调：字段联动由父组件处理
// - 输出纯字段流，由外层统一滚动（provider-form / McpFormView 各自的 scrollbox 承载）。

export type FormPanelProps = {
	readonly title: string;
	readonly fields: readonly FormField[];
	// 各字段实时值，键为 field.id（key-value 字段值为序列化后的 K=V 文本）。
	readonly values: Record<string, string>;
	readonly focusedIndex: number;
	readonly active: boolean;
	readonly errors?: readonly string[];
	readonly onMoveFocus: (direction: 1 | -1) => void;
	readonly onSelectChange: (id: string, direction: 1 | -1) => void;
	readonly onFieldChange: (id: string, value: string) => void;
	readonly onSubmit: () => void;
	readonly onCancel: () => void;
	/** Page-owned app shortcut hook; runs before generic form modifier handling. */
	readonly onKeyEvent?: (keyEvent: KeyEvent) => boolean;
	/** State and callbacks for model-select fields. */
	readonly modelSelect?: {
		readonly fieldIds: readonly string[];
		readonly openFieldId: string | null;
		readonly loading: boolean;
		readonly candidates: readonly string[];
		readonly cursor: number;
		readonly onChange: (id: string, value: string) => void;
		readonly onSubmit: (id: string) => void;
		readonly onFocus?: (id: string) => void;
		readonly onKeyDown?: (id: string, keyEvent: KeyEvent) => boolean;
	};
	/** Optional page-owned custom content rendered in the same vertical field flow. */
	readonly custom?: ReactNode;
};

/** 字段是否可编辑（readonly / disabled 不可聚焦）。 */
export function isEditableField(field: FormField): boolean {
	return field.type !== 'readonly' && !field.disabled;
}

/** 下一个可编辑字段索引（↑/↓ 跳过 readonly，循环移动）。 */
export function nextEditableIndex(fields: readonly FormField[], from: number, direction: 1 | -1): number {
	const editableIndexes = fields
		.map((field, index) => ({field, index}))
		.filter(({field}) => isEditableField(field))
		.map(({index}) => index);
	if (editableIndexes.length === 0) {
		return 0;
	}

	const currentPosition = editableIndexes.indexOf(from);
	if (currentPosition < 0) {
		return direction > 0 ? editableIndexes[0]! : editableIndexes[editableIndexes.length - 1]!;
	}

	const nextPosition = (currentPosition + direction + editableIndexes.length) % editableIndexes.length;
	return editableIndexes[nextPosition]!;
}

/** 首个可编辑字段索引（表单初始聚焦）。 */
export function firstEditableIndex(fields: readonly FormField[]): number {
	const index = fields.findIndex(isEditableField);
	return index >= 0 ? index : 0;
}

function fieldNodeId(field: FormField, index: number): string {
	return `form-field-${index}-${field.id}`;
}

export function FormPanel({
	title,
	fields,
	values,
	focusedIndex,
	active,
	errors,
	onMoveFocus,
	onSelectChange,
	onFieldChange,
	onSubmit,
	onCancel,
	onKeyEvent,
	modelSelect,
	custom
}: FormPanelProps) {
	useKeyboard(keyEvent => {
		if (!active) {
			return;
		}

		const name = keyEvent.name.toLowerCase();
		if (onKeyEvent?.(keyEvent)) {
			return;
		}

		// 保存按编辑语义处理：macOS Cmd+S，其他平台 Ctrl+S。
		if (name === 's' && isEditingModifier(keyEvent)) {
			onSubmit();
			return;
		}

		// 放行其余 Ctrl/Meta/Super 组合（粘贴、终端快捷键等），交由底层 input/textarea 或终端处理。
		// meta 是 Alt/Option，super 才是 macOS Cmd，这里一并放行避免误捕。
		if (keyEvent.ctrl || keyEvent.meta || keyEvent.super) {
			return;
		}

		if (name === 'escape') {
			onCancel();
			return;
		}

		const field = fields[focusedIndex];

		// 字段间切换：↑/↓（跳过 readonly/disabled，循环移动）。
		if (name === 'up' || name === 'arrowup') {
			onMoveFocus(-1);
			return;
		}

		if (name === 'down' || name === 'arrowdown') {
			onMoveFocus(1);
			return;
		}

		// radio/select 选项切换：←/→ 与 Tab/Shift+Tab（上下键已让给字段切换）。
		if (field?.type === 'select' || field?.type === 'radio') {
			const prev = name === 'left' || name === 'arrowleft' || name === 'shift-tab' || (name === 'tab' && keyEvent.shift);
			const next = name === 'right' || name === 'arrowright' || (name === 'tab' && !keyEvent.shift);
			if (prev) {
				onSelectChange(field.id, -1);
				return;
			}

			if (next) {
				onSelectChange(field.id, 1);
				return;
			}
		}

		// 保存由编辑语义快捷键触发；Enter 不再触发保存（textarea 字段 Enter 维持换行默认行为）。
	});

	const fieldNodes = fields.map((field, index) => {
		const focused = index === focusedIndex;
		const live = values[field.id] ?? '';
		let node: ReactNode;

		if (field.type === 'readonly') {
			node = (
				<box flexDirection="column">
					<box flexDirection="row" alignItems="flex-start">
						<FormLabel label={field.label} focused={focused} />
						<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
							{live || field.value || '（空）'}
						</text>
					</box>
					{field.helpText ? (
						<box marginLeft={FORM_VALUE_MARGIN_LEFT}>
							<text
								fg={colors.muted}
								attributes={TextAttributes.DIM}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
							>
								{field.helpText}
							</text>
						</box>
					) : null}
				</box>
			);
		} else if (field.type === 'radio') {
			node = (
				<RadioField
					label={field.label}
					value={live || field.value}
					options={field.options}
					helpText={field.helpText}
					focused={focused}
				/>
			);
		} else if (field.type === 'select') {
			node = (
				<SelectField
					label={field.label}
					value={live || field.value}
					options={field.options}
					helpText={field.helpText}
					focused={focused}
					onChange={value => onFieldChange(field.id, value)}
				/>
			);
		} else if (field.type === 'model-select') {
			const modelState = modelSelect?.fieldIds.includes(field.id) ? modelSelect : undefined;
			node = (
				<ModelSelectField
					label={field.label}
					value={live}
					helpText={field.helpText}
					focused={focused}
					active={active}
					open={modelState?.openFieldId === field.id}
					loading={modelState?.loading ?? false}
					candidates={modelState?.candidates ?? []}
					cursor={modelState?.cursor ?? 0}
					onChange={value => {
						if (modelState) modelState.onChange(field.id, value);
						else onFieldChange(field.id, value);
					}}
					onSubmit={() => {
						if (modelState) modelState.onSubmit(field.id);
					}}
					onFocus={modelState ? () => modelState.onFocus?.(field.id) : undefined}
					onKeyDown={
						modelState?.openFieldId === field.id && modelState.onKeyDown
							? keyEvent => modelState.onKeyDown?.(field.id, keyEvent) ?? false
							: undefined
					}
				/>
			);
		} else if (field.type === 'key-value') {
			node = (
				<KeyValueField
					label={field.label}
					entries={field.entries}
					text={live || serializeEntries(field.entries)}
					helpText={field.helpText}
					focused={focused}
					active={active}
					onChange={text => onFieldChange(field.id, text)}
				/>
			);
		} else {
			node = (
				<TextField
					label={field.label}
					value={live}
					secret={field.type === 'secret'}
					helpText={field.helpText}
					focused={focused}
					active={active}
					onChange={value => onFieldChange(field.id, value)}
					onKeyDown={
						onKeyEvent
							? keyEvent => {
									if (onKeyEvent(keyEvent)) keyEvent.preventDefault();
								}
							: undefined
					}
				/>
			);
		}

		return (
			<box key={`${index}-${field.id}`} id={fieldNodeId(field, index)} flexDirection="column" flexShrink={0} marginBottom={1}>
				{node}
			</box>
		);
	});

	return (
		<box flexDirection="column">
			<box marginBottom={1}>
				<text
					fg={colors.primary}
					attributes={TextAttributes.BOLD}
					selectionBg={colors.selectionBg}
					selectionFg={colors.selectionFg}
				>
					{title}
				</text>
			</box>

			<box flexDirection="column">
				{fieldNodes}
				{custom}
			</box>

			{errors && errors.length > 0 ? (
				<box marginTop={1}>
					<ErrorPanel message={errors.join('；')} />
				</box>
			) : null}
		</box>
	);
}
