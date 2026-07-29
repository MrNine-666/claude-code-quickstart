import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../../theme/index.js';
import { FormLabel, FORM_VALUE_MARGIN_LEFT } from './FormLabel.js';
import { FormControlFrame } from './FormControlFrame.js';
import type { SelectOption } from './field-types.js';

export type RadioFieldProps = {
	readonly label: string;
	readonly value: string;
	readonly options: readonly SelectOption[];
	readonly helpText?: string;
	readonly focused: boolean;
	readonly compact?: boolean;
};

export function RadioField({ label, value, options, helpText, focused, compact = false }: RadioFieldProps) {
	const optionNodes = options.map((option) => {
		const selected = option.value === value;
		return (
			<text
				key={option.value}
				fg={selected ? colors.navSelectedForeground : focused ? colors.primary : colors.text}
				bg={selected ? colors.primary : undefined}
				attributes={selected ? TextAttributes.BOLD : 0}
			>
				{` ${option.label} `}
			</text>
		);
	});

	return (
		<box flexDirection="column">
			<box flexDirection="row" alignItems="center">
				{compact ? <text fg={focused ? colors.primary : colors.muted}>{label}</text> : <FormLabel label={label} focused={focused} />}
				{compact ? (
					<box flexDirection="row" flexWrap="wrap" minWidth={0}>{optionNodes}</box>
				) : (
					<FormControlFrame>
						<box flexDirection="row" flexWrap="wrap" minWidth={0}>{optionNodes}</box>
					</FormControlFrame>
				)}
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
