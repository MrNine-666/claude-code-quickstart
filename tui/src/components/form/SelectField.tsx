import React, {useEffect, useRef} from 'react';
import {TextAttributes, type TabSelectRenderable} from '@opentui/core';
import {colors} from '../../theme/index.js';
import {FormLabel, FORM_VALUE_MARGIN_LEFT} from './FormLabel.js';
import {FormControlFrame} from './FormControlFrame.js';
import type {SelectOption} from './field-types.js';

export type SelectFieldProps = {
	readonly label: string;
	readonly value: string;
	readonly options: readonly SelectOption[];
	readonly helpText?: string;
	readonly focused: boolean;
	readonly onChange: (value: string) => void;
};

/** 横向原生 tab-select；外层持有值，选择变化立即回写。 */
export function SelectField({label, value, options, helpText, focused, onChange}: SelectFieldProps) {
	const selectRef = useRef<TabSelectRenderable>(null);
	const selectedIndex = Math.max(
		0,
		options.findIndex(opt => opt.value === value)
	);

	// tab-select 没有 selectedIndex JSX 属性，外层值变化时同步原生选中项。
	useEffect(() => {
		if (selectRef.current && selectRef.current.getSelectedIndex() !== selectedIndex) {
			selectRef.current.setSelectedIndex(selectedIndex);
		}
	}, [selectedIndex]);

	return (
		<box flexDirection="column">
			<box flexDirection="row" alignItems="center">
				<FormLabel label={label} focused={focused} />
				<FormControlFrame>
					<tab-select
						ref={selectRef}
						options={options.map(option => ({name: option.label, description: '', value: option.value}))}
						width={options.length * 6}
						tabWidth={6}
						height={1}
						showDescription={false}
						showUnderline={false}
						showScrollArrows={false}
						wrapSelection
						focused={focused}
						textColor={colors.text}
						focusedBackgroundColor={colors.focusedBackground}
						selectedBackgroundColor={focused ? colors.primary : colors.selectInactiveBackground}
						selectedTextColor={focused ? colors.navSelectedForeground : colors.text}
						onChange={(_, option) => {
							if (typeof option?.value === 'string' && option.value !== value) onChange(option.value);
						}}
					/>
				</FormControlFrame>
			</box>
			{helpText ? (
				<box marginLeft={FORM_VALUE_MARGIN_LEFT}>
					<text
						fg={colors.muted}
						attributes={TextAttributes.DIM}
						selectionBg={colors.selectionBg}
						selectionFg={colors.selectionFg}
					>
						{helpText}
					</text>
				</box>
			) : null}
		</box>
	);
}
