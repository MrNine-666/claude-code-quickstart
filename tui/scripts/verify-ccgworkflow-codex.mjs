import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	codexCcgManagedPaths,
	codexCcgInstallGuidance,
	CODEX_CCG_MANAGED_FILES,
	CODEX_PROTECTED_FILES
} from '../src/core/tools-lifecycle.ts';
import {uninstallComponent} from '../src/core/tools-manage.ts';

// Task 1.7 → Phase 3：CcgWorkflow Codex Mode 文件边界（design D5/PBT-5），断言真实 resolver + 真实卸载。
// 不变量：Codex uninstall 只删 CCG-managed 文件/marker，绝不删 CODEX_HOME/config.toml；
// Codex install 无官方非交互入口，只给引导文案。

// ── 受管 vs 受保护清单互斥 ─────────────────────────────────────────────────────
// config.toml 绝不在受管清单内。
for (const managed of CODEX_CCG_MANAGED_FILES) {
	assert.notEqual(managed, 'config.toml', `受管清单不得含 config.toml: ${managed}`);
}

for (const protectedPath of CODEX_PROTECTED_FILES) {
	assert.equal(
		CODEX_CCG_MANAGED_FILES.includes(protectedPath),
		false,
		`受保护路径 ${protectedPath} 不得出现在受管删除清单`
	);
}

// 受管文件必须是 CCG marker 可识别（ccg- 前缀或 ccg-workflow）
for (const managed of CODEX_CCG_MANAGED_FILES) {
	const base = managed.split('/').pop() ?? '';
	assert.ok(/ccg/i.test(base), `受管文件 ${managed} 应带 ccg marker`);
}

// AGENTS.md 只处理 CCG marker 内容（首期不整文件删除，留给后续 marker-aware 实现）。
assert.ok(/Codex Mode/.test(codexCcgInstallGuidance()) || /ccg-workflow/.test(codexCcgInstallGuidance()), 'Codex install 引导提及官方菜单');

console.log('[PASS] 1.7 CcgWorkflow Codex 受管/受保护清单互斥 + install 引导');

// ── Phase 3 真实卸载：Codex 上下文卸载只删受管文件，config.toml 保留 ──────────
{
	const home = mkdtempSync(join(tmpdir(), 'ccq-ccg-codex-uninstall-'));
	process.env.CODEX_HOME = join(home, '.codex');
	const codexHome = process.env.CODEX_HOME;
	mkdirSync(join(codexHome, 'agents'), {recursive: true});
	mkdirSync(join(codexHome, 'hooks'), {recursive: true});
	// 受管文件（CCG-managed）
	writeFileSync(join(codexHome, 'agents', 'ccg-implement.toml'), 'managed', 'utf8');
	writeFileSync(join(codexHome, 'agents', 'ccg-review.toml'), 'managed', 'utf8');
	writeFileSync(join(codexHome, 'agents', 'ccg-research.toml'), 'managed', 'utf8');
	writeFileSync(join(codexHome, 'hooks', 'ccg-workflow.py'), 'managed', 'utf8');
	// 用户自定义（受保护）
	writeFileSync(join(codexHome, 'config.toml'), 'user config', 'utf8');
	writeFileSync(join(codexHome, 'agents', 'user-agent.toml'), 'user', 'utf8');

	const outcome = await uninstallComponent('CcgWorkflow', undefined, {agentContext: 'cx', exec: async () => ({code: 0, stdout: '', stderr: ''})});
	assert.equal(outcome.success, true, 'CcgWorkflow Codex 卸载成功');

	// 受管文件已删
	for (const abs of codexCcgManagedPaths()) {
		assert.equal(existsSync(abs), false, `受管文件已删: ${abs}`);
	}

	// config.toml 与用户自定义 agent 保留
	assert.equal(existsSync(join(codexHome, 'config.toml')), true, 'config.toml 绝不删除（受保护）');
	assert.equal(existsSync(join(codexHome, 'agents', 'user-agent.toml')), true, '用户自定义 agent 文件保留');

	// agents 目录含用户文件不清理；hooks 目录受管文件删后变空则清理
	assert.equal(existsSync(join(codexHome, 'agents')), true, 'agents 目录含用户文件时保留');
	assert.equal(existsSync(join(codexHome, 'hooks')), false, '空 hooks 目录已清理');

	delete process.env.CODEX_HOME;
	rmSync(home, {recursive: true, force: true});
}
console.log('[PASS] 3.7 CcgWorkflow Codex 真实卸载：只删受管文件 + config.toml 保留 + 空目录清理');

console.log('[PASS] CcgWorkflow Codex Mode 生命周期门禁全部通过');
