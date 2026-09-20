import {describe, expect, test} from 'bun:test';
import {codeGraphUninstallCommands} from '../../src/core/tools-lifecycle.js';

// P4a 迁移自 scripts/verify-codegraph-lifecycle.mjs（7 条静态断言，纯进程内，无 fs / 子进程）。
// Task 1.6 → Phase 3：CodeGraph 生命周期命令边界（design D4/PBT-4），断言真实 resolver。
// 不变量：resolver 层 uninstall 只解除集成（不删 .codegraph/）；共享 CLI 移除命令独立暴露，
// 是否执行由 tools-manage 按剩余 cc/cx MCP 决定。
//
// R9 去重（本批前置）：`agentTarget` cc/cx、`codeGraphInstallCommands` cc/cx、
// `codeGraphUninstallCommands('cx')`、`codeGraphRemoveCliCommands()` 已由 P1 的
// `tests/core/tools-lifecycle.test.ts`（`CodeGraph 安装/卸载按 agentContext 派生 --target，Pi 无命令`）
// 以相同期望值覆盖，本文件不重复迁移；此处只承载 P1 未覆盖的卸载边界不变量。

describe('CodeGraph 生命周期 resolver 卸载边界（install / CLI 移除已由 P1 覆盖）', () => {
	test('resolver 层默认卸载只解除当前 Agent 集成', () => {
		expect(codeGraphUninstallCommands('cc'), 'cc: 默认卸载只解除当前 Agent 集成').toEqual([
			{cmd: 'codegraph', args: ['uninstall', '--target=claude', '--yes']}
		]);
	});

	test('resolver 层卸载不得 npm uninstall，也不得删除 .codegraph/ 项目索引', () => {
		for (const [context, target] of [
			['cc', 'claude'],
			['cx', 'codex']
		] as const) {
			const uninstall = codeGraphUninstallCommands(context);
			expect(
				uninstall.some(command => command.cmd === 'npm' && command.args.includes('uninstall')),
				`${target}: resolver 层卸载不得 npm uninstall`
			).toBe(false);
			expect(
				uninstall.some(command => command.args.some(argument => /\.codegraph|uninit/.test(argument))),
				`${target}: 默认卸载不得删除 .codegraph/ 项目索引`
			).toBe(false);
		}
	});
});
