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
	const checkboxColor = disabled ? colors.muted : focused || checked ? colors.primary : colors.muted;
	const labelColor = disabled ? colors.muted : undefined;

	return (
		<box flexDirection="row">
			<text fg={checkboxColor}>[</text>
			<text fg={checkboxColor}>{checkmark}</text>
			<text fg={checkboxColor}>]</text>
			{label ? <text fg={labelColor}>{` ${label}`}</text> : null}
		</box>
	);
}
