import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../../theme/index.js';
import { FormLabel, FORM_VALUE_MARGIN_LEFT } from './FormLabel.js';
import { FormControlFrame } from './FormControlFrame.js';
import type { SelectOption } from './field-types.js';

export type SelectFieldProps = {
	readonly label: string;
	readonly value: string;
	readonly options: readonly SelectOption[];
	readonly helpText?: string;
	readonly focused: boolean;
	readonly onChange: (value: string) => void;
};

/**
 * SelectField：OpenTUI 官方 <tab-select> 封装。
 * - 左右键、滚动与选中高亮交给官方组件处理
 * - 外层仍保留 label/helpText 与表单值同步，避免视图层直接依赖底层组件
 */
export function SelectField({ label, value, options, helpText, focused, onChange }: SelectFieldProps) {
	const selectedIndex = Math.max(0, options.findIndex((opt) => opt.value === value));
	const visibleOptions = options.slice(Math.max(0, selectedIndex - 1), selectedIndex + 2);

	return (
		<box flexDirection="column">
			<box flexDirection="row" alignItems="center">
				<FormLabel label={label} focused={focused} />
				<FormControlFrame>
					<text fg={focused ? colors.primary : colors.text}>
						{selectedIndex > 0 ? '‹ ' : '  '}
						{visibleOptions.map((option) => option.value === value ? `[${option.label}]` : option.label).join('  ')}
						{selectedIndex < options.length - 1 ? ' ›' : ''}
					</text>
				</FormControlFrame>
			</box>
			{helpText ? (
				<box marginLeft={FORM_VALUE_MARGIN_LEFT}>
					<text fg={colors.muted} attributes={TextAttributes.DIM}>
						{helpText}
					</text>
				</box>
			) : null}
		</box>
	);
}
