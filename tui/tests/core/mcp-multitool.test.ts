import {describe, expect, test} from 'bun:test';
import {removeSharedServer} from '../../src/core/mcp.js';
import {removeSharedMcpServer} from '../../src/services/mcp-service.js';

// P2b 载体迁移：verify-mcp-multitool.mjs 的纯边界断言
// （共享全量删除未确认时返回 NeedConfirmation 失败，在任何文件写入前短路）。
// 载体：tests/core（确认门禁不读取 runtime/vault，无真实 HOME 依赖）。
// 其余 Claude/Codex 双写、enabled=false 第三态、批量提交差异侧等真实文件断言仍留在 verify 脚本。

describe('共享全量删除确认边界', () => {
	test('d 未确认时返回 NeedConfirmation 失败且不触碰 runtime/vault', () => {
		// service 层原始语义：未确认映射为 ok:false（不进入任何 runtime/vault 写入）。
		expect(removeSharedMcpServer('shared7', false)).toEqual({ok: false, error: '需要确认删除'});
		// core 层门禁：短路返回 NeedConfirmation，同样不触碰 runtime/vault。
		expect(removeSharedServer('shared7', false)).toEqual({
			Success: false,
			ServerId: 'shared7',
			Status: 'NeedConfirmation'
		});
	});
});
