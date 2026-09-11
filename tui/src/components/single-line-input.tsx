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
	/** 鼠标点入原生 input 时同步页面自己的逻辑焦点。 */
	readonly onFocus?: () => void;
	readonly onSubmit?: (value: string) => void;
};

export function normalizeSingleLineValue(value: string): string {
	return value.replace(/[\r\n]+/g, '');
}

export function singleLineInputKeyBindings(platform = shortcutPlatform()): InputKeyBinding[] {
	const retained = defaultTextareaKeyBindings.filter(binding => {
		// InputRenderable 的 keyBindings setter 会以 Textarea 基础绑定重建映射，不能保留 newline。
		if (binding.name === 'return' || binding.name === 'kpenter' || binding.name === 'linefeed') return false;
		return platform === 'darwin' || !(
			binding.ctrl
			&& (binding.name === 'a' || binding.name === 'z' || binding.name === 'y')
		);
	});
	const submitBindings: InputKeyBinding[] = [
		{name: 'return', action: 'submit'},
		{name: 'kpenter', action: 'submit'},
		{name: 'linefeed', action: 'submit'}
	];
	if (platform === 'darwin') return [...retained, ...submitBindings];

	return [
		...retained,
		...submitBindings,
		{name: 'a', ctrl: true, action: 'select-all'},
		{name: 'z', ctrl: true, action: 'undo'},
		{name: 'z', ctrl: true, shift: true, action: 'redo'},
		{name: 'y', ctrl: true, action: 'redo'}
	];
}

/** 页面过滤/搜索共用的真实 OpenTUI 单行编辑器。组件始终挂载，避免焦点切换重建 edit buffer。 */
export function SingleLineInput({label, value, focused, placeholder, onChange, onFocus, onSubmit}: SingleLineInputProps) {
	const inputRef = useRef<InputRenderable>(null);
	const renderer = useRenderer();
	const keyBindings = useMemo(() => singleLineInputKeyBindings(), []);
	const handleValueChange = (next: string) => onChange(normalizeSingleLineValue(next));
	const handleSubmit = (next: unknown): void => {
		if (typeof next === 'string') onSubmit?.(normalizeSingleLineValue(next));
	};

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
					onMouseDown={onFocus ? () => onFocus() : undefined}
					onSubmit={onSubmit ? handleSubmit : undefined}
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
