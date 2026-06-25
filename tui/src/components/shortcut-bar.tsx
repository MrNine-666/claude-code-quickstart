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

export function ShortcutBar({ shortcuts }: ShortcutBarProps) {
	return (
		<box flexDirection="row" flexWrap="wrap">
			{shortcuts.map((shortcut, index) => (
				<React.Fragment key={`${shortcut.key}-${shortcut.label}`}>
					{index > 0 ? <text>  </text> : null}
					<text fg={colors.primary} attributes={TextAttributes.BOLD}>{shortcut.key}</text>
					<text fg={colors.muted}> {shortcut.label}</text>
				</React.Fragment>
			))}
		</box>
	);
}
