import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors, PRIMARY } from '../theme/index.js';

export type ModalTone = 'default' | 'warning' | 'danger';

export type ModalProps = {
	readonly active: boolean;
	readonly title: string;
	readonly hint?: string;
	readonly tone?: ModalTone;
	readonly width?: number;
	readonly children: React.ReactNode;
};

const DEFAULT_MODAL_WIDTH = 40;
export function Modal({
	active,
	title,
	hint,
	tone = 'default',
	width = DEFAULT_MODAL_WIDTH,
	children
}: ModalProps) {
	if (!active) {
		return null;
	}

	const accent = accentForTone(tone);

	return (
		<box
			position="absolute"
			left={0}
			top={0}
			width="100%"
			height="100%"
			zIndex={100}
			flexDirection="column"
			justifyContent="center"
			alignItems="center"
		>
			<box
				width={width}
				flexDirection="column"
				borderStyle="rounded"
				borderColor={accent}
				backgroundColor={colors.modalBackground}
				paddingX={1}
				title={title}
				titleColor={accent}
			>
				<box marginTop={1} flexDirection="column">
					{children}
				</box>
				{hint ? (
					<box marginTop={1} flexDirection="column">
						<ModalHint hint={hint} />
					</box>
				) : null}
			</box>
		</box>
	);
}

// hint 中高亮为主题色的按键 token：方向/空格/确认/取消键统一加粗主色，其余文案走 muted。
const HINT_KEY_TOKENS = new Set(['↑/↓', '空格', 'Enter', 'Esc']);
const HINT_KEY_SPLIT = /(↑\/↓|空格|Enter|Esc)/g;

function ModalHint({ hint }: { readonly hint: string }) {
	const parts = hint.split(HINT_KEY_SPLIT);
	return (
		<box flexDirection="row" justifyContent="flex-end">
			<text selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{parts.map((part, index) => {
					const isKey = HINT_KEY_TOKENS.has(part);
					return (
						<span key={`${part}-${index}`} fg={isKey ? PRIMARY : colors.muted} attributes={isKey ? TextAttributes.BOLD : 0}>
							{part}
						</span>
					);
				})}
			</text>
		</box>
	);
}

function accentForTone(tone: ModalTone): string {
	switch (tone) {
		case 'danger':
			return colors.danger;
		case 'warning':
			return colors.warning;
		case 'default':
			return PRIMARY;
	}
}
