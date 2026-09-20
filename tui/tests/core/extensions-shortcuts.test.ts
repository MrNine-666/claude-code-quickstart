import {expect, test} from 'bun:test';
import {EXTENSIONS_COMMANDS, extensionsBindings} from '../../src/config/keybindings.js';

// 迁自 scripts/verify-extensions-view.mjs 的 A 类源码正则断言：
// 「O 查看详情 / A 全部更新」的物理键绑定改由 keybindings registry 行为断言覆盖。

function keyFor(command: string): string | undefined {
	return extensionsBindings.find(binding => binding.cmd === command)?.key as string | undefined;
}

test('扩展管理 O 绑定查看详情、A 绑定全部更新', () => {
	expect(keyFor(EXTENSIONS_COMMANDS.OPEN_DETAILS)).toBe('o');
	expect(keyFor(EXTENSIONS_COMMANDS.UPDATE_ALL)).toBe('a');
});
