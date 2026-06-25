import { TextAttributes } from '@opentui/core';
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { DataTable, type TableColumn } from "./components/data-table.js";

// 测试 DataTable - 使用官方 texttable 组件封装

type User = {
	id: number;
	name: string;
	status: string;
};

function TestDataTable() {
	const users: User[] = [
		{ id: 1, name: "Alice", status: "active" },
		{ id: 2, name: "Bob", status: "inactive" },
		{ id: 3, name: "张三", status: "active" },
		{ id: 4, name: "李四", status: "pending" },
	];

	const columns: TableColumn<User>[] = [
		{ key: "id", title: "ID", width: 8, render: (u) => String(u.id) },
		{ key: "name", title: "姓名", width: 15, render: (u) => u.name },
		{ key: "status", title: "状态", width: 12, render: (u) => u.status },
	];

	return (
		<box flexDirection="column" padding={1}>
			<text attributes={TextAttributes.BOLD}>测试 DataTable（OpenTUI 官方 texttable）:</text>
			<text>---</text>

			<text>示例 1: 无选中</text>
			<DataTable
				columns={columns}
				rows={users}
				getRowKey={(u) => String(u.id)}
			/>

			<text>---</text>
			<text>示例 2: 选中第 2 行（Bob）</text>
			<DataTable
				columns={columns}
				rows={users}
				selectedIndex={1}
				getRowKey={(u) => String(u.id)}
			/>

			<text>---</text>
			<text>示例 3: 空数据</text>
			<DataTable
				columns={columns}
				rows={[]}
				getRowKey={(u) => String(u.id)}
				emptyText="没有用户数据"
			/>

			<text>---</text>
			<text attributes={TextAttributes.DIM}>✓ DataTable 使用官方 texttable（CJK 'char' 换行 + 'content' 列宽）</text>
			<text attributes={TextAttributes.DIM}>✓ 替代 Ink 闲置 data-table.tsx（manage/source 无消费方）</text>
			<text attributes={TextAttributes.DIM}>Press Ctrl+C to exit</text>
		</box>
	);
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<TestDataTable />);
