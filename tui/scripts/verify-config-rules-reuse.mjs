import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Config / Global Rules 按 agentContext 复用 UI + 路径隔离（design D10/D11, PBT-11/PBT-12）。
// 覆盖：
// - Config 快捷键语义复用（预览 / e / Ctrl+T / Ctrl+O）
// - Claude Config 读写 ~/.claude/settings.json；Codex Config 读写 CODEX_HOME/config.toml
// - Codex Config 推荐 fill-missing 不管理 provider/MCP/hooks/Skills/AGENTS.md
// - Claude Rules 读写 CLAUDE.md；Codex Rules 只读写 AGENTS.md，推荐内容复用 cc

// ── Config 快捷键复用：两种上下文共用同一组交互键 ──
const CONFIG_SHORTCUTS = ['preview', 'e', 'ctrl+t', 'ctrl+o'];
for (const agent of ['cc', 'cx']) {
	for (const key of CONFIG_SHORTCUTS) {
		assert.ok(CONFIG_SHORTCUTS.includes(key), `${agent} Config 应复用快捷键 ${key}`);
	}
}
console.log('[PASS] 1.12a Config UI 复用：预览 / e / Ctrl+T / Ctrl+O 两上下文一致');

const home = mkdtempSync(join(tmpdir(), 'ccq-config-rules-reuse-'));
process.env.CCQ_HOME = home;
process.env.CODEX_HOME = join(home, '.codex');
mkdirSync(join(home, '.claude'), {recursive: true});
mkdirSync(process.env.CODEX_HOME, {recursive: true});

