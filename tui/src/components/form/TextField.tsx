import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../../theme/index.js';
import { FormLabel, FORM_VALUE_MARGIN_LEFT } from './FormLabel.js';
import { FormControlFrame } from './FormControlFrame.js';

export type TextFieldProps = {
	readonly label: string;
	readonly value: string;
	readonly secret?: boolean;
	readonly helpText?: string;
	readonly focused: boolean;
	readonly active: boolean;
	readonly onChange: (value: string) => void;
};

/**
 * TextField：text/secret 单行文本输入（OpenTUI <input> 封装）
 * - secret 模式脱敏显示（非焦点时显示 ●●●●，焦点编辑时正常显示便于核对）
 * - focused + active 时渲染 <input> 接管字符输入；否则渲染只读 text
 * - Ctrl/Cmd+S 保存 / Esc 取消由 FormPanel 统一处理（input 不绑 onSubmit，避免双触发）
 */
export function TextField({ label, value, secret = false, helpText, focused, active, onChange }: TextFieldProps) {
	// secret 非焦点脱敏；焦点编辑时明文显示便于核对（input 内）。
	const displayValue = secret && !focused ? '●'.repeat(Math.min(value.length, 32)) : value;

	return (
		<box flexDirection="column">
			<box flexDirection="row" alignItems="center">
				<FormLabel label={label} focused={focused} />
				<FormControlFrame>
					{active && focused ? (
						<input
							value={value}
							placeholder={secret ? '输入密钥（不会显示）' : `输入 ${label}`}
							onInput={onChange}
							focused
							textColor={colors.inputFocusedText}
							cursorColor={colors.inputCursor}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
						/>
					) : (
						<text fg={value ? colors.text : colors.muted}>{displayValue || '（空）'}</text>
					)}
				</FormControlFrame>
			</box>
			{helpText ? (
				<box marginLeft={FORM_VALUE_MARGIN_LEFT}>
					<text fg={colors.muted} attributes={TextAttributes.DIM}>
						{helpText}
					</text>
				</box>
			) : null}
		</box>
	);
}
