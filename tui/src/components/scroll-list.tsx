import React, { useEffect, useMemo, useRef } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { Card } from './card.js';
import { colors } from '../theme/index.js';

// 卡片纵向列表 + 焦点驱动滚动（OpenTUI 适配）：列表项全部交给官方
// <scrollbox viewportCulling> 管理可视裁剪，光标移动时用 scrollChildIntoView
// 将当前卡片滚入可视区域，避免继续维护手写窗口切片逻辑。

export type ScrollListItem = {
	readonly key: string;
	readonly title: React.ReactNode;
	// 标题行右侧内容（透传给 Card.titleRight，如检查更新状态）。
	readonly titleRight?: React.ReactNode;
	// 左栏标记（透传给 Card.leading，触发左右两栏布局：供应商/MCP 状态圆点、Skills 选中框）。
	readonly leading?: React.ReactNode;
	readonly body?: React.ReactNode;
	readonly selected?: boolean;
	// body 多行自由换行（透传给 Card）；默认固定单行。
	readonly multiLine?: boolean;
};

export type ScrollListProps = {
	readonly items: readonly ScrollListItem[];
	readonly cursor: number;
	readonly viewportHeight: number;
	// ScrollList 之外（同一 content 区内）已占用的行数：标题、副标题、notice 等。
	readonly reservedRows?: number;
	// 拉伸模式：由父容器 flex 分配高度，避免继续用 viewportHeight 手算列表高度。
	readonly stretch?: boolean;
	readonly emptyText?: string;
};

// 底部 (n/total) 计数占 1 行。
const COUNT_ROWS = 1;

function itemId(item: ScrollListItem, index: number): string {
	return `scroll-list-item-${index}-${item.key}`;
}

export function ScrollList({
	items,
	cursor,
	viewportHeight,
	reservedRows = 0,
	stretch = false,
	emptyText = '暂无数据'
}: ScrollListProps) {
	const ref = useRef<ScrollBoxRenderable>(null);
	const safeCursor = items.length === 0 ? 0 : Math.min(Math.max(cursor, 0), items.length - 1);
	const activeItemId = items[safeCursor] ? itemId(items[safeCursor], safeCursor) : null;
	const scrollHeight = Math.max(1, viewportHeight - reservedRows - COUNT_ROWS);
	const scrollboxHeight = stretch ? undefined : scrollHeight;
	const renderedItems = useMemo(
		() => items.map((item, index) => ({item, index, id: itemId(item, index)})),
		[items]
	);

	useEffect(() => {
		if (!ref.current || !activeItemId) {
			return;
		}

		ref.current.scrollChildIntoView(activeItemId);
	}, [activeItemId]);

	if (items.length === 0) {
		return <text fg={colors.muted}>{emptyText}</text>;
	}

	return (
		<box flexDirection="column" flexGrow={stretch ? 1 : 0}>
			<scrollbox
				ref={ref}
				height={scrollboxHeight}
				style={stretch ? {flexGrow: 1} : undefined}
				width="100%"
				viewportCulling
				scrollY
				scrollX={false}
				verticalScrollbarOptions={{showArrows: true}}
			>
				{renderedItems.map(({item, index, id}) => (
					<box key={item.key} id={id} flexDirection="column" flexShrink={0}>
						<Card
							title={item.title}
							titleRight={item.titleRight}
							leading={item.leading}
							focused={index === safeCursor}
							selected={item.selected}
							multiLine={item.multiLine}
						>
							{item.body}
						</Card>
					</box>
				))}
			</scrollbox>
			<text fg={colors.muted}>{`(${safeCursor + 1}/${items.length})`}</text>
		</box>
	);
}
