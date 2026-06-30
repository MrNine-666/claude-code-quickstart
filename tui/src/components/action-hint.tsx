import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../theme/index.js';

// 操作说明行：纯文字 label（disabled 时整行 DIM + 可选 disabledHint）。
// 键位提示统一由 footer ShortcutBar 展示（HC-SHORTCUT-SINGLE-SOURCE），此处不重复快捷键。

export type ActionHintProps = {
	readonly label: string;
	readonly enabled: boolean;
	readonly disabledHint?: string;
};

export function ActionHint({ label, enabled, disabledHint = '' }: ActionHintProps) {
	return (
		<box flexDirection="row" flexShrink={0}>
			<text fg={enabled ? colors.text : colors.muted} attributes={!enabled ? TextAttributes.DIM : 0}>{label}</text>
			{!enabled && disabledHint ? <text fg={colors.muted} attributes={TextAttributes.DIM}> {disabledHint}</text> : null}
		</box>
	);
}
