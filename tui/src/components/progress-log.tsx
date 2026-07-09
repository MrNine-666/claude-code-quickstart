import React from 'react';
import { TextAttributes } from '@opentui/core';
import type {ProgressLevel} from '../core/exec.js';
import { colors } from '../theme/index.js';

// ProgressLog - 进度日志组件（OpenTUI 适配）
// 显示异步操作的进度消息列表，支持纯字符串消息与带 level 的结构化 entries。

export type ProgressLogEntry = {
	readonly id?: string;
	readonly message: string;
	readonly level?: ProgressLevel;
};

export type ProgressLogProps = {
	readonly title?: string;
	readonly messages?: readonly string[];
	readonly entries?: readonly ProgressLogEntry[];
	readonly emptyText?: string;
};

function entryColor(level?: ProgressLevel): string {
	if (level === undefined) {
		return colors.text;
	}

	switch (level) {
		case 'success':
			return colors.success;
		case 'warning':
			return colors.warning;
		case 'danger':
			return colors.danger;
		default:
			return colors.info;
	}
}

export function ProgressLog({ title = '事件日志', messages = [], entries, emptyText = '暂无事件' }: ProgressLogProps) {
	const logEntries = entries ?? messages.map((message): ProgressLogEntry => ({message}));
	return (
		<box flexDirection="column">
			<text fg={colors.text} attributes={TextAttributes.BOLD} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{title}</text>
			{logEntries.length === 0 ? <text fg={colors.muted} attributes={TextAttributes.DIM} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{emptyText}</text> : null}
			{logEntries.map((entry, index) => (
				<text fg={entryColor(entry.level)} key={entry.id ?? `${index}-${entry.message}`} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>· {entry.message}</text>
			))}
		</box>
	);
}
