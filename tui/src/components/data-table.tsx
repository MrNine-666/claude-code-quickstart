import React from 'react';
import { RGBA, type TextChunk, type TextTableContent } from '@opentui/core';
import { colors } from '../theme/index.js';

// DataTable - 使用 OpenTUI 官方 <texttable> 组件（TextTableRenderable）
// 替代 Ink 闲置 data-table.tsx（manage/source 无消费方）
// CJK 换行用官方 'char' 策略，列宽用 'content' 模式

function textChunk(text: string, fg?: RGBA): TextChunk {
	return fg ? {__isChunk: true, text, fg} : {__isChunk: true, text};
}

export type TableColumn<Row> = {
	readonly key: string;
	readonly title: string;
	readonly width?: number;
	readonly render: (row: Row) => string; // 官方 texttable 只支持纯文本，不支持 ReactNode
};

export type DataTableProps<Row> = {
	readonly columns: readonly TableColumn<Row>[];
	readonly rows: readonly Row[];
	readonly selectedIndex?: number;
	readonly getRowKey: (row: Row, index: number) => string;
	readonly emptyText?: string;
};

export function DataTable<Row>({
	columns,
	rows,
	selectedIndex,
	getRowKey,
	emptyText = '暂无数据'
}: DataTableProps<Row>) {
	if (rows.length === 0) {
		return <text fg={colors.muted}>{emptyText}</text>;
	}

	// 构建 TextTableContent: 每个单元格是 TextChunk[]。
	const headerRow = columns.map(col => [textChunk(col.title)]);

	// 数据行：带选中标记
	const selectedFg = selectedIndex === undefined ? undefined : RGBA.fromHex(colors.primary);
	const dataRows = rows.map((row, index) => {
		const isSelected = index === selectedIndex;
		const prefix = isSelected ? '► ' : '  ';
		const fg = isSelected ? selectedFg : undefined;

		return columns.map((col, colIndex) => {
			const cellText = col.render(row);
			// 第一列加前缀（选中标记）
			const displayText = colIndex === 0 ? prefix + cellText : cellText;

			return [textChunk(displayText, fg)];
		});
	});

	const tableData: TextTableContent = [headerRow, ...dataRows];

	return (
		<texttable
			content={tableData}
			wrapMode="char" // CJK 'char' 换行支持（官方明确标注 better for CJK）
			columnWidthMode="content" // 列宽适配内容
			border={false} // 不显示边框（对齐旧 Ink 风格）
			outerBorder={false}
			cellPadding={1}
		/>
	);
}
