import React from 'react';
import { TextAttributes } from '@opentui/core';
import { borderColors, colors } from '../theme/index.js';

// 通用卡片：list 与 grid 复用。焦点用 border 高亮（Claude 橙）表达
// - focused：选中/聚焦态，border 转主色、标题加粗主色
// - width：grid 布局时固定列宽；list 留空自适应
// - 内容区固定单行（title 行 + 可选 body 行），配合 round 边框 = 固定行高
//
// 两种布局（由 leading 驱动）：
// 1) 纵向（leading 缺省）：title 行（左 title + 右 titleRight）+ body 行
// 2) 左右两栏（leading 存在）：左栏 leading 标记 + 右栏 title 行 + body 行

export type CardProps = {
	readonly title?: React.ReactNode;
	// 标题行右侧内容（纵向布局专用，如检查更新状态）
	readonly titleRight?: React.ReactNode;
	// 左栏标记（左右两栏布局触发器）
	readonly leading?: React.ReactNode;
	readonly focused?: boolean;
	readonly width?: number;
	readonly minHeight?: number;
	readonly children?: React.ReactNode;
	// 选中标记（多选场景，纵向布局）
	readonly selected?: boolean;
	// body 多行自由换行；默认固定单行截断防溢出
	readonly multiLine?: boolean;
};

export function Card({
	title,
	titleRight,
	leading,
	focused = false,
	width,
	minHeight,
	children,
	selected,
	multiLine = false
}: CardProps) {
	const body = children === undefined || children === null ? null : (
		<box height={multiLine ? undefined : 1} overflow={multiLine ? 'visible' : 'hidden'}>
			{children}
		</box>
	);

	// 左右两栏布局：左 leading 标记 + 右内容栏（title 行 + body 行）
	if (leading !== undefined) {
		return (
			<box
				borderStyle="rounded"
				borderColor={focused ? borderColors.active : borderColors.inactive}
				paddingX={1}
				width={width}
				minHeight={minHeight}
				flexShrink={0}
			>
				<box flexShrink={0} marginRight={1}>{leading}</box>
				<box flexDirection="column" flexGrow={1} minWidth={0} overflow="hidden">
					{title === undefined ? null : (
						<box height={1} overflow="hidden">
							<text fg={focused ? colors.primary : undefined} attributes={TextAttributes.BOLD}>
								{title}
							</text>
						</box>
					)}
					{body}
				</box>
			</box>
		);
	}

	// 纵向布局：title 行（左 title + 右 titleRight）+ body 行
	return (
		<box
			flexDirection="column"
			borderStyle="rounded"
			borderColor={focused ? borderColors.active : borderColors.inactive}
			paddingX={1}
			width={width}
			minHeight={minHeight}
			flexShrink={0}
		>
			{title === undefined ? null : (
				<box height={1} overflow="hidden">
					<box flexShrink={1} flexGrow={1} overflow="hidden">
						{selected === undefined ? null : (
							<text fg={selected ? colors.primary : colors.muted}>{selected ? '✅ ' : '⬜ '}</text>
						)}
						<text fg={focused ? colors.primary : undefined} attributes={TextAttributes.BOLD}>
							{title}
						</text>
					</box>
					{titleRight === undefined ? null : <box flexShrink={0}>{titleRight}</box>}
				</box>
			)}
			{body}
		</box>
	);
}
