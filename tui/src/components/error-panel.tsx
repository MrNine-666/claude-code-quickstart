import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../theme/index.js';

// ErrorPanel - 错误面板（OpenTUI 适配）
// 替代 Ink 版本，使用 <box>/<text> 原语

export type ErrorPanelProps = {
	readonly title?: string;
	readonly message: string;
	readonly detail?: string;
};

export function ErrorPanel({ title = '操作失败', message, detail }: ErrorPanelProps) {
	return (
		<box flexDirection="column">
			<text fg={colors.danger} attributes={TextAttributes.BOLD}>
				{title}
			</text>
			<text>{message}</text>
			{detail ? <text fg={colors.muted}>{detail}</text> : null}
		</box>
	);
}
