import React, {useMemo, useRef} from 'react';
import {
	defaultTextareaKeyBindings,
	type InputKeyBinding,
	type InputRenderable
} from '@opentui/core';
import {useKeyboard, useRenderer} from '@opentui/react';
import {borderColors, colors} from '../theme/index.js';
import {copyTextWithFeedback} from '../utils/copy-feedback.js';
import {isEditingModifier, shortcutPlatform} from '../utils/keyboard.js';

export type SingleLineInputProps = {
	readonly label: string;
	readonly value: string;
	readonly focused: boolean;
	readonly placeholder: string;
	readonly onChange: (value: string) => void;
};

export function normalizeSingleLineValue(value: string): string {
	return value.replace(/[\r\n]+/g, '');
}

export function singleLineInputKeyBindings(platform = shortcutPlatform()): InputKeyBinding[] {
	if (platform === 'darwin') {
		return [...defaultTextareaKeyBindings];
	}

	const retained = defaultTextareaKeyBindings.filter(binding => !(
		binding.ctrl
		&& (binding.name === 'a' || binding.name === 'z' || binding.name === 'y')
	));
	return [
		...retained,
		{name: 'a', ctrl: true, action: 'select-all'},
		{name: 'z', ctrl: true, action: 'undo'},
		{name: 'z', ctrl: true, shift: true, action: 'redo'},
		{name: 'y', ctrl: true, action: 'redo'}
	];
}

/** Skills 过滤/搜索共用的真实 OpenTUI 单行编辑器。组件始终挂载，避免焦点切换重建 edit buffer。 */
export function SingleLineInput({label, value, focused, placeholder, onChange}: SingleLineInputProps) {
	const inputRef = useRef<InputRenderable>(null);
	const renderer = useRenderer();
	const keyBindings = useMemo(() => singleLineInputKeyBindings(), []);
	const handleValueChange = (next: string) => onChange(normalizeSingleLineValue(next));

	useKeyboard((keyEvent) => {
		if (!focused || !isEditingModifier(keyEvent)) {
			return;
		}

		const name = keyEvent.name.toLowerCase();
		if (name !== 'c' && name !== 'x') {
			return;
		}

		keyEvent.preventDefault?.();
		const input = inputRef.current;
		if (!input?.hasSelection()) {
			return;
		}

		copyTextWithFeedback(renderer, input.getSelectedText());
		if (name === 'x' && input.deleteSelection()) {
			onChange(normalizeSingleLineValue(input.value));
		}
	});

	return (
		<box flexDirection="row" flexShrink={0}>
			<box
				flexDirection="row"
				borderStyle="rounded"
				borderColor={focused ? borderColors.active : borderColors.inactive}
				backgroundColor={focused ? colors.focusedBackground : undefined}
				flexGrow={1}
				minWidth={0}
			>
				<text fg={colors.muted} flexShrink={0}>{`${label}：`}</text>
				<input
					ref={inputRef}
					value={value}
					placeholder={placeholder}
					onInput={handleValueChange}
					onChange={handleValueChange}
					focused={focused}
					keyBindings={keyBindings}
					textColor={colors.text}
					focusedTextColor={colors.inputFocusedText}
					cursorColor={colors.inputCursor}
					placeholderColor={colors.muted}
					selectionBg={colors.selectionBg}
					selectionFg={colors.selectionFg}
					flexGrow={1}
					minWidth={0}
				/>
			</box>
		</box>
	);
}
