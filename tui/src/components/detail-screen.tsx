import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors, borderColors } from '../theme/index.js';

// 全屏详情壳（OpenTUI 适配）：点击 list item 后隐藏列表、整屏展示详情。
// 左上角固定「← 返回」按钮（Esc/← 触发，由调用方监听键盘），其下渲染详情内容。

export type DetailScreenProps = {
	readonly title: React.ReactNode;
	// 右上角可选操作提示（如「E 编辑 · D 删除」），纯展示。
	readonly actionsHint?: React.ReactNode;
	readonly children?: React.ReactNode;
};

export function DetailScreen({ title, actionsHint, children }: DetailScreenProps) {
	return (
		<box flexDirection="column" flexGrow={1}>
			<box justifyContent="space-between">
				<box>
					<text fg={colors.primary} attributes={TextAttributes.BOLD}>
						{'← 返回'}
					</text>
					<text fg={colors.text} attributes={TextAttributes.BOLD}>{'  '}{title}</text>
				</box>
				{actionsHint ? <text fg={colors.muted} attributes={TextAttributes.DIM}>{actionsHint}</text> : null}
			</box>
			<box
				flexDirection="column"
				flexGrow={1}
				borderStyle="rounded"
				borderColor={borderColors.inactive}
				paddingX={1}
				marginTop={1}
			>
				{children}
			</box>
		</box>
	);
}
