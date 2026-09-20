import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importFillMissing, settingsFilePath} from '../src/core/config-recommend.ts';

// [P5b 迁走] fill-missing 幂等性 (P-1)、DoNotManage 保护 (P-2)、ConfigView Claude ownership
// 过滤/保存合并、Codex 推荐配置契约内容、Codex fill-missing 空缓冲补齐 → tests/core/config-view.test.ts
// （33 条静态断言）。createConfigDocumentAdapter('cx').openExternal / openSuccessMessage 已由
// P1-G2 载体 tests/core/config-document-adapter.test.ts 覆盖（R9），P5e 已删除 verify 侧 2 条。
// 本文件保留真实 fs 段：importFillMissing 端到端幂等、损坏 settings.json 拒绝覆盖、
// Codex config.toml 结构化保存 / 过滤展示 / 路径隔离 / 错误脱敏。

// Phase 5 配置文件菜单门禁：守住 fill-missing 的两条核心不变量——
//   P-1 幂等性：同一配置导入两次，第二次无变更；
//   P-2 DoNotManage 保护：受保护键（model/statusLine/hooks/供应商 env）导入后值不变。
// 外加损坏 settings.json 拒绝覆盖（对齐 Install-ClaudeConfig 安全策略）。

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

// ── 6.10 Codex ConfigView：agentContext 与 TOML 结构化保存 ─────────────────────
// P1-G2 静态断言治理：原 23 条源码正则已分类处置——
//   A 类（16 条 adapter 描述符/路由）迁到 tests/core/config-document-adapter.test.ts；
//   B 类（7 条 agentContext 必经路径 / dirty 编辑 / HC-EDITOR-PANEL-STABLE 结构不变量）
//   并入 scripts/verify-view-architecture.mjs（P1-G2 段）；C = 0。
// 详见 .trellis/tasks/09-18-p1-static-assertion-governance/research-reconciliation-G2.md。
console.log('[PASS] 6.10 ConfigView agentContext + Codex TOML 编辑行为不变量（静态合同见 verify-view-architecture.mjs）');

const codexHome = mkdtempSync(join(tmpdir(), 'ccq-config-codex-view-'));
process.env.CCQ_HOME = codexHome;
process.env.CODEX_HOME = join(codexHome, '.codex');
try {
	mkdirSync(process.env.CODEX_HOME, {recursive: true});
	const {configFileExists, getConfigPath, readCurrentConfigText, fillMissingIntoText, saveConfigText} = await import(
		'../src/services/config-service.ts'
	);
	// [P5e 去重] adapter `openExternal` / `openSuccessMessage`（2 条）已由 P1-G2 载体独占：
	// tests/core/config-document-adapter.test.ts > openExternal 指向 Config service，成功提示指向目标路径
	// （对 TARGETS 全量断言 `typeof openExternal === 'function'` 与 `openSuccessMessage.includes(getConfigPath(target))`）。
	const codexPath = getConfigPath('cx');
	writeFileSync(
		codexPath,
		[
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
		].join('\n'),
		'utf8'
	);

	const before = readFileSync(codexPath, 'utf8');
	const invalid = saveConfigText('model = "broken', 'cx');
	assert.equal(invalid.ok, false, 'Codex Config 应拒绝无效 TOML');
	assert.equal(readFileSync(codexPath, 'utf8'), before, '无效 TOML 保存失败时不得覆盖原文件');
	assert.equal(invalid.error.includes('sk-codex-config-secret'), false, 'TOML 错误输出不得泄漏已有 token');

	const visible = readCurrentConfigText('cx');
	assert.doesNotMatch(visible, /model\s*=\s*"custom-model"/, 'Codex Config 展示必须过滤 model（归供应商管）');
	assert.doesNotMatch(visible, /\[model_providers\.deepseek\]/, 'Codex Config 展示必须过滤 provider table');
	assert.doesNotMatch(visible, /experimental_bearer_token/, 'Codex Config 展示不得暴露 provider token 字段');
	assert.doesNotMatch(visible, /\[mcp_servers\.context7\]/, 'Codex Config 展示必须过滤 MCP table');
	assert.match(visible, /\[hooks\]/, 'Codex Config 展示 hooks table（已放开直编）');

	const fill = fillMissingIntoText(visible, 'cx');
	assert.equal(fill.ok, true, 'Codex Config fill-missing 应接受过滤后的 TOML');
	assert.doesNotMatch(fill.text, /model\s*=\s*"custom-model"/, 'Codex fill-missing 缓冲不含 model（归供应商管）');
	assert.doesNotMatch(fill.text, /\[model_providers\.deepseek\]/, 'Codex fill-missing 缓冲不得重新暴露 provider table');
	assert.doesNotMatch(fill.text, /\[mcp_servers\.context7\]/, 'Codex fill-missing 缓冲不得重新暴露 MCP table');
	assert.match(fill.text, /\[hooks\]/, 'Codex fill-missing 缓冲保留 hooks table（已放开直编）');
	writeFileSync(
		codexPath,
		['[model_providers.only_provider]', 'name = "only_provider"', '', '[mcp_servers.context7]', 'command = "npx"', '', '[hooks]'].join(
			'\n'
		),
		'utf8'
	);
	assert.equal(configFileExists('cx'), true, 'Codex config.toml 存在时必须可被视图识别');
	assert.equal(readCurrentConfigText('cx').trim(), '[hooks]', '仅剩 hooks 时 Config 可见内容应展示 hooks（已放开直编）');

	writeFileSync(codexPath, before, 'utf8');
	const saved = saveConfigText(fill.text, 'cx');
	assert.equal(saved.ok, true, 'Codex Config 应保存合法 TOML');
	const afterSave = readFileSync(codexPath, 'utf8');
	assert.match(afterSave, /model\s*=\s*"custom-model"/, 'Codex Config 保存必须从原文件恢复 model（归供应商管）');
	assert.match(afterSave, /\[model_providers\.deepseek\]/, 'Codex Config 保存必须从原文件恢复 provider table');
	assert.match(afterSave, /experimental_bearer_token\s*=\s*"sk-codex-config-secret"/, 'Codex Config 保存必须保留原 provider token');
	assert.match(afterSave, /\[mcp_servers\.context7\]/, 'Codex Config 保存必须保留原 MCP table');
	assert.match(afterSave, /\[hooks\]/, 'Codex Config 保存 hooks table（已放开直编，随 edited 保存）');
	assert.equal(existsSync(join(codexHome, '.claude', 'settings.json')), false, 'Codex Config 保存不得创建 Claude settings.json');
	console.log('[PASS] 6.10 Codex Config TOML 结构化保存 + 过滤展示 + 路径隔离 + 错误脱敏');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
	rmSync(codexHome, {recursive: true, force: true});
}

console.log('[PASS] Phase 5/6.10 配置文件菜单 fill-missing 与 Codex agentContext 门禁通过');
