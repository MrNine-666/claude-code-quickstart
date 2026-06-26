import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../theme/index.js';

export type Shortcut = {
	readonly key: string;
	readonly label: string;
};

export type ShortcutBarProps = {
	readonly shortcuts: readonly Shortcut[];
};

// footer 快捷键字母大写化：仅单字母 token 转大写（a→A、s→S），修饰键名（Ctrl/Shift/Meta/Super）、
// 方向/功能键名（↑↓←→ Enter Esc Tab Space）保持不变。按「/」拆等价键、「+」拆修饰组合后逐 token 处理。
function upperizeKey(key: string): string {
	return key
		.split('/')
		.map(variant =>
			variant
				.split('+')
				.map(token => {
					const trimmed = token.trim();
					return /^[a-z]$/.test(trimmed) ? trimmed.toUpperCase() : token;
				})
				.join('+')
		)
		.join('/');
}

export function ShortcutBar({ shortcuts }: ShortcutBarProps) {
	return (
		<box flexDirection="row" flexWrap="wrap">
			{shortcuts.map((shortcut, index) => (
				<React.Fragment key={`${shortcut.key}-${shortcut.label}`}>
					{index > 0 ? <text>  </text> : null}
					<text fg={colors.primary} attributes={TextAttributes.BOLD}>{upperizeKey(shortcut.key)}</text>
					<text fg={colors.muted}> {shortcut.label}</text>
				</React.Fragment>
			))}
		</box>
	);
}
