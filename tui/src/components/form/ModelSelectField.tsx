import {useEffect, useRef} from 'react';
import {TextAttributes, type KeyEvent} from '@opentui/core';
import {colors} from '../../theme/index.js';
import {ListLoadingState} from '../list-state.js';
import {ScrollList, type ScrollListItem} from '../scroll-list.js';
import {FormControlFrame} from './FormControlFrame.js';
import {FormLabel, FORM_VALUE_MARGIN_LEFT} from './FormLabel.js';

export type ModelSelectFieldProps = {
	readonly label: string;
	readonly value: string;
	readonly helpText?: string;
	readonly focused: boolean;
	readonly active: boolean;
	readonly open: boolean;
	readonly loading: boolean;
	readonly candidates: readonly string[];
	readonly cursor: number;
	readonly onChange: (value: string) => void;
	readonly onSubmit: () => void;
	readonly onFocus?: () => void;
	readonly onKeyDown?: (keyEvent: KeyEvent) => boolean;
};

const MODEL_LIST_HEIGHT = 8;

/**
 * 模型字段专用单选控件：输入框仍是模型值本身，列表只是同一字段的候选来源。
 * 选择候选后由父表单立即回写输入值；Ctrl/Cmd+S 不经过本控件的候选状态。
 */
export function ModelSelectField({
	label,
	value,
	helpText,
	focused,
	active,
	open,
	loading,
	candidates,
	cursor,
	onChange,
	onSubmit,
	onFocus,
	onKeyDown
}: ModelSelectFieldProps) {
	const onFocusRef = useRef(onFocus);
	onFocusRef.current = onFocus;

	useEffect(() => {
		if (active && focused) {
			onFocusRef.current?.();
		}
	}, [active, focused]);

	const items: ScrollListItem[] = candidates.map(model => ({
		key: model,
		title: model,
		bordered: false
	}));

	return (
		<box flexDirection="column">
			<box flexDirection="row" alignItems="center">
				<FormLabel label={label} focused={focused} />
				<FormControlFrame>
					{active && focused ? (
						<input
							value={value}
							placeholder={`输入 ${label}，表单按 Ctrl+D 获取候选`}
							onInput={onChange}
							onSubmit={onSubmit}
							onMouseDown={onFocus}
							onKeyDown={keyEvent => {
								if (onKeyDown?.(keyEvent)) keyEvent.preventDefault();
							}}
							focused
							textColor={colors.inputFocusedText}
							cursorColor={colors.inputCursor}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
						/>
					) : (
						<text fg={value ? colors.text : colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
							{value || '（空）'}
						</text>
					)}
				</FormControlFrame>
			</box>
			{helpText ? (
				<box marginLeft={FORM_VALUE_MARGIN_LEFT}>
					<text
						fg={colors.muted}
						attributes={TextAttributes.DIM}
						selectionBg={colors.selectionBg}
						selectionFg={colors.selectionFg}
					>
						{helpText}
					</text>
				</box>
			) : null}
			{open ? (
				<box marginLeft={FORM_VALUE_MARGIN_LEFT} marginTop={1} height={MODEL_LIST_HEIGHT} minHeight={0} flexShrink={0}>
					{loading ? (
						<ListLoadingState message="正在获取上游模型" />
					) : (
						<ScrollList
							items={items}
							cursor={cursor}
							active={active && focused}
							focusIndicator="card"
							emptyText="暂无模型，请手工输入模型 ID"
						/>
					)}
				</box>
			) : null}
		</box>
	);
}
