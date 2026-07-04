import assert from 'node:assert/strict';
import {
	agentTarget,
	codeGraphInstallCommands,
	codeGraphUninstallCommands,
	codeGraphRemoveCliCommands
} from '../src/core/tools-lifecycle.ts';

// Task 1.6 → Phase 3：CodeGraph 生命周期命令边界（design D4/PBT-4），断言真实 resolver。
// 不变量：install 接入当前 Agent；默认 uninstall 只解除集成（不 npm uninstall、不删 .codegraph/）；
// 移除 CLI 为独立高级动作。

// agentContext 短名 → 官方 --target 全称。
assert.equal(agentTarget('cc'), 'claude', 'cc → --target=claude');
assert.equal(agentTarget('cx'), 'codex', 'cx → --target=codex');

for (const [context, target] of [['cc', 'claude'], ['cx', 'codex']]) {
	const install = codeGraphInstallCommands(context);
	assert.deepEqual(
		install[0],
		{cmd: 'codegraph', args: ['install', `--target=${target}`, '--location=global', '--yes']},
		`${target}: install 后接入当前 Agent`
	);

	const uninstall = codeGraphUninstallCommands(context);
	assert.deepEqual(
		uninstall[0],
		{cmd: 'codegraph', args: ['uninstall', `--target=${target}`, '--yes']},
		`${target}: 默认卸载只解除当前 Agent 集成`
	);

	// 默认卸载不得 npm uninstall
	const hasNpmUninstall = uninstall.some(c => c.cmd === 'npm' && c.args.includes('uninstall'));
	assert.equal(hasNpmUninstall, false, `${target}: 默认卸载不得 npm uninstall`);

	// 默认卸载不得删除 .codegraph/ 项目索引（不出现 uninit / rm .codegraph）
	const touchesProjectIndex = uninstall.some(c => c.args.some(a => /\.codegraph|uninit/.test(a)));
	assert.equal(touchesProjectIndex, false, `${target}: 默认卸载不得删除 .codegraph/ 项目索引`);
}

// 移除 CLI（高级动作）：npm uninstall -g，与默认卸载分离。
const removeCli = codeGraphRemoveCliCommands();
assert.deepEqual(
	removeCli[0],
	{cmd: 'npm', args: ['uninstall', '-g', '@colbymchenry/codegraph']},
	'移除 CLI 高级动作 = npm uninstall -g @colbymchenry/codegraph'
);

console.log('[PASS] 1.6/3.8/3.9/3.10 CodeGraph 生命周期 resolver：install 接入 + 默认卸载只解除集成 + 移除 CLI 独立高级动作');
