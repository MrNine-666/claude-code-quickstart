// Spinner 加载动画封装（opentui-spinner）
// 用于工具安装/更新等耗时操作的动画反馈

import React from 'react';
import { registerSpinner } from 'opentui-spinner/react';
import type { SpinnerOptions } from 'opentui-spinner';
import { colors } from '../theme/index.js';

// 显式注册 <spinner> 宿主组件。裸副作用 import（`import 'opentui-spinner/react'`）
// 在 `bun build --compile --minify` 下可能被 tree-shake，导致渲染时报
// `Unknown component type: spinner`。显式调用 registerSpinner() 带绑定，
// bundler 必须保留，注册顺序明确。
registerSpinner();

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
