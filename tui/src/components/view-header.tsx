import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../theme/index.js';

// 视图标题行：title（橙色 BOLD）+ subtitle（muted）+ 可选 right（标题右侧附加节点）
// 统一 6 个视图原先分裂的标题样式（4 白 BOLD / 2 橙 BOLD）与副标题（DIM / muted 混用）
// 规范：title 一律 primary+BOLD，副信息一律 colors.muted

export type ViewHeaderProps = {
	readonly title: string;
	// 标题右侧副信息：计数（"共 N 个"）或路径或功能说明
	readonly subtitle?: string;
	/** 标题右侧附加节点（如脏标记 / 状态），不传则不渲染（向后兼容）。 */
	readonly right?: React.ReactNode;
};

export function ViewHeader({ title, subtitle, right }: ViewHeaderProps) {
	return (
		<box flexDirection="row" marginBottom={1}>
			<text fg={colors.primary} attributes={TextAttributes.BOLD}>
				{title}
			</text>
			{subtitle === undefined ? null : <text fg={colors.muted}>  {subtitle}</text>}
			{right === undefined ? null : <text>{' '}</text>}
			{right ?? null}
		</box>
	);
}
