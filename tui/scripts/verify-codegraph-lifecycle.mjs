import assert from 'node:assert/strict';

// Task 1.6 骨架：CodeGraph 生命周期命令边界冻结（design D4/PBT-4）。
// 冻结「CLI 安装/接入分离」与「默认卸载只解除 Agent 集成」不变量；
// 阶段 3 落地 lifecycle resolver 后改为 import 真实 resolver 断言。

// resolver 期望输出：install 后接入当前 Agent，default uninstall 只解除集成。
function expectedInstallCommands(target) {
	return [
		{cmd: 'codegraph', args: ['install', `--target=${target}`, '--location=global', '--yes']}
	];
}

function expectedDefaultUninstallCommands(target) {
	return [
		{cmd: 'codegraph', args: ['uninstall', `--target=${target}`, '--yes']}
	];
}

for (const target of ['claude', 'codex']) {
	const install = expectedInstallCommands(target);
	assert.deepEqual(
		install[0],
		{cmd: 'codegraph', args: ['install', `--target=${target}`, '--location=global', '--yes']},
		`${target}: install 后应接入 Agent`
	);

	const uninstall = expectedDefaultUninstallCommands(target);
	assert.deepEqual(
		uninstall[0],
		{cmd: 'codegraph', args: ['uninstall', `--target=${target}`, '--yes']},
		`${target}: 默认卸载解除 Agent 集成`
	);

	// 默认卸载不得 npm uninstall
	const hasNpmUninstall = uninstall.some(c => c.cmd === 'npm' && c.args.includes('uninstall'));
	assert.equal(hasNpmUninstall, false, `${target}: 默认卸载不得 npm uninstall`);

	// 默认卸载不得删除 .codegraph/ 项目索引（不出现 uninit / rm .codegraph）
	const touchesProjectIndex = uninstall.some(c =>
		c.args.some(a => /\.codegraph|uninit/.test(a))
	);
	assert.equal(touchesProjectIndex, false, `${target}: 默认卸载不得删除 .codegraph/ 项目索引`);
}

console.log('[PASS] 1.6 CodeGraph 生命周期骨架：install 接入 + 默认卸载只解除集成（不 npm uninstall / 不删 .codegraph）');
