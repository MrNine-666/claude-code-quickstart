import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../theme/index.js';

// Checkbox：简单的 [✓]/[ ] 样式（OpenTUI 适配）

export type CheckboxProps = {
	readonly checked: boolean;
	readonly label?: string;
	readonly focused?: boolean;
};

export function Checkbox({ checked, label, focused = false }: CheckboxProps) {
	const checkmark = checked ? '✓' : ' ';
	const prefix = `[${checkmark}]`;

	return (
		<text fg={focused ? colors.primary : undefined} attributes={focused ? TextAttributes.INVERSE : 0}>
			{prefix}{label ? ` ${label}` : ''}
		</text>
	);
}
