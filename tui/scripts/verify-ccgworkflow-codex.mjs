import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	ccgWorkflowInstallCommands,
	ccgWorkflowUninstallCommands,
	agentTarget
} from '../src/core/tools-lifecycle.ts';
import {uninstallComponent} from '../src/core/tools-manage.ts';

// Task 1.7 → Phase 3：CcgWorkflow Codex Mode 生命周期（design D5/PBT-5），断言官方非交互命令。
// 不变量：Codex install/uninstall 走官方 `codex-mode` 子命令；Claude 走 `init`/`uninstall`；
// ccq 不再手写 fs 删除 config.toml 等文件（文件边界交给官方命令负责）。

// ── 命令解析层不变量（纯函数）──────────────────────────────────────────────────

// Codex install 命令含 codex-mode 子命令
const codexInstall = ccgWorkflowInstallCommands('cx', '/tmp/.claude');
assert.equal(codexInstall.length, 1, 'Codex install 解析为单条命令');
assert.equal(codexInstall[0].cmd, 'npx', 'Codex install 命令为 npx');
assert.ok(codexInstall[0].args.includes('codex-mode'), 'Codex install 含 codex-mode 子命令');
assert.ok(codexInstall[0].args.includes('install'), 'Codex install 含 install 子命令');

// Codex uninstall 命令含 codex-mode 子命令
const codexUninstall = ccgWorkflowUninstallCommands('cx');
assert.equal(codexUninstall.length, 1, 'Codex uninstall 解析为单条命令');
assert.equal(codexUninstall[0].cmd, 'npx', 'Codex uninstall 命令为 npx');
assert.ok(codexUninstall[0].args.includes('codex-mode'), 'Codex uninstall 含 codex-mode 子命令');
assert.ok(codexUninstall[0].args.includes('uninstall'), 'Codex uninstall 含 uninstall 子命令');

// Claude install 命令走 init（非 codex-mode）
const claudeInstall = ccgWorkflowInstallCommands('cc', '/tmp/.claude');
assert.equal(claudeInstall.length, 1, 'Claude install 解析为单条命令');
assert.equal(claudeInstall[0].cmd, 'npx', 'Claude install 命令为 npx');
assert.ok(claudeInstall[0].args.includes('init'), 'Claude install 含 init 子命令');
assert.equal(
	claudeInstall[0].args.some(a => a === 'codex-mode'),
	false,
	'Claude install 不含 codex-mode 子命令'
);

// Claude uninstall 命令走 uninstall（非 codex-mode）
const claudeUninstall = ccgWorkflowUninstallCommands('cc');
assert.equal(claudeUninstall.length, 1, 'Claude uninstall 解析为单条命令');
assert.equal(claudeUninstall[0].cmd, 'npx', 'Claude uninstall 命令为 npx');
assert.ok(claudeUninstall[0].args.includes('uninstall'), 'Claude uninstall 含 uninstall 子命令');
assert.equal(
	claudeUninstall[0].args.some(a => a === 'codex-mode'),
	false,
	'Claude uninstall 不含 codex-mode 子命令'
);

// agentTarget 映射不变
assert.equal(agentTarget('cx'), 'codex', 'agentTarget(cx) = codex');
assert.equal(agentTarget('cc'), 'claude', 'agentTarget(cc) = claude');

console.log('[PASS] 1.7 CcgWorkflow 官方非交互命令解析（Codex codex-mode / Claude init+uninstall）');

// ── Phase 3 真实卸载：Codex 上下文执行官方 codex-mode uninstall ──────────────
{
	const home = mkdtempSync(join(tmpdir(), 'ccq-ccg-codex-uninstall-'));
	const execCalls = [];
	const mockExec = async (cmd, args) => {
		execCalls.push({cmd, args});
		return {code: 0, stdout: '', stderr: ''};
	};

	const outcome = await uninstallComponent('CcgWorkflow', undefined, {agentContext: 'cx', exec: mockExec});
	assert.equal(outcome.success, true, 'CcgWorkflow Codex 卸载成功');

	// 断言执行了官方 codex-mode uninstall 命令
	const officialCall = execCalls.find(c => c.args.includes('ccg-workflow') && c.args.includes('codex-mode') && c.args.includes('uninstall'));
	assert.ok(officialCall, 'Codex 卸载执行官方 codex-mode uninstall 命令');

	// ccq 不再 fs 删除任何文件（不再 import fs 删除函数）
	assert.equal(execCalls.length, 1, 'Codex 卸载仅执行单条官方命令，无额外 fs 操作');

	rmSync(home, {recursive: true, force: true});
}
console.log('[PASS] 3.7 CcgWorkflow Codex 卸载走官方 codex-mode uninstall，ccq 不 fs 删除');

console.log('[PASS] CcgWorkflow Codex Mode 生命周期门禁全部通过');