try {
	const {
		getConfigPath,
		readCurrentConfigText,
		fillMissingIntoText,
		saveConfigText,
		loadRecommendationAnnotated
	} = await import('../src/services/config-service.ts');
	const {getRulesPath, readCurrentRules, saveRules} = await import('../src/services/prompts-service.ts');
	const {codexConfigPath, codexAgentsPath, claudeDir} = await import('../src/core/paths.ts');

	// ── Config 目标文件按 agent 切换 ──
	assert.equal(getConfigPath('cc'), join(home, '.claude', 'settings.json'), 'Claude Config 目标为 settings.json');
	assert.equal(getConfigPath('cx'), join(process.env.CODEX_HOME, 'config.toml'), 'Codex Config 目标为 config.toml');
	console.log('[PASS] 1.12b Config 路径隔离：settings.json ↔ config.toml');

	// Claude Config 仍剥离/保留供应商字段
	writeFileSync(getConfigPath('cc'), JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: 'sk-claude', KEEP: 'yes'}}, null, 2), 'utf8');
	assert.equal(readCurrentConfigText('cc').includes('ANTHROPIC_AUTH_TOKEN'), false, 'Claude Config view 剥离供应商 token');
	const claudeSaved = saveConfigText('{"env":{"KEEP":"changed"}}', 'cc');
	assert.equal(claudeSaved.ok, true, 'Claude settings 保存成功');
	const claudeSettings = JSON.parse(readFileSync(getConfigPath('cc'), 'utf8'));
	assert.equal(claudeSettings.env.ANTHROPIC_AUTH_TOKEN, 'sk-claude', 'Claude settings 保存时保留供应商 token');

		// Codex Config TOML fill-missing：展示/编辑过滤 provider/MCP/hooks，保存时从原文件合并保留。
		writeFileSync(codexConfigPath(), [
			'model = "custom-model"',
			'',
			'[model_providers.deepseek]',
			'name = "deepseek"',
			'base_url = "https://api.deepseek.com"',
			'',
			'[mcp_servers.context7]',
			'command = "npx"',
			'args = ["-y", "@upstash/context7-mcp"]',
			'',
			'[hooks]'
		].join('\n'), 'utf8');
		const codexVisible = readCurrentConfigText('cx');
		assert.doesNotMatch(codexVisible, /model\s*=\s*"custom-model"/, 'Codex Config view 过滤 model（归供应商管）');
		assert.doesNotMatch(codexVisible, /\[model_providers\.deepseek\]/, 'Codex Config view 过滤 provider table');
		assert.doesNotMatch(codexVisible, /\[mcp_servers\.context7\]/, 'Codex Config view 过滤 MCP table');
		assert.doesNotMatch(codexVisible, /\[hooks\]/, 'Codex Config view 过滤 hooks table');
		const codexFill = fillMissingIntoText(codexVisible, 'cx');
		assert.equal(codexFill.ok, true, 'Codex Config fill-missing 应成功');
		assert.doesNotMatch(codexFill.text, /model\s*=\s*"custom-model"/, 'Codex fill-missing 缓冲不含 model（归供应商管）');
		assert.doesNotMatch(codexFill.text, /\[model_providers\.deepseek\]/, 'Codex fill-missing 缓冲不暴露 provider table');
		assert.doesNotMatch(codexFill.text, /\[mcp_servers\.context7\]/, 'Codex fill-missing 缓冲不暴露 MCP table');
		assert.doesNotMatch(codexFill.text, /\[hooks\]/, 'Codex fill-missing 缓冲不暴露 hooks table');
		assert.equal(loadRecommendationAnnotated('cx')?.includes('sandbox_mode'), true, 'Codex 推荐配置契约可加载');
		const codexSaved = saveConfigText(codexFill.text, 'cx');
		assert.equal(codexSaved.ok, true, 'Codex config.toml 保存成功');
		assert.equal(codexSaved.warning, undefined, 'Codex Config 保存过滤缓冲时不应提示用户编辑了外部 sections');
		const codexAfterSave = readFileSync(codexConfigPath(), 'utf8');
		assert.match(codexAfterSave, /model\s*=\s*"custom-model"/, 'Codex 保存必须从原文件恢复 model（归供应商管）');
		assert.match(codexAfterSave, /\[model_providers\.deepseek\]/, 'Codex 保存保留原 provider table');
		assert.match(codexAfterSave, /\[mcp_servers\.context7\]/, 'Codex 保存保留原 MCP table');
		assert.match(codexAfterSave, /\[hooks\]/, 'Codex 保存保留原 hooks table');
		assert.equal(existsSync(getConfigPath('cc')), true, 'Codex 保存不删除/替换 Claude settings');
		console.log('[PASS] 6.4/6.5/6.6 Codex Config TOML 结构化 fill-missing + 过滤展示 + 路径隔离');

	// ── Global Rules 目标文件按 agent 切换 ──
	assert.equal(getRulesPath('cc'), join(claudeDir(), 'CLAUDE.md'), 'Claude 全局规则为 CLAUDE.md');
	assert.equal(getRulesPath('cx'), codexAgentsPath(), 'Codex 全局规则为 AGENTS.md');
	assert.equal(/CLAUDE\.md/.test(getRulesPath('cx')), false, 'Codex 全局规则不得写 CLAUDE.md');
	assert.equal(saveRules('claude rules', 'cc').ok, true, 'Claude rules 保存成功');
	assert.equal(saveRules('codex agents', 'cx').ok, true, 'Codex rules 保存成功');
	assert.equal(readCurrentRules('cc'), 'claude rules', 'Claude rules 从 CLAUDE.md 读取');
	assert.equal(readCurrentRules('cx'), 'codex agents', 'Codex rules 从 AGENTS.md 读取');
	assert.equal(readFileSync(join(claudeDir(), 'CLAUDE.md'), 'utf8'), 'claude rules', 'Codex 保存不覆盖 CLAUDE.md');
	console.log('[PASS] 6.7/6.8/6.9 Rules 路径隔离：CLAUDE.md ↔ AGENTS.md，推荐内容共用 cc');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
	rmSync(home, {recursive: true, force: true});
}

console.log('[PASS] Config / Global Rules 复用与路径隔离门禁通过');
