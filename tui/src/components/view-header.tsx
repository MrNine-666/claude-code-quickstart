import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../theme/index.js';

// 视图标题行：title（橙色 BOLD）+ subtitle（muted）
// 统一 6 个视图原先分裂的标题样式（4 白 BOLD / 2 橙 BOLD）与副标题（DIM / muted 混用）
// 规范：title 一律 primary+BOLD，副信息一律 colors.muted

export type ViewHeaderProps = {
	readonly title: string;
	// 标题右侧副信息：计数（"共 N 个"）或路径或功能说明
	readonly subtitle?: string;
};

export function ViewHeader({ title, subtitle }: ViewHeaderProps) {
	return (
		<box marginBottom={1}>
			<text fg={colors.primary} attributes={TextAttributes.BOLD}>
				{title}
			</text>
			{subtitle === undefined ? null : <text fg={colors.muted}>  {subtitle}</text>}
		</box>
	);
}
