import React from 'react';
import { TextAttributes } from '@opentui/core';
import { displayWidth } from '../core/text-utils.js';
import { colors } from '../theme/index.js';

export type Shortcut = {
	readonly key: string;
	readonly label: string;
};

export type ShortcutBarProps = {
	readonly shortcuts: readonly Shortcut[];
	readonly width?: number;
};

type DisplayShortcut = Shortcut & {
	readonly displayKey: string;
};

const SHORTCUT_ITEM_GAP = 2;

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

function displayShortcuts(shortcuts: readonly Shortcut[]): readonly DisplayShortcut[] {
	return shortcuts.map(shortcut => ({...shortcut, displayKey: upperizeKey(shortcut.key)}));
}

function shortcutWidth(shortcut: DisplayShortcut): number {
	return displayWidth(shortcut.displayKey) + 1 + displayWidth(shortcut.label);
}

export function shortcutBarRows(shortcuts: readonly Shortcut[], width: number | undefined): number {
	const items = displayShortcuts(shortcuts);
	if (items.length === 0) {
		return 0;
	}

	if (width === undefined || width <= 0) {
		return 1;
	}

	let rows = 1;
	let usedWidth = 0;

	for (const item of items) {
		const itemWidth = shortcutWidth(item);
		const nextWidth = usedWidth === 0 ? itemWidth : usedWidth + SHORTCUT_ITEM_GAP + itemWidth;
		if (usedWidth > 0 && nextWidth > width) {
			rows += 1;
			usedWidth = 0;
		}

		usedWidth = usedWidth === 0 ? itemWidth : usedWidth + SHORTCUT_ITEM_GAP + itemWidth;
	}

	return rows;
}

export function ShortcutBar({ shortcuts, width }: ShortcutBarProps) {
	const items = displayShortcuts(shortcuts);
	return (
		<box flexDirection="row" flexWrap="wrap" width={width} flexShrink={0}>
			{items.map((shortcut) => (
				<box key={`${shortcut.key}-${shortcut.label}`} flexDirection="row" marginRight={SHORTCUT_ITEM_GAP}>
					<text fg={colors.primary} attributes={TextAttributes.BOLD}>{shortcut.displayKey}</text>
					<text fg={colors.muted}> {shortcut.label}</text>
				</box>
			))}
		</box>
	);
}
