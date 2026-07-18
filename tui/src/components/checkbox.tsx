import React from 'react';
import { colors } from '../theme/index.js';

// Checkbox：简单的 [✓]/[ ] 样式（OpenTUI 适配）

export type CheckboxProps = {
	readonly checked: boolean;
	readonly label?: string;
	readonly focused?: boolean;
	readonly disabled?: boolean;
};

export function Checkbox({ checked, label, focused = false, disabled = false }: CheckboxProps) {
	const checkmark = disabled ? '—' : checked ? '✓' : ' ';
	const bracketColor = focused ? colors.primary : disabled ? colors.muted : undefined;
	const contentColor = disabled ? colors.muted : undefined;

	return (
		<box flexDirection="row">
			<text fg={bracketColor}>[</text>
			<text fg={contentColor}>{checkmark}</text>
			<text fg={bracketColor}>]</text>
			{label ? <text fg={contentColor}>{` ${label}`}</text> : null}
		</box>
	);
}
