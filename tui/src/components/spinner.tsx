// Spinner 加载动画封装（opentui-spinner）
// 用于工具安装/更新等耗时操作的动画反馈

import React from 'react';
import 'opentui-spinner/react';
import type { SpinnerOptions } from 'opentui-spinner';
import { colors } from '../theme/index.js';

export type SpinnerProps = {
	readonly label?: string;
	readonly type?: SpinnerOptions['name'];
};

export function Spinner({ label, type = 'dots' }: SpinnerProps) {
	return (
		<box flexDirection="row" alignItems="center">
			<spinner name={type} color={colors.primary} />
			<text marginLeft={1} fg={colors.primary}>
				{label ?? '加载中...'}
			</text>
		</box>
	);
}
