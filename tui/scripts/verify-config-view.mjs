import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyFillMissing, importFillMissing, loadConfigContract, settingsFilePath} from '../src/core/config-recommend.ts';

// Phase 5 配置文件菜单门禁：守住 fill-missing 的两条核心不变量——
//   P-1 幂等性：同一配置导入两次，第二次无变更；
//   P-2 DoNotManage 保护：受保护键（model/statusLine/hooks/供应商 env）导入后值不变。
// 外加损坏 settings.json 拒绝覆盖（对齐 Install-ClaudeConfig 安全策略）。

const contract = loadConfigContract();
assert.ok(contract, 'claude-config.json 契约应可加载');

// ── P-1 幂等性（纯函数）─────────────────────────────────────────────────────
const source = {language: '简体中文', env: {MAX_THINKING_TOKENS: '31999'}, permissions: {allow: ['CustomTool']}};
const first = applyFillMissing(contract, source);
const second = applyFillMissing(contract, first.settings);
assert.deepEqual(second.updatedItems, [], '第二次 fill-missing 应无变更项');
assert.deepEqual(second.settings, first.settings, '幂等：两次合并结果一致');
console.log('[PASS] fill-missing 幂等性 (P-1)');

// ── P-2 DoNotManage 保护（纯函数）───────────────────────────────────────────
const protectedSource = {
	model: 'my-model',
	statusLine: {type: 'command', command: 'ccline'},
	hooks: {Stop: [{matcher: ''}]},
	env: {ANTHROPIC_AUTH_TOKEN: 'sk-secret', ANTHROPIC_BASE_URL: 'https://x.com'},
	permissions: {allow: ['CustomTool']}
};
const guarded = applyFillMissing(contract, protectedSource);
assert.equal(guarded.settings.model, 'my-model', 'model 不被触碰');
assert.deepEqual(guarded.settings.statusLine, {type: 'command', command: 'ccline'}, 'statusLine 不被触碰');
assert.deepEqual(guarded.settings.hooks, {Stop: [{matcher: ''}]}, 'hooks 不被触碰');
assert.equal(guarded.settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-secret', '供应商 token 不被触碰');
assert.equal(guarded.settings.env.ANTHROPIC_BASE_URL, 'https://x.com', '供应商 baseUrl 不被触碰');
assert.equal(guarded.settings.language, '简体中文', '缺失 language 被补充');
assert.equal(guarded.settings.env.MAX_THINKING_TOKENS, '31999', '缺失受管 env 被补充');
assert.ok(guarded.settings.permissions.allow.includes('CustomTool'), '用户已有权限保留');
assert.ok(guarded.settings.permissions.allow.includes('Bash'), '基础权限追加');
console.log('[PASS] DoNotManage 保护 (P-2)');

// ── 端到端 importFillMissing（CCQ_HOME 隔离）────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'ccq-config-test-'));
process.env.CCQ_HOME = home;
try {
	mkdirSync(join(home, '.claude'), {recursive: true});
	writeFileSync(settingsFilePath(), JSON.stringify({model: 'keep-me', env: {ANTHROPIC_AUTH_TOKEN: 'sk-x'}}), 'utf8');

	const e1 = importFillMissing();
	assert.ok(e1.ok && e1.changed > 0, '首次导入应补全缺失项');

	const e2 = importFillMissing();
	assert.ok(e2.ok && e2.changed === 0, '二次导入应幂等无变更');

	const written = JSON.parse(readFileSync(settingsFilePath(), 'utf8'));
	assert.equal(written.model, 'keep-me', '端到端：model 保留');
	assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, 'sk-x', '端到端：供应商 token 保留');
	assert.equal(written.language, '简体中文', '端到端：缺失 language 补充');
	console.log('[PASS] importFillMissing 端到端幂等 + 保护');
} finally {
	delete process.env.CCQ_HOME;
	rmSync(home, {recursive: true, force: true});
}

// ── 损坏 settings.json 拒绝覆盖 ─────────────────────────────────────────────
const badHome = mkdtempSync(join(tmpdir(), 'ccq-config-bad-'));
process.env.CCQ_HOME = badHome;
try {
	mkdirSync(join(badHome, '.claude'), {recursive: true});
	const badPath = settingsFilePath();
	writeFileSync(badPath, '{ broken json', 'utf8');
	const result = importFillMissing();
	assert.equal(result.ok, false, '损坏 JSON 应拒绝写入');
	assert.equal(readFileSync(badPath, 'utf8'), '{ broken json', '损坏文件保持原样（未被覆盖）');
	console.log('[PASS] 损坏 settings.json 拒绝覆盖');
} finally {
	delete process.env.CCQ_HOME;
	rmSync(badHome, {recursive: true, force: true});
}

