import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors, PRIMARY } from '../theme/index.js';

export type ModalTone = 'default' | 'warning' | 'danger';

export type ModalProps = {
	readonly active: boolean;
	readonly title: string;
	readonly hint?: string;
	readonly tone?: ModalTone;
	readonly viewportWidth: number;
	readonly viewportHeight: number;
	readonly width?: number;
	readonly height?: number;
	readonly children: React.ReactNode;
};

const MODAL_BACKGROUND = '#16110D';
const DEFAULT_MODAL_WIDTH = 40;
const DEFAULT_MODAL_HEIGHT = 8;

export function Modal({
	active,
	title,
	hint,
	tone = 'default',
	viewportWidth,
	viewportHeight,
	width = DEFAULT_MODAL_WIDTH,
	height = DEFAULT_MODAL_HEIGHT,
	children
}: ModalProps) {
	if (!active) {
		return null;
	}

	const accent = accentForTone(tone);
	const left = Math.max(0, Math.floor((viewportWidth - width) / 2));
	const top = Math.max(0, Math.floor((viewportHeight - height) / 2));

	return (
		<box
			position="absolute"
			left={left}
			top={top}
			width={width}
			height={height}
			zIndex={100}
			flexDirection="column"
			borderStyle="rounded"
			borderColor={accent}
			backgroundColor={MODAL_BACKGROUND}
			paddingX={1}
		>
			<text fg={accent} attributes={TextAttributes.BOLD}>{title}</text>
			<text fg={colors.muted}>{'─'.repeat(Math.max(1, width - 4))}</text>
			{children}
			<box flexGrow={1} />
			{hint ? <ModalHint hint={hint} /> : null}
		</box>
	);
}

function ModalHint({ hint }: { readonly hint: string }) {
	const parts = hint.split(/(Enter|Esc)/g);
	return (
		<box flexDirection="row" justifyContent="flex-end">
			<text>
				{parts.map((part, index) => (
					<span key={`${part}-${index}`} fg={part === 'Enter' || part === 'Esc' ? PRIMARY : colors.muted} attributes={part === 'Enter' || part === 'Esc' ? TextAttributes.BOLD : 0}>
						{part}
					</span>
				))}
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
