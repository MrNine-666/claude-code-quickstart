// Toast 渲染层：顶部居中，向下堆叠
//
// 定位方式对齐 spinner.tsx 的 overlay：外层 position="absolute" 铺满，内层用
// justifyContent="flex-start" + alignItems="center" 实现顶部居中。zIndex=300 压在
// modal(100) 与 spinner overlay(200) 之上，保证操作反馈始终可见。

import React, {useSyncExternalStore} from 'react';
import {colors} from '../theme/index.js';
import {getToastSnapshot, subscribeToasts, type ToastEntry, type ToastType} from './toast-store.js';

const MAX_PANEL_WIDTH = 56;
const TOP_OFFSET = 1;

const ICONS: Readonly<Record<ToastType, string>> = {
	success: '✓',
	error: '✗',
	warning: '!',
	info: 'i'
};

function accentColor(type: ToastType): string {
	switch (type) {
		case 'success':
			return colors.success;
		case 'error':
			return colors.danger;
		case 'warning':
			return colors.warning;
		// 用 primary（品牌橙）而非 colors.info：后者在两套主题里是 white / black，属正文前景
		// 语义（见 code-preview.tsx 的用法），作边框会是刺眼的纯白/纯黑，与其余三色不同维度。
		case 'info':
			return colors.primary;
	}
}

export function ToastViewport({terminalWidth = 80}: {readonly terminalWidth?: number}) {
	const entries = useSyncExternalStore(subscribeToasts, getToastSnapshot, getToastSnapshot);
	if (entries.length === 0) {
		return null;
	}

	const panelWidth = Math.max(12, Math.min(MAX_PANEL_WIDTH, terminalWidth - 4));
	return (
		<box
			position="absolute"
			left={0}
			top={TOP_OFFSET}
			width="100%"
			zIndex={300}
			flexDirection="column"
			alignItems="center"
			justifyContent="flex-start"
		>
			{entries.map(entry => (
				<ToastRow key={entry.id} entry={entry} width={panelWidth} />
			))}
		</box>
	);
}

function ToastRow({entry, width}: {readonly entry: ToastEntry; readonly width: number}) {
	const accent = accentColor(entry.type);
	return (
		<box
			width={width}
			flexDirection="row"
			alignItems="center"
			borderStyle="rounded"
			borderColor={accent}
			backgroundColor={colors.modalBackground}
			paddingX={1}
			marginBottom={1}
		>
			<text fg={accent} flexShrink={0}>
				{ICONS[entry.type]}
			</text>
			<text marginLeft={1} fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{entry.message}
			</text>
		</box>
	);
}
