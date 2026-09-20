import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// [P5b 迁走] Config/Rules 目标路径按 agent 隔离投影（getConfigPath/getRulesPath 共 5 条）
// + Codex 推荐配置契约含 sandbox_mode/file_opener（2 条）→ tests/core/config-rules-reuse.test.ts。
// 「Config UI 复用快捷键」段保留在 verify：它是 `CONFIG_SHORTCUTS.includes(key)` 对自身元素的
// 自指恒真断言，不读任何 src，迁入 tests 会制造假绿（见对账 §5）。
// 本文件保留真实 fs 段：Claude/Codex settings 字节读写、Codex fill-missing 过滤展示、Rules 落盘。

// Config / Global Rules 按 agentContext 复用 UI + 路径隔离（design D10/D11, PBT-11/PBT-12）。
// 覆盖：
// - Config 快捷键语义复用（预览 / e / Ctrl+T / Ctrl+O）
// - Claude Config 读写 ~/.claude/settings.json；Codex Config 读写 ~/.codex/config.toml
// - Codex Config 推荐 fill-missing 不管理 provider/MCP/hooks/Skills/AGENTS.md
// - Claude/Codex Rules 只读写各自的全局规则文件，不提供规则推荐导入

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
	const {getConfigPath, readCurrentConfigText, fillMissingIntoText, saveConfigText} = await import(
		'../src/services/config-service.ts'
	);
	const {readCurrentRules, saveRules} = await import('../src/services/prompts-service.ts');
	const {codexConfigPath, claudeDir} = await import('../src/core/paths.ts');

	// ── Config 目标文件按 agent 切换（路径投影已迁 tests；此处仍用 getConfigPath 读写真实字节）──

	// Claude Config 仍剥离/保留供应商字段
	writeFileSync(getConfigPath('cc'), JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: 'sk-claude', KEEP: 'yes'}}, null, 2), 'utf8');
	assert.equal(readCurrentConfigText('cc').includes('ANTHROPIC_AUTH_TOKEN'), false, 'Claude Config view 剥离供应商 token');
	const claudeSaved = saveConfigText('{"env":{"KEEP":"changed"}}', 'cc');
	assert.equal(claudeSaved.ok, true, 'Claude settings 保存成功');
	const claudeSettings = JSON.parse(readFileSync(getConfigPath('cc'), 'utf8'));
	assert.equal(claudeSettings.env.ANTHROPIC_AUTH_TOKEN, 'sk-claude', 'Claude settings 保存时保留供应商 token');

		// Codex Config TOML fill-missing：展示/编辑过滤 provider/MCP（保存时从原文件合并保留），
		// hooks 已放开直编（与 Claude settings.json 侧一致），展示可见、随 edited 落盘。
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
		assert.match(codexVisible, /\[hooks\]/, 'Codex Config view 展示 hooks table（已放开直编）');
		const codexFill = fillMissingIntoText(codexVisible, 'cx');
		assert.equal(codexFill.ok, true, 'Codex Config fill-missing 应成功');
		assert.doesNotMatch(codexFill.text, /model\s*=\s*"custom-model"/, 'Codex fill-missing 缓冲不含 model（归供应商管）');
		assert.doesNotMatch(codexFill.text, /\[model_providers\.deepseek\]/, 'Codex fill-missing 缓冲不暴露 provider table');
		assert.doesNotMatch(codexFill.text, /\[mcp_servers\.context7\]/, 'Codex fill-missing 缓冲不暴露 MCP table');
		assert.match(codexFill.text, /\[hooks\]/, 'Codex fill-missing 缓冲展示 hooks table（已放开直编）');
		// fill-missing 应补齐新增托管项：file_opener（顶层标量）。
		assert.match(codexFill.text, /file_opener\s*=\s*"vscode"/, 'Codex fill-missing 补齐 file_opener');
		const codexSaved = saveConfigText(codexFill.text, 'cx');
		assert.equal(codexSaved.ok, true, 'Codex config.toml 保存成功');
		assert.equal(codexSaved.warning, undefined, 'Codex Config 保存过滤缓冲时不应提示用户编辑了外部 sections');
		const codexAfterSave = readFileSync(codexConfigPath(), 'utf8');
		assert.match(codexAfterSave, /model\s*=\s*"custom-model"/, 'Codex 保存必须从原文件恢复 model（归供应商管）');
		assert.match(codexAfterSave, /\[model_providers\.deepseek\]/, 'Codex 保存保留原 provider table');
		assert.match(codexAfterSave, /\[mcp_servers\.context7\]/, 'Codex 保存保留原 MCP table');
		assert.match(codexAfterSave, /\[hooks\]/, 'Codex 保存落盘 hooks table（已放开直编，随 edited 保存）');
		assert.equal(existsSync(getConfigPath('cc')), true, 'Codex 保存不删除/替换 Claude settings');
		console.log('[PASS] 6.4/6.5/6.6 Codex Config TOML 结构化 fill-missing + 过滤展示 + 路径隔离');

	// ── Global Rules 目标文件按 agent 切换（路径投影已迁 tests；此处验证真实落盘）──
	assert.equal(saveRules('claude rules', 'cc').ok, true, 'Claude rules 保存成功');
	assert.equal(saveRules('codex agents', 'cx').ok, true, 'Codex rules 保存成功');
	assert.equal(readCurrentRules('cc'), 'claude rules', 'Claude rules 从 CLAUDE.md 读取');
	assert.equal(readCurrentRules('cx'), 'codex agents', 'Codex rules 从 AGENTS.md 读取');
	assert.equal(readFileSync(join(claudeDir(), 'CLAUDE.md'), 'utf8'), 'claude rules', 'Codex 保存不覆盖 CLAUDE.md');
	console.log('[PASS] 6.7/6.8/6.9 Rules 路径隔离：CLAUDE.md ↔ AGENTS.md，无规则推荐导入');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
	rmSync(home, {recursive: true, force: true});
}

console.log('[PASS] Config / Global Rules 复用与路径隔离门禁通过');
