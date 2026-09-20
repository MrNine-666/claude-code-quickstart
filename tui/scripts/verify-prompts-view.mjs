import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Phase 6.10 全局规则视图门禁：
// - PromptsView 必须按 agentContext 切换 CLAUDE.md / AGENTS.md。
// - 全局规则只提供查看、编辑与保存，不加载或导入推荐规则。
//
// [P5d 迁走] `getRulesPath` 三目标路径隔离断言（1 条静态 / 3 运行期）→
//   tests/core/config-rules-reuse.test.ts（cc/cx 已由该文件覆盖，pi 为新增缺口）。
// R9：adapter 描述符/路由/无推荐功能与 prompts 快捷键 registry 断言已由
//   tests/core/prompts-document-adapter.test.ts（P1-G2）覆盖；本脚本保留真实文件读写段。

// P1-G2 静态断言治理：原 15 条源码正则已分类处置——
//   A 类（13 条 adapter 描述符/路由/无推荐功能、prompts 快捷键 registry）迁到
//   tests/core/prompts-document-adapter.test.ts；B 类（2 条 agentContext 必经路径、
//   “规则 core 不得加载推荐模板”）并入 scripts/verify-view-architecture.mjs（P1-G2 段）；C = 0。
// 详见 .trellis/tasks/09-18-p1-static-assertion-governance/research-reconciliation-G2.md。
console.log('[PASS] 6.10 PromptsView agentContext + 无推荐规则功能（静态合同见 verify-view-architecture.mjs）');

const home = mkdtempSync(join(tmpdir(), 'ccq-prompts-view-'));
process.env.CCQ_HOME = home;
process.env.CODEX_HOME = join(home, '.codex');
try {
	mkdirSync(join(home, '.claude'), {recursive: true});
	mkdirSync(process.env.CODEX_HOME, {recursive: true});
	const {readCurrentRules, saveRules} = await import('../src/services/prompts-service.ts');

	const expectedPaths = {
		cc: join(home, '.claude', 'CLAUDE.md'),
		cx: join(process.env.CODEX_HOME, 'AGENTS.md'),
		pi: join(home, '.pi', 'agent', 'AGENTS.md')
	};
	// [P5e 去重] adapter 投影（7 条：subtitle / 无「查看与编辑」/ editorTitle / recommendationContent /
	// importInto / openExternal / openSuccessMessage）与 prompts 编辑态 footer（1 条）已由 P1-G2 载体独占：
	// tests/core/prompts-document-adapter.test.ts（逐条对 TARGETS 断言同导出同性质）。
	for (const target of ['cc', 'cx', 'pi']) {
		assert.equal(readCurrentRules(target), null, `${target} 规则缺失时返回 null`);
	}

	const claudeSave = saveRules('claude rules', 'cc');
	assert.equal(claudeSave.ok, true, 'Claude rules 保存应成功');
	assert.equal(readCurrentRules('cc'), 'claude rules', 'Claude rules 应从 CLAUDE.md 读取');
	assert.equal(existsSync(expectedPaths.cx), false, 'Claude rules 保存不得创建 Codex AGENTS.md');

	const codexSave = saveRules('codex agents', 'cx');
	assert.equal(codexSave.ok, true, 'Codex rules 保存应成功');
	assert.equal(readCurrentRules('cx'), 'codex agents', 'Codex rules 应从 AGENTS.md 读取');
	assert.equal(readFileSync(expectedPaths.cc, 'utf8'), 'claude rules', 'Codex rules 保存不得覆盖 CLAUDE.md');

	const piSave = saveRules('pi agents', 'pi');
	assert.equal(piSave.ok, true, 'Pi rules 保存应成功');
	assert.equal(readCurrentRules('pi'), 'pi agents', 'Pi rules 应从 ~/.pi/agent/AGENTS.md 读取');
	assert.equal(existsSync(join(home, '.pi', 'AGENTS.md')), false, 'Pi rules 保存不得写入 ~/.pi/AGENTS.md');
	assert.equal(existsSync(join(process.cwd(), '.pi', 'AGENTS.md')), false, 'Pi rules 保存不得写入项目 .pi/AGENTS.md');

	console.log('[PASS] 全局规则真实文件读写（cc/cx/pi 路径隔离投影见 tests/core/config-rules-reuse.test.ts）');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
	rmSync(home, {recursive: true, force: true});
}

console.log('[PASS] PromptsView / Global Rules agentContext 门禁通过');
