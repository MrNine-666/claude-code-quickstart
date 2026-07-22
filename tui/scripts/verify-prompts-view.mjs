import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Phase 6.10 全局规则视图门禁：
// - PromptsView 必须按 agentContext 切换 CLAUDE.md / AGENTS.md。
// - Codex 规则只写 ~/.codex/AGENTS.md，不触碰 Claude CLAUDE.md。
// - UI 交互复用预览 / e / Ctrl+T / Ctrl+O / dirty 取消语义。

const promptsViewSource = [
	'../src/views/prompts/PromptsView.tsx',
	'../src/views/prompts/prompts-document-adapter.ts',
	'../src/components/managed-document/ManagedDocumentView.tsx',
	'../src/components/managed-document/DocumentHomeView.tsx',
	'../src/components/managed-document/DocumentFormView.tsx'
].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
assert.match(promptsViewSource, /createPromptsDocumentAdapter\(props\.agentContext\)/, 'PromptsView 必须从 agentContext 派生 adapter');
assert.match(promptsViewSource, /target === 'cx'/, 'PromptsView 必须识别 Codex 上下文');
assert.match(promptsViewSource, /getRulesPath\(target\)/, '规则目标路径必须按 target 切换');
assert.match(promptsViewSource, /readCurrentRules\(target\)/, '规则读取必须按 target 切换');
assert.match(promptsViewSource, /saveRules\(content, target\)/, '规则保存必须按 target 切换');
assert.match(promptsViewSource, /assembleRulesRecommendation\(target\)/, '推荐规则内容必须按 target 做 cc/cx 差异化');
assert.match(promptsViewSource, /title: '全局规则管理'/, 'Header 标题统一为「全局规则管理」（Codex 上下文经由 Header 全称区分）');
assert.match(promptsViewSource, /~\/\.codex\/AGENTS\.md/, 'Codex Header/空状态必须指向 AGENTS.md');
assert.match(promptsViewSource, /if \(appMod && name === 't'\)/, 'Ctrl+T 应打开推荐规则面板');
assert.match(promptsViewSource, /if \(appMod && name === 'o'\)/, 'Ctrl+O 应导入推荐规则到编辑缓冲');
assert.match(promptsViewSource, /if \(dirty\) \{[\s\S]{0,80}toast\.info\('已放弃未保存的编辑'\)/, '取消编辑必须识别 dirty 状态');
assert.match(promptsViewSource, /editorRef\.current\?\.replaceText\(result\.text\)/, '导入推荐只能替换编辑缓冲，保存前不得落盘');
assert.match(promptsViewSource, /const installed = readCurrentRules\(target\) \?\? '';/, '导入推荐必须以磁盘规则文件为注释块权威来源，避免依赖编辑缓冲时序');
assert.match(promptsViewSource, /mergeRecommendationPreservingManagedBlocks\(recommendationContent, installed\)/, '导入推荐必须保留注入的注释块，只覆盖块以外内容');
assert.doesNotMatch(promptsViewSource, /mergeRecommendationPreservingManagedBlocks\(recommendationContent, editorRef\.current/, '导入推荐不得从编辑缓冲提取注释块（时序不可靠）');
assert.match(promptsViewSource, /setDirty\(false\);/, '保存/取消后必须清理 dirty 状态，避免跨上下文误写');
assert.match(
	promptsViewSource,
	/useEffect\(\(\) => \{[\s\S]{0,120}reset\(adapter\.load\(\)\);[\s\S]{0,40}\}, \[adapter\]\);/,
	'PromptsView 切换 agentContext/target 时必须重读目标文件并清理编辑临时态'
);
// HC-EDITOR-PANEL-STABLE：editor 面板容器父路径必须恒定（始终 row 容器内的 key='editor-panel'），
// 推荐边栏作为带 key 的兄弟条件插入/移除。否则 split↔editor 切换会改变 editorEl 父路径，React 卸载重挂
// TextareaEditor，<textarea initialValue> 用 editInitial 重新初始化、丢失用户编辑（关闭推荐边栏内容回退 bug）。
// 注：React key 仅在同一父节点的兄弟间保证复用；跨父路径的 key 无效，故必须靠稳定结构而非给 TextareaEditor 加 key。
assert.match(promptsViewSource, /key="editor-panel"/, 'PromptsView editor 面板必须有稳定 key，父路径恒定避免 textarea 重挂丢内容');
assert.match(promptsViewSource, /key="recommend-panel"/, 'PromptsView 推荐边栏必须作为带 key 的兄弟节点条件渲染，不改变 editor 面板父路径');
assert.doesNotMatch(promptsViewSource, /\?\s*\([\s\S]{0,200}\{editorEl\}[\s\S]{0,200}\)\s*:\s*\(\s*editorEl\s*\)/, 'editor 不得再走 split/非 split 两分支渲染（会改变父路径导致重挂）');
console.log('[PASS] 6.10 PromptsView agentContext + 快捷键 + dirty 源码不变量');

const home = mkdtempSync(join(tmpdir(), 'ccq-prompts-view-'));
process.env.CCQ_HOME = home;
process.env.CODEX_HOME = join(home, '.codex');
try {
	mkdirSync(join(home, '.claude'), {recursive: true});
	mkdirSync(process.env.CODEX_HOME, {recursive: true});
	const {getRulesPath, readCurrentRules, saveRules} = await import('../src/services/prompts-service.ts');
	const {assembleRecommendation, assembleRulesRecommendation} = await import('../src/core/prompts.ts');

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

	const promptsCoreSource = readFileSync(new URL('../src/core/prompts.ts', import.meta.url), 'utf8');
	const claudeRecommendation = assembleRulesRecommendation('cc', 'windows') ?? '';
	const codexRecommendation = assembleRulesRecommendation('cx', 'windows') ?? '';
	assert.ok((assembleRecommendation('windows') ?? '').trim().length > 0, 'Claude 推荐规则内容来源应可加载');
	assert.match(promptsCoreSource, /readClaudeTemplate\('base'\)/, 'Claude 推荐规则必须保留 base 模板读取');
	assert.match(promptsCoreSource, /readClaudeTemplate\(`platform-\$\{platform\}`\)/, 'Claude 推荐规则必须保留平台模板拼接');
	assert.match(promptsCoreSource, /readTemplateFile\('codex-md\.md'\)/, 'Codex 推荐规则必须读取独立 codex-md.md 模板');
	assert.doesNotMatch(promptsCoreSource, /adaptBaseRecommendationForCodex|replace\(/, 'Codex 推荐规则不得由 Claude 模板运行时替换生成');
	assert.match(claudeRecommendation, /# Claude Code 增强配置/, 'Claude 推荐规则应包含 base 模板');
	assert.match(claudeRecommendation, /Windows \/ PowerShell/, 'Claude Windows 推荐规则应拼接平台专用段');
	assert.match(codexRecommendation, /暂未内置推荐规则模板。/, 'Codex 推荐规则读取 codex-md.md 独立模板');
	assert.doesNotMatch(codexRecommendation, /# Claude Code 增强配置/, 'Codex 推荐规则不得保留 Claude Code 标题');
	assert.doesNotMatch(codexRecommendation, /Windows \/ PowerShell/, 'Codex 推荐规则不应包含 Claude Windows 平台专用段');
	assert.doesNotMatch(codexRecommendation, /Claude Code|CLAUDE\.md|\.claude\/projects|Plan Mode/, 'Codex 推荐规则不得残留 Claude Code 专属语义');
	const {extractManagedBlocks, mergeRecommendationPreservingManagedBlocks} = await import('../src/core/prompts.ts');
	const sampleCurrent = [
		'旧的用户规则正文',
		'<!-- CODEGRAPH_START -->',
		'## CodeGraph',
		'<!-- CODEGRAPH_END -->',
		'<!-- CCG-FAST-CONTEXT-START -->',
		'fast context 注入',
		'<!-- CCG-FAST-CONTEXT-END -->'
	].join('\n');
	const extracted = extractManagedBlocks(sampleCurrent);
	assert.equal(extracted.length, 2, '应提取 CodeGraph 与 CCG-FAST-CONTEXT 两个受管块');
	assert.ok(extracted[0].includes('CODEGRAPH_START') && extracted[0].includes('CODEGRAPH_END'), '首块应为按原文顺序的 CodeGraph 块');
	const merged = mergeRecommendationPreservingManagedBlocks('# 新推荐正文', sampleCurrent);
	assert.match(merged, /# 新推荐正文/, '合并结果应包含推荐正文');
	assert.match(merged, /<!-- CODEGRAPH_START -->[\s\S]*<!-- CODEGRAPH_END -->/, '合并结果应保留 CodeGraph 注释块');
	assert.match(merged, /<!-- CCG-FAST-CONTEXT-START -->[\s\S]*<!-- CCG-FAST-CONTEXT-END -->/, '合并结果应保留 CCG-FAST-CONTEXT 注释块');
	assert.doesNotMatch(merged, /旧的用户规则正文/, '注释块以外的旧正文应被推荐覆盖');
	assert.equal(mergeRecommendationPreservingManagedBlocks('# 仅推荐', '无标记纯文本'), '# 仅推荐', '无受管块时应直接返回推荐正文');
	console.log('[PASS] 导入推荐保留 CodeGraph / ccg-workflow 注释块');
	console.log('[PASS] 6.10 Prompts service CLAUDE.md ↔ AGENTS.md 路径隔离 + Codex 独立模板');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
	rmSync(home, {recursive: true, force: true});
}

console.log('[PASS] PromptsView / Global Rules agentContext 门禁通过');
