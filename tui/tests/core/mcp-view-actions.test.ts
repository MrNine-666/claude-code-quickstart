import {describe, expect, test} from 'bun:test';
import {MCP_GRID_COLUMNS, moveMcpGridCursor} from '../../src/views/mcp/mcp-view-actions.js';

// P2b 载体迁移：verify-mcp-shared-projection.mjs 第 6 段的纯函数断言
// （MCP 网格固定两列 / 右移同行第二列 / 下移保持列位置 / 末行下移循环回首行同列）。
// 载体：tests/core（进程内确定性，无真实 HOME 依赖）。

describe('MCP 网格导航（moveMcpGridCursor）', () => {
	test('固定两列：右移同行第二列、下移保持列位置、末行下移循环回首行同列', () => {
		expect(MCP_GRID_COLUMNS).toBe(2);
		expect(moveMcpGridCursor(0, 4, 'right')).toBe(1);
		expect(moveMcpGridCursor(1, 4, 'down')).toBe(3);
		expect(moveMcpGridCursor(3, 4, 'down')).toBe(1);
	});
});
