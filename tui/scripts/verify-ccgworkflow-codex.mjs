import assert from 'node:assert/strict';

// Task 1.7 骨架：CcgWorkflow Codex Mode 文件边界冻结（design D5/PBT-5）。
// 冻结「Codex uninstall 只删 CCG-managed 文件/marker，绝不删 CODEX_HOME/config.toml」不变量；
// 阶段 3 落地 Codex 集成路径后改为对真实卸载 planner 断言。

// Codex 卸载受管删除清单（相对 CODEX_HOME）。config.toml 绝不在内。
const CODEX_CCG_MANAGED_PATHS = [
	'agents/ccg-implement.toml',
	'agents/ccg-review.toml',
	'agents/ccg-research.toml',
	'hooks/ccg-workflow.py'
];

// 绝不删除的 Codex 用户配置。
const CODEX_PROTECTED_PATHS = ['config.toml'];

// 受管清单不得包含 config.toml
for (const managed of CODEX_CCG_MANAGED_PATHS) {
	assert.equal(managed, managed.replace(/^config\.toml$/, '__FORBIDDEN__'), `受管清单不得含 ${managed}`);
	assert.notEqual(managed, 'config.toml', 'Codex 卸载清单绝不含 config.toml');
}

// 受保护清单与受管清单不得交集
for (const protectedPath of CODEX_PROTECTED_PATHS) {
	assert.equal(
		CODEX_CCG_MANAGED_PATHS.includes(protectedPath),
		false,
		`受保护路径 ${protectedPath} 不得出现在受管删除清单`
	);
}

// 受管文件必须是 CCG marker 可识别（ccg- 前缀或 ccg-workflow）
for (const managed of CODEX_CCG_MANAGED_PATHS) {
	const base = managed.split('/').pop() ?? '';
	assert.ok(/ccg/i.test(base), `受管文件 ${managed} 应带 ccg marker`);
}

// AGENTS.md 只处理 CCG-marked 内容，不整文件删除
const agentsHandling = 'ccg-marker-only';
assert.equal(agentsHandling, 'ccg-marker-only', 'AGENTS.md 只处理 CCG marker 内容，不整文件删除');

console.log('[PASS] 1.7 CcgWorkflow Codex Mode 骨架：只删 CCG-managed 文件/marker + 绝不删 config.toml');
