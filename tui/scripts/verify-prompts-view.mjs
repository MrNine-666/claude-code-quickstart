import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Phase 6.10 全局规则视图门禁：
// - PromptsView 必须按 agentContext 切换 CLAUDE.md / AGENTS.md。
// - 全局规则只提供查看、编辑与保存，不加载或导入推荐规则。

const promptViewSource = ['../src/views/prompts/PromptsView.tsx', '../src/views/prompts/prompts-document-adapter.ts']
	.map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
	.join('\n');
const promptsCoreSource = readFileSync(new URL('../src/core/prompts.ts', import.meta.url), 'utf8');
const keybindingsSource = readFileSync(new URL('../src/config/keybindings.ts', import.meta.url), 'utf8');
const shortcutsSource = readFileSync(new URL('../src/state/shortcuts.ts', import.meta.url), 'utf8');

assert.match(promptViewSource, /createPromptsDocumentAdapter\(props\.agentContext\)/, 'PromptsView 必须从 agentContext 派生 adapter');
assert.match(promptViewSource, /const rulesPath = getRulesPath\(target\)/, '全局规则 adapter 必须从 service 派生目标路径');
assert.match(promptViewSource, /getRulesPath\(target\)/, '规则目标路径必须按 target 切换');
assert.match(promptViewSource, /openRulesFile\(target\)/, '全局规则页必须把打开文件动作路由到 Prompts service');
assert.match(promptViewSource, /openExternal:/, '全局规则 adapter 必须提供外部打开动作');
assert.match(promptViewSource, /readCurrentRules\(target\)/, '规则读取必须按 target 切换');
assert.match(promptViewSource, /saveRules\(content, target\)/, '规则保存必须按 target 切换');
assert.match(promptViewSource, /title: '全局规则管理'/, 'Header 标题必须统一为「全局规则管理」');
assert.match(promptViewSource, /subtitle: rulesPath/, '全局规则 Header 说明必须直接使用真实文件路径');
assert.doesNotMatch(promptViewSource, /查看与编辑/, '全局规则 Header 说明不得包含「查看与编辑」');
assert.doesNotMatch(promptViewSource, /当前规则/, '全局规则编辑器不得显示「当前规则」标题');
assert.doesNotMatch(promptViewSource, /recommendation|推荐/i, '全局规则 view 不得包含推荐规则功能');
assert.doesNotMatch(promptsCoreSource, /recommendation|推荐|loadTextContract/i, '规则 core 不得加载推荐模板');
assert.doesNotMatch(keybindingsSource, /prompts:(?:toggle-panel|import|focus-cycle)/, '全局规则不得注册推荐边栏/导入/焦点切换命令');
assert.doesNotMatch(shortcutsSource, /PROMPTS_COMMANDS\.(?:TOGGLE_PANEL|IMPORT|FOCUS_CYCLE)/, '全局规则 footer 不得暴露推荐命令');
console.log('[PASS] 6.10 PromptsView agentContext + 无推荐规则功能源码不变量');

const home = mkdtempSync(join(tmpdir(), 'ccq-prompts-view-'));
process.env.CCQ_HOME = home;
process.env.CODEX_HOME = join(home, '.codex');
try {
	mkdirSync(join(home, '.claude'), {recursive: true});
	mkdirSync(process.env.CODEX_HOME, {recursive: true});
	const {getRulesPath, readCurrentRules, saveRules} = await import('../src/services/prompts-service.ts');
	const {createPromptsDocumentAdapter} = await import('../src/views/prompts/prompts-document-adapter.ts');
	const {viewShortcuts} = await import('../src/state/shortcuts.ts');

	const expectedPaths = {
		cc: join(home, '.claude', 'CLAUDE.md'),
		cx: join(process.env.CODEX_HOME, 'AGENTS.md'),
		pi: join(home, '.pi', 'agent', 'AGENTS.md')
	};
	for (const target of ['cc', 'cx', 'pi']) {
		assert.equal(getRulesPath(target), expectedPaths[target], `${target} 全局规则目标路径错误`);
		assert.equal(readCurrentRules(target), null, `${target} 规则缺失时返回 null`);
		const adapter = createPromptsDocumentAdapter(target);
		assert.equal(adapter.subtitle, expectedPaths[target], `${target} Header 说明必须展示真实规则文件路径`);
		assert.equal(adapter.subtitle.includes('查看与编辑'), false, `${target} Header 说明不得包含「查看与编辑」`);
		assert.equal(adapter.editorTitle, '', `${target} 不应提供「当前规则」编辑器标题`);
		assert.equal(adapter.recommendationContent, undefined, `${target} 不应提供推荐规则内容`);
		assert.equal(adapter.importInto, undefined, `${target} 不应提供推荐规则导入`);
		assert.equal(typeof adapter.openExternal, 'function', `${target} 必须提供外部打开动作`);
		assert.ok(adapter.openSuccessMessage?.includes(expectedPaths[target]), `${target} 外部打开提示必须指向目标文件`);
	}

	assert.deepEqual(
		viewShortcuts('prompts', 'edit').map(shortcut => shortcut.label),
		['保存', '取消'],
		'全局规则编辑态 footer 只应提供保存和取消'
	);

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

	console.log('[PASS] 全局规则 cc/cx/pi 路径隔离、读写与推荐功能移除');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
	rmSync(home, {recursive: true, force: true});
}

console.log('[PASS] PromptsView / Global Rules agentContext 门禁通过');
