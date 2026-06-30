import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../theme/index.js';

// DetailPanel - 详情面板（OpenTUI 适配）
// 键值对列表展示

export type DetailItem = {
	readonly label: string;
	readonly value: React.ReactNode;
};

export type DetailPanelProps = {
	readonly title?: string;
	readonly items: readonly DetailItem[];
};

export function DetailPanel({ title, items }: DetailPanelProps) {
	return (
		<box flexDirection="column">
			{title ? <text fg={colors.text} attributes={TextAttributes.BOLD}>{title}</text> : null}
			{items.map((item) => (
				<box key={item.label}>
					<text fg={colors.muted} attributes={TextAttributes.DIM}>{item.label}：</text>
					{typeof item.value === 'string' ? <text fg={colors.text}>{item.value}</text> : item.value}
				</box>
			))}
		</box>
	);
}
