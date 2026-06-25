import { createCliRenderer, TextAttributes, TextTableRenderable } from "@opentui/core";
import { createRoot } from "@opentui/react";

function TestTextTable() {
  // 测试 TextTableRenderable - 这是 @opentui/core 提供的官方表格原语
  const tableData = [
    ["组件", "状态", "来源"],
    ["box", "✓", "@opentui/react"],
    ["text", "✓", "@opentui/react"],
    ["scrollbox", "✓", "@opentui/react"],
    ["texttable", "✓", "@opentui/core (TextTableRenderable)"],
    ["中文测试", "✓", "CJK 字符支持"],
  ];

  return (
    <box flexDirection="column" padding={1}>
      <text attributes={TextAttributes.BOLD}>Testing TextTableRenderable (官方表格组件):</text>
      <text>---</text>

      {/* 使用 texttable - 这是 TextTableRenderable 在 React 中的暴露形式 */}
      <texttable
        data={tableData}
        border="single"
        columnWidths="content"
        wrapStrategy="char"
      />

      <text>---</text>
      <text attributes={TextAttributes.DIM}>✓ TextTableRenderable 可用 (CJK 'char' 换行支持)</text>
      <text attributes={TextAttributes.DIM}>✓ DataTable 将使用官方 texttable，不自造</text>
      <text attributes={TextAttributes.DIM}>Press Ctrl+C to exit</text>
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<TestTextTable />);
