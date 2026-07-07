import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Phase 6.10 全局规则视图门禁：
// - PromptsView 必须按 agentContext 切换 CLAUDE.md / AGENTS.md。
// - Codex 规则只写 CODEX_HOME/AGENTS.md，不触碰 Claude CLAUDE.md。
// - UI 交互复用预览 / e / Ctrl+T / Ctrl+O / dirty 取消语义。

const promptsViewSource = readFileSync(new URL('../src/views/PromptsView.tsx', import.meta.url), 'utf8');
assert.match(promptsViewSource, /const target: PromptsTarget = agentContext/, 'PromptsView 必须从 agentContext 派生 target');
assert.match(promptsViewSource, /const isCodex = target === 'cx'/, 'PromptsView 必须识别 Codex 上下文');
assert.match(promptsViewSource, /getRulesPath\(target\)/, '规则目标路径必须按 target 切换');
assert.match(promptsViewSource, /readCurrentRules\(target\)/, '规则读取必须按 target 切换');
assert.match(promptsViewSource, /saveRules\(content, target\)/, '规则保存必须按 target 切换');
assert.match(promptsViewSource, /title=\{isCodex \? 'Codex 全局规则管理' : '全局规则管理'\}/, 'Header 标题必须随 agentContext 切换');
assert.match(promptsViewSource, /CODEX_HOME\/AGENTS\.md/, 'Codex Header/空状态必须指向 AGENTS.md');
assert.match(promptsViewSource, /if \(appMod && name === 't'\) \{ togglePanel\(\); return; \}/, 'Ctrl+T 应打开推荐规则面板');
assert.match(promptsViewSource, /if \(appMod && name === 'o'\) \{ requestImport\(\); return; \}/, 'Ctrl+O 应导入推荐规则到编辑缓冲');
assert.match(promptsViewSource, /if \(dirty\) toast\.info\('已放弃未保存的编辑'\);/, '取消编辑必须识别 dirty 状态');
assert.match(promptsViewSource, /editorRef\.current\?\.replaceText\(recommendationContent\)/, '导入推荐只能替换编辑缓冲，保存前不得落盘');
assert.match(promptsViewSource, /setDirty\(false\);/, '保存/取消后必须清理 dirty 状态，避免跨上下文误写');
console.log('[PASS] 6.10 PromptsView agentContext + 快捷键 + dirty 源码不变量');

const home = mkdtempSync(join(tmpdir(), 'ccq-prompts-view-'));
process.env.CCQ_HOME = home;
process.env.CODEX_HOME = join(home, '.codex');
try {
	mkdirSync(join(home, '.claude'), {recursive: true});
	mkdirSync(process.env.CODEX_HOME, {recursive: true});
	const {getRulesPath, readCurrentRules, saveRules} = await import('../src/services/prompts-service.ts');
	const {assembleRecommendation} = await import('../src/core/prompts.ts');

	assert.equal(getRulesPath('cc'), join(home, '.claude', 'CLAUDE.md'), 'Claude rules 目标必须是 CLAUDE.md');
	assert.equal(getRulesPath('cx'), join(process.env.CODEX_HOME, 'AGENTS.md'), 'Codex rules 目标必须是 AGENTS.md');
	assert.equal(readCurrentRules('cc'), null, 'Claude rules 缺失时返回 null');
	assert.equal(readCurrentRules('cx'), null, 'Codex rules 缺失时返回 null');

	const claudeSave = saveRules('claude rules', 'cc');
	assert.equal(claudeSave.ok, true, 'Claude rules 保存应成功');
	assert.equal(readCurrentRules('cc'), 'claude rules', 'Claude rules 应从 CLAUDE.md 读取');
	assert.equal(existsSync(join(process.env.CODEX_HOME, 'AGENTS.md')), false, 'Claude rules 保存不得创建 AGENTS.md');

	const codexSave = saveRules('codex agents', 'cx');
	assert.equal(codexSave.ok, true, 'Codex rules 保存应成功');
	assert.equal(readCurrentRules('cx'), 'codex agents', 'Codex rules 应从 AGENTS.md 读取');
	assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'claude rules', 'Codex rules 保存不得覆盖 CLAUDE.md');
	assert.equal(readFileSync(join(process.env.CODEX_HOME, 'AGENTS.md'), 'utf8'), 'codex agents', 'Codex rules 应写入 AGENTS.md');
	assert.ok((assembleRecommendation() ?? '').trim().length > 0, 'Codex 推荐规则应复用 Claude 推荐规则内容来源');
	console.log('[PASS] 6.10 Prompts service CLAUDE.md ↔ AGENTS.md 路径隔离');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
	rmSync(home, {recursive: true, force: true});
}

console.log('[PASS] PromptsView / Global Rules agentContext 门禁通过');
