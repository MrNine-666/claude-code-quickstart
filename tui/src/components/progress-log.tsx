import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../theme/index.js';

// ProgressLog - 进度日志组件（OpenTUI 适配）
// 显示异步操作的进度消息列表

export type ProgressLogProps = {
	readonly title?: string;
	readonly messages: readonly string[];
};

export function ProgressLog({ title = '事件日志', messages }: ProgressLogProps) {
	return (
		<box flexDirection="column">
			<text fg={colors.text} attributes={TextAttributes.BOLD}>{title}</text>
			{messages.length === 0 ? <text fg={colors.muted} attributes={TextAttributes.DIM}>暂无事件</text> : null}
			{messages.map((message, index) => (
				<text fg={colors.text} key={`${index}-${message}`}>· {message}</text>
			))}
		</box>
	);
}
