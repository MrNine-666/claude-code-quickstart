import React, { useEffect, useRef } from 'react';
import { TextAttributes, type TabSelectOption, type TabSelectRenderable } from '@opentui/core';
import { colors } from '../../theme/index.js';
import type { SelectOption } from './field-types.js';

export type SelectFieldProps = {
	readonly label: string;
	readonly value: string;
	readonly options: readonly SelectOption[];
	readonly helpText?: string;
	readonly focused: boolean;
	readonly active: boolean;
	readonly onChange: (value: string) => void;
};

/**
 * SelectField：OpenTUI 官方 <tab-select> 封装。
 * - 左右键、滚动与选中高亮交给官方组件处理
 * - 外层仍保留 label/helpText 与表单值同步，避免视图层直接依赖底层组件
 */
export function SelectField({ label, value, options, helpText, focused, active, onChange }: SelectFieldProps) {
	const ref = useRef<TabSelectRenderable>(null);
	const selectedIndex = Math.max(0, options.findIndex((opt) => opt.value === value));
	const tabWidth = Math.max(8, Math.min(18, Math.max(...options.map((opt) => opt.label.length), label.length) + 4));
	const width = Math.max(tabWidth, Math.min(40, tabWidth * Math.min(Math.max(options.length, 1), 3)));
	const tabOptions: TabSelectOption[] = options.map((opt) => ({
		name: opt.label,
		description: '',
		value: opt.value
	}));

	useEffect(() => {
		if (!ref.current || options.length === 0) {
			return;
		}

		if (ref.current.getSelectedIndex() !== selectedIndex) {
			ref.current.setSelectedIndex(selectedIndex);
		}
	}, [options.length, selectedIndex]);

	return (
		<box flexDirection="column" marginBottom={1}>
			<text attributes={focused ? TextAttributes.BOLD : 0} fg={focused ? colors.primary : undefined}>
				{focused ? '› ' : '  '}
				{label}
			</text>
			<tab-select
				ref={ref}
				options={tabOptions}
				focused={active && focused}
				width={width}
				tabWidth={tabWidth}
				showDescription={false}
				showUnderline={false}
				showScrollArrows
				wrapSelection
				textColor={focused ? colors.primary : undefined}
				focusedTextColor={colors.primary}
				selectedTextColor="#1A1A1A"
				selectedBackgroundColor={colors.primary}
				onChange={(_, option) => {
					if (option?.value !== undefined) {
						onChange(String(option.value));
					}
				}}
			/>
			{helpText ? (
				<text fg="gray" attributes={TextAttributes.DIM}>
					{helpText}
				</text>
			) : null}
		</box>
	);
}
