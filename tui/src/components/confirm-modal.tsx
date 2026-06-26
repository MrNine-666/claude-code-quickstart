import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../theme/index.js';

export type ConfirmModalProps = {
	readonly title: string;
	readonly message: string;
	readonly confirmLabel?: string;
	readonly cancelLabel?: string;
	readonly tone?: 'warning' | 'danger';
};

export function ConfirmModal({
	title,
	message,
	confirmLabel = 'Enter 确认',
	cancelLabel = 'Esc 取消',
	tone = 'warning'
}: ConfirmModalProps) {
	const accent = tone === 'danger' ? colors.danger : colors.warning;
	return (
		<box flexDirection="column" borderStyle="rounded" borderColor={accent} paddingX={1}>
			<text fg={accent} attributes={TextAttributes.BOLD}>{title}</text>
			<text>{message}</text>
			<text fg={colors.muted} attributes={TextAttributes.DIM}>{confirmLabel}  {cancelLabel}</text>
		</box>
	);
}
