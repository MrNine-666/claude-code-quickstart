import React from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { colors } from '../../theme/index.js';
import { ErrorPanel } from '../error-panel.js';
import { TextField } from './TextField.js';
import { SelectField } from './SelectField.js';
import { KeyValueField, serializeEntries } from './KeyValueField.js';
import type { FormField } from './field-types.js';

// 通用表单容器（Provider / MCP 复用）：
// - 字段垂直列表，↑/↓ 切换可编辑字段（跳过 readonly/disabled）
// - text/secret/key-value 行内编辑，select 交给 OpenTUI <tab-select> 处理 ←/→
// - Enter 统一保存（onSubmit），Esc 取消（onCancel）
// - 纯展示 + 回调：字段联动（如 select 切换重算字段）由父组件处理

export type FormPanelProps = {
	readonly title: string;
	readonly fields: readonly FormField[];
	// 各字段实时值，键为 field.id（key-value 字段值为序列化后的 K=V 文本）。
	readonly values: Record<string, string>;
	readonly focusedIndex: number;
	readonly active: boolean;
	readonly errors?: readonly string[];
	readonly onMoveFocus: (direction: 1 | -1) => void;
	readonly onFieldChange: (id: string, value: string) => void;
	readonly onSubmit: () => void;
	readonly onCancel: () => void;
};

/** 字段是否可编辑（readonly / disabled 不可聚焦）。 */
export function isEditableField(field: FormField): boolean {
	return field.type !== 'readonly' && !field.disabled;
}

/** 下一个可编辑字段索引（↑/↓ 跳过 readonly），无则停在原位。 */
export function nextEditableIndex(
	fields: readonly FormField[],
	from: number,
	direction: 1 | -1
): number {
	const length = fields.length;
	if (length === 0) {
		return 0;
	}

	for (let step = 1; step <= length; step++) {
		const candidate = from + direction * step;
		if (candidate < 0 || candidate >= length) {
			break;
		}

		if (isEditableField(fields[candidate]!)) {
			return candidate;
		}
	}

	return Math.min(Math.max(from, 0), length - 1);
}

/** 首个可编辑字段索引（表单初始聚焦）。 */
export function firstEditableIndex(fields: readonly FormField[]): number {
	const index = fields.findIndex(isEditableField);
	return index >= 0 ? index : 0;
}

export function FormPanel({
	title,
	fields,
	values,
	focusedIndex,
	active,
	errors,
	onMoveFocus,
	onFieldChange,
	onSubmit,
	onCancel
}: FormPanelProps) {
	useKeyboard((keyEvent) => {
		if (!active) {
			return;
		}

		const name = keyEvent.name;

		if (name === 'escape') {
			onCancel();
			return;
		}

		// ↑/↓ 切换字段焦点（跳过 readonly）。
		if (name === 'up' || name === 'arrowup') {
			onMoveFocus(-1);
			return;
		}

		if (name === 'down' || name === 'arrowdown') {
			onMoveFocus(1);
			return;
		}

		// Enter 统一保存。文本类字段的 <input> 不绑 onSubmit，避免双触发。
		if (name === 'return' || name === 'enter') {
			onSubmit();
		}
	});

	return (
		<box flexDirection="column">
			<box marginBottom={1}>
				<text fg={colors.primary} attributes={TextAttributes.BOLD}>
					{title}
				</text>
			</box>

			{fields.map((field, index) => {
				const focused = index === focusedIndex;
				const live = values[field.id] ?? '';

				if (field.type === 'readonly') {
					return (
						<box key={field.id} flexDirection="column" marginBottom={1}>
							<text fg="gray">{field.label}</text>
							<text fg={colors.muted}>{live || field.value}</text>
						</box>
					);
				}

				if (field.type === 'select') {
					return (
						<SelectField
							key={field.id}
							label={field.label}
							value={live || field.value}
							options={field.options}
							helpText={field.helpText}
							focused={focused}
							active={active}
							onChange={(value) => onFieldChange(field.id, value)}
						/>
					);
				}

				if (field.type === 'key-value') {
					return (
						<KeyValueField
							key={field.id}
							label={field.label}
							entries={field.entries}
							text={live || serializeEntries(field.entries)}
							helpText={field.helpText}
							focused={focused}
							active={active}
							onChange={(text) => onFieldChange(field.id, text)}
						/>
					);
				}

				// text / secret
				return (
					<TextField
						key={field.id}
						label={field.label}
						value={live}
						secret={field.type === 'secret'}
						helpText={field.helpText}
						focused={focused}
						active={active}
						onChange={(value) => onFieldChange(field.id, value)}
					/>
				);
			})}

			{errors && errors.length > 0 ? (
				<box marginTop={1}>
					<ErrorPanel message={errors.join('；')} />
				</box>
			) : null}
		</box>
	);
}