// ── 6.10 Codex ConfigView：agentContext 源码不变量 + TOML 结构化保存 ─────────────
const configViewSource = readFileSync(new URL('../src/views/ConfigView.tsx', import.meta.url), 'utf8');
assert.match(configViewSource, /const target: ConfigTarget = agentContext/, 'ConfigView 必须从 agentContext 派生 target');
assert.match(configViewSource, /loadRecommendationAnnotated\(target\)/, '推荐配置必须按 target 加载');
assert.match(configViewSource, /getConfigPath\(target\)/, '目标路径必须按 target 切换');
assert.match(configViewSource, /readCurrentConfigText\(target\)/, '读取配置必须按 target 切换');
assert.match(configViewSource, /fillMissingIntoText\([^\n]+target\)/, 'Ctrl+O fill-missing 必须按 target 路由');
assert.match(configViewSource, /saveConfigText\(content, target\)/, '保存必须按 target 路由');
assert.match(configViewSource, /isJson=\{!isCodex\}/, 'Codex Config 编辑器不得启用 JSON 校验，应交给 TOML service 校验');
assert.match(configViewSource, /filetype=\{isCodex \? 'text' : 'json'\}/, 'Codex Config 编辑器不应声明为 JSON filetype');
assert.match(configViewSource, /title=\{isCodex \? 'Codex 配置文件管理' : '配置文件管理'\}/, '编辑态 Header 必须随 agentContext 切换标题');
assert.match(configViewSource, /subtitle=\{isCodex \? '查看、补全与编辑 CODEX_HOME\/config\.toml' : '查看、补全与编辑 Claude Code settings\.json'\}/, '编辑态 Header 必须随 agentContext 切换副标题');
assert.match(configViewSource, /if \(dirty\) toast\.info\('已放弃未保存的编辑'\);/, '取消编辑必须识别 dirty 状态');
assert.match(configViewSource, /setDirty\(false\);/, '保存/取消后必须清理 dirty 状态，避免跨上下文误写');
console.log('[PASS] 6.10 ConfigView agentContext + Codex TOML 编辑源码不变量');

const codexHome = mkdtempSync(join(tmpdir(), 'ccq-config-codex-view-'));
process.env.CCQ_HOME = codexHome;
process.env.CODEX_HOME = join(codexHome, '.codex');
try {
	mkdirSync(process.env.CODEX_HOME, {recursive: true});
	const {getConfigPath, readCurrentConfigText, fillMissingIntoText, saveConfigText} = await import('../src/services/config-service.ts');
	const codexPath = getConfigPath('cx');
	writeFileSync(codexPath, [
		'model = "custom-model"',
		'',
		'[model_providers.deepseek]',
		'name = "deepseek"',
		'experimental_bearer_token = "sk-codex-config-secret"',
		'',
		'[mcp_servers.context7]',
		'command = "npx"',
		'',
		'[hooks]'
	].join('\n'), 'utf8');

	const before = readFileSync(codexPath, 'utf8');
	const invalid = saveConfigText('model = "broken', 'cx');
	assert.equal(invalid.ok, false, 'Codex Config 应拒绝无效 TOML');
	assert.equal(readFileSync(codexPath, 'utf8'), before, '无效 TOML 保存失败时不得覆盖原文件');
	assert.equal(invalid.error.includes('sk-codex-config-secret'), false, 'TOML 错误输出不得泄漏已有 token');

	const fill = fillMissingIntoText(readCurrentConfigText('cx'), 'cx');
	assert.equal(fill.ok, true, 'Codex Config fill-missing 应接受 TOML');
	assert.match(fill.text, /model\s*=\s*"custom-model"/, 'Codex fill-missing 不覆盖用户 model');
	assert.match(fill.text, /\[model_providers\.deepseek\]/, 'Codex fill-missing 保留 provider table');
	assert.match(fill.text, /experimental_bearer_token\s*=\s*"sk-codex-config-secret"/, 'Codex fill-missing 结构化保留用户 profile/provider 字段');
	assert.match(fill.text, /\[mcp_servers\.context7\]/, 'Codex fill-missing 保留 MCP table');
	assert.match(fill.text, /\[hooks\]/, 'Codex fill-missing 保留 hooks table');
	const saved = saveConfigText(fill.text, 'cx');
	assert.equal(saved.ok, true, 'Codex Config 应保存合法 TOML');
	assert.equal(existsSync(join(codexHome, '.claude', 'settings.json')), false, 'Codex Config 保存不得创建 Claude settings.json');
	console.log('[PASS] 6.10 Codex Config TOML 结构化保存 + 路径隔离 + 错误脱敏');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
	rmSync(codexHome, {recursive: true, force: true});
}

console.log('[PASS] Phase 5/6.10 配置文件菜单 fill-missing 与 Codex agentContext 门禁通过');
