// Spinner 加载动画封装（opentui-spinner）
// 用于工具安装/更新等耗时操作的动画反馈

import React, {useRef, useState} from 'react';
import {registerSpinner} from 'opentui-spinner/react';
import type {SpinnerOptions} from 'opentui-spinner';
import {useKeyboard} from '@opentui/react';
import {colors} from '../theme/index.js';

// 显式注册 <spinner> 宿主组件。裸副作用 import（`import 'opentui-spinner/react'`）
// 在 `bun build --compile --minify` 下可能被 tree-shake，导致渲染时报
// `Unknown component type: spinner`。显式调用 registerSpinner() 带绑定，
// bundler 必须保留，注册顺序明确。
registerSpinner();

type SpinnerBaseProps = {
	readonly label?: string;
	readonly type?: SpinnerOptions['name'];
};

type InlineSpinnerProps = SpinnerBaseProps & {
	readonly variant?: 'inline';
};

type OverlaySpinnerProps = SpinnerBaseProps & {
	readonly variant: 'overlay';
	readonly message?: string;
	readonly terminalWidth?: number;
	readonly onCancel: () => void;
};

export type SpinnerProps = InlineSpinnerProps | OverlaySpinnerProps;

export type BusyAction = 'install' | 'update' | 'uninstall';

export type BusyOverlayState = {
	readonly title: string;
	readonly message?: string;
	readonly onCancel: () => void;
};

const MAX_PANEL_WIDTH = 56;

export function busyActionTitle(action: BusyAction, subject: string): string {
	switch (action) {
		case 'install':
			return `正在安装${subject}`;
		case 'update':
			return `正在更新${subject}`;
		case 'uninstall':
			return `正在卸载${subject}`;
	}
}

export function Spinner(props: SpinnerProps) {
	const {label, type = 'dots'} = props;
	if (props.variant === 'overlay') {
		return <OverlaySpinner {...props} type={type} />;
	}

	return <SpinnerIndicator label={label} type={type} />;
}

function SpinnerIndicator({label, type}: {readonly label?: string; readonly type: SpinnerOptions['name']}) {
	return (
		<box flexDirection="row" alignItems="center">
			<spinner name={type} color={colors.primary} />
			<text marginLeft={1} fg={colors.primary}>
				{label ?? '加载中...'}
			</text>
		</box>
	);
}

function OverlaySpinner({
	label,
	type,
	message,
	terminalWidth = 80,
	onCancel
}: OverlaySpinnerProps & {readonly type: SpinnerOptions['name']}) {
	const cancelRequestedRef = useRef(false);
	const [visible, setVisible] = useState(true);
	const panelWidth = Math.max(12, Math.min(MAX_PANEL_WIDTH, terminalWidth - 4));
	useKeyboard(keyEvent => {
		if (keyEvent.name !== 'escape' || cancelRequestedRef.current) {
			return;
		}

		keyEvent.preventDefault?.();
		cancelRequestedRef.current = true;
		setVisible(false);
		onCancel();
	});
	if (!visible) {
		return null;
	}

	return (
		<box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={200}>
			<box position="absolute" left={0} top={0} width="100%" height="100%" backgroundColor={colors.modalBackground} opacity={0.72} />
			<box
				position="absolute"
				left={0}
				top={0}
				width="100%"
				height="100%"
				zIndex={1}
				flexDirection="column"
				justifyContent="center"
				alignItems="center"
			>
				<box
					width={panelWidth}
					flexDirection="column"
					alignItems="center"
					borderStyle="rounded"
					borderColor={colors.primary}
					backgroundColor={colors.modalBackground}
					paddingX={2}
					paddingY={1}
				>
					<SpinnerIndicator label={label} type={type} />
					{message ? (
						<text marginTop={1} fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
							{message}
						</text>
					) : null}
					<text marginTop={1} fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
						Esc 取消任务
					</text>
				</box>
			</box>
		</box>
	);
}
