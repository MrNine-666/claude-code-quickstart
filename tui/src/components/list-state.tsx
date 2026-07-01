import React from 'react';
import {colors} from '../theme/index.js';
import {ActionHint} from './action-hint.js';
import {Spinner} from './spinner.js';

/**
 * 列表空状态组件
 * 用于展示「暂无数据」等空状态提示，支持可选的操作提示
 */
export function ListEmptyState({
	message,
	hint
}: {
	readonly message: string;
	readonly hint?: {label: string; enabled?: boolean};
}): React.ReactNode {
	return (
		<box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
			<text fg={colors.muted}>{message}</text>
			{hint ? (
				<box marginTop={1}>
					<ActionHint label={hint.label} enabled={hint.enabled ?? true} />
				</box>
			) : null}
		</box>
	);
}

/**
 * 列表加载状态组件
 * 用于展示加载中的提示（带 Spinner 动画）
 */
export function ListLoadingState({message}: {readonly message: string}): React.ReactNode {
	return (
		<box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
			<Spinner label={message} />
		</box>
	);
}
