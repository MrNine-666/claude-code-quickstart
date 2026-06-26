import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../../theme/index.js';

export const FORM_LABEL_WIDTH = 18;
export const FORM_VALUE_MARGIN_LEFT = FORM_LABEL_WIDTH + 2;

export type FormLabelProps = {
	readonly label: string;
	readonly focused: boolean;
};

export function FormLabel({ label, focused }: FormLabelProps) {
	return (
		<>
			<box width={FORM_LABEL_WIDTH} flexShrink={0} overflow="hidden">
				<text fg={focused ? colors.primary : colors.muted} attributes={focused ? TextAttributes.BOLD : 0}>
					{focused ? '› ' : '  '}
					{label}
				</text>
			</box>
			<text fg={focused ? colors.primary : colors.muted} attributes={focused ? TextAttributes.BOLD : 0}>│ </text>
		</>
	);
}
