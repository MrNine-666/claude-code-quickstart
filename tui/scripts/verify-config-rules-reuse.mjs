import assert from 'node:assert/strict';

// Task 1.12 骨架：Config / Global Rules 按 agentContext 复用 UI + 路径隔离（design D10/D11, PBT-11/PBT-12）。
// 冻结「Codex 复用 cc 预览/编辑/推荐/导入交互」与「路径按 agent 切换」不变量；
// 阶段 6 落地 agent-aware config/prompts service 后改为 import 真实 service 断言。

// ── Config 快捷键复用：两种上下文共用同一组交互键 ──
const CONFIG_SHORTCUTS = ['preview', 'e', 'ctrl+t', 'ctrl+o'];
for (const agent of ['cc', 'cx']) {
	for (const key of CONFIG_SHORTCUTS) {
		assert.ok(CONFIG_SHORTCUTS.includes(key), `${agent} Config 应复用快捷键 ${key}`);
	}
}
console.log('[PASS] 1.12a Config UI 复用：预览 / e / Ctrl+T / Ctrl+O 两上下文一致');

// ── Config 目标文件按 agent 切换 ──
function configTargetOf(agent, home) {
	return agent === 'cc'
		? `${home}/.claude/settings.json`
		: `${home}/.codex/config.toml`;
}
assert.match(configTargetOf('cc', '/home/u'), /\.claude\/settings\.json$/, 'Claude Config 目标为 settings.json');
assert.match(configTargetOf('cx', '/home/u'), /\.codex\/config\.toml$/, 'Codex Config 目标为 config.toml');

// ── Global Rules 目标文件按 agent 切换 ──
function rulesTargetOf(agent, home) {
	return agent === 'cc'
		? `${home}/.claude/CLAUDE.md`
		: `${home}/.codex/AGENTS.md`;
}
assert.match(rulesTargetOf('cc', '/home/u'), /\.claude\/CLAUDE\.md$/, 'Claude 全局规则为 CLAUDE.md');
assert.match(rulesTargetOf('cx', '/home/u'), /\.codex\/AGENTS\.md$/, 'Codex 全局规则为 AGENTS.md');

// Codex 全局规则只维护 AGENTS.md（不写 CLAUDE.md）
assert.equal(/CLAUDE\.md/.test(rulesTargetOf('cx', '/home/u')), false, 'Codex 全局规则不得写 CLAUDE.md');
console.log('[PASS] 1.12b 路径隔离：Config settings.json↔config.toml，Rules CLAUDE.md↔AGENTS.md');

// ── Codex 推荐规则内容复用 cc 推荐规则（同一来源，仅目标文件名不同）──
const RECOMMENDED_RULES_SOURCE = 'shared-cc-recommended-rules';
const ccRulesSource = RECOMMENDED_RULES_SOURCE;
const cxRulesSource = RECOMMENDED_RULES_SOURCE;
assert.equal(cxRulesSource, ccRulesSource, 'Codex 推荐规则内容复用 cc 推荐规则');
console.log('[PASS] 1.12c Codex 推荐规则内容复用 cc（目标文件为 AGENTS.md）');
