import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../theme/index.js';

// ConfirmModal 在列表下方占用的近似行数（marginTop 1 + 边框上下 2 + title 1 + 单行 message 1）。
// 供视图在 confirm 子模式计入 ScrollList.reservedRows，让列表自动收缩，
// 避免底部计数行 (n/total) 与 modal 垂直重叠（曾导致 "2" 透显到 modal title 行）。
export const CONFIRM_MODAL_ROWS = 5;

export type ConfirmModalProps = {
	readonly title: string;
	readonly message: string;
	readonly tone?: 'warning' | 'danger';
};

// 快捷键（Enter 确认 / Esc 取消）统一由 footer ShortcutBar 单一展示（HC-SHORTCUT-SINGLE-SOURCE），
// 此处不再渲染 confirmLabel/cancelLabel，避免与 footer 重复，并使 modal 少占一行（利于下方列表布局）。
export function ConfirmModal({
	title,
	message,
	tone = 'warning'
}: ConfirmModalProps) {
	const accent = tone === 'danger' ? colors.danger : colors.warning;
	return (
		<box flexDirection="column" borderStyle="rounded" borderColor={accent} paddingX={1}>
			<text fg={accent} attributes={TextAttributes.BOLD}>{title}</text>
			<text>{message}</text>
		</box>
	);
}
