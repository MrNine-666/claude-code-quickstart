import {describe, expect, test} from 'bun:test';
import {hasPiMcpAdapterPackage, parsePiPackageNames} from '../../src/core/pi-mcp-adapter.js';

// P2b 载体迁移：verify-mcp-pi-adapter.mjs 的纯包名解析断言
// （JSON packages 字段 / Pi list 分组文本 source 提取 / adapter 命中判定）。
// 载体：tests/core（纯字符串解析，无真实 ~/.pi 与 adapter marker 依赖）。
// 其余检测、标准配置投影、凭据隔离、单侧启停与共享全量删除断言仍留在 verify 脚本。

describe('Pi adapter 包名解析（parsePiPackageNames / hasPiMcpAdapterPackage）', () => {
	test('JSON packages 字段解析 package source 名称', () => {
		expect(parsePiPackageNames(JSON.stringify({packages: ['npm:pi-mcp-adapter@latest', {name: '@scope/other'}]}))).toEqual([
			'pi-mcp-adapter',
			'@scope/other'
		]);
	});

	test('Pi list 分组文本只解析 package source，并去掉 npm 版本后缀', () => {
		expect(
			parsePiPackageNames(
				'User packages:\n  npm:pi-mcp-adapter@1.2.3\n    C:\\Users\\test\\.pi\\agent\\npm\\node_modules\\pi-mcp-adapter\n'
			)
		).toEqual(['pi-mcp-adapter']);
	});

	test('hasPiMcpAdapterPackage 命中与未命中', () => {
		expect(hasPiMcpAdapterPackage(JSON.stringify(['pi-mcp-adapter']))).toBe(true);
		expect(hasPiMcpAdapterPackage(JSON.stringify(['@scope/other']))).toBe(false);
	});
});
