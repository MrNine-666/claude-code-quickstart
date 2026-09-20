import {describe, expect, test} from 'bun:test';
import {uninstallComponent} from '../../src/core/tools-manage.js';

// P5d 迁移自 scripts/verify-ccgworkflow-codex.mjs 的 Phase 3 段（3 条静态断言）。
// 判据：uninstallComponent 的 exec 为注入缝（原脚本的 mkdtempSync home 从未被读取），无真实子进程 / fs。
// R9：同脚本的命令解析段（18 条：ccgWorkflowInstallCommands / ccgWorkflowUninstallCommands / agentTarget）
// 已由 tests/core/tools-lifecycle.test.ts 的「CcgWorkflow Claude/Codex/Pi 走各自官方命令」覆盖
// （且用精确 deepEqual，强于原脚本的 args.includes），按 R9 不重复迁移，保留在 verify 待 P5e 去重。

describe('CcgWorkflow Codex 卸载走官方 codex-mode uninstall', () => {
	test('Codex 上下文只执行单条官方 codex-mode uninstall，ccq 不做额外 fs 操作', async () => {
		const execCalls: {cmd: string; args: readonly string[]}[] = [];
		const mockExec = async (cmd: string, args: readonly string[]) => {
			execCalls.push({cmd, args});
			return {code: 0, stdout: '', stderr: ''};
		};

		const outcome = await uninstallComponent('CcgWorkflow', undefined, {agentContext: 'cx', exec: mockExec});
		expect(outcome.success, 'CcgWorkflow Codex 卸载成功').toBe(true);

		const officialCall = execCalls.find(
			call => call.args.includes('ccg-workflow') && call.args.includes('codex-mode') && call.args.includes('uninstall')
		);
		expect(officialCall, 'Codex 卸载执行官方 codex-mode uninstall 命令').toBeTruthy();

		expect(execCalls.length, 'Codex 卸载仅执行单条官方命令，无额外 fs 操作').toBe(1);
	});
});
