import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	buildCodexProviderFormModel,
	codexProviderValuesFromToml,
	codexProviderValuesToToml,
	validateCodexProviderForm
} from '../src/core/codex-provider-form.ts';

const home = mkdtempSync(join(tmpdir(), 'ccq-codex-provider-form-'));
process.env.CCQ_HOME = home;
process.env.CODEX_HOME = join(home, '.codex');

try {
	// ── 5.4 provider 类型：复用 Claude 内置供应商语义 + official login + custom，无 OpenAI-compatible 标签 ──
	const add = buildCodexProviderFormModel({mode: 'add'});
	const providerTypeField = add.fields.find(field => field.id === 'providerType');
	assert.equal(providerTypeField?.type, 'radio', '新增表单首字段为 providerType radio');
	const options = providerTypeField?.type === 'radio' ? providerTypeField.options : [];
	assert.ok(options.some(option => option.value === 'officialLogin' && option.label === 'official login'), 'Codex 增加 official login 类型');
	assert.ok(options.some(option => option.value === 'custom' && /自定义/.test(option.label)), 'Codex 保留自定义供应商语义');
	assert.equal(options.some(option => /OpenAI-compatible/i.test(option.label)), false, '不得新增 OpenAI-compatible 标签');
	console.log('[PASS] 5.4 Codex provider 类型：official login + Claude 语义 + custom，无 OpenAI-compatible');

	// ── 5.7 official login：不要求 API key / Base URL ───────────────────────────
	const official = buildCodexProviderFormModel({mode: 'add', providerType: 'officialLogin'});
	assert.equal(official.values.providerType, 'officialLogin');
	assert.equal(validateCodexProviderForm('add', {...official.values, profileKey: 'official'}).length, 0,
		'official login 不要求 API key/Base URL');
	const officialToml = codexProviderValuesToToml({...official.values, profileKey: 'official', model: 'gpt-5'});
	assert.match(officialToml, /model\s*=\s*"gpt-5"/, 'official login 可保存模型默认值');
	assert.equal(officialToml.includes('model_providers'), false, 'official login 不写 provider table');
	console.log('[PASS] 5.7 official login 表单分支不要求 API key');

	// ── 5.5/5.6 API-key provider：字段 → TOML，TOML → 字段 ─────────────────────
	const apiValues = {
		...buildCodexProviderFormModel({mode: 'add', providerType: 'custom'}).values,
		profileKey: 'deepseek',
		providerType: 'custom',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: 'sk-secret-should-never-leak'
	};
	assert.deepEqual(validateCodexProviderForm('add', apiValues), [], 'API-key provider 字段应通过校验');
	const toml = codexProviderValuesToToml(apiValues);
	assert.match(toml, /model_provider\s*=\s*"deepseek"/, '字段变更生成 TOML model_provider');
	assert.match(toml, /base_url\s*=\s*"https:\/\/api\.deepseek\.com"/, 'Base URL 规范化后写 TOML');
	assert.match(toml, /experimental_bearer_token\s*=\s*"sk-secret-should-never-leak"/, 'API key 写 experimental_bearer_token');
	assert.equal(/env_key\s*=|requires_openai_auth\s*=|\[model_providers\.deepseek\.auth\]/.test(toml), false,
		'认证字段互斥：不得含 env_key/auth/requires_openai_auth');
	const parsed = codexProviderValuesFromToml(apiValues, toml);
	assert.equal(parsed.ok, true, 'TOML textarea 可解析回字段');
	if (parsed.ok) {
		assert.equal(parsed.values.baseUrl, 'https://api.deepseek.com');
		assert.equal(parsed.values.model, 'deepseek-chat');
		assert.equal(parsed.values.providerType, 'custom');
	}
	console.log('[PASS] 5.5/5.6 Codex provider 字段 + TOML 双向同步与 API key 策略');

	// ── parse error：不允许保存无效 TOML ────────────────────────────────────────
	const invalid = codexProviderValuesFromToml(apiValues, 'not = [valid');
	assert.equal(invalid.ok, false, '无效 TOML 应返回错误，不回填字段');
	console.log('[PASS] 5.5 无效 TOML 拒绝回填/保存');
} finally {
	rmSync(home, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
}
